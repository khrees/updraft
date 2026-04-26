import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id          TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('git', 'upload')),
      source_ref  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','building','deploying','running','failed','cancelled')),
      requested_image_tag TEXT,
      image_tag   TEXT,
      container_id TEXT,
      container_name TEXT,
      internal_port INTEGER,
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
      sequence      INTEGER NOT NULL,
      UNIQUE(deployment_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment
      ON deployment_logs(deployment_id, sequence);

    CREATE TABLE IF NOT EXISTS deployment_builds (
      id            TEXT PRIMARY KEY,
      source_type   TEXT NOT NULL CHECK(source_type IN ('git', 'upload')),
      source_ref    TEXT NOT NULL,
      image_tag     TEXT NOT NULL,
      build_method  TEXT NOT NULL CHECK(build_method IN ('railpack', 'reused')),
      created_by_deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL,
      UNIQUE(source_type, source_ref, image_tag)
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_builds_source
      ON deployment_builds(source_type, source_ref, created_at DESC);
  `);

  const columns = db
    .prepare(`PRAGMA table_info(deployments)`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'requested_image_tag')) {
    db.exec(`ALTER TABLE deployments ADD COLUMN requested_image_tag TEXT`);
  }
}
