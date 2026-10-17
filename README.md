# MotorVibe Capstone

MotorVibe is a responsive industrial equipment monitoring dashboard built with React, TypeScript, Vite, and Express. It combines authenticated REST APIs, PostgreSQL user storage, simulated or MQTT sensor readings, time-series charts, history, and reports.

## Course outcomes covered

| Outcome | Project implementation |
| --- | --- |
| CO1 — HTML/CSS and responsive accessible pages | Semantic React markup, CSS Grid/Flexbox layouts, labeled controls, and responsive breakpoints in `src/App.tsx`, `src/App.css`, and `src/index.css`. |
| CO2 — JavaScript/TypeScript and async patterns | Typed React components, event handlers, hooks, `async`/`await`, fetch, and error handling in `src/App.tsx`. |
| CO3 — React, state, and charts | Component state with React hooks and Recharts time-series/summary charts in the dashboard. |
| CO4 — Node.js, Express, REST, middleware | Auth and dashboard routes, JSON parsing, CORS, JWT middleware, and API error responses in `server/index.js`. |
| CO5 — Realtime and IoT data | JWT-authenticated Socket.IO and one-time-ticket SSE streams; an MQTT ingestion worker validates telemetry and forwards it to the API for live dashboard updates. |
| CO6 — Enterprise architecture and deployment | Bcrypt password hashing, JWT and service-token authentication, separate web/API/telemetry/PostgreSQL/MQTT services, Docker Compose deployment, health checks, and environment-based configuration. |

The deployable components are separated by service boundary. The Express API remains a modular service (authentication and dashboard routes share the process); it is not presented as several independently deployed business microservices.

## Run locally

Requirements: Node.js 20 or newer and npm. Set `DATABASE_URL` and a strong `JWT_SECRET` in `server/.env` to use PostgreSQL. The API loads that file at startup, verifies its PostgreSQL connection before serving, and reports connection status at `/api/health`. User profiles created through registration are stored in PostgreSQL's `users` table; existing JSON profiles are imported if the table is empty. If no `DATABASE_URL` is present, the API uses the local JSON user store.

```powershell
npm install
npm run dev
```

The Vite client runs at `http://localhost:5173`. The API uses `PORT` from `server/.env` (or defaults to `5000`), and Vite reads the same port to proxy API and Socket.IO traffic. For separately hosted frontend and API deployments, set `VITE_API_URL` in the frontend build environment to the API origin (for example `https://api.example.com`) and set `CLIENT_ORIGIN` in `server/.env` to the frontend website origin (for example `https://dashboard.example.com`). `CLIENT_ORIGIN` accepts comma-separated HTTP(S) origins without paths; trailing slashes are normalized. Production requests are restricted to configured website origins, while development also permits localhost origins. The dashboard uses Socket.IO when connected, falls back to ticket-authenticated SSE, and continues with REST polling if both realtime transports are unavailable.

Run checks:

```powershell
npm test
npm run lint
npm run build
```

## Realtime and MQTT

Socket.IO clients authenticate using the signed-in user's JWT. The alternative SSE endpoint uses short-lived, single-use tickets created with `POST /api/dashboard/stream-ticket` (Bearer token), then consumed by `GET /api/dashboard/events?ticket=...`.

Set `SIMULATE_READINGS=true` in `server/.env` to generate sample Turbine 04 readings every two seconds. The API stores each sample in PostgreSQL and pushes updates to the dashboard over Socket.IO (or SSE); the Live feed labels these values as simulated. Set it to `false` to stop generating sample data. Sensor measurements are stored in PostgreSQL in `public.live_readings` as one row per metric (`sensor_name`, `reading`, `unit`, `source`, and `recorded_at`). The API creates or upgrades this table at startup. Use `GET /api/live-readings?limit=20` to inspect recent records, or run this query in pgAdmin/psql:

```sql
SELECT id, sensor_name, reading, unit, source, recorded_at
FROM public.live_readings
ORDER BY recorded_at DESC, id DESC
LIMIT 50;
```

For MQTT ingestion, set `MQTT_URL`, `TELEMETRY_SERVICE_TOKEN`, and optionally `MQTT_TOPIC` in `server/.env`. Use the same unique token for the API and worker. The default topic filter is `motorvibe/+/telemetry`. A topic uses the asset code in its second-to-last segment, for example `motorvibe/TRB-04/telemetry`. Publish a JSON payload such as:

```json
{
  "vibration": 3.2,
  "peakVibration": 4.1,
  "temperature": 59,
  "rpm": 1680,
  "timestamp": "2026-10-17T08:00:00.000Z"
}
```

`assetCode` may also be included in the payload. The worker forwards the values to the service-token-protected `POST /api/internal/telemetry` endpoint, which records each supplied vibration, peak vibration, temperature, and RPM value in PostgreSQL. In Docker Compose, a dedicated telemetry worker subscribes to MQTT and sends readings to the API. The included Mosquitto config allows anonymous connections only on a loopback-bound local port for demo use. Use broker authentication and TLS for a networked or production deployment.

## Deploy with Docker Compose

Docker Desktop (or Docker Engine with Compose) is required. Create a root `.env` file from the template, replace the placeholders with unique secrets, then start the services:

```powershell
Copy-Item .env.example .env
# Edit .env and set strong POSTGRES_PASSWORD, JWT_SECRET, and TELEMETRY_SERVICE_TOKEN values.
docker compose up --build
```

Open `http://localhost:8080`. Compose starts PostgreSQL, Mosquitto, the Express API, the independent MQTT telemetry worker, and an Nginx-served React client. PostgreSQL data is kept in a named volume. Do not commit `.env`; `.gitignore` excludes it.

## Demo login

- Email: `admin@motorvibe.com`
- Password: `password123`

The demo account is seeded when the configured database has no users. Do not use demo credentials or fallback secrets in a deployed environment.
