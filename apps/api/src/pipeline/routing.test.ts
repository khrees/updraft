import { describe, expect, it } from 'vitest';
import { createPathRouteAssigner } from './routing.js';
import type { Deployment } from '@updraft/shared-types';

const deployment: Deployment = {
  id: 'abc123',
  source_type: 'git',
  source_ref: 'https://example.com/r.git',
  status: 'deploying',
  container_name: 'dep-abc123',
  internal_port: 3000,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

describe('path route assigner', () => {
  it('builds a path-based live url from the configured base', () => {
    const assigner = createPathRouteAssigner({ publicBaseUrl: 'http://localhost:8081' });
    const { route_path, live_url } = assigner.assign({ deployment });
    expect(route_path).toBe('/d/abc123');
    expect(live_url).toBe('http://localhost:8081/d/abc123');
  });

  it('strips trailing slashes from the base url', () => {
    const assigner = createPathRouteAssigner({ publicBaseUrl: 'http://example.com///' });
    expect(assigner.assign({ deployment }).live_url).toBe('http://example.com/d/abc123');
  });

  it('requires runtime metadata from the deploy step', () => {
    const assigner = createPathRouteAssigner({ publicBaseUrl: 'http://example.com' });
    expect(() => assigner.assign({
      deployment: { ...deployment, container_name: undefined, internal_port: undefined },
    })).toThrow(/container_name and internal_port/);
  });
});
