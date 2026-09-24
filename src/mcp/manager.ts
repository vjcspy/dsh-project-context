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
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { ownsMcpToolNamespace, reconcile, type McpServerStatus } from './reconcile.ts'
import { createMcpRuntime, type McpClientModule, type McpRuntime, type McpServerConfig } from './runtime.ts'
import type { McpManagerConfig, McpServerEntry } from './types.ts'

/** How many times one pass re-reads the tool registry while mounts settle. */
const TOOL_SETTLE_PASSES = 3

/** Delay between tool-registry reads, in milliseconds. */
const TOOL_SETTLE_DELAY_MS = 50

/**
 * How long ONE tick's retry confirmation window waits, in milliseconds.
 *
 * Deliberately NOT the mount-settle window above. `TOOL_SETTLE_*` sizes the
 * wait for a mount that already awaited the client's `ready`; this one sizes
 * the wait for a mount that was just re-entered with an effectively unbounded
 * reconnect policy, so a background retry may still be in flight. The two are
 * similar enough to be conflated later, which is why they are named apart.
 */
const RETRY_CONFIRM_TIMEOUT_MS = 5_000

/** Delay between live tool-registry reads inside the confirmation window. */
const RETRY_CONFIRM_POLL_MS = 250

/** The health vocabulary: one tri-state per managed server. */
export type McpHealthStatus = 'ok' | 'down' | 'ignored'

/**
 * Why a server is `down`.
 *
 * Allow-listed by construction: the three literals are the only values that
 * can reach a notice or the HTTP route, so no raw mount error — which can carry
 * a credentialed URL or a `stdio` argument — is ever published.
 */
export type McpDownReasonCode = 'no-tools-after-reconnect' | 'mount-threw' | 'remounts-exhausted'

/**
 * One server's liveness as of a health tick.
 *
 * `ok` and `ignored` are not the same thing: `ignored` means the server's state
 * is deliberate or structural (`disabled`, a tool-name `conflict`, an
 * `invalid` duplicate) and therefore neither retried nor notified.
 */
export interface McpHealth {
  /** The entry's `serverName`. */
  readonly serverName: string
  /** Tri-state liveness. */
  readonly status: McpHealthStatus
  /** Present only when {@link status} is `down`. */
  readonly reasonCode?: McpDownReasonCode
  /** Plugin-owned text, present only for the two plugin-generated reason codes. */
  readonly detail?: string
}

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
  /**
   * Retry-window timings, defaulted to the production constants. Exposed so a
   * spec can drive the confirmation window without waiting 5 s per case; the
   * shipped values are {@link RETRY_CONFIRM_TIMEOUT_MS} /
   * {@link RETRY_CONFIRM_POLL_MS}.
   */
  readonly retry?: {
    /** Total budget for ONE tick's shared confirmation window, in ms. */
    readonly confirmTimeoutMs?: number
    /** Delay between registry reads inside that window, in ms. */
    readonly confirmPollMs?: number
  }
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
  /**
   * Project every managed server's liveness from the LIVE registry, now.
   *
   * Never the cached {@link statuses} for liveness: a server that connected
   * once and died later keeps reporting `mounted` there forever, because the
   * already-mounted branch of `reconcile()` never consults the registry and
   * `emptyNamespaces` is only populated for a server mounted in the same pass.
   * @returns one {@link McpHealth} per document entry, in document order.
   */
  healthSnapshot(exhausted?: readonly string[]): readonly McpHealth[]
  /**
   * The `serverName`s whose consecutive-remount budget is spent.
   *
   * The loop labels their outage `remounts-exhausted`; the budget itself stays
   * enforced here, next to the counter that records it.
   * @returns one `serverName` per exhausted outage.
   */
  exhaustedServerNames(): readonly string[]
  /**
   * Reconnect the named servers by evicting and re-mounting them, then confirm
   * the outcome against the live registry in ONE shared bounded window.
   *
   * Serialized through the same queue as {@link reconcile}, so it cannot
   * interleave with a settings-driven pass. A server whose consecutive-remount
   * budget is spent is skipped — its notice is kept, not its churn.
   * @param servers - `serverName`s to retry, in the order they were observed down.
   * @returns the `serverName`s whose remount actually produced tools.
   */
  retryUnhealthy(servers: readonly string[]): Promise<readonly string[]>
  /** Stop every mounted server and drain the queue. */
  dispose(): Promise<void>
}

/**
 * How many consecutive remounts ONE outage may consume.
 *
 * A permanently dead endpoint must not be torn down and rebuilt 1,440 times a
 * day, and a connected-but-tool-less server must not be remounted forever.
 * Once the budget is spent the loop stops remounting and keeps a single notice
 * — with `remounts-exhausted` as its reason — until a healthy observation
 * resets the counter.
 */
export const MAX_REMOUNT_ATTEMPTS = 5

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
  /**
   * `serverName` → consecutive remounts that produced no tools.
   *
   * One counter per outage: reset by a healthy observation (the confirmation
   * window, or the entry leaving the document) and never by the attempt itself.
   */
  const remountAttempts = new Map<string, number>()
  const confirmTimeoutMs = context.retry?.confirmTimeoutMs ?? RETRY_CONFIRM_TIMEOUT_MS
  const confirmPollMs = context.retry?.confirmPollMs ?? RETRY_CONFIRM_POLL_MS
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
    const stored = context.read()
    const entries: McpServerEntry[] = []
    for (const entry of stored.servers) {
      if (!entry.enabled) {
        entries.push(entry)
        continue
      }
      try {
        entries.push(await resolveEntrySecrets(context.ctx, entry))
        // A credential that resolves now clears an earlier credential refusal;
        // a mount refusal from another cause is left for the mount path to reset.
        if (mountFailures.get(entry.serverName)?.startsWith('credential ')) mountFailures.delete(entry.serverName)
      } catch (error: unknown) {
        mountFailures.set(entry.serverName, error instanceof Error ? error.message : String(error))
        // Kept in the document so the card renders the `failed` state; reconcile
        // short-circuits on the recorded failure and never mounts it.
        entries.push(entry)
      }
    }
    const plan = reconcile({
      entries,
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
      entries,
      mounted,
      toolNames: toolNames(),
      failures: failures(),
      emptyNamespaces,
    }).statuses
  }

  /**
   * Project liveness from the live registry, at the moment of the call.
   *
   * The cached {@link statuses} is consulted ONLY for the states no tool change
   * can alter — `disabled`, `conflict`, `invalid` and a sticky mount failure —
   * and never for `mounted`, whose registry namespace is re-read here.
   * @param exhausted - `serverName`s whose consecutive-remount budget is spent.
   *   A down server in this list reports `remounts-exhausted`, because that is
   *   the fact that changes what the operator can do about it.
   * @returns one health record per document entry, in document order.
   */
  const healthSnapshot = (exhausted: readonly string[] = []): readonly McpHealth[] => {
    const names = toolNames()
    const spent = new Set(exhausted)
    return statuses.map((status): McpHealth => {
      if (status.state === 'disabled' || status.state === 'conflict' || status.state === 'invalid') {
        return { serverName: status.serverName, status: 'ignored' }
      }
      if (status.state === 'failed') {
        // The raw refusal is deliberately NOT carried: a transport error can
        // embed the full request URL and a `stdio` spawn/handshake error can
        // echo an argument-borne credential. It stays in `mountFailures`, host
        // local, and the notice carries a reason code alone.
        return {
          serverName: status.serverName,
          status: 'down',
          reasonCode: spent.has(status.serverName) ? 'remounts-exhausted' : 'mount-threw',
        }
      }
      if (ownsMcpToolNamespace(status.serverName, names)) {
        return { serverName: status.serverName, status: 'ok' }
      }
      // `mounted` in the cache but nothing in the registry NOW: either the
      // server died mid-session or it never produced a tool at all. With
      // `failOnStartupError: false` those two are indistinguishable from
      // outside the client, so the code states the observation, not a cause.
      return {
        serverName: status.serverName,
        status: 'down',
        reasonCode: spent.has(status.serverName) ? 'remounts-exhausted' : 'no-tools-after-reconnect',
      }
    })
  }

  /**
   * Reconnect down servers, then confirm the outcome in ONE shared window.
   *
   * The eviction MUST clear the sticky failure FIRST. `reconcile()`
   * short-circuits an entry with a recorded failure at
   * `src/mcp/reconcile.ts:171-175` — before it reaches `plan.mount` — so
   * without that delete the retry is a guaranteed no-op: the entry is reported
   * `failed` again and the mount loop's own `mountFailures.delete` is
   * unreachable for it. That short-circuit is exactly why this path issues the
   * delete itself instead of adding a second mount implementation.
   * @param servers - the `serverName`s observed `down` this tick.
   * @returns the `serverName`s whose remount produced tools.
   */
  const retryUnhealthy = async (servers: readonly string[]): Promise<readonly string[]> => {
    const present = new Set(context.read().servers.map(entry => entry.serverName))
    for (const serverName of [...remountAttempts.keys()]) {
      // One key, one cleanup: an entry that left the document must not hand its
      // stale budget — or a stale `since` — to a later re-added entry.
      if (!present.has(serverName)) remountAttempts.delete(serverName)
    }
    // A `failed` entry has no live mount — that is precisely the state this
    // path exists to unlock — so "retryable" is "live OR sticky failure", never
    // "live" alone. A server that is neither was never mounted and has nothing
    // to evict, and one whose budget is spent must not churn again.
    const retrying = servers.filter(serverName => (mounted.has(serverName) || mountFailures.has(serverName))
      && (remountAttempts.get(serverName) ?? 0) < MAX_REMOUNT_ATTEMPTS)
    if (retrying.length === 0) return []
    for (const serverName of retrying) {
      remountAttempts.set(serverName, (remountAttempts.get(serverName) ?? 0) + 1)
      mountFailures.delete(serverName)
      // No mounted-check here: `runtime.disposeServer` returns early for an
      // unknown name, so evicting a never-mounted server is silent.
      await unmount(serverName)
    }
    // ONE pass for every evicted server, so the whole tick's bookkeeping stays
    // in the single implementation of the mount path.
    await pass()

    const recovered: string[] = []
    const deadline = Date.now() + confirmTimeoutMs
    for (;;) {
      // Never hold teardown: `dispose()` awaits this queue, so the window must
      // end the moment the manager is stopping.
      if (stopped) return recovered
      const names = toolNames()
      const pending = retrying.filter(serverName => present.has(serverName)
        && !ownsMcpToolNamespace(serverName, names))
      const done = retrying.filter(serverName => present.has(serverName)
        && ownsMcpToolNamespace(serverName, names))
      for (const serverName of done) {
        if (!recovered.includes(serverName)) recovered.push(serverName)
      }
      if (pending.length === 0 || Date.now() >= deadline) break
      await delay(confirmPollMs)
    }
    // Reconcile the cached namespace set with what the window actually saw, so
    // the Settings card keeps telling the truth.
    for (const serverName of retrying) {
      if (!present.has(serverName)) continue
      if (recovered.includes(serverName)) {
        remountAttempts.delete(serverName)
        emptyNamespaces.delete(serverName)
      } else {
        emptyNamespaces.add(serverName)
      }
    }
    return recovered
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
    healthSnapshot,
    exhaustedServerNames: () => [...remountAttempts.entries()]
      .filter(([, count]) => count >= MAX_REMOUNT_ATTEMPTS)
      .map(([serverName]) => serverName),
    retryUnhealthy(servers) {
      if (stopped) return Promise.resolve([])
      // The queue tail stays `void`; only the caller observes the recovered set.
      const next = tail.then(() => retryUnhealthy(servers), () => retryUnhealthy(servers))
      tail = next.then(() => {}, () => {})
      return next
    },
    async dispose() {
      stopped = true
      await tail.catch(() => {})
      mounted.clear()
      mountFailures.clear()
      unconfirmed.clear()
      emptyNamespaces.clear()
      remountAttempts.clear()
      statuses = []
      await runtime.dispose()
    },
  }
}

/**
 * Replace every credential reference in one entry with its resolved value.
 *
 * `env` and `headers` values name credentials, never secrets: the settings
 * document persists into the profile Cordis patch, a tracked file in this
 * deployment, so a value must never be written there. The credentials seam is
 * preferred; the launch environment is the documented fallback when no
 * credentials provider is mounted. A reference that resolves to nothing makes
 * the mount fail with a host-local reason instead of sending an empty header.
 *
 * @param ctx - the owning context, for the credentials seam and launch environment.
 * @param entry - one document entry, with references in `env`/`headers`.
 * @returns the same entry with literal values in `env`/`headers`.
 * @throws {Error} when a reference resolves to no value.
 */
async function resolveEntrySecrets(ctx: Context, entry: McpServerEntry): Promise<McpServerEntry> {
  const credentials = ctx.get('credentials')
  const resolve = async (ref: string): Promise<string> => {
    const value = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (value === undefined || value.length === 0) {
      throw new Error(`credential "${ref}" is not set`)
    }
    return value
  }
  const resolveMap = async (map: Readonly<Record<string, string>>): Promise<Record<string, string>> =>
    Object.fromEntries(await Promise.all(
      Object.entries(map).map(async ([key, ref]) => [key, await resolve(ref)] as const),
    ))
  return {
    ...entry,
    env: await resolveMap(entry.env),
    headers: await resolveMap(entry.headers),
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
  return new Promise(resolve => {
    // Unref'd where the runtime offers it, so a pending confirmation window can
    // never hold the process open on its own. Guarded because a timer shim that
    // returns a plain handle (some test environments) has no `unref`.
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    timer.unref?.()
  })
}
