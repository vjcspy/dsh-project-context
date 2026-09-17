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
  const tools: { schemas(scope?: unknown): { name: string }[] } = ctx.get('tools')
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
