import type { SSEMessage } from '@updraft/shared-types';

type Subscriber = (msg: SSEMessage) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(deploymentId: string, fn: Subscriber): () => void {
  if (!subscribers.has(deploymentId)) subscribers.set(deploymentId, new Set());
  subscribers.get(deploymentId)!.add(fn);
  return () => {
    subscribers.get(deploymentId)?.delete(fn);
    if (subscribers.get(deploymentId)?.size === 0) subscribers.delete(deploymentId);
  };
}

export function publish(deploymentId: string, msg: SSEMessage): void {
  subscribers.get(deploymentId)?.forEach((fn) => fn(msg));
}
