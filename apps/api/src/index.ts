import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import health from "./routes/health.js";
import { createDeploymentsRouter } from "./routes/deployments.js";

const db = getDb();
runMigrations(db);

const app = new Hono();

app.route("/health", health);
app.route("/deployments", createDeploymentsRouter(db));

const PORT = Number(process.env["PORT"] ?? 8088);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`API listening on port ${PORT}`);
});
