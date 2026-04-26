import type { Deployment, DeploymentBuild, DeploymentLogEvent } from '@updraft/shared-types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

type ApiEnvelope<T> = {
  success: boolean;
  message: string;
  data: T;
};

type CreateDeploymentInput =
  | { mode: 'git'; gitUrl: string }
  | { mode: 'upload'; archive: Blob; filename: string };

export async function listDeployments(): Promise<Deployment[]> {
  const response = await fetch(`${API_BASE_URL}/deployments`);
  const payload = (await response.json()) as ApiEnvelope<Deployment[]>;

  if (!response.ok || !payload.success) {
    throw new Error(payload.message || 'Failed to load deployments');
  }

  return payload.data;
}

export async function createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
  const response = await fetch(`${API_BASE_URL}/deployments`, {
    method: 'POST',
    headers: input.mode === 'git' ? { 'content-type': 'application/json' } : undefined,
    body: input.mode === 'git'
      ? JSON.stringify({ git_url: input.gitUrl })
      : (() => {
          const formData = new FormData();
          formData.set('archive', input.archive, input.filename);
          return formData;
        })(),
  });

  const payload = (await response.json()) as ApiEnvelope<Deployment>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || 'Failed to create deployment');
  }

  return payload.data;
}

export async function listDeploymentBuilds(deploymentId: string): Promise<DeploymentBuild[]> {
  const response = await fetch(`${API_BASE_URL}/deployments/${deploymentId}/builds`);
  const payload = (await response.json()) as ApiEnvelope<DeploymentBuild[]>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || 'Failed to load deployment builds');
  }
  return payload.data;
}

export async function redeployDeployment(
  deploymentId: string,
  imageTag: string,
  action: 'redeploy' | 'rollback' = 'redeploy',
): Promise<Deployment> {
  const response = await fetch(`${API_BASE_URL}/deployments/${deploymentId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_tag: imageTag }),
  });
  const payload = (await response.json()) as ApiEnvelope<Deployment>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || `Failed to ${action}`);
  }
  return payload.data;
}

export function streamDeploymentLogs(
  deploymentId: string,
  afterSequence: number,
  handlers: {
    onLog: (event: DeploymentLogEvent) => void;
    onStatus: (status: string) => void;
    onDone: (status: string) => void;
    onError: () => void;
    onOpen: () => void;
  },
): () => void {
  const url = `${API_BASE_URL}/deployments/${deploymentId}/logs/stream${afterSequence > 0 ? `?afterSequence=${afterSequence}` : ''}`;
  const es = new EventSource(url);

  es.onopen = () => handlers.onOpen();
  es.onerror = () => { handlers.onError(); es.close(); };

  es.addEventListener('log', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as DeploymentLogEvent;
    handlers.onLog(data);
  });
  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as { deployment_id: string; status: string };
    handlers.onStatus(data.status);
  });
  es.addEventListener('done', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as { status: string };
    handlers.onDone(data.status);
    es.close();
  });

  return () => es.close();
}
