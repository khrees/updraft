import type Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import type {
  BuildMethod,
  DeploymentBuild,
  Deployment,
  DeploymentLogEvent,
  DeploymentSourceType,
  DeploymentStatus,
  LogStage,
} from '@updraft/shared-types';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz', 21);

type DeploymentRow = {
  id: string;
  source_type: string;
  source_ref: string;
  status: string;
  requested_image_tag: string | null;
  image_tag: string | null;
  container_id: string | null;
  container_name: string | null;
  internal_port: number | null;
  route_path: string | null;
  live_url: string | null;
  created_at: string;
  updated_at: string;
};

type DeploymentLogRow = {
  id: string;
  deployment_id: string;
  stage: string;
  message: string;
  timestamp: string;
  sequence: number;
};

type DeploymentBuildRow = {
  id: string;
  source_type: string;
  source_ref: string;
  image_tag: string;
  build_method: string;
  created_by_deployment_id: string;
  created_at: string;
};

function rowToDeployment(row: DeploymentRow): Deployment {
  const d: Deployment = {
    id: row.id,
    source_type: row.source_type as DeploymentSourceType,
    source_ref: row.source_ref,
    status: row.status as DeploymentStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.requested_image_tag !== null) d.requested_image_tag = row.requested_image_tag;
  if (row.image_tag !== null) d.image_tag = row.image_tag;
  if (row.container_id !== null) d.container_id = row.container_id;
  if (row.container_name !== null) d.container_name = row.container_name;
  if (row.internal_port !== null) d.internal_port = row.internal_port;
  if (row.route_path !== null) d.route_path = row.route_path;
  if (row.live_url !== null) d.live_url = row.live_url;
  return d;
}

function rowToLogEvent(row: DeploymentLogRow): DeploymentLogEvent {
  return {
    id: row.id,
    deployment_id: row.deployment_id,
    stage: row.stage as LogStage,
    message: row.message,
    timestamp: row.timestamp,
    sequence: row.sequence,
  };
}

function rowToDeploymentBuild(row: DeploymentBuildRow): DeploymentBuild {
  return {
    id: row.id,
    source_type: row.source_type as DeploymentSourceType,
    source_ref: row.source_ref,
    image_tag: row.image_tag,
    build_method: row.build_method as BuildMethod,
    created_by_deployment_id: row.created_by_deployment_id,
    created_at: row.created_at,
  };
}

// Deployment lifecycle: pending -> building -> deploying -> running.
// Any non-terminal state may transition to failed or cancelled. running/failed/cancelled are terminal.
const ALLOWED_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  pending: ['building', 'failed', 'cancelled'],
  building: ['deploying', 'failed', 'cancelled'],
  deploying: ['running', 'failed', 'cancelled'],
  running: [],
  failed: [],
  cancelled: [],
};

export function isValidStatusTransition(
  from: DeploymentStatus,
  to: DeploymentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Invalid deployment status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class DeploymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Deployment not found: ${id}`);
    this.name = 'DeploymentNotFoundError';
  }
}

export interface CreateDeploymentInput {
  source_type: DeploymentSourceType;
  source_ref: string;
  requested_image_tag?: string;
}

export interface UpdateDeploymentInput {
  image_tag?: string;
  container_id?: string;
  container_name?: string;
  internal_port?: number;
  route_path?: string;
  live_url?: string;
}

export function createDeploymentRepository(db: Database.Database) {
  return {
    create(input: CreateDeploymentInput): Deployment {
      const now = new Date().toISOString();
      const id = nanoid();
      db.prepare(
        `INSERT INTO deployments (id, source_type, source_ref, status, requested_image_tag, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(id, input.source_type, input.source_ref, input.requested_image_tag ?? null, now, now);
      return {
        id,
        source_type: input.source_type,
        source_ref: input.source_ref,
        status: 'pending',
        ...(input.requested_image_tag ? { requested_image_tag: input.requested_image_tag } : {}),
        created_at: now,
        updated_at: now,
      };
    },

    getById(id: string): Deployment | null {
      const row = db
        .prepare(`SELECT * FROM deployments WHERE id = ?`)
        .get(id) as DeploymentRow | undefined;
      return row ? rowToDeployment(row) : null;
    },

    list(): Deployment[] {
      const rows = db
        .prepare(`SELECT * FROM deployments ORDER BY created_at DESC`)
        .all() as DeploymentRow[];
      return rows.map(rowToDeployment);
    },

    claim(): Deployment | null {
      const row = db
        .prepare(
          `UPDATE deployments SET status = 'building', updated_at = ?
           WHERE id = (SELECT id FROM deployments WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1)
           RETURNING *`,
        )
        .get(new Date().toISOString()) as DeploymentRow | undefined;
      return row ? rowToDeployment(row) : null;
    },

    claimById(id: string): Deployment | null {
      const row = db
        .prepare(
          `UPDATE deployments SET status = 'building', updated_at = ?
           WHERE id = ? AND status = 'pending'
           RETURNING *`,
        )
        .get(new Date().toISOString(), id) as DeploymentRow | undefined;
      return row ? rowToDeployment(row) : null;
    },

    updateStatus(id: string, next: DeploymentStatus): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      if (!isValidStatusTransition(current.status, next)) {
        throw new InvalidStatusTransitionError(current.status, next);
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE deployments SET status = ?, updated_at = ? WHERE id = ?`,
      ).run(next, now, id);
      return { ...current, status: next, updated_at: now };
    },

    updateStatusWithLog(
      id: string,
      next: DeploymentStatus,
      logStage: LogStage,
      logMessage: string,
    ): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      if (!isValidStatusTransition(current.status, next)) {
        throw new InvalidStatusTransitionError(current.status, next);
      }
      const now = new Date().toISOString();
      const run = db.transaction(() => {
        db.prepare(
          `UPDATE deployments SET status = ?, updated_at = ? WHERE id = ?`,
        ).run(next, now, id);
        const seqRow = db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM deployment_logs WHERE deployment_id = ?`,
          )
          .get(id) as { next: number };
        const seq = seqRow.next;
        db.prepare(
          `INSERT INTO deployment_logs (id, deployment_id, stage, message, timestamp, sequence)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(nanoid(), id, logStage, logMessage, now, seq);
      });
      run();
      return { ...current, status: next, updated_at: now };
    },

    updateFields(id: string, fields: UpdateDeploymentInput): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return current;
      const now = new Date().toISOString();
      const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
      const values = entries.map(([, v]) => v as string | number);
      db.prepare(
        `UPDATE deployments SET ${setClause}, updated_at = ? WHERE id = ?`,
      ).run(...values, now, id);
      return this.getById(id)!;
    },
  };
}

export function createLogRepository(db: Database.Database) {
  const selectNextSeq = db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM deployment_logs WHERE deployment_id = ?`,
  );
  const insertLog = db.prepare(
    `INSERT INTO deployment_logs (id, deployment_id, stage, message, timestamp, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Atomic MAX+INSERT so concurrent appends can't produce duplicate sequences.
  // The UNIQUE(deployment_id, sequence) constraint is the final safety net.
  const appendTxn = db.transaction(
    (deployment_id: string, stage: LogStage, message: string, id: string, timestamp: string): number => {
      const { next } = selectNextSeq.get(deployment_id) as { next: number };
      insertLog.run(id, deployment_id, stage, message, timestamp, next);
      return next;
    },
  );

  return {
    append(input: {
      deployment_id: string;
      stage: LogStage;
      message: string;
    }): DeploymentLogEvent {
      const id = nanoid();
      const timestamp = new Date().toISOString();
      const sequence = appendTxn(input.deployment_id, input.stage, input.message, id, timestamp);
      return {
        id,
        deployment_id: input.deployment_id,
        stage: input.stage,
        message: input.message,
        timestamp,
        sequence,
      };
    },

    listByDeployment(
      deployment_id: string,
      opts: { afterSequence?: number } = {},
    ): DeploymentLogEvent[] {
      const after = opts.afterSequence ?? 0;
      const rows = db
        .prepare(
          `SELECT * FROM deployment_logs
           WHERE deployment_id = ? AND sequence > ?
           ORDER BY sequence ASC`,
        )
        .all(deployment_id, after) as DeploymentLogRow[];
      return rows.map(rowToLogEvent);
    },
  };
}

export interface RecordBuildInput {
  source_type: DeploymentSourceType;
  source_ref: string;
  image_tag: string;
  build_method: BuildMethod;
  created_by_deployment_id: string;
}

export function createBuildRepository(db: Database.Database) {
  return {
    record(input: RecordBuildInput): DeploymentBuild {
      const existing = db.prepare(
        `SELECT * FROM deployment_builds
         WHERE source_type = ? AND source_ref = ? AND image_tag = ?`,
      ).get(input.source_type, input.source_ref, input.image_tag) as DeploymentBuildRow | undefined;
      if (existing) return rowToDeploymentBuild(existing);

      const id = nanoid();
      const created_at = new Date().toISOString();
      db.prepare(
        `INSERT INTO deployment_builds (
          id, source_type, source_ref, image_tag, build_method, created_by_deployment_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.source_type,
        input.source_ref,
        input.image_tag,
        input.build_method,
        input.created_by_deployment_id,
        created_at,
      );
      return {
        id,
        source_type: input.source_type,
        source_ref: input.source_ref,
        image_tag: input.image_tag,
        build_method: input.build_method,
        created_by_deployment_id: input.created_by_deployment_id,
        created_at,
      };
    },

    listForSource(source_type: DeploymentSourceType, source_ref: string): DeploymentBuild[] {
      const rows = db.prepare(
        `SELECT * FROM deployment_builds
         WHERE source_type = ? AND source_ref = ?
         ORDER BY created_at DESC`,
      ).all(source_type, source_ref) as DeploymentBuildRow[];
      return rows.map(rowToDeploymentBuild);
    },

    hasForSourceImage(source_type: DeploymentSourceType, source_ref: string, image_tag: string): boolean {
      const row = db.prepare(
        `SELECT 1 AS found FROM deployment_builds
         WHERE source_type = ? AND source_ref = ? AND image_tag = ?
         LIMIT 1`,
      ).get(source_type, source_ref, image_tag) as { found: number } | undefined;
      return !!row;
    },
  };
}

export type DeploymentRepository = ReturnType<typeof createDeploymentRepository>;
export type LogRepository = ReturnType<typeof createLogRepository>;
export type BuildRepository = ReturnType<typeof createBuildRepository>;
