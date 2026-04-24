import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id          TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('git', 'upload')),
      source_ref  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','building','deploying','live','failed','cancelled')),
      image_tag   TEXT,
      container_id TEXT,
      route_path  TEXT,
      live_url    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployment_logs (
      id            TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      stage         TEXT NOT NULL CHECK(stage IN ('build','deploy','system')),
      message       TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      sequence      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment
      ON deployment_logs(deployment_id, sequence);
  `);
}
