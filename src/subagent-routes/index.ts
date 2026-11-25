/**
 * Registration of the route card's one exact Fetch route.
 *
 * The seam is `ctx.connection.fetch.register`, deliberately NOT a raw
 * `ctx.webServer.register` route: a raw route is dispatched with no admission at
 * all (`packages/host/webserver/src/index.ts:527-542`), so it would be reachable
 * by a bare `curl` through the deployment's tunnel. The exact Fetch route is
 * mounted on the shared `/api` channel, whose handler runs only after
 * `connection.admit()` produced a Peer, and whose exact routes are owner-only
 * (`packages/client/connection/src/rpc-host.ts:219-223`).
 *
 * One path, two declared methods. `WebServer.register` keys registrations by
 * `(kind, path)` and has no method field, so a second registration for the other
 * verb cannot exist; declaring `['GET', 'POST']` is the only shape that works.
 * Any other verb is left to the connection service, which is why the handler
 * synthesizes no `405`.
 *
 * `ctx.inject` rather than a declared `inject` entry: on a headless composition
 * the `connection` service never resolves, the callback never runs, nothing is
 * registered, and the card receives the channel's ordinary `404` and renders its
 * unavailable state. Putting `connection` on the plugin's own `inject` list would
 * instead hold the whole plugin — agents, rules, commands, MCP — hostage to one
 * optional service.
 *
 * @module dsh-project-context/subagent-routes
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares the `connection` member and the `ConnectionFetchRoute`
// shape. Nothing of that package is imported at run time.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RouteContext } from './service.ts'
import { handleSubagentRoutes, SUBAGENT_ROUTES_PATH } from './service.ts'

export type { AgentRouteView, RouteContext } from './service.ts'
export { APPLIES_TO, MAX_REQUEST_BODY_BYTES, SUBAGENT_ROUTES_PATH } from './service.ts'

/**
 * Mount the card's exact Fetch route on the authenticated `/api` channel.
 * @param ctx - the plugin context the registration is owned by.
 * @param routeContext - the lazily-resolved services one request needs.
 */
export function mountSubagentRoutes(ctx: Context, routeContext: RouteContext): void {
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      connectionCtx.connection.fetch.register({
        path: SUBAGENT_ROUTES_PATH,
        methods: ['GET', 'POST'],
        // Buffered, not streaming: the body is one small JSON document and the
        // channel's own JSON cap then bounds it before this plugin's 8 KiB check
        // ever runs.
        requestBody: 'buffered',
        fetch: request => handleSubagentRoutes(request, routeContext),
      })
    } catch (error: unknown) {
      // `register` throws on a duplicate path, which a plugin reload or an HMR
      // re-mount can produce. Soft-fail: the card then renders its 404 state and
      // the rest of the plugin keeps working.
      ctx.logger.warn(
        `dsh-project-context: registering ${SUBAGENT_ROUTES_PATH} failed (another registration may already own it): ${String(error)}`,
      )
    }
  })
}
