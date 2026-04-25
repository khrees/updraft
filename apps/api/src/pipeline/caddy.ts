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

      // Insert before the frontend catch-all using its @id anchor.
      // "PUT /id/<id>" replaces the route if it already exists (idempotent).
      const existingId = `dep-${deploymentId}`;
      const putUrl = `${adminUrl}/id/${existingId}`;

      // Try PUT first (update if exists)
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(route),
      });

      if (putRes.ok) return;

      // Route doesn't exist yet — POST to insert into the routes array
      // Insert at index 1 (after the api-route, before the frontend catch-all)
      const postUrl = `${adminUrl}/config/apps/http/servers/updraft/routes/1`;
      const postRes = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(route),
      });

      if (!postRes.ok) {
        const body = await postRes.text().catch(() => '');
        throw new Error(`Caddy admin API error ${postRes.status}: ${body}`);
      }
    },
  };
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
