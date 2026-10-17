import bcrypt from "bcryptjs";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "node:path";
import { Server as SocketServer } from "socket.io";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT || 5000);
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || undefined });
const jwtSecret = process.env.JWT_SECRET || "development-only-change-this-secret";
const telemetryServiceToken = process.env.TELEMETRY_SERVICE_TOKEN || "";
const jsonFile = process.env.DB_FILE || path.join(__dirname, "data", "db.json");
const databaseConfigured = Boolean(process.env.DATABASE_URL);
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("CLIENT_ORIGIN entries must use HTTP or HTTPS.");
    }
    return parsed.origin;
  });
const isDevelopment = process.env.NODE_ENV !== "production";

const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      return callback(null, false);
    }
    const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized);
    if (allowedOrigins.includes(normalized) || (isDevelopment && localOrigin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
};

const io = new SocketServer(httpServer, { cors: corsOptions });
app.use(cors(corsOptions));
app.use(express.json({ limit: "64kb" }));

const sensorMetrics = [
  { key: "vibration", name: "vibration", unit: "mm/s" },
  { key: "peakVibration", name: "peak vibration", unit: "mm/s" },
  { key: "temperature", name: "temperature", unit: "°C" },
  { key: "rpm", name: "rpm", unit: "rpm" },
];
const assetMetadata = new Map([
  ["TRB-04", { id: 4, name: "Turbine 04", type: "Steam turbine", location: "North plant" }],
]);
const streamTickets = new Map();
let simulationTimer;
let jsonState = { users: [], readings: [] };
let jsonWriteQueue = Promise.resolve();

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL error:", error.message);
});

async function loadJsonState() {
  try {
    const contents = await readFile(jsonFile, "utf8");
    const parsed = JSON.parse(contents);
    jsonState = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      readings: Array.isArray(parsed.readings) ? parsed.readings : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    jsonState = { users: [], readings: [] };
  }
}

function persistJsonState() {
  jsonWriteQueue = jsonWriteQueue.then(async () => {
    await mkdir(path.dirname(jsonFile), { recursive: true });
    await writeFile(jsonFile, `${JSON.stringify(jsonState, null, 2)}\n`, "utf8");
  });
  return jsonWriteQueue;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.live_readings (
      id BIGSERIAL PRIMARY KEY,
      sensor_name TEXT NOT NULL,
      reading DOUBLE PRECISION NOT NULL,
      unit TEXT,
      source TEXT NOT NULL DEFAULT 'mqtt',
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE public.live_readings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mqtt'",
  );

  const existingUsers = await pool.query("SELECT COUNT(*)::int AS count FROM public.users");
  if (existingUsers.rows[0].count === 0 && jsonState.users.length > 0) {
    for (const user of jsonState.users) {
      if (!user.name || !user.email || !user.passwordHash) continue;
      await pool.query(
        `INSERT INTO public.users (name, email, password_hash, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [user.name, user.email.toLowerCase(), user.passwordHash, user.createdAt || new Date()],
      );
    }
    console.log("Imported existing user profiles into PostgreSQL.");
  }
}

function publicUser(user) {
  return { id: Number(user.id), name: user.name, email: user.email };
}

async function findUserByEmail(email) {
  if (databaseConfigured) {
    const result = await pool.query(
      "SELECT id, name, email, password_hash AS password_hash FROM public.users WHERE email = $1",
      [email],
    );
    return result.rows[0] || null;
  }
  return jsonState.users.find((user) => user.email.toLowerCase() === email) || null;
}

async function createUser({ name, email, passwordHash }) {
  if (databaseConfigured) {
    const result = await pool.query(
      `INSERT INTO public.users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    return result.rows[0];
  }
  const user = { id: Date.now(), name, email, passwordHash, createdAt: new Date().toISOString() };
  jsonState.users.push(user);
  await persistJsonState();
  return user;
}

function createToken(user) {
  return jwt.sign({ id: Number(user.id), email: user.email }, jwtSecret, { expiresIn: "12h" });
}

function authenticate(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  try {
    if (!token) throw new Error("Missing bearer token");
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    res.status(401).json({ success: false, message: "Authentication required" });
  }
}

async function readStoredReadings(limit = 1000) {
  if (databaseConfigured) {
    const result = await pool.query(
      `SELECT id, sensor_name, reading, unit, source, recorded_at
       FROM public.live_readings
       ORDER BY recorded_at DESC NULLS LAST, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }
  return [...jsonState.readings]
    .sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at) || right.id - left.id)
    .slice(0, limit);
}

async function saveTelemetry({ assetCode, payload, source = "mqtt" }) {
  const metrics = sensorMetrics.filter(
    ({ key }) => typeof payload[key] === "number" && Number.isFinite(payload[key]),
  );
  if (metrics.length === 0) return null;

  const timestamp =
    payload.timestamp === undefined
      ? new Date()
      : typeof payload.timestamp === "string"
        ? new Date(payload.timestamp)
        : null;
  if (!timestamp || Number.isNaN(timestamp.getTime())) return null;

  const names = metrics.map(({ name }) => `${assetCode}: ${name}`);
  const values = metrics.map(({ key }) => payload[key]);
  const units = metrics.map(({ unit }) => unit);
  const timestamps = metrics.map(() => timestamp);
  if (databaseConfigured) {
    return pool.query(
      `INSERT INTO public.live_readings (sensor_name, reading, unit, source, recorded_at)
       SELECT * FROM UNNEST($1::text[], $2::double precision[], $3::text[], $4::text[], $5::timestamptz[])
       RETURNING id, sensor_name, reading, unit, recorded_at`,
      [names, values, units, metrics.map(() => source), timestamps],
    );
  }

  const rows = metrics.map(({ key }, index) => ({
    id: Date.now() + index,
    sensor_name: names[index],
    reading: payload[key],
    unit: units[index],
    source,
    recorded_at: timestamp.toISOString(),
  }));
  jsonState.readings.push(...rows);
  await persistJsonState();
  return { rows, rowCount: rows.length };
}

function statusFor(vibration, temperature) {
  if (vibration >= 6 || temperature >= 75) return "critical";
  if (vibration >= 4 || temperature >= 65) return "observe";
  return "nominal";
}

async function dashboardSnapshot() {
  const stored = await readStoredReadings(1000);
  const grouped = new Map();
  for (const row of stored) {
    const separator = row.sensor_name.indexOf(": ");
    if (separator < 1) continue;
    const code = row.sensor_name.slice(0, separator);
    const metricName = row.sensor_name.slice(separator + 2);
    const key = `${code}|${new Date(row.recorded_at).toISOString()}`;
    const sample = grouped.get(key) || { assetCode: code, timestamp: new Date(row.recorded_at).toISOString() };
    sample.source = row.source || sample.source || "mqtt";
    if (metricName === "vibration") sample.vibration = Number(row.reading);
    if (metricName === "peak vibration") sample.peakVibration = Number(row.reading);
    if (metricName === "temperature") sample.temperature = Number(row.reading);
    if (metricName === "rpm") sample.rpm = Number(row.reading);
    grouped.set(key, sample);
  }

  const samples = [...grouped.values()]
    .filter((sample) => sample.vibration !== undefined)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const latestByCode = new Map();
  for (const sample of samples) latestByCode.set(sample.assetCode, sample);
  const codes = new Set([...assetMetadata.keys(), ...latestByCode.keys()]);
  const assets = [...codes].map((code) => {
    const metadata = assetMetadata.get(code) || {
      id: assetsIdFor(code),
      name: code,
      type: "Monitored equipment",
      location: "North plant",
    };
    const sample = latestByCode.get(code);
    const vibration = sample?.vibration ?? 0;
    const temperature = sample?.temperature ?? 0;
    const state = sample ? statusFor(vibration, temperature) : "nominal";
    return {
      ...metadata,
      code,
      value: vibration,
      state,
      note: sample ? `${state === "nominal" ? "Operating normally" : "Elevated sensor reading"}` : "Waiting for sensor data",
      temp: temperature,
      frequency: sample?.rpm ? Number((sample.rpm / 60).toFixed(1)) : 0,
      trend: "stable",
      peakVibration: sample?.peakVibration ?? vibration,
      rpm: sample?.rpm ?? 0,
      healthScore: Math.max(0, Math.round(100 - vibration * 5 - Math.max(0, temperature - 50))),
      lastUpdated: sample?.timestamp,
      signal: sample ? "online" : "offline",
      dataSource: sample?.source,
    };
  });
  const dashboardReadings = samples.map((sample, index) => {
    const asset = assets.find((item) => item.code === sample.assetCode);
    return {
      id: `${sample.assetCode}-${sample.timestamp}-${index}`,
      assetId: asset?.id ?? 0,
      assetName: asset?.name ?? sample.assetCode,
      timestamp: sample.timestamp,
      vibration: sample.vibration,
      peakVibration: sample.peakVibration ?? sample.vibration,
      temperature: sample.temperature ?? 0,
      rpm: sample.rpm ?? 0,
      status: statusFor(sample.vibration, sample.temperature ?? 0),
    };
  });
  const alerts = dashboardReadings.flatMap((sample) => {
    const alert = sample.vibration >= 4 || sample.temperature >= 65;
    if (!alert) return [];
    const metric = sample.vibration >= 4 ? "vibration" : "temperature";
    const value = sample[metric];
    return [{
      id: `alert-${sample.id}`,
      assetId: sample.assetId,
      assetName: sample.assetName,
      type: `${metric} threshold exceeded`,
      metric,
      value,
      threshold: metric === "vibration" ? 4 : 65,
      severity: sample.status === "critical" ? "CRITICAL" : "WARNING",
      timestamp: sample.timestamp,
      status: "active",
    }];
  }).slice(-100);
  const latestSamples = dashboardReadings.slice(-24);
  const averageVibration = assets.length
    ? assets.reduce((sum, asset) => sum + asset.value, 0) / assets.length
    : 0;
  const healthyAssets = assets.filter((asset) => asset.state === "nominal").length;
  const attentionAssets = assets.filter((asset) => asset.state !== "nominal").length;

  return {
    summary: {
      plantPulse: averageVibration,
      healthyAssets,
      attentionAssets,
      criticalAssets: assets.filter((asset) => asset.state === "critical").length,
      uptime: "99.9%",
      output: "Live sensor simulation",
    },
    assets,
    feed: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      value: `${asset.value.toFixed(2)} mm/s`,
      status: asset.state === "nominal" ? "Nominal" : asset.state === "critical" ? "Critical" : "Observe",
      detail: `${asset.temp.toFixed(1)}°C · ${asset.rpm} rpm`,
    })),
    watchlist: [],
    history: [],
    reports: [],
    chartData: latestSamples.map((sample) => ({
      name: new Date(sample.timestamp).toLocaleTimeString(),
      value: sample.vibration,
    })),
    readings: dashboardReadings,
    alerts,
    thresholds: { vibration: { warning: 4, critical: 6 }, temperature: { warning: 65, critical: 75 } },
  };
}

function assetsIdFor(code) {
  let hash = 0;
  for (const character of code) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash || 1;
}

async function broadcastDashboard() {
  const snapshot = await dashboardSnapshot();
  io.emit("dashboard:update", snapshot);
}

app.get("/api/health", async (_req, res) => {
  if (!databaseConfigured) {
    res.json({ status: "ok", database: "not configured" });
    return;
  }
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
    res.status(400).json({ success: false, message: "Enter a valid name, email, and password of at least 8 characters" });
    return;
  }
  try {
    if (await findUserByEmail(email)) {
      res.status(409).json({ success: false, message: "User already exists" });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({ name, email, passwordHash });
    res.status(201).json({ success: true, user: publicUser(user), token: createToken(user) });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ success: false, message: "User already exists" });
      return;
    }
    console.error("Registration failed:", error.message);
    res.status(500).json({ success: false, message: "Could not create account" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    const user = email ? await findUserByEmail(email) : null;
    if (!user || !(await bcrypt.compare(password, user.password_hash ?? user.passwordHash))) {
      res.status(401).json({ success: false, message: "Invalid email or password" });
      return;
    }
    res.json({ success: true, user: publicUser(user), token: createToken(user) });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ success: false, message: "Could not sign in" });
  }
});

app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const user = await findUserByEmail(req.user.email);
    if (!user || Number(user.id) !== Number(req.user.id)) {
      res.status(404).json({ success: false, message: "Profile not found" });
      return;
    }
    res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    console.error("Profile lookup failed:", error.message);
    res.status(500).json({ success: false, message: "Could not load profile" });
  }
});

app.patch("/api/profile", authenticate, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: "Enter a valid name and email" });
    return;
  }
  try {
    let user;
    if (databaseConfigured) {
      const result = await pool.query(
        `UPDATE public.users SET name = $1, email = $2
         WHERE id = $3 RETURNING id, name, email`,
        [name, email, req.user.id],
      );
      user = result.rows[0];
    } else {
      user = jsonState.users.find((item) => Number(item.id) === Number(req.user.id));
      if (user) {
        user.name = name;
        user.email = email;
        await persistJsonState();
      }
    }
    if (!user) {
      res.status(404).json({ success: false, message: "Profile not found" });
      return;
    }
    res.json({ success: true, user: publicUser(user), token: createToken(user) });
  } catch (error) {
    if (error.code === "23505") {
      res.status(409).json({ success: false, message: "Email is already in use" });
      return;
    }
    console.error("Profile update failed:", error.message);
    res.status(500).json({ success: false, message: "Could not update profile" });
  }
});

app.get("/api/dashboard/overview", authenticate, async (_req, res) => {
  try {
    const data = await dashboardSnapshot();
    res.json({ success: true, ...data, data });
  } catch (error) {
    console.error("Dashboard snapshot failed:", error.message);
    res.status(500).json({ success: false, message: "Could not load dashboard data" });
  }
});

app.post("/api/dashboard/stream-ticket", authenticate, (_req, res) => {
  const ticket = randomUUID();
  streamTickets.set(ticket, Date.now() + 60_000);
  res.json({ ticket });
});

app.get("/api/dashboard/events", async (req, res) => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  const expiresAt = streamTickets.get(ticket);
  streamTickets.delete(ticket);
  if (!expiresAt || expiresAt < Date.now()) {
    res.status(401).json({ error: "Invalid or expired stream ticket" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const writeSnapshot = async () => {
    try {
      res.write(`data: ${JSON.stringify(await dashboardSnapshot())}\n\n`);
    } catch (error) {
      console.error("Dashboard SSE update failed:", error.message);
    }
  };
  await writeSnapshot();
  const timer = setInterval(writeSnapshot, 2000);
  req.on("close", () => clearInterval(timer));
});

app.get("/api/live-readings", async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20, 1), 200);
    const readings = await readStoredReadings(limit);
    res.json(readings);
  } catch (error) {
    console.error("Failed to fetch readings:", error.message);
    res.status(500).json({ error: "Could not fetch live readings" });
  }
});

app.post("/api/internal/telemetry", async (req, res) => {
  const suppliedToken = Buffer.from(req.get("x-telemetry-token") || "");
  const expectedToken = Buffer.from(telemetryServiceToken);
  const authorized =
    expectedToken.length > 0 &&
    suppliedToken.length === expectedToken.length &&
    timingSafeEqual(suppliedToken, expectedToken);
  if (!authorized) {
    res.status(401).json({ error: "Unauthorized telemetry request" });
    return;
  }
  const assetCode = typeof req.body?.assetCode === "string" ? req.body.assetCode.trim() : "";
  if (!assetCode || assetCode.length > 80) {
    res.status(400).json({ error: "A valid assetCode is required" });
    return;
  }
  try {
    const result = await saveTelemetry({ assetCode, payload: req.body });
    if (!result) {
      res.status(400).json({ error: "Provide at least one valid sensor reading and timestamp" });
      return;
    }
    res.status(202).json({ success: true, saved: result.rowCount });
    void broadcastDashboard().catch((error) => console.error("Dashboard broadcast failed:", error.message));
  } catch (error) {
    console.error("Failed to save telemetry:", error.message);
    res.status(500).json({ error: "Could not save telemetry" });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") throw new Error("Authentication required");
    socket.data.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    next(new Error("Authentication required"));
  }
});

io.on("connection", (socket) => {
  dashboardSnapshot()
    .then((snapshot) => socket.emit("dashboard:update", snapshot))
    .catch((error) => console.error("Initial dashboard update failed:", error.message));
});

async function generateReading() {
  const payload = {
    vibration: Number((1.2 + Math.random() * 2.2).toFixed(2)),
    peakVibration: Number((2.5 + Math.random() * 2.5).toFixed(2)),
    temperature: Number((42 + Math.random() * 17).toFixed(1)),
    rpm: Math.floor(1400 + Math.random() * 500),
    timestamp: new Date().toISOString(),
  };
  const result = await saveTelemetry({ assetCode: "TRB-04", payload, source: "simulated" });
  if (!result) throw new Error("Generated sensor readings were invalid.");
  console.log(
    `[SIMULATED] Saved ${result.rowCount} readings for TRB-04: ` +
    `vibration=${payload.vibration} mm/s, temperature=${payload.temperature}°C, rpm=${payload.rpm}`,
  );
  await broadcastDashboard();
}

async function startServer() {
  try {
    if (databaseConfigured) {
      await pool.query("SELECT 1");
      await initializeDatabase();
      console.log("PostgreSQL connected; user profiles and sensor readings are stored in the database.");
    } else {
      await loadJsonState();
      console.warn("DATABASE_URL is not configured; using the local JSON fallback store.");
    }
    if (databaseConfigured && process.env.SIMULATE_READINGS === "true") {
      await generateReading();
      simulationTimer = setInterval(() => {
        generateReading().catch((error) => console.error("Reading generation failed:", error.message));
      }, 2000);
      console.log("Simulated sensor readings enabled (TRB-04, every 2 seconds).");
    } else {
      console.log("Sensor simulation disabled; awaiting real sensor data.");
    }

    const server = httpServer.listen(PORT, () => {
      console.log(`MotorVibe API ready at http://localhost:${PORT}`);
    });
    server.on("error", (error) => {
      console.error("API listener failed:", error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exitCode = 1;
  }
}

async function shutdown() {
  if (simulationTimer) clearInterval(simulationTimer);
  io.close();
  await new Promise((resolve) => httpServer.close(() => resolve()));
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
startServer();
