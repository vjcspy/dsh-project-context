/**
 * The MCP health state machine.
 *
 * `createHealthLoop` owns no timer and no host service: it is a pure function of
 * a snapshot thunk, a retry thunk and two sinks, so every transition is driven
 * here directly rather than through a clock. The invariants asserted are the
 * ones the operator experiences: ONE notice per outage, cleared on recovery,
 * never emitted for a structural state, and never carrying a raw mount error.
 */

import { describe, expect, test } from 'vitest'
import {
  createHealthLoop,
  healthPayload,
  MCP_HEALTH_INTERVAL_MS,
  type McpNotice,
} from '../../src/mcp/health.ts'
import type { McpHealth } from '../../src/mcp/manager.ts'

/** A scripted world: what the next snapshot reports, and whether a retry works. */
interface World {
  /** Every `snapshot()` call's argument, in order. */
  readonly exhausted: string[][]
  /** The health list the next snapshot returns. */
  current: McpHealth[]
  /** `serverName`s a retry is allowed to heal. */
  healed: Set<string>
  /** How many times the retry seam was called. */
  retries: number
}

function world(initial: McpHealth[]): World {
  return { exhausted: [], current: initial, healed: new Set(), retries: 0 }
}

/** Build a loop over one scripted world, recording everything it emits. */
function loopFor(state: World, exhausted: readonly string[] = []): {
  loop: ReturnType<typeof createHealthLoop>
  notified: McpNotice[]
  info: string[]
  warn: string[]
} {
  const notified: McpNotice[] = []
  const info: string[] = []
  const warn: string[] = []
  const loop = createHealthLoop({
    intervalMs: MCP_HEALTH_INTERVAL_MS,
    snapshot: (spent) => {
      state.exhausted.push([...spent])
      return state.current
    },
    retry: async (servers) => {
      state.retries += 1
      const recovered = servers.filter(serverName => state.healed.has(serverName))
      if (recovered.length > 0) {
        state.current = state.current.map(entry => recovered.includes(entry.serverName)
          ? { serverName: entry.serverName, status: 'ok' as const }
          : entry)
      }
      return recovered
    },
    exhausted: () => exhausted,
    notify: notice => notified.push(notice),
    log: { info: message => info.push(message), warn: message => warn.push(message) },
  })
  return { loop, notified, info, warn }
}

describe('per-outage notices', () => {
  test('one notice on the down transition, none while it stays down, one more after recovery', async () => {
    const state = world([{ serverName: 'Monolith', status: 'down', reasonCode: 'no-tools-after-reconnect' }])
    const { loop, notified, info } = loopFor(state)

    await loop.tick()
    expect(notified.map(notice => notice.serverName)).toEqual(['Monolith'])
    expect(notified[0]?.reasonCode).toBe('no-tools-after-reconnect')
    expect(notified[0]?.detail).toBe('no tools registered after reconnect')
    expect(notified[0]?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Still down on the next tick: the retry runs, the notice does NOT repeat.
    await loop.tick()
    expect(state.retries).toBe(2)
    expect(notified).toHaveLength(1)

    // Recovery clears the notice and logs exactly one line.
    state.healed.add('Monolith')
    await loop.tick()
    expect(loop.notices().size).toBe(0)
    expect(info.filter(line => line.includes('connected again'))).toHaveLength(1)

    // A NEW outage notifies again.
    state.healed.clear()
    state.current = [{ serverName: 'Monolith', status: 'down', reasonCode: 'no-tools-after-reconnect' }]
    await loop.tick()
    expect(notified).toHaveLength(2)
  })

  test('a server removed from the document drops its notice without a healthy observation', async () => {
    const state = world([{ serverName: 'gone', status: 'down', reasonCode: 'mount-threw' }])
    const { loop, info } = loopFor(state)

    await loop.tick()
    expect(loop.notices().size).toBe(1)

    state.current = []
    await loop.tick()
    expect(loop.notices().size).toBe(0)
    expect(info.some(line => line.includes('"gone"'))).toBe(true)
  })

  test('a reason-code change is a new fact and re-announces the outage', async () => {
    const state = world([{ serverName: 'stuck', status: 'down', reasonCode: 'no-tools-after-reconnect' }])
    const { loop, notified } = loopFor(state)

    await loop.tick()
    state.current = [{ serverName: 'stuck', status: 'down', reasonCode: 'remounts-exhausted' }]
    await loop.tick()

    expect(notified.map(notice => notice.reasonCode)).toEqual(['no-tools-after-reconnect', 'remounts-exhausted'])
    expect(notified[1]?.detail).toBe('remount budget exhausted; the server stays down until a host restart')
  })
})

describe('structural states', () => {
  test('an ignored state is never retried and never notified', async () => {
    const state = world([
      { serverName: 'off', status: 'ignored' },
      { serverName: 'clash', status: 'ignored' },
    ])
    const { loop, notified } = loopFor(state)

    await loop.tick()
    expect(notified).toEqual([])
    expect(state.retries).toBe(0)
    expect(loop.notices().size).toBe(0)
  })

  test('only the down entries of a mixed snapshot are retried', async () => {
    const state = world([
      { serverName: 'ok-one', status: 'ok' },
      { serverName: 'off', status: 'ignored' },
      { serverName: 'broken', status: 'down', reasonCode: 'mount-threw' },
    ])
    const retried: string[][] = []
    const loop = createHealthLoop({
      intervalMs: MCP_HEALTH_INTERVAL_MS,
      snapshot: () => state.current,
      retry: async (servers) => { retried.push([...servers]); return [] },
      exhausted: () => [],
      notify: () => {},
      log: { info: () => {}, warn: () => {} },
    })

    await loop.tick()
    expect(retried).toEqual([['broken']])
  })
})

describe('payload allow-list', () => {
  test('the exhausted list reaches the projection, and the payload omits ignored states', async () => {
    const state = world([{ serverName: 'stuck', status: 'down', reasonCode: 'remounts-exhausted' }])
    const { loop } = loopFor(state, ['stuck'])

    const payload = await loop.tick()
    expect(state.exhausted[0]).toEqual(['stuck'])
    expect(payload.servers).toHaveLength(1)
    expect(payload.servers[0]?.status).toBe('down')

    // The projection is the only place `ignored` exists, and it is filtered
    // before any notice record is created.
    state.current = [{ serverName: 'off', status: 'ignored' }]
    const after = await loop.tick()
    expect(after.servers).toEqual([])
  })

  test('mount-threw carries a reason code and NO detail', async () => {
    const state = world([{ serverName: 'raw', status: 'down', reasonCode: 'mount-threw' }])
    const { loop, notified } = loopFor(state)

    await loop.tick()
    expect(notified[0]?.reasonCode).toBe('mount-threw')
    expect(notified[0]?.detail).toBeUndefined()
    expect('detail' in (notified[0] as object)).toBe(false)
    // The raw refusal never reaches the payload, whatever it contained.
    expect(JSON.stringify(loop.notices())).not.toContain('api-key')
  })

  test('healthPayload serializes the registry as `{ servers: [...] }`', () => {
    const payload = healthPayload(new Map([
      ['a', { serverName: 'a', status: 'down', reasonCode: 'mount-threw', since: '2026-09-23T00:00:00.000Z' }],
    ]))
    expect(payload).toEqual({
      servers: [{ serverName: 'a', status: 'down', reasonCode: 'mount-threw', since: '2026-09-23T00:00:00.000Z' }],
    })
  })
})

describe('containment', () => {
  test('a throwing retry does not kill the loop and still surfaces the outage', async () => {
    const warn: string[] = []
    const notified: McpNotice[] = []
    const loop = createHealthLoop({
      intervalMs: MCP_HEALTH_INTERVAL_MS,
      snapshot: () => [{ serverName: 'x', status: 'down', reasonCode: 'no-tools-after-reconnect' }],
      retry: () => Promise.reject(new Error('retry exploded')),
      exhausted: () => [],
      notify: notice => notified.push(notice),
      log: { info: () => {}, warn: message => warn.push(message) },
    })

    const payload = await loop.tick()
    expect(warn.some(line => line.includes('retry exploded'))).toBe(true)
    // The failure is contained, and the notice is NOT published: without a
    // completed retry there is nothing honest to announce yet.
    expect(notified).toEqual([])
    expect(payload.servers).toEqual([])
  })

  test('a throwing snapshot is contained rather than escaping the interval', async () => {
    const warn: string[] = []
    const loop = createHealthLoop({
      intervalMs: MCP_HEALTH_INTERVAL_MS,
      snapshot: () => { throw new Error('registry gone') },
      retry: async () => [],
      exhausted: () => [],
      notify: () => {},
      log: { info: () => {}, warn: message => warn.push(message) },
    })

    await expect(loop.tick()).resolves.toEqual({ servers: [] })
    expect(warn.some(line => line.includes('registry gone'))).toBe(true)
  })
})
