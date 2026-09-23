/**
 * Manager lifecycle: mount, edit, disable, remove, conflict, and empty server.
 *
 * The manager is driven against a real Cordis context with a stub MCP-client
 * plugin, so scope ownership, the `serverName`-keyed mount map, the tool
 * registry scan, the serialized passes and the failure containment all run the
 * way they do in the host. Only the connection is replaced:
 * `@deepseek-ai/dsh-mcp-client` is proven unmocked in
 * `test/composition/mcp-mount.spec.ts`, which spawns a real MCP server over
 * stdio.
 */

import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createMcpManager, type McpManager } from '../../src/mcp/manager.ts'
import type { McpManagerConfig, McpServerEntry } from '../../src/mcp/types.ts'

/** `serverName`s the stub client refuses to mount, and why. */
const refused = new Map<string, string>()

/** Every mount the stub client accepted, in order. */
const accepted: string[] = []

/** Config the stub accepts: one required field is enough to catch a mismatch. */
const StubConfig = z.object({ serverName: z.string().required() })

/** A registered definition that satisfies the tool registry's own contract. */
function toolDefinition(name: string): unknown {
  return {
    name,
    description: 'probe',
    parameters: {},
    output: { schema: {}, render: () => [] },
    execute: async () => ({}),
  }
}

/** Stub stand-in for the MCP client plugin: one scope-owned tool per server. */
const StubMcpClient = {
  name: 'stub-mcp-client',
  inject: ['tools'],
  Config: StubConfig,
  apply(ctx: Context, config: { serverName: string }): void {
    const refusal = refused.get(config.serverName)
    if (refusal !== undefined) throw new Error(refusal)
    // Registered as an effect, exactly as the real client does through
    // `syncTools`, so disposing the mount's scope unregisters the tool.
    ctx.effect(() => {
      const register = (ctx.get('tools') as { register(definition: unknown): () => void })
      return register.register(toolDefinition(`mcp__${config.serverName}__probe`))
    }, 'stub-mcp-client.tools')
    accepted.push(config.serverName)
  },
}

/** Boot a host with the real tool registry and prompt registry. */
async function bootHost(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // The default logger service prints every contained failure; the suite
  // asserts on reported state instead.
  const host = ctx as unknown as { logger: Record<string, unknown> }
  host.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
  return ctx
}

/** One entry with every field the schema resolves present. */
function entry(overrides: Partial<McpServerEntry> & { serverName: string }): McpServerEntry {
  return {
    id: overrides.serverName,
    enabled: true,
    transport: 'stdio',
    command: 'echo',
    args: [],
    env: {},
    headers: {},
    cwd: '',
    url: '',
    toolCallTimeoutMs: 60_000,
    maxInstructionBytes: 0,
    ...overrides,
  }
}

function managerFor(ctx: Context, document: McpManagerConfig): McpManager {
  return createMcpManager({
    ctx,
    read: () => document,
    log: { warn: () => {} },
    client: StubMcpClient as never,
  })
}

/**
 * Live tool names an Agent in this host would see.
 *
 * A per-scope mount is invisible to the registry's global view - the same
 * property that makes a scoped tool silently shadow an inherited one - so the
 * spec reads the registry through a scope, exactly as an Agent's own view does.
 */
function scopedToolNames(ctx: Context): string[] {
  // Non-null: every caller boots the real `ToolRuntime`, and a missing registry
  // is a broken fixture rather than a state this spec is asserting about.
  const tools = ctx.get('tools') as { schemas(scope?: unknown): { name: string }[] }
  const probe = createScope(ctx, { probe: true })
  return tools.schemas(probe.ctx).map(schema => schema.name)
}

describe('MCP manager', () => {
  test('mounts an enabled server, unmounts a disabled one, and removes on demand', async () => {
    const ctx = await bootHost()
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = managerFor(ctx, document)

    await manager.reconcile()
    expect(scopedToolNames(ctx)).toEqual(['mcp__alpha__probe'])
    expect(manager.mountedServerNames()).toEqual(['alpha'])
    expect(manager.statuses().map(status => status.state)).toEqual(['mounted'])

    document.servers = [entry({ serverName: 'alpha', enabled: false })]
    await manager.reconcile()
    expect(scopedToolNames(ctx)).toEqual([])
    expect(manager.mountedServerNames()).toEqual([])
    expect(manager.statuses().map(status => status.state)).toEqual(['disabled'])

    document.servers = []
    await manager.reconcile()
    expect(manager.statuses()).toEqual([])
    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('a name another registration already owns is a conflict, not a mount', async () => {
    const ctx = await bootHost()
    // Registered on the registry as a bundle patch row or another runtime
    // mount would be. A patch-file reader cannot see either; the registry can.
    const tools = ctx.get('tools') as { register(definition: unknown): () => void }
    const disposer = tools.register(toolDefinition('mcp__taken__already_there'))
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'taken' })] }
    const manager = managerFor(ctx, document)

    await manager.reconcile()
    expect(manager.mountedServerNames()).toEqual([])
    const [status] = manager.statuses()
    expect(status?.state).toBe('conflict')
    expect(status?.reason).toContain('mcp__taken__')

    disposer()
    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('re-mounts only the server whose connection fields changed', async () => {
    accepted.length = 0
    const ctx = await bootHost()
    const document: { servers: McpServerEntry[] } = {
      servers: [entry({ serverName: 'alpha' }), entry({ serverName: 'beta' })],
    }
    const manager = managerFor(ctx, document)

    await manager.reconcile()
    expect(accepted).toEqual(['alpha', 'beta'])
    expect(scopedToolNames(ctx).sort()).toEqual(['mcp__alpha__probe', 'mcp__beta__probe'])

    // A repeated pass over an unchanged document mounts nothing again.
    await manager.reconcile()
    expect(accepted).toEqual(['alpha', 'beta'])

    // Editing one server's command remounts exactly that server.
    document.servers = [entry({ serverName: 'alpha', command: '/bin/other' }), entry({ serverName: 'beta' })]
    await manager.reconcile()
    expect(accepted).toEqual(['alpha', 'beta', 'alpha'])
    expect(scopedToolNames(ctx).sort()).toEqual(['mcp__alpha__probe', 'mcp__beta__probe'])

    await manager.dispose()
    expect(scopedToolNames(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  test('an unusable server fails alone and the healthy one stays mounted', async () => {
    const ctx = await bootHost()
    refused.set('broken', 'stub-mcp-client(broken): cannot spawn /nonexistent')
    const document: { servers: McpServerEntry[] } = {
      servers: [entry({ serverName: 'broken' }), entry({ serverName: 'fine' })],
    }
    const manager = managerFor(ctx, document)

    try {
      await manager.reconcile()
      expect(scopedToolNames(ctx)).toEqual(['mcp__fine__probe'])
      const statuses = manager.statuses()
      expect(statuses[0]?.state).toBe('failed')
      expect(statuses[0]?.reason).toContain('cannot spawn')
      expect(statuses[1]?.state).toBe('mounted')
      expect(manager.mountedServerNames()).toEqual(['fine'])
    } finally {
      refused.clear()
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })

  test('a mounted server whose namespace stays empty is reported as empty, not as working', async () => {
    const ctx = await bootHost()
    // A server that connected but registered no tool: the silent-failure
    // symptom `failOnStartupError: false` and a rolled-back generation share.
    const silent = {
      name: 'silent-mcp-client',
      inject: ['tools'],
      Config: StubConfig,
      apply: (): void => {},
    }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silent as never,
    })

    await manager.reconcile()
    expect(manager.mountedServerNames()).toEqual(['alpha'])
    expect(manager.statuses()[0]?.state).toBe('empty')
    expect(scopedToolNames(ctx)).toEqual([])

    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('mounts nothing when the document has no servers', async () => {
    accepted.length = 0
    const ctx = await bootHost()
    const manager = managerFor(ctx, { servers: [] })
    await manager.reconcile()
    expect(manager.mountedServerNames()).toEqual([])
    expect(manager.statuses()).toEqual([])
    expect(accepted).toEqual([])
    await manager.dispose()
    await ctx.fiber.dispose()
  })
})

/**
 * A stub client whose tool registration is switched off, so a mount succeeds
 * but the namespace stays empty — the shape of a server that connected and
 * exposes nothing, and of a remount that did not heal anything.
 * @param counter - mutable mount counter the spec asserts against.
 * @returns a plugin module shaped like `@deepseek-ai/dsh-mcp-client`.
 */
function silentClient(counter: { mounts: number }): unknown {
  return {
    name: 'silent-mcp-client',
    inject: ['tools'],
    Config: StubConfig,
    apply: (): void => { counter.mounts += 1 },
  }
}

/** Retry-window timings used by these cases: real, but 10× faster than production. */
const FAST_RETRY = { confirmTimeoutMs: 400, confirmPollMs: 50 } as const

describe('tick-time health projection', () => {
  test('a mounted server whose tools disappear from the registry is down with no commit', async () => {
    const ctx = await bootHost()
    // The C1 shape: the server connected once and died later. The document is
    // never touched, so `pass()` never runs again and the cached `statuses`
    // keeps saying `mounted` forever.
    const held: { unregister?: () => void } = {}
    const flaky = {
      name: 'flaky-mcp-client',
      inject: ['tools'],
      Config: StubConfig,
      apply(ctx: Context, config: { serverName: string }): void {
        ctx.effect(() => {
          const register = (ctx.get('tools') as { register(definition: unknown): () => void })
          const dispose = register.register(toolDefinition(`mcp__${config.serverName}__probe`))
          held.unregister = dispose
          return dispose
        }, 'flaky-mcp-client.tools')
      },
    }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: flaky as never,
      retry: FAST_RETRY,
    })

    await manager.reconcile()
    expect(manager.statuses().map(status => status.state)).toEqual(['mounted'])
    expect(manager.healthSnapshot()).toEqual([{ serverName: 'alpha', status: 'ok' }])

    // The connection dies: its tools go, the document and the cache do not.
    held.unregister?.()
    expect(manager.statuses().map(status => status.state)).toEqual(['mounted'])
    expect(manager.healthSnapshot()).toEqual([
      { serverName: 'alpha', status: 'down', reasonCode: 'no-tools-after-reconnect' },
    ])

    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('the tri-state maps the structural states to ignored and a mount failure to mount-threw', async () => {
    const ctx = await bootHost()
    refused.set('broken', 'stub-mcp-client(broken): cannot spawn /nonexistent')
    const tools = ctx.get('tools') as { register(definition: unknown): () => void }
    const disposer = tools.register(toolDefinition('mcp__taken__already_there'))
    const document: { servers: McpServerEntry[] } = {
      servers: [
        entry({ serverName: 'off', enabled: false }),
        entry({ serverName: 'taken' }),
        entry({ serverName: 'broken' }),
        entry({ serverName: 'fine' }),
      ],
    }
    const manager = managerFor(ctx, document)

    try {
      await manager.reconcile()
      expect(manager.statuses().map(status => status.state))
        .toEqual(['disabled', 'conflict', 'failed', 'mounted'])
      expect(manager.healthSnapshot()).toEqual([
        { serverName: 'off', status: 'ignored' },
        { serverName: 'taken', status: 'ignored' },
        { serverName: 'broken', status: 'down', reasonCode: 'mount-threw' },
        { serverName: 'fine', status: 'ok' },
      ])
      // The raw refusal is host-local: it must not be projected at all.
      expect(JSON.stringify(manager.healthSnapshot())).not.toContain('cannot spawn')
    } finally {
      refused.clear()
      disposer()
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })

  test('an exhausted server is labelled remounts-exhausted', async () => {
    const ctx = await bootHost()
    const counter = { mounts: 0 }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silentClient(counter) as never,
      retry: FAST_RETRY,
    })

    await manager.reconcile()
    expect(manager.healthSnapshot()).toEqual([
      { serverName: 'alpha', status: 'down', reasonCode: 'no-tools-after-reconnect' },
    ])

    for (let attempt = 0; attempt < 5; attempt += 1) await manager.retryUnhealthy(['alpha'])
    expect(manager.exhaustedServerNames()).toEqual(['alpha'])
    expect(manager.healthSnapshot(manager.exhaustedServerNames())).toEqual([
      { serverName: 'alpha', status: 'down', reasonCode: 'remounts-exhausted' },
    ])

    await manager.dispose()
    await ctx.fiber.dispose()
  })
})

describe('retryUnhealthy', () => {
  test('clears the sticky failure FIRST, so the following pass reaches the mount instead of short-circuiting', async () => {
    const ctx = await bootHost()
    refused.set('flaky', 'stub-mcp-client(flaky): cannot spawn /nonexistent')
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'flaky' })] }
    const manager = managerFor(ctx, document)

    try {
      await manager.reconcile()
      expect(manager.statuses().map(status => status.state)).toEqual(['failed'])
      expect(manager.mountedServerNames()).toEqual([])

      // The operator fixes the server; the sticky failure is still recorded, so
      // only the retry path can unlock it.
      refused.delete('flaky')
      accepted.length = 0
      const recovered = await manager.retryUnhealthy(['flaky'])

      expect(accepted).toEqual(['flaky'])
      expect(recovered).toEqual(['flaky'])
      expect(manager.statuses().map(status => status.state)).toEqual(['mounted'])
      expect(manager.healthSnapshot()).toEqual([{ serverName: 'flaky', status: 'ok' }])
    } finally {
      refused.clear()
      await manager.dispose()
      await ctx.fiber.dispose()
    }
  })

  test('the budget stops at 5 consecutive remounts and a healthy tick resets it', async () => {
    const ctx = await bootHost()
    const counter = { mounts: 0 }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silentClient(counter) as never,
      retry: FAST_RETRY,
    })

    await manager.reconcile()
    expect(manager.statuses().map(status => status.state)).toEqual(['empty'])

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const recovered = await manager.retryUnhealthy(['alpha'])
      expect(recovered).toEqual([])
    }
    expect(counter.mounts).toBe(6) // one initial mount plus five remounts
    expect(manager.exhaustedServerNames()).toEqual(['alpha'])
    expect(manager.healthSnapshot(manager.exhaustedServerNames())).toEqual([
      { serverName: 'alpha', status: 'down', reasonCode: 'remounts-exhausted' },
    ])

    // Spent: the retry is a no-op and the churn stops.
    await manager.retryUnhealthy(['alpha'])
    expect(counter.mounts).toBe(6)

    // A healthy observation resets the counter, so the next outage gets a fresh
    // budget. Observed here by removing the entry, which is the other reset.
    document.servers = []
    await manager.reconcile()
    await manager.retryUnhealthy([])
    expect(manager.exhaustedServerNames()).toEqual([])

    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('ONE shared confirmation window per tick, not one per server', async () => {
    const ctx = await bootHost()
    const counter = { mounts: 0 }
    const document: { servers: McpServerEntry[] } = {
      // Unrelated healthy entries are required: on a single-entry document the
      // "one window" claim would hold trivially.
      servers: [
        entry({ serverName: 'dead-a' }),
        entry({ serverName: 'dead-b' }),
        entry({ serverName: 'dead-c' }),
      ],
    }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silentClient(counter) as never,
      retry: FAST_RETRY,
    })

    await manager.reconcile()
    counter.mounts = 0

    const started = Date.now()
    const recovered = await manager.retryUnhealthy(['dead-a', 'dead-b', 'dead-c'])
    const elapsed = Date.now() - started

    expect(recovered).toEqual([])
    // Three remounts, one window: `N × 400 ms` would be the failure.
    expect(counter.mounts).toBe(3)
    expect(elapsed).toBeGreaterThanOrEqual(FAST_RETRY.confirmTimeoutMs)
    expect(elapsed).toBeLessThan(FAST_RETRY.confirmTimeoutMs * 2)

    await manager.dispose()
    await ctx.fiber.dispose()
  })

  test('the confirmation window aborts as soon as dispose() sets stopped', async () => {
    const ctx = await bootHost()
    const counter = { mounts: 0 }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silentClient(counter) as never,
      // Deliberately long: only the abort can end this window early.
      retry: { confirmTimeoutMs: 60_000, confirmPollMs: 25 },
    })

    await manager.reconcile()
    const retrying = manager.retryUnhealthy(['alpha'])
    // Let the remount land and the window start before teardown.
    await new Promise(resolve => setTimeout(resolve, 100))

    const started = Date.now()
    await manager.dispose()
    await retrying
    expect(Date.now() - started).toBeLessThan(5_000)

    await ctx.fiber.dispose()
  })

  test('retryUnhealthy is serialized behind an in-flight reconcile', async () => {
    const ctx = await bootHost()
    const counter = { mounts: 0 }
    const document: { servers: McpServerEntry[] } = { servers: [entry({ serverName: 'alpha' })] }
    const manager = createMcpManager({
      ctx,
      read: () => document,
      log: { warn: () => {} },
      client: silentClient(counter) as never,
      retry: FAST_RETRY,
    })

    await manager.reconcile()
    counter.mounts = 0

    // Both enter the queue in the same turn; the queue must run them one at a
    // time, so the retry's remount cannot interleave with the pass's mount.
    const pass = manager.reconcile()
    const retry = manager.retryUnhealthy(['alpha'])
    await Promise.all([pass, retry])
    // A silent remount plus nothing else: the second pass over an unchanged
    // document mounts nothing.
    expect(counter.mounts).toBe(1)

    await manager.dispose()
    await ctx.fiber.dispose()
  })
})
