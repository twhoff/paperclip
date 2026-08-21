import { Pool } from "pg";

/**
 * Read-only connection pool for the pcli operational database.
 *
 * The pcli tables (pcli_optimiser_decisions, pcli_optimiser_evaluations, etc.)
 * live in a separate Postgres instance from the tizzi app database.
 * Connection is configured via the same env vars that pcli itself uses.
 */
const pcliPool = new Pool({
  host: process.env.PAPERCLIP_DB_HOST ?? "127.0.0.1",
  port: parseInt(process.env.PAPERCLIP_DB_PORT ?? "54329", 10),
  database: process.env.PAPERCLIP_DB_NAME ?? "paperclip",
  user: process.env.PGUSER ?? "paperclip",
  password: process.env.PGPASSWORD ?? "paperclip",
  max: 5,
  idleTimeoutMillis: 30_000,
});

export { pcliPool };
