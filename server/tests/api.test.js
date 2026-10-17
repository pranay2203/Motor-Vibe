import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { io as createSocket } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serverPath = path.join(__dirname, '..', 'index.js');

function startServer(dbFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: '4100',
        JWT_SECRET: 'test-secret',
        DB_FILE: dbFile,
        DATABASE_URL: '',
        TELEMETRY_SERVICE_TOKEN: 'test-telemetry-token',
        CLIENT_ORIGIN: 'https://dashboard.example.test/',
        NODE_ENV: 'test',
      },
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('MotorVibe API ready')) {
        resolve(child);
      }
    });

    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited early with code ${code}: ${output}`));
      }
    });
  });
}

test('register and login endpoints provide auth token', async () => {
  const dbFile = path.join(os.tmpdir(), `motorvibe-test-${randomUUID()}.json`);
  const child = await startServer(dbFile);
  let socket;

  try {
    const preflightResponse = await fetch('http://localhost:4100/api/auth/register', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(preflightResponse.headers.get('access-control-allow-origin'), 'https://dashboard.example.test');
    assert.equal(preflightResponse.headers.get('access-control-allow-credentials'), 'true');

    const deniedPreflight = await fetch('http://localhost:4100/api/auth/register', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://unlisted.example.test',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);

    const registerResponse = await fetch('http://localhost:4100/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        password: 'testpass123',
      }),
    });

    const registerData = await registerResponse.json();
    assert.equal(registerResponse.status, 201);
    assert.equal(registerData.success, true);
    assert.ok(registerData.token);
    assert.ok(Number.isInteger(registerData.user.id));

    const duplicateResponse = await fetch('http://localhost:4100/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email: 'test@example.com',
        password: 'testpass123',
      }),
    });

    const duplicateData = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicateData.success, false);
    assert.equal(duplicateData.message, 'User already exists');

    const loginResponse = await fetch('http://localhost:4100/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'testpass123',
      }),
    });

    const loginData = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(loginData.success, true);
    assert.ok(loginData.token);

    socket = createSocket('http://localhost:4100', {
      auth: { token: loginData.token },
      transports: ['websocket'],
      reconnection: false,
    });
    const realtimeSnapshot = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for authenticated socket snapshot')), 5000);
      socket.once('dashboard:update', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.ok(Array.isArray(realtimeSnapshot.assets));

    socket.disconnect();
    socket = undefined;

    const unauthenticatedSocket = createSocket('http://localhost:4100', {
      transports: ['websocket'],
      reconnection: false,
    });
    const authenticationError = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for socket authentication failure')), 5000);
      unauthenticatedSocket.once('connect_error', (error) => {
        clearTimeout(timeout);
        resolve(error);
      });
      unauthenticatedSocket.once('connect', () => {
        clearTimeout(timeout);
        reject(new Error('Unauthenticated socket connection was accepted'));
      });
    });
    assert.match(authenticationError.message, /Authentication required/);
    unauthenticatedSocket.disconnect();

    const ticketResponse = await fetch('http://localhost:4100/api/dashboard/stream-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    const ticketData = await ticketResponse.json();
    assert.equal(ticketResponse.status, 200);
    assert.ok(ticketData.ticket);

    const sseController = new AbortController();
    const sseResponse = await fetch(
      `http://localhost:4100/api/dashboard/events?ticket=${encodeURIComponent(ticketData.ticket)}`,
      { signal: sseController.signal },
    );
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type'), /text\/event-stream/);
    const sseReader = sseResponse.body.getReader();
    const firstEvent = await sseReader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /"assets":\[/);
    sseController.abort();

    const reusedTicketResponse = await fetch(
      `http://localhost:4100/api/dashboard/events?ticket=${encodeURIComponent(ticketData.ticket)}`,
    );
    assert.equal(reusedTicketResponse.status, 401);

    const unauthorizedTelemetry = await fetch('http://localhost:4100/api/internal/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetCode: 'TRB-04', vibration: 3.2, temperature: 59, rpm: 1680 }),
    });
    assert.equal(unauthorizedTelemetry.status, 401);

    const telemetryResponse = await fetch('http://localhost:4100/api/internal/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telemetry-token': 'test-telemetry-token',
      },
      body: JSON.stringify({
        assetCode: 'TRB-04',
        vibration: 3.2,
        peakVibration: 4.1,
        temperature: 59,
        rpm: 1680,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(telemetryResponse.status, 202);

    const overviewResponse = await fetch('http://localhost:4100/api/dashboard/overview', {
      headers: {
        Authorization: `Bearer ${loginData.token}`,
      },
    });

    const overviewData = await overviewResponse.json();
    assert.equal(overviewResponse.status, 200);
    assert.equal(overviewData.success, true);
    assert.ok(Array.isArray(overviewData.assets));
    const turbine = overviewData.assets.find((asset) => asset.code === 'TRB-04');
    assert.equal(turbine.dataSource, 'mqtt');
    assert.equal(turbine.value, 3.2);

    const nextOverviewResponse = await fetch('http://localhost:4100/api/dashboard/overview', {
      headers: {
        Authorization: `Bearer ${loginData.token}`,
      },
    });
    const nextOverviewData = await nextOverviewResponse.json();
    assert.ok(nextOverviewData.chartData.length > 0);
    assert.equal(nextOverviewData.chartData.at(-1).value, 3.2);

    const healthResponse = await fetch('http://localhost:4100/api/health');
    const healthData = await healthResponse.json();
    assert.equal(healthData.database, 'not configured');
  } finally {
    socket?.disconnect();
    child.kill('SIGTERM');
    await rm(dbFile, { force: true });
  }
});
