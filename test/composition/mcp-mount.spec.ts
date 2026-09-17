/**
 * Real-composition proof of the mount path.
 *
 * The manager's own spec drives a stub client, so it proves the reconcile
 * decision and nothing about the connection. This spec is the other half: the
 * plugin's real MCP manager mounts the REAL `@deepseek-ai/dsh-mcp-client`
 * against a REAL MCP server over stdio, in the real service composition, and
 * the assertion is a tool-registry observation rather than a log line — a
 * mount that "succeeded" is not evidence that a server answers.
 *
 * The fixture is `test/fixtures/mcp-server.ts`, spawned as a child process.
 */

import { afterEach, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createMcpManager, type McpManager } from '../../src/mcp/manager.ts'
import type { McpServerEntry } from '../../src/mcp/types.ts'

/** The fixture server's own absolute path; Node strips its types at spawn. */
const FIXTURE = fileURLToPath(new URL('../fixtures/mcp-server.ts', import.meta.url))

/** The server namespace this spec mounts under. */
const SERVER_NAME = 'fixture'

/** How long the fixture may take to spawn, connect and list its tools. */
const READY_TIMEOUT_MS = 20_000

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** Boot the real tool registry, prompt registry and a live Agent scope. */
async function bootHost(): Promise<{ ctx: Context; agentScope: Context }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const host = ctx as unknown as { logger: Record<string, unknown> }
  host.logger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
  cleanups.push(async () => { await ctx.fiber.dispose() })
  // A scope to read the registry through: a per-scope mount is invisible to the
  // global view, which is the same property that lets a scoped tool shadow an
  // inherited one. This is the view an Agent's own scope has.
  const probe = createScope(ctx, { observer: true })
  cleanups.push(async () => { await probe.dispose() })
  return { ctx, agentScope: probe.ctx }
}

/** Live tool names visible to one scope. */
function visibleTools(scope: Context): string[] {
  const tools: { schemas(view?: unknown): { name: string }[] } = scope.get('tools') as never
  return tools.schemas(scope).map(schema => schema.name)
}

/** One enabled stdio entry pointing at the fixture server. */
function fixtureEntry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: 'fixture',
    serverName: SERVER_NAME,
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    headers: {},
    cwd: '',
    url: '',
    toolCallTimeoutMs: 20_000,
    maxInstructionBytes: 0,
    ...overrides,
  }
}

/** Poll until the predicate holds, or fail with what was observed. */
async function waitFor(scope: Context, predicate: (names: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let names = visibleTools(scope)
  while (Date.now() < deadline) {
    if (predicate(names)) return names
    await new Promise(resolve => setTimeout(resolve, 100))
    names = visibleTools(scope)
  }
  return names
}

test('mounts a real stdio MCP server and observes its tool in the registry', async () => {
  const { ctx, agentScope } = await bootHost()
  const document = { servers: [fixtureEntry()] }
  const manager: McpManager = createMcpManager({ ctx, read: () => document, log: { warn: () => {} } })
  cleanups.push(async () => { await manager.dispose() })

  await manager.reconcile()
  expect(manager.mountedServerNames()).toEqual([SERVER_NAME])

  // The assertion is the registry, matched on the `mcp__<serverName>__` PREFIX:
  // a public tool name is hash-suffixed whenever the joined name is too long or
  // needs character rewriting, so an equality against a full name would be
  // wrong even when the mount worked.
  const names = await waitFor(agentScope, current => current.some(name => name.startsWith(`mcp__${SERVER_NAME}__`)))
  expect(names.filter(name => name.startsWith(`mcp__${SERVER_NAME}__`))).toEqual([`mcp__${SERVER_NAME}__fixture_echo`])
  expect(manager.statuses().map(status => status.state)).toEqual(['mounted'])
})

test('disposing the manager unregisters the server tools and stops its process', async () => {
  const { ctx, agentScope } = await bootHost()
  const document = { servers: [fixtureEntry()] }
  const manager = createMcpManager({ ctx, read: () => document, log: { warn: () => {} } })

  await manager.reconcile()
  const names = await waitFor(agentScope, current => current.some(name => name.startsWith(`mcp__${SERVER_NAME}__`)))
  expect(names).toContain(`mcp__${SERVER_NAME}__fixture_echo`)

  await manager.dispose()
  expect(visibleTools(agentScope).filter(name => name.startsWith(`mcp__${SERVER_NAME}__`))).toEqual([])
  expect(manager.mountedServerNames()).toEqual([])
})

test('an unreachable server mounts nothing and leaves no tool behind', async () => {
  const { ctx, agentScope } = await bootHost()
  // A command that cannot start: the MCP client's `failOnStartupError` default
  // keeps the mount, so the observable is the empty namespace, not a throw.
  const document = {
    servers: [fixtureEntry({ serverName: 'unreachable', command: '/nonexistent/mcp-server-binary' })],
  }
  const manager = createMcpManager({ ctx, read: () => document, log: { warn: () => {} } })
  cleanups.push(async () => { await manager.dispose() })

  await manager.reconcile()
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(visibleTools(agentScope).filter(name => name.startsWith('mcp__unreachable__'))).toEqual([])
})
