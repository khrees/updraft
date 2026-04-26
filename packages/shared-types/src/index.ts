// Deployment status state machine
export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'cancelled';

export const TERMINAL_DEPLOYMENT_STATUSES = ['running', 'failed', 'cancelled'] as const satisfies readonly DeploymentStatus[];

export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly DeploymentStatus[]).includes(status);
}

// Source type for deployments
export type DeploymentSourceType = 'git' | 'upload';

// Log event stage
export type LogStage = 'build' | 'deploy' | 'system';

// Core Deployment resource
export interface Deployment {
  id: string;
  source_type: DeploymentSourceType;
  source_ref: string;
  status: DeploymentStatus;
  requested_image_tag?: string;
  image_tag?: string;
  container_id?: string;
  container_name?: string;
  internal_port?: number;
  route_path?: string;
  live_url?: string;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

// Deployment log event
export interface DeploymentLogEvent {
  id: string;
  deployment_id: string;
  stage: LogStage;
  message: string;
  timestamp: string; // ISO 8601
  sequence: number;
}

export type BuildMethod = 'railpack' | 'reused';

export interface DeploymentBuild {
  id: string;
  source_type: DeploymentSourceType;
  source_ref: string;
  image_tag: string;
  build_method: BuildMethod;
  created_by_deployment_id: string;
  created_at: string;
}

// API Request/Response types
export interface CreateDeploymentRequest {
  git_url?: string;
}

export interface CreateDeploymentResponse {
  deployment: Deployment;
}

export interface ListDeploymentsResponse {
  deployments: Deployment[];
}

export interface GetDeploymentResponse {
  deployment: Deployment;
}

export interface StreamLogsResponse {
  events: DeploymentLogEvent[];
}

// SSE Log Event for streaming
export interface SSELogEvent {
  type: 'log';
  data: DeploymentLogEvent;
}

export interface SSEStatusEvent {
  type: 'status';
  data: {
    deployment_id: string;
    status: DeploymentStatus;
  };
}

export type SSEMessage = SSELogEvent | SSEStatusEvent;
