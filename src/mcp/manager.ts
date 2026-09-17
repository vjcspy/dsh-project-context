/**
 * The MCP server manager: the plugin's MCP entry point.
 *
 * It owns three things the plugin entry must not: the serialized reconcile
 * queue, the live mount map, and the per-server states the Settings card
 * renders. Nothing here throws into a host hook — a settings commit, a plugin
 * unload and a mount refusal all resolve into state.
 *
 * @module dsh-project-context/mcp/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { reconcile, type McpServerStatus } from './reconcile.ts'
import { createMcpRuntime, type McpClientModule, type McpRuntime, type McpServerConfig } from './runtime.ts'
import type { McpManagerConfig } from './types.ts'

/** How many times one pass re-reads the tool registry while mounts settle. */
const TOOL_SETTLE_PASSES = 3

/** Delay between tool-registry reads, in milliseconds. */
const TOOL_SETTLE_DELAY_MS = 50

/**
 * Services the manager reads.
 *
 * `tools` is looked up through `ctx.get` rather than declared: the registry is
 * optional, and a host that composed none simply reports no conflicts and no
 * tools.
 */
export interface McpManagerContext {
  /** The owner context, whose plugin API mounts each server. */
  readonly ctx: Context
  /** Read the authoritative namespace document. */
  readonly read: () => McpManagerConfig
  /** The host logger. */
  readonly log: { warn(message: string): void }
  /** The MCP client plugin to mount; defaults to the real one. */
  readonly client?: McpClientModule
}

/**
 * The plugin-facing manager surface.
 */
export interface McpManager {
  /** Reconcile the live mounts with the current document, serialized. */
  reconcile(): Promise<void>
  /** The last pass's per-entry states, in document order. */
  statuses(): readonly McpServerStatus[]
  /** `serverName`s this manager currently holds a live mount for. */
  mountedServerNames(): readonly string[]
  /** Stop every mounted server and drain the queue. */
  dispose(): Promise<void>
}

/** The plugin-owned manager. */
export function createMcpManager(context: McpManagerContext): McpManager {
  const runtime: McpRuntime = createMcpRuntime(
    context.ctx,
    context.client === undefined ? {} : { client: context.client },
  )
  /** `serverName` → the config currently mounted for it. */
  const mounted = new Map<string, McpServerConfig>()
  /** `serverName` → why its mount attempt was refused. Sticky until a retry. */
  const mountFailures = new Map<string, string>()
  /**
   * Servers mounted whose tools have not been observed yet. Kept separate from
   * {@link mountFailures} because a slow connect and an empty server are
   * different states: one may still produce tools, the other never will.
   */
  const unconfirmed = new Set<string>()
  /** Servers whose mount succeeded and whose tool namespace is still empty. */
  const emptyNamespaces = new Set<string>()
  let statuses: readonly McpServerStatus[] = []
  let stopped = false
  /** Serializes passes: a fast sequence of commits must not interleave mounts. */
  let tail: Promise<void> = Promise.resolve()

  const toolNames = (): ReadonlySet<string> => liveToolNames(context.ctx, context.log)

  const failures = (): ReadonlyMap<string, string> => mountFailures

  const unmount = async (serverName: string): Promise<void> => {
    mounted.delete(serverName)
    unconfirmed.delete(serverName)
    emptyNamespaces.delete(serverName)
    try {
      await runtime.disposeServer(serverName)
    } catch (error: unknown) {
      context.log.warn(`dsh-project-context: unmounting "${serverName}" failed: ${String(error)}`)
    }
  }

  /**
   * Re-read the registry while the pass's own mounts settle.
   *
   * A mount that connected contributes its tools asynchronously, so a single
   * read taken right after it would report a working server as empty. The
   * window is bounded: a server that never produces a tool stays `empty`,
   * which is the honest reading of `failOnStartupError: false` — a successful
   * mount is not evidence that the server answers.
   */
  const settle = async (serverNames: readonly string[]): Promise<void> => {
    let pending = serverNames.filter(serverName => unconfirmed.has(serverName))
    for (let attempt = 0; attempt < TOOL_SETTLE_PASSES && pending.length > 0; attempt += 1) {
      await delay(TOOL_SETTLE_DELAY_MS)
      const names = toolNames()
      pending = pending.filter((serverName) => {
        if (!hasTools(serverName, names)) return true
        unconfirmed.delete(serverName)
        emptyNamespaces.delete(serverName)
        return false
      })
    }
    for (const serverName of pending) emptyNamespaces.add(serverName)
  }

  const pass = async (): Promise<void> => {
    const config = context.read()
    const plan = reconcile({
      entries: config.servers,
      mounted,
      toolNames: toolNames(),
      failures: failures(),
      emptyNamespaces,
    })

    for (const serverName of plan.unmount) await unmount(serverName)

    const mountedNow: string[] = []
    for (const serverConfig of plan.mount) {
      const { serverName } = serverConfig
      // A configuration change is the operator's retry: clearing the sticky
      // refusal lets the same pass report a fresh outcome instead of the old one.
      mountFailures.delete(serverName)
      unconfirmed.delete(serverName)
      emptyNamespaces.delete(serverName)
      try {
        await runtime.mount(serverConfig)
        mounted.set(serverName, serverConfig)
        unconfirmed.add(serverName)
        mountedNow.push(serverName)
      } catch (error: unknown) {
        mountFailures.set(serverName, error instanceof Error ? error.message : String(error))
      }
    }

    await settle(mountedNow)
    statuses = reconcile({
      entries: config.servers,
      mounted,
      toolNames: toolNames(),
      failures: failures(),
      emptyNamespaces,
    }).statuses
  }

  return {
    reconcile() {
      if (stopped) return Promise.resolve()
      const next = tail.then(pass, pass)
      // The queue tail stays fulfilled so one failed pass cannot strand every
      // later one; the caller still observes this pass's own rejection.
      tail = next.catch(() => {})
      return next
    },
    statuses: () => statuses,
    mountedServerNames: () => [...mounted.keys()],
    async dispose() {
      stopped = true
      await tail.catch(() => {})
      mounted.clear()
      mountFailures.clear()
      unconfirmed.clear()
      emptyNamespaces.clear()
      statuses = []
      await runtime.dispose()
    },
  }
}

/**
 * One live tool name per registration the manager could collide with.
 *
 * The scan reads the tool registry through `ctx.get`, never a patch file: a
 * `serverName` can arrive from a bundle patch, a profile patch row, another
 * runtime mount, or an Agent-scoped mount, and only the registry sees the
 * runtime ones. Two views are unioned because a scope's own registrations are
 * invisible to the global view while still shadowing a name for every Agent
 * inside that scope:
 * - the global view, which is where an ordinary plugin-level mount lands;
 * - each live Agent's view, which is where a per-Agent mount lands and the
 *   only view that can observe a descendant shadowing an ancestor.
 *
 * @param ctx - the owning context.
 * @param log - host logger for a contained registry failure.
 * @returns every tool name a new mount could collide with.
 */
function liveToolNames(ctx: Context, log: { warn(message: string): void }): ReadonlySet<string> {
  const tools: { schemas(scope?: object): { name: string }[] } | undefined = ctx.get('tools')
  if (tools === undefined) return new Set()
  const names = new Set<string>()
  try {
    for (const schema of tools.schemas()) names.add(schema.name)
    // An Agent IS the scope key its registrations were made under, so the
    // Agent is what a scoped read takes — its context is not.
    const agents: { list(): readonly object[] } | undefined = ctx.get('agents')
    for (const agent of agents?.list() ?? []) {
      for (const schema of tools.schemas(agent)) names.add(schema.name)
    }
  } catch (error: unknown) {
    log.warn(`dsh-project-context: reading the tool registry failed: ${String(error)}`)
  }
  return names
}

function hasTools(serverName: string, names: ReadonlySet<string>): boolean {
  const prefix = `mcp__${serverName}__`
  for (const name of names) {
    if (name.startsWith(prefix)) return true
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
