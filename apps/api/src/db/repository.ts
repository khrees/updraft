import type Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import type {
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
  image_tag: string | null;
  container_id: string | null;
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

function rowToDeployment(row: DeploymentRow): Deployment {
  const d: Deployment = {
    id: row.id,
    source_type: row.source_type as DeploymentSourceType,
    source_ref: row.source_ref,
    status: row.status as DeploymentStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.image_tag !== null) d.image_tag = row.image_tag;
  if (row.container_id !== null) d.container_id = row.container_id;
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

// Deployment lifecycle: pending -> building -> deploying -> live.
// Any non-terminal state may transition to failed or cancelled. live/failed/cancelled are terminal.
const ALLOWED_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  pending: ['building', 'failed', 'cancelled'],
  building: ['deploying', 'failed', 'cancelled'],
  deploying: ['live', 'failed', 'cancelled'],
  live: [],
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
}

export interface UpdateDeploymentInput {
  image_tag?: string;
  container_id?: string;
  route_path?: string;
  live_url?: string;
}

export function createDeploymentRepository(db: Database.Database) {
  return {
    create(input: CreateDeploymentInput): Deployment {
      const now = new Date().toISOString();
      const id = nanoid();
      db.prepare(
        `INSERT INTO deployments (id, source_type, source_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(id, input.source_type, input.source_ref, now, now);
      return {
        id,
        source_type: input.source_type,
        source_ref: input.source_ref,
        status: 'pending',
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
      const values = entries.map(([, v]) => v as string);
      db.prepare(
        `UPDATE deployments SET ${setClause}, updated_at = ? WHERE id = ?`,
      ).run(...values, now, id);
      return this.getById(id)!;
    },
  };
}

export function createLogRepository(db: Database.Database) {
  return {
    append(input: {
      deployment_id: string;
      stage: LogStage;
      message: string;
    }): DeploymentLogEvent {
      const id = nanoid();
      const timestamp = new Date().toISOString();
      // MAX(sequence) + 1 scoped per deployment; COALESCE handles the empty case (gives 1).
      const seqRow = db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM deployment_logs WHERE deployment_id = ?`,
        )
        .get(input.deployment_id) as { next: number };
      const sequence = seqRow.next;
      db.prepare(
        `INSERT INTO deployment_logs (id, deployment_id, stage, message, timestamp, sequence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.deployment_id, input.stage, input.message, timestamp, sequence);
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

export type DeploymentRepository = ReturnType<typeof createDeploymentRepository>;
export type LogRepository = ReturnType<typeof createLogRepository>;
