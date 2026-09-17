/**
 * Secret redaction on the SHIPPED namespace schema.
 *
 * The settings redaction walker returns a node it does not recognize verbatim,
 * so a schema whose shape mirrors the MCP client's `stdio | streamable-http`
 * discriminated union would put a plaintext API key on the settings wire with
 * an empty `secrets[]`. This spec proves both halves of that claim against the
 * real schema: the flat object redacts both secret positions, and a union does
 * not.
 */

import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SettingsProvider from '@deepseek-ai/dsh-settings'
// The walker's own subpath is not in the package's exports map, so the spec
// reaches the source file directly — it is proof material, not a consumer edge.
import { redactSecrets } from '@deepseek-ai/dsh-settings/src/redact.ts'
import { McpManagerConfig } from '../../src/mcp/schema.ts'
import { MCP_NAMESPACE } from '../../src/mcp/types.ts'

const API_KEY = 'ctx7-sk-super-secret-value'
const ENV_TOKEN = 'ghp-env-super-secret-value'

/** Minimal in-memory settings provider: the namespace needs a real host. */
class MemorySettings extends SettingsProvider {
  override readonly writable = true
  /**
   * The raw document the provider loads. Static because `load()` runs during
   * the plugin's own init, before a test can reach the instance: the seed must
   * be in place before the provider mounts, or the namespace resolves against
   * an empty document and never re-resolves.
   */
  static seed: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(MemorySettings.seed))
  }

  protected override persist(ns: string, section: Record<string, unknown>): Promise<void> {
    MemorySettings.seed = { ...MemorySettings.seed, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Bring up a host whose settings document already holds the seed. */
async function bootSeeded(): Promise<Context> {
  MemorySettings.seed = structuredClone(seededDocument)
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  return ctx
}

/** The document a migrated installation holds. */
const seededDocument = {
  [MCP_NAMESPACE]: {
    servers: [
      {
        id: 'doccontext',
        serverName: 'mcp-doccontext',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: API_KEY },
      },
      {
        // A `stdio` server holding its credential in `env` instead: a second
        // one-entry server keeps both positions in one document, so the
        // assertion below covers the header path and the env path together.
        id: 'github',
        serverName: 'mcp-github',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: ENV_TOKEN },
      },
    ],
  },
}

describe('shipped namespace schema', () => {
  test('describe({ redactSecrets: true }) returns no env or header value and lists every secret path', async () => {
    const ctx = await bootSeeded()
    const scope = ctx.settings.register(MCP_NAMESPACE, McpManagerConfig, { base: { servers: [] } })
    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === MCP_NAMESPACE)

    expect(descriptor).toBeDefined()
    const serialized = JSON.stringify(descriptor)
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain('sk-super-secret')
    // `env` is a secret position on the same terms as `headers`: a stdio server
    // takes its token through `env`, and a value that reached the wire would be
    // a leak the card could neither show nor re-send.
    expect(serialized).not.toContain(ENV_TOKEN)
    expect(serialized).not.toContain('env-super-secret')
    // The NAME of each is still present: a card must be able to show that a
    // credential is configured without ever reading it. Both paths are listed,
    // in document order, so a walker that stopped covering one of them fails.
    expect(descriptor?.secrets).toEqual([
      { path: ['servers', '0', 'headers', 'CONTEXT7_API_KEY'], set: true },
      { path: ['servers', '1', 'env', 'GITHUB_TOKEN'], set: true },
    ])
    expect(scope.get().servers[0]?.url).toBe('https://mcp.context7.com/mcp')
  })

  test('the UNREDACTED read is what the wire must never use', async () => {
    const ctx = await bootSeeded()
    ctx.settings.register(MCP_NAMESPACE, McpManagerConfig, { base: { servers: [] } })
    const descriptor = ctx.settings.describe().find(candidate => candidate.ns === MCP_NAMESPACE)
    // Documents why every read path passes `redactSecrets: true`: the default
    // is verbatim, and these are the values it hands back.
    expect(JSON.stringify(descriptor)).toContain(API_KEY)
    expect(JSON.stringify(descriptor)).toContain(ENV_TOKEN)
    expect(descriptor?.secrets).toBeUndefined()
  })

  test('a union node defeats the walker, which is why the schema is flat', () => {
    const union = z.union([
      z.object({ transport: z.const('streamable-http'), headers: z.dict(z.string().role('secret')) }),
      z.object({ transport: z.const('stdio'), command: z.string() }),
    ])
    const redacted = redactSecrets(
      union as never,
      { transport: 'streamable-http', headers: { CONTEXT7_API_KEY: API_KEY } },
    )
    expect(JSON.stringify(redacted.value)).toContain(API_KEY)
    expect(redacted.secrets).toEqual([])
  })
})
