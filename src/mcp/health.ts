/**
 * The MCP health state machine: one tick, two sinks, no I/O.
 *
 * The loop itself owns no host service — {@link createHealthLoop} takes a
 * snapshot thunk, a retry thunk, a notify sink and a log sink, so the whole
 * per-tick sequence is a pure function of those four and can be driven with
 * fake timers. The timer, the HTTP route and the banner script are wired in
 * `src/index.ts`.
 *
 * The notice registry is the single source of truth for what the operator sees:
 * the Web route serializes it, the banner polls it, and a `ctx.logger` line is
 * emitted on every host (web included) on each down transition and each
 * recovery. One state machine, two sinks — never an "is there a webserver?"
 * branch inside the loop.
 *
 * @module dsh-project-context/mcp/health
 */

import type { McpDownReasonCode, McpHealth } from './manager.ts'

/** How often the host half re-derives liveness, in milliseconds. */
export const MCP_HEALTH_INTERVAL_MS = 60_000

/** Plugin identity carried by the banner and by every logged line. */
const PLUGIN_LABEL = 'dsh-project-context'

/**
 * The text published as `detail`, per reason code.
 *
 * Allow-listed, never sanitized: only the two codes this module generates have
 * an entry, so `mount-threw` carries no `detail` at all and the raw mount error
 * — which can embed a credentialed URL or a `stdio` argument — has no path to
 * the route or to the browser.
 */
const DETAILS: Readonly<Record<McpDownReasonCode, string | undefined>> = {
  'no-tools-after-reconnect': 'no tools registered after reconnect',
  'remounts-exhausted': 'remount budget exhausted; the server stays down until a host restart',
  'mount-threw': undefined,
}

/** One active outage, as the route and the banner need it. */
export interface McpNotice {
  /** The entry's `serverName`. */
  readonly serverName: string
  /** Always `down`: a notice exists only while a server is down. */
  readonly status: 'down'
  /** Allow-listed cause. */
  readonly reasonCode: McpDownReasonCode
  /** Plugin-owned text; absent for `mount-threw`. */
  readonly detail?: string
  /** ISO timestamp of the down transition, stable across ticks of one outage. */
  readonly since: string
}

/** The route's response body. */
export interface McpHealthPayload {
  /** Every active outage, in the order it was first observed. */
  readonly servers: readonly McpNotice[]
}

/** What the loop needs from its owner. */
export interface HealthLoopOptions {
  /** How often {@link HealthLoop.start} ticks, in milliseconds. */
  readonly intervalMs: number
  /**
   * Project liveness from the live registry, now.
   * @param exhausted - `serverName`s whose remount budget is already spent, so
   *   the projection can label them `remounts-exhausted`.
   */
  readonly snapshot: (exhausted: readonly string[]) => readonly McpHealth[]
  /**
   * Attempt a reconnect for the given servers.
   * @returns the subset whose remount produced tools.
   */
  readonly retry: (servers: readonly string[]) => Promise<readonly string[]>
  /**
   * The `serverName`s whose consecutive-remount budget is spent.
   *
   * Read from the manager rather than counted here: the budget is enforced next
   * to the mount bookkeeping, and this loop only needs the answer to label the
   * outage `remounts-exhausted`.
   * @returns one `serverName` per exhausted outage.
   */
  readonly exhausted: () => readonly string[]
  /** Called once per down transition, with the outage's notice. */
  readonly notify: (notice: McpNotice) => void
  /** Called once per recovery, and for a contained failure. */
  readonly log: {
    /** One line per recovered or vanished server. */
    info(message: string): void
    /** One line per contained failure. */
    warn(message: string): void
  }
}

/** The host-half loop surface. */
export interface HealthLoop {
  /** Begin ticking; a no-op when already running. */
  start(): void
  /** Stop ticking. Does not clear notices. */
  stop(): void
  /**
   * Run one health pass to completion.
   *
   * Never rejects: a throwing snapshot or retry is contained and logged, so a
   * broken tick can never break the interval or a caller's `void tick()`.
   * @returns the notice registry after the pass.
   */
  tick(): Promise<McpHealthPayload>
  /**
   * The notice registry as it stands, without running a tick.
   *
   * Read by the HTTP route, which serializes it with {@link healthPayload}
   * rather than triggering work of its own.
   * @returns the active outages, keyed by `serverName`.
   */
  notices(): ReadonlyMap<string, McpNotice>
}

/**
 * Create the loop for one plugin instance.
 * @param options - snapshot, retry, notify and log seams.
 * @returns the loop.
 */
export function createHealthLoop(options: HealthLoopOptions): HealthLoop {
  /** `serverName` → its active outage. */
  const notices = new Map<string, McpNotice>()
  /** Servers already announced; the down TRANSITION is the notify trigger. */
  const downNotified = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  /** Drop one server's notice and flag together — one key, one cleanup. */
  const clearNotice = (serverName: string): void => {
    if (!notices.delete(serverName)) return
    downNotified.delete(serverName)
    options.log.info(`${PLUGIN_LABEL}: MCP server "${serverName}" is connected again`)
  }

  /** Build the immutable notice for one down transition. */
  const noticeFor = (entry: McpHealth): McpNotice => {
    const reasonCode = entry.reasonCode ?? 'no-tools-after-reconnect'
    const detail = DETAILS[reasonCode]
    return {
      serverName: entry.serverName,
      status: 'down',
      reasonCode,
      since: new Date().toISOString(),
      ...detail === undefined ? {} : { detail },
    }
  }

  const tick = async (): Promise<McpHealthPayload> => {
    try {
      const before = options.snapshot(options.exhausted())
      const downBefore = before.filter(entry => entry.status === 'down')

      // Recovery is a TRANSITION, not a state: a server that is simply removed
      // from the document must drop its notice too, and that check has to run
      // before any early return.
      const stillDown = new Set(downBefore.map(entry => entry.serverName))
      for (const serverName of [...notices.keys()]) {
        if (!stillDown.has(serverName)) clearNotice(serverName)
      }
      if (downBefore.length === 0) return healthPayload(notices)

      const recovered = new Set(await options.retry(downBefore.map(entry => entry.serverName)))
      for (const serverName of recovered) clearNotice(serverName)

      // The second snapshot is what decides the notice: the retry has already
      // had its confirmation window, so anything still down here stays down.
      for (const entry of options.snapshot(options.exhausted())) {
        if (entry.status !== 'down') continue
        const reasonCode = entry.reasonCode ?? 'no-tools-after-reconnect'
        const known = notices.get(entry.serverName)
        // A reason code CHANGE is a new fact (the budget just ran out), so the
        // notice is rebuilt and re-announced; a tick that changed nothing keeps
        // the existing `since` and stays silent.
        if (known !== undefined && known.reasonCode !== reasonCode) {
          notices.delete(entry.serverName)
          downNotified.delete(entry.serverName)
        }
        if (!notices.has(entry.serverName)) notices.set(entry.serverName, noticeFor(entry))
        if (downNotified.has(entry.serverName)) continue
        downNotified.add(entry.serverName)
        const notice = notices.get(entry.serverName)
        if (notice !== undefined) options.notify(notice)
      }
      return healthPayload(notices)
    } catch (error: unknown) {
      options.log.warn(`${PLUGIN_LABEL}: the MCP health tick failed: ${String(error)}`)
      return healthPayload(notices)
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      timer = setInterval(() => {
        // A tick that outlives its interval must not stack: skip, do not queue.
        if (running) return
        running = true
        void tick().finally(() => { running = false })
      }, options.intervalMs)
      // Unref'd where the runtime offers it: the health loop must never be the
      // reason a process stays alive.
      const handle = timer as unknown as { unref?: () => void }
      handle.unref?.()
    },
    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    tick,
    notices: () => notices,
  }
}
/**
 * Serialize the active outages for the read-only route.
 *
 * `ignored` states are omitted by construction: only {@link McpNotice} records
 * exist in the registry, and a notice is only ever created for a `down` entry.
 * @param notices - the loop's notice registry.
 * @returns the route payload.
 */
export function healthPayload(notices: ReadonlyMap<string, McpNotice>): McpHealthPayload {
  return { servers: [...notices.values()] }
}
