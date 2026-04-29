export interface CaddyRouteRegistrarDeps {
  adminUrl?: string;
}

export interface RegisterRouteInput {
  deploymentId: string;
  containerName: string;
  internalPort: number;
}

export interface RouteRegistrar {
  register(input: RegisterRouteInput): Promise<void>;
  unregister(deploymentId: string): Promise<void>;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Caddy admin API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function getConfig(adminUrl: string): Promise<Record<string, unknown>> {
  return (await fetchJson(`${adminUrl}/config`) as { [key: string]: unknown });
}

async function putConfig(adminUrl: string, path: string, body: unknown): Promise<void> {
  await fetchJson(`${adminUrl}/config/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildRoute(deploymentId: string, containerName: string, internalPort: number) {
  const pathPrefix = `/d/${deploymentId}`;
  return {
    '@id': `dep-${deploymentId}`,
    match: [{ path: [`${pathPrefix}`, `${pathPrefix}/*`] }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: [
              {
                handler: 'rewrite',
                strip_path_prefix: pathPrefix,
              },
              {
                handler: 'reverse_proxy',
                upstreams: [{ dial: `${containerName}:${internalPort}` }],
              },
            ],
          },
        ],
      },
    ],
  };
}

export function createCaddyRouteRegistrar(deps: CaddyRouteRegistrarDeps = {}): RouteRegistrar {
  const adminUrl = (
    deps.adminUrl ??
    process.env['CADDY_ADMIN_URL'] ??
    'http://caddy:2019'
  ).replace(/\/+$/, '');

  return {
    async register({ deploymentId, containerName, internalPort }) {
      const route = buildRoute(deploymentId, containerName, internalPort);
      const routeId = `dep-${deploymentId}`;

      // Delete any existing route with this ID first (idempotent — 404 is fine).
      await fetch(`${adminUrl}/id/${routeId}`, { method: 'DELETE' }).catch(() => {});

      // Find the catch-all route index dynamically by looking for a match-all route
      // (path "/*" with no @id, or @id="frontend-route"). We insert before it so
      // deployment routes always take precedence over the frontend catch-all.
      const config = await getConfig(adminUrl);
      const routes: unknown[] = (
        config?.apps as { http?: { servers?: { updraft?: { routes?: unknown[] } } } }
      )?.http?.servers?.updraft?.routes ?? [];

      let insertIndex = routes.length; // default: append at end
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i] as Record<string, unknown>;
        const m = r?.match as Record<string, unknown>[] | undefined;
        const hasWildcardPath = m?.some?.(
          (match) => Array.isArray((match as Record<string, unknown>)?.path) &&
            ((match as Record<string, unknown>)?.path as string[])?.includes?.('/*'),
        );
        const isFrontendRoute = r?.['@id'] === 'frontend-route';
        if (hasWildcardPath && !r?.['@id']) {
          insertIndex = i;
          break;
        }
        if (isFrontendRoute) {
          insertIndex = i;
          break;
        }
      }

      await putConfig(
        adminUrl,
        `apps/http/servers/updraft/routes/${insertIndex}`,
        route,
      );
    },

    async unregister(deploymentId: string) {
      const routeId = `dep-${deploymentId}`;
      // Delete from Caddy's in-memory config. Idempotent — 404 if already gone.
      await fetch(`${adminUrl}/id/${routeId}`, { method: 'DELETE' }).catch(() => {});
    },
  };
}
