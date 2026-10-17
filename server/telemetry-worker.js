import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mqtt from 'mqtt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const brokerUrl = process.env.MQTT_URL;
const serviceToken = process.env.TELEMETRY_SERVICE_TOKEN;
const apiUrl = `${process.env.API_INTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`}/api/internal/telemetry`;
const topic = process.env.MQTT_TOPIC || 'motorvibe/+/telemetry';

if (!brokerUrl || !serviceToken) {
  throw new Error('Telemetry worker requires MQTT_URL and TELEMETRY_SERVICE_TOKEN.');
}

const client = mqtt.connect(brokerUrl, { reconnectPeriod: 5000 });

client.on('connect', () => {
  client.subscribe(topic, { qos: 1 }, (error) => {
    if (error) {
      console.error('MQTT subscription failed:', error.code || error.message);
      return;
    }
    console.log(`Telemetry worker subscribed to ${topic}`);
  });
});

client.on('message', async (receivedTopic, message) => {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch {
    console.warn('Dropped MQTT message with invalid JSON.');
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn('Dropped MQTT message with invalid payload shape.');
    return;
  }

  const topicAssetCode = receivedTopic.split('/').at(-2);
  const telemetry = {
    ...payload,
    assetCode: typeof payload.assetCode === 'string' ? payload.assetCode : topicAssetCode,
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telemetry-token': serviceToken,
      },
      body: JSON.stringify(telemetry),
    });

    if (!response.ok) {
      console.error(`Telemetry API rejected message with HTTP ${response.status}.`);
    }
  } catch (error) {
    console.error('Could not forward MQTT telemetry:', error.code || error.message);
  }
});

client.on('error', (error) => {
  console.error('MQTT worker error:', error.code || error.message);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    client.end(false, {}, () => process.exit(0));
  });
}
