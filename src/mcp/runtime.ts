/**
 * Live mounting of MCP servers through `@deepseek-ai/dsh-mcp-client`.
 *
 * The MCP client exposes no service, no registry and no lifecycle event, so
 * `ctx.plugin(McpClient, config)` is the ONLY way to add a server, and
 * disposing the returned fiber is the only way to remove one. Both are
 * effect-scoped, which is what makes enable, disable, add, edit and remove
 * live operations with no host restart and no file write.
 *
 * Each server is mounted on THIS plugin's own context, never in a scope of its
 * own: `mcp-client` registers every tool through the context it was mounted
 * on, and a scoped registration lands in a layer that only that scope and its
 * descendants can see. These servers are the deployment's, so every Agent must
 * see their tools — the global layer, exactly where a `cordis.yml` Loader entry
 * mounting `@deepseek-ai/dsh-mcp-client` lands. One fiber per server keeps
 * eviction independent and one server's failure contained.
 *
 * @module dsh-project-context/mcp/runtime
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/** One resolved MCP client configuration, as the runtime mounts it. */
export type McpServerConfig = McpClientConfig

/** The mount path's teardown boundary for one mounted server. */
export interface MountedMcpServer {
  /** The config this mount was created from. */
  readonly config: McpServerConfig
  /** Dispose the server's scope, disconnecting it and unregistering its tools. */
  readonly dispose: () => Promise<void>
}

/** Live mount/dispose of MCP servers for one host context. */
export interface McpRuntime {
  /**
   * Mount one server into its own scope.
   * @param config - the resolved MCP client configuration.
   * @returns the mount's teardown boundary.
   * @throws {Error} when `mcp-client` refuses the configuration.
   */
  mount(config: McpServerConfig): Promise<MountedMcpServer>
  /** Dispose one mounted server by name; a name with no mount is ignored. */
  disposeServer(serverName: string): Promise<void>
  /** Dispose every mount this runtime owns and wait for each teardown to settle. */
  dispose(): Promise<void>
}

/** The lifecycle surface this module needs from `@deepseek-ai/dsh-mcp-client`. */
export interface McpClientModule {
  /** Cordis plugin name. */
  readonly name: string
  /** The plugin body, mounted by {@link McpRuntime.mount}. */
  readonly apply: (ctx: Context, config: McpServerConfig) => void | Promise<void>
}

/** Dependency seam: the MCP client plugin this runtime mounts. */
export interface McpRuntimeOptions {
  /**
   * The MCP client plugin to mount. Defaults to the real
   * `@deepseek-ai/dsh-mcp-client`; an injected seam exists so a spec can drive
   * the mount lifecycle without spawning a child process.
   */
  readonly client?: McpClientModule
}

/**
 * Create the runtime for one owner context.
 *
 * An owning effect is registered on `ctx`, so unloading the plugin tears down
 * every server it mounted even if a caller forgot to. Teardown walks the
 * mounts explicitly rather than relying on the owner's own unload, because
 * that unload is not told to start until the children have already been
 * quiesced.
 *
 * @param ctx - the owner context (its dependency API is inherited by each mount).
 * @param options - the mount seam; omit to mount the real MCP client.
 * @returns the runtime.
 */
export function createMcpRuntime(ctx: Context, options: McpRuntimeOptions = {}): McpRuntime {
  const client = options.client ?? McpClient
  const mounts = new Map<string, MountedMcpServer>()

  const disposeAll = async (): Promise<void> => {
    const live = [...mounts.values()]
    mounts.clear()
    for (const mounted of live.reverse()) {
      try {
        await mounted.dispose()
      } catch (error: unknown) {
        // Teardown must not stop at the first refusal: the remaining servers
        // would stay connected with nothing left holding their handles.
        ctx.logger.warn(`dsh-project-context: unmounting "${mounted.config.serverName}" failed: ${String(error)}`)
      }
    }
  }

  // Async effect: Cordis awaits the returned disposer while the plugin unloads,
  // so a host shutdown cannot leave a child process behind.
  ctx.effect(() => () => disposeAll(), 'dsh-project-context.mcpServers()')

  return {
    async mount(config) {
      const pending = ctx.plugin(client as never, config as never)
      try {
        // One server must never fail the whole pass: a bad command, a refused
        // port or an unreachable endpoint is a per-server state the card
        // renders, not a reason to skip the other servers.
        await pending
      } catch (error: unknown) {
        await quiesce(pending)
        throw error instanceof Error ? error : new Error(String(error))
      }
      const mounted: MountedMcpServer = {
        config,
        dispose: async () => {
          mounts.delete(config.serverName)
          await quiesce(pending)
        },
      }
      mounts.set(config.serverName, mounted)
      return mounted
    },
    async disposeServer(serverName) {
      const mounted = mounts.get(serverName)
      if (mounted === undefined) return
      mounts.delete(serverName)
      await mounted.dispose()
    },
    dispose: disposeAll,
  }
}

/**
 * Drive one mount fiber to quiescence.
 *
 * `dispose()` unloads the plugin and the transport it opened; `inertia` is the
 * in-flight teardown that unload started, and awaiting it is what makes the
 * returned promise mean "the child process is gone" rather than "unload was
 * requested".
 *
 * @param fiber - the mount's fiber, or the fiber-shaped promise `ctx.plugin()` returned.
 */
async function quiesce(fiber: Fiber | (Fiber & PromiseLike<Fiber>)): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/**
 * Select the live tool names belonging to one server's namespace.
 *
 * MCP public tool names are `mcp__<serverName>__<rawName>`, normalized and
 * hash-suffixed when needed, so a namespace is always matched by PREFIX.
 *
 * @param serverName - the server namespace to look for.
 * @param toolNames - every live tool name.
 * @returns the matching live tool names, in registry order.
 */
export function toolsOfServer(serverName: string, toolNames: Iterable<string>): string[] {
  const prefix = `mcp__${serverName}__`
  const found: string[] = []
  for (const name of toolNames) {
    if (name.startsWith(prefix)) found.push(name)
  }
  return found
}
