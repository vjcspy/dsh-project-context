/**
 * Shared vocabulary for the plugin-owned MCP server namespace.
 *
 * One entry is the durable description of ONE MCP server the operator manages
 * from the Settings section. The shape is deliberately FLAT: `transport` is an
 * enum field on the same object as every transport-specific field, never a
 * discriminated union. {@link import('./schema.ts').McpManagerConfig} states
 * the reason at the schema.
 *
 * @module dsh-project-context/mcp/types
 */

/** Which transport an entry configures. */
export type McpTransport = 'stdio' | 'streamable-http'

/**
 * One managed MCP server as stored in the settings namespace.
 *
 * Every field is present after schema resolution; the parser-facing input may
 * omit the ones carrying defaults. `id` is allocated once by the Settings card
 * and never reused, so a later edit replaces an entry in place instead of
 * remounting it under a fresh path segment.
 */
export interface McpServerEntry {
  /** Stable, card-allocated identity. */
  readonly id: string
  /**
   * Model-facing tool-name namespace: `mcp__<serverName>__<rawName>`. Must
   * match the MCP client's own pattern (`[A-Za-z0-9_-]{1,32}`) and be unique
   * across the list.
   */
  readonly serverName: string
  /** Whether this server is currently mounted. */
  readonly enabled: boolean
  /** Selects which transport fields apply. */
  readonly transport: McpTransport
  /** Executable to spawn. `stdio` only; required there. */
  readonly command: string
  /** Extra arguments. `stdio` only. */
  readonly args: readonly string[]
  /** Extra environment variables, overrides resolved defaults. `stdio` only. */
  readonly env: Record<string, string>
  /** Extra HTTP headers. `streamable-http` only. Values are write-only. */
  readonly headers: Record<string, string>
  /** Working directory for the child process. `stdio` only; empty means inherit. */
  readonly cwd: string
  /** MCP endpoint. `streamable-http` only; required there. */
  readonly url: string
  /** Timeout for one tool call, in milliseconds. */
  readonly toolCallTimeoutMs: number
  /** Maximum attributed instruction bytes. Zero means the MCP client default. */
  readonly maxInstructionBytes: number
}

/** The namespace document: every managed server, in list order. */
export interface McpManagerConfig {
  /** Managed servers. Absent for a repository that ships no default servers. */
  readonly servers: readonly McpServerEntry[]
}

/**
 * The settings namespace this plugin owns.
 *
 * rc.1 keys configuration forms by profile entry id, so the managed servers live
 * in this plugin's OWN entry form (`mcp.servers`) instead of a separate
 * namespace. The id matches the bundle patch row (`cordis.patch.yml`).
 */
export const MCP_NAMESPACE = 'dsh-project-context'

/** The composition-layer value the plugin entry supplies as the namespace base. */
export const MCP_NAMESPACE_BASE: McpManagerConfig = { servers: [] }
