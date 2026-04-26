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

      // Route doesn't exist yet — PUT to insert at index 1 so it sits
      // between the /api/* route and the frontend /* catch-all. (POST on
      // an array path appends, which would put it after the catch-all and
      // never match.)
      const insertUrl = `${adminUrl}/config/apps/http/servers/updraft/routes/1`;
      const insertRes = await fetch(insertUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(route),
      });

      if (!insertRes.ok) {
        const body = await insertRes.text().catch(() => '');
        throw new Error(`Caddy admin API error ${insertRes.status}: ${body}`);
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
