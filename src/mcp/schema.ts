/**
 * Schemastery schema for the plugin-owned MCP server namespace, plus the
 * constraints a schema cannot express.
 *
 * **The schema is a single flat object, never a discriminated union.** The
 * settings redaction walker (`packages/settings/settings/src/redact.ts`)
 * recurses into `object`, `dict` and `array` nodes and returns every OTHER
 * node verbatim; a union node is therefore opaque to it, so a mirrored
 * `stdio` | `streamable-http` union would put a plaintext API key on the
 * settings wire with `secrets[]` empty — a leak with no record of the miss.
 * Keeping `transport` an enum field on one flat object leaves the walker in
 * the `dict`/`array` cases that work, and moves the per-transport
 * requirements into {@link validateEntries}, which the `installSection`
 * `validate` hook runs before anything persists.
 *
 * @module dsh-project-context/mcp/schema
 */

import z from '@deepseek-ai/schemastery'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import {
  ALLOWED_URL_PROTOCOLS,
  MAX_ARG_LENGTH,
  MAX_ARGS,
  MAX_COMMAND_LENGTH,
  MAX_CWD_LENGTH,
  MAX_ENV_ENTRIES,
  MAX_ENV_VALUE_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  MAX_HEADERS,
  MAX_ID_LENGTH,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVERS,
  MAX_URL_LENGTH,
  SERVER_NAME_PATTERN,
} from './bounds.ts'
import type { McpManagerConfig as McpManagerConfigShape, McpServerEntry, McpTransport } from './types.ts'

/** The namespace document as the schema resolves it. */
export type McpManagerConfigResolved = McpManagerConfigShape

/**
 * One server entry as the schema RESOLVES it: every field present.
 *
 * The parser-facing input type is derived by the schema itself — a field with
 * a `.default()` is optional on input — so this alias is only ever the
 * resolved side of the type.
 */
export type McpServerEntryResolved = McpServerEntry

const entrySchema = z.object({
  /** Card-allocated identity; opaque to the host half. */
  id: z.string().max(MAX_ID_LENGTH).required(),
  /**
   * Tool-name namespace. The pattern is duplicated from the MCP client's own
   * `SERVER_NAME_PATTERN` because that constant is module-private there, and a
   * mismatch is otherwise refused at mount time with a far less actionable
   * message.
   */
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  enabled: z.boolean().default(true),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).required(),
  command: z.string().max(MAX_COMMAND_LENGTH).default(''),
  args: z.array(z.string().max(MAX_ARG_LENGTH)).max(MAX_ARGS).default([]),
  /**
   * Every environment value is a potential credential — a `stdio` server
   * commonly takes its token or API key through `env`, exactly as a
   * `streamable-http` server does through `headers` — so the whole collection
   * is a secret position on the same terms as `headers`: stripped from every
   * wire document and enumerated in `secrets[]` as one path per configured
   * entry. The dict NODE is walked either way, so this costs nothing in walker
   * coverage and needs no schema reshaping.
   */
  env: z.dict(z.string().max(MAX_ENV_VALUE_LENGTH).role('secret')).max(MAX_ENV_ENTRIES).default({}),
  /**
   * Every header value is a potential credential — the legacy Context7 row
   * carried its API key as a plaintext `CONTEXT7_API_KEY` header — so the
   * whole collection is a secret position: it is stripped from every wire
   * document and enumerated in `secrets[]` as one path per configured entry.
   */
  headers: z.dict(z.string().max(MAX_HEADER_VALUE_LENGTH).role('secret')).max(MAX_HEADERS).default({}),
  cwd: z.string().max(MAX_CWD_LENGTH).default(''),
  url: z.string().max(MAX_URL_LENGTH).default(''),
  toolCallTimeoutMs: z.number().default(60_000),
  /** Zero means "use the MCP client's own default". */
  maxInstructionBytes: z.number().default(0),
})

/**
 * The MCP server namespace schema.
 *
 * The cast spells the input type (defaults optional) explicitly, because
 * schemastery derives a resolved type from `.default()` calls that reads
 * optional fields as `| undefined`; the resolved document is the settings
 * service's `T`, and every field is present after a real resolution.
 */
export const McpManagerConfig = z.object({
  servers: z.array(entrySchema).max(MAX_SERVERS).default([]),
}) as unknown as z<McpManagerConfigInput, McpManagerConfigResolved>

/** Parser-facing namespace document: every defaulted field may be omitted. */
export interface McpManagerConfigInput {
  /** Managed servers; omission means none. */
  readonly servers?: readonly McpServerEntryInput[]
}

/** Parser-facing entry: every defaulted field may be omitted. */
export interface McpServerEntryInput extends Partial<Omit<McpServerEntry, 'id' | 'serverName' | 'transport'>> {
  /** Stable, card-allocated identity. */
  readonly id: string
  /** Tool-name namespace. */
  readonly serverName: string
  /** Selects which transport fields apply. */
  readonly transport: McpTransport
}

/**
 * Constraints the schema cannot express, checked as a group.
 *
 * Reported as one list rather than thrown one at a time: an invalid write is
 * refused at the settings boundary, and the operator must be able to fix every
 * reported field in one pass instead of rediscovering the next complaint.
 *
 * @param config - the resolved namespace document.
 * @returns one human-readable reason per violated constraint, in list order.
 */
export function validateEntries(config: McpManagerConfigResolved): string[] {
  const reasons: string[] = []
  if (config.servers.length > MAX_SERVERS) {
    reasons.push(`at most ${String(MAX_SERVERS)} servers are supported, received ${String(config.servers.length)}`)
  }
  const seen = new Map<string, number>()
  config.servers.forEach((entry, index) => {
    const where = `servers[${String(index)}]`
    const name = entry.serverName
    if (!SERVER_NAME_PATTERN.test(name)) {
      reasons.push(
        `${where}.serverName "${name}" must match ${String(SERVER_NAME_PATTERN)} (at most ${String(MAX_SERVER_NAME_LENGTH)} characters)`,
      )
    }
    const first = seen.get(name)
    if (first !== undefined) {
      reasons.push(`${where}.serverName "${name}" duplicates servers[${String(first)}].serverName; tool names would shadow each other`)
    } else {
      seen.set(name, index)
    }
    if (entry.transport === 'stdio') {
      if (entry.command.trim().length === 0) {
        reasons.push(`${where}.command is required for the stdio transport`)
      }
      if (entry.url.length > 0) {
        reasons.push(`${where}.url does not apply to the stdio transport`)
      }
    } else {
      if (entry.url.trim().length === 0) {
        reasons.push(`${where}.url is required for the streamable-http transport`)
      } else if (!isHttpUrl(entry.url)) {
        reasons.push(`${where}.url "${entry.url}" must be an absolute ${ALLOWED_URL_PROTOCOLS.join(' or ')} URL`)
      }
      if (entry.command.length > 0) {
        reasons.push(`${where}.command does not apply to the streamable-http transport`)
      }
    }
  })
  return reasons
}

/**
 * Validate a namespace document, throwing an aggregated refusal.
 *
 * Shaped as the `installSection` `validate` hook.
 * @param config - the resolved namespace document.
 * @throws {TypeError} when any constraint is violated.
 */
export function validateManagerConfig(config: McpManagerConfigResolved): void {
  const reasons = validateEntries(config)
  if (reasons.length > 0) throw new TypeError(`mcp servers: ${reasons.join('; ')}`)
}

/**
 * Resolve a namespace document into the MCP client's own config objects.
 * @param config - the resolved namespace document.
 * @returns one complete MCP client config per entry, in list order.
 * @throws {TypeError} when a collection bound is exceeded.
 */
export function resolveManagerConfig(config: McpManagerConfigResolved): McpClientConfig[] {
  return config.servers.map(entry => resolveMcpServer(entry))
}

/**
 * Whether a string is an absolute HTTP(S) URL.
 * @param value - the candidate URL.
 * @returns true when the URL parses and its protocol is HTTP or HTTPS.
 */
export function isHttpUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)
}

/**
 * Resolve one entry into the MCP client's own config object.
 *
 * The client's `Config` is a discriminated union whose defaults are applied by
 * its schema; this namespace schema has already resolved every field, so the
 * object built here is complete and matches one union branch exactly. The
 * collection bounds are re-checked here — not only in {@link validateEntries} —
 * because a hand-edited `settings.yaml` never passes through the `validate`
 * hook.
 *
 * @param entry - one resolved entry.
 * @returns the complete MCP client config for that entry.
 * @throws {TypeError} when a collection bound is exceeded.
 */
export function resolveMcpServer(entry: McpServerEntryResolved): McpClientConfig {
  if (entry.args.length > MAX_ARGS) {
    throw new TypeError(`mcp servers: "${entry.serverName}" has ${String(entry.args.length)} args, at most ${String(MAX_ARGS)} are supported`)
  }
  if (Object.keys(entry.env).length > MAX_ENV_ENTRIES) {
    throw new TypeError(`mcp servers: "${entry.serverName}" has ${String(Object.keys(entry.env).length)} env entries, at most ${String(MAX_ENV_ENTRIES)} are supported`)
  }
  if (Object.keys(entry.headers).length > MAX_HEADERS) {
    throw new TypeError(`mcp servers: "${entry.serverName}" has ${String(Object.keys(entry.headers).length)} headers, at most ${String(MAX_HEADERS)} are supported`)
  }
  const shared = {
    serverName: entry.serverName,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    // Always soft: a server that is down must not veto plugin activation, and
    // the mount path reports the failure through its own state instead.
    failOnStartupError: false,
    // Zero means "keep the MCP client's own default", so the field is omitted
    // rather than sent as an explicit zero, which its schema would refuse.
    ...entry.maxInstructionBytes > 0 ? { maxInstructionBytes: entry.maxInstructionBytes } : {},
  }
  if (entry.transport === 'stdio') {
    return { ...shared, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, cwd: entry.cwd }
  }
  return { ...shared, transport: 'streamable-http', url: entry.url, headers: { ...entry.headers } }
}
