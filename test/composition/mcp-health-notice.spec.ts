/**
 * The MCP outage notice over the REAL seam.
 *
 * Two halves are asserted here and nothing about either is mocked:
 *
 * - the `webserver/index-inject` table the plugin actually emits, passed to the
 *   host's own `renderIndexInjections`, so the served index HTML really carries
 *   the polling script;
 * - the plugin-owned HTTP route, served by a REAL bound `WebServer` and fetched
 *   over a REAL socket, so the JSON the browser would poll is the JSON the
 *   process answers with.
 *
 * What is deliberately NOT asserted: the browser executing the injected script
 * and painting the DOM (no DOM is instantiated here), and the 60 s cadence of
 * the loop (the first tick runs immediately, and the assertions poll for its
 * effect rather than waiting a minute).
 */

import { afterEach, describe, expect, test } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as ProjectContext from '../../src/index.ts'
import { MCP_HEALTH_DOM_ID, MCP_HEALTH_ROUTE } from '../../src/diagnostics.ts'
import type { McpServerEntry } from '../../src/mcp/types.ts'
import type { Config } from '../../src/types.ts'

/**
 * The one method this plugin uses on a settings provider.
 *
 * `installMcpNamespace` is the ONLY trigger of a mount pass — it is the
 * namespace's `onChange` that arms the first `reconcile()` — so a composition
 * without a settings provider never mounts anything at all. Rather than mounting
 * the whole settings stack, this stub makes the entry config authoritative and
 * fires the hooks exactly as `SettingsProvider.installSection` does
 * (`packages/settings/settings/src/index.ts:472-496`).
 */
class EntrySettings extends Service {
  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  installSection<const Namespace extends string, T>(
    _owner: Context,
    _ns: Namespace,
    _schema: unknown,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void {
    hooks.setSource(() => entry)
    hooks.onChange()
  }
}

/** A minimal index document, shaped the way the real one is consumed. */
const INDEX_HTML = '<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>'

/** Values that must never reach the route payload or the injected script. */
const STDIO_SECRET = 'super-secret-stdio-token'
const STDIO_ARG_SECRET = 'super-secret-arg-value'
const HTTP_SECRET = 'super-secret-header-value'
const HTTP_URL = 'http://127.0.0.1:1/mcp?token=super-secret-url-value'

/** How long the first tick's retry confirmation window may take, plus slack. */
const TICK_TIMEOUT_MS = 25_000

let disposers: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  disposers = []
})

/** One fully resolved entry, as the settings namespace would hold it. */
function entry(over: Partial<McpServerEntry> & { serverName: string }): McpServerEntry {
  return {
    id: over.serverName,
    enabled: true,
    transport: 'stdio',
    command: '/nonexistent/mcp-server-binary',
    args: [],
    env: {},
    headers: {},
    cwd: '',
    url: '',
    toolCallTimeoutMs: 5_000,
    maxInstructionBytes: 0,
    ...over,
  }
}

interface Booted {
  readonly ctx: Context
  /** The raw injection table the host would collect right now. */
  injections(): IndexInjection[]
  /** The served index HTML, through the host's own collector + renderer. */
  servedIndex(): string
  /** `GET` the plugin's health route over a real socket. */
  health(): Promise<{ status: number; body: unknown }>
  /** Poll the route until the payload reports at least one server. */
  healthWhenPopulated(): Promise<{ status: number; body: unknown }>
}

/**
 * Boot the plugin with one unreachable stdio entry and one disabled entry, with
 * a real bound WebServer.
 * @param servers - the namespace document to seed.
 * @returns the booted composition.
 */
async function boot(servers: readonly McpServerEntry[]): Promise<Booted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Mounted BEFORE the plugin, so the namespace's `settings` inject resolves and
  // its `onChange` arms the first mount pass.
  disposers.push((await ctx.plugin(EntrySettings)).dispose)
  const config: Config = { globalAgentsDir: '/nonexistent', mcp: { servers } }
  disposers.push((await ctx.plugin(ProjectContext, config)).dispose)
  // Port 0 asks the OS for a free port, so a parallel suite cannot collide.
  disposers.push((await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })).dispose)

  const injections = (): IndexInjection[] => {
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    return table
  }
  const url = `http://127.0.0.1:${String(ctx.webServer.port)}${MCP_HEALTH_ROUTE}`
  const health = async (): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    return { status: response.status, body: await response.json() }
  }
  return {
    ctx,
    injections,
    servedIndex: () => renderIndexInjections(INDEX_HTML, injections()),
    health,
    async healthWhenPopulated() {
      const deadline = Date.now() + TICK_TIMEOUT_MS
      let last = await health()
      while (Date.now() < deadline) {
        const body = last.body as { servers?: unknown[] }
        if (Array.isArray(body.servers) && body.servers.length > 0) return last
        await new Promise(resolve => setTimeout(resolve, 250))
        last = await health()
      }
      return last
    },
  }
}

describe('the injected banner row', () => {
  test('the real index-inject table carries one MCP row whose script names the route and DOM id', async () => {
    const booted = await boot([entry({ serverName: 'Monolith' })])

    const rows = booted.injections().filter(row => row.kind === 'script')
    const row = rows.find(candidate => candidate.text.includes(MCP_HEALTH_DOM_ID))
    expect(row).toBeDefined()
    expect(row?.placement).toBe('body')
    expect(row?.kind === 'script' ? row.text.includes(MCP_HEALTH_ROUTE) : false).toBe(true)

    // …and it survives the host's own renderer into the served HTML.
    const html = booted.servedIndex()
    expect(html).toContain(MCP_HEALTH_DOM_ID)
    expect(html).toContain(MCP_HEALTH_ROUTE)
    expect(html).toContain('role')
  })

  test('the row is emitted even when the document is empty, so a later outage needs no reload', async () => {
    // The banner script is unconditional: it is the POLL that decides whether
    // anything is painted, so an outage starting after the page load still
    // appears without a refresh.
    const booted = await boot([])
    expect(booted.servedIndex()).toContain(MCP_HEALTH_DOM_ID)
  })
})

describe('the plugin-owned route', () => {
  test('answers 200 JSON and reports only the DOWN entries of a mixed document', async () => {
    const booted = await boot([
      entry({ serverName: 'Monolith' }),
      entry({ serverName: 'switched-off', enabled: false }),
    ])

    const response = await booted.healthWhenPopulated()
    expect(response.status).toBe(200)
    const body = response.body as { servers: Array<Record<string, unknown>> }
    expect(body.servers.map(server => server.serverName)).toEqual(['Monolith'])
    // Tri-state filtering: the disabled entry is `ignored`, so it is omitted.
    expect(JSON.stringify(body)).not.toContain('switched-off')
    expect(body.servers[0]?.status).toBe('down')
    expect(body.servers[0]?.reasonCode).toBe('no-tools-after-reconnect')
    expect(body.servers[0]?.detail).toBe('no tools registered after reconnect')
    expect(typeof body.servers[0]?.since).toBe('string')
  })

  test('serves the route as a named exact path with no caching', async () => {
    const booted = await boot([])
    const response = await fetch(`http://127.0.0.1:${String(booted.ctx.webServer.port)}${MCP_HEALTH_ROUTE}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    await response.json()
  })
})

describe('no secret reaches a browser', () => {
  test('neither the route payload nor the injected script carries a url, header or env value', async () => {
    const booted = await boot([
      entry({
        serverName: 'Monolith',
        command: '/nonexistent/mcp-server-binary',
        args: ['--api-key', STDIO_ARG_SECRET],
        env: { MONOLITH_TOKEN: STDIO_SECRET },
      }),
      entry({
        serverName: 'remote',
        transport: 'streamable-http',
        command: '',
        url: HTTP_URL,
        headers: { Authorization: `Bearer ${HTTP_SECRET}` },
      }),
    ])

    const response = await booted.healthWhenPopulated()
    const published = JSON.stringify(response.body) + booted.servedIndex()
    for (const secret of [STDIO_SECRET, STDIO_ARG_SECRET, HTTP_SECRET, HTTP_URL, 'super-secret-url-value']) {
      expect(published).not.toContain(secret)
    }
    // The allow-listed shape is what IS published.
    expect(published).toContain(MCP_HEALTH_ROUTE)
  })
})
