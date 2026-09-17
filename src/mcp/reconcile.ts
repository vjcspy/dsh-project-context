/**
 * Reconcile the namespace document against the live mount map.
 *
 * Pure and synchronous: it turns "what the document says" and "what is
 * mounted" into the list of mount/unmount operations that closes the gap, plus
 * the per-server states the Settings card renders. No host service is touched
 * here, which is what makes every branch testable without a booted runtime —
 * the caller applies the plan and owns the async ordering.
 *
 * @module dsh-project-context/mcp/reconcile
 */

import { resolveMcpServer } from './schema.ts'
import type { McpServerEntry } from './types.ts'
import type { McpServerConfig } from './runtime.ts'

/**
 * What the card renders for one entry. `mounted` is the mount path's own
 * belief, never a claim that the server answers: the MCP client exposes no
 * connection state, so a mount that failed to connect still reports `mounted`
 * unless the registry shows the namespace stayed empty, which is reported as
 * `empty` — the silent-failure symptom `failOnStartupError: false` hides. A
 * tool collision reports `conflict` even though nothing was mounted.
 */
export type McpServerState = 'mounted' | 'empty' | 'disabled' | 'conflict' | 'invalid' | 'failed'

/** The observed state of one managed server after a reconcile pass. */
export interface McpServerStatus {
  /** {@link import('./types.ts').McpServerEntry.id} of the entry this describes. */
  readonly id: string
  /** The entry's `serverName`, echoed so a removed entry's status stays readable. */
  readonly serverName: string
  /** What the card renders. */
  readonly state: McpServerState
  /** Human-readable cause for `conflict`, `invalid`, and `failed`. */
  readonly reason?: string
}

/**
 * The manager's view of the world, supplied by the caller.
 *
 * Every member is a plain value rather than a service, so a caller can build
 * one from a booted composition or from a test literal.
 */
export interface ReconcileInput {
  /** The namespace document's entries, in list order. */
  readonly entries: readonly McpServerEntry[]
  /** `serverName` → the config currently mounted for it. */
  readonly mounted: ReadonlyMap<string, McpServerConfig>
  /**
   * Every live tool name, for conflict detection.
   *
   * Read from the tool registry, never from a patch file: a `serverName` can
   * arrive from a bundle patch, a profile patch row, or another runtime mount,
   * and a file reader sees none of the runtime ones. A name that is ALREADY
   * owned by a mounted server of ours is not a conflict — the plan unmounts it
   * before mounting its replacement.
   */
  readonly toolNames: ReadonlySet<string>
  /** Per-`serverName` refusals raised by the mount path on this pass or an earlier one. */
  readonly failures?: ReadonlyMap<string, string>
  /**
   * `serverName`s that are mounted but whose tool namespace is still empty
   * after the caller's settle window. Rendered as `empty` rather than as a
   * failure, because a mount that connected is not evidence that the server
   * exposes any tool.
   */
  readonly emptyNamespaces?: ReadonlySet<string>
}

/** What the caller must do to make the live mounts match the document. */
export interface ReconcilePlan {
  /** `serverName`s to dispose, in the order they must be disposed. */
  readonly unmount: readonly string[]
  /** Configs to mount, in document order, after every unmount has settled. */
  readonly mount: readonly McpServerConfig[]
  /** One entry per document entry, in document order. */
  readonly statuses: readonly McpServerStatus[]
}

/**
 * Whether two resolved configs describe the same mount.
 *
 * The mount is torn down and rebuilt only when a field the MCP client reads at
 * startup changes, so an edit to an unrelated entry — or a save that changes
 * nothing — does not disconnect a working server. `id` is deliberately not
 * compared: it is the card's identity, not the mount's.
 *
 * @param left - one resolved config.
 * @param right - the other resolved config.
 * @returns true when the two would produce the same connection.
 */
export function sameMcpServerConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  if (left.transport !== right.transport) return false
  if (left.serverName !== right.serverName) return false
  if (left.toolCallTimeoutMs !== right.toolCallTimeoutMs) return false
  if (left.maxInstructionBytes !== right.maxInstructionBytes) return false
  if (left.transport === 'stdio' && right.transport === 'stdio') {
    return left.command === right.command
      && left.cwd === right.cwd
      && sameStringList(left.args, right.args)
      && sameStringMap(left.env, right.env)
  }
  if (left.transport === 'streamable-http' && right.transport === 'streamable-http') {
    return left.url === right.url && sameStringMap(left.headers, right.headers)
  }
  return false
}

/**
 * Whether the live tool registry already owns one server's tool namespace.
 *
 * MCP tool names are `mcp__<serverName>__<rawName>`, normalized to
 * `[A-Za-z0-9_-]` and suffixed with 12 hex characters when the joined name is
 * too long or the raw name needs rewriting, so the test is a PREFIX match and
 * never an equality against a full name.
 *
 * @param serverName - the candidate namespace.
 * @param toolNames - every live tool name.
 * @returns true when at least one live tool is already in that namespace.
 */
export function ownsMcpToolNamespace(serverName: string, toolNames: ReadonlySet<string>): boolean {
  const prefix = `mcp__${serverName}__`
  for (const name of toolNames) {
    if (name.startsWith(prefix)) return true
  }
  return false
}

/**
 * Compute the mount plan that closes the gap between the document and the live
 * mounts, plus each entry's rendered state.
 *
 * Ordering is part of the result: every unmount precedes every mount, because
 * the MCP client's `serverName` reservation is per registration scope and a
 * replacement for a live name would otherwise be refused as a duplicate.
 *
 * @param input - the document, the live mounts, and the live tool names.
 * @returns the plan the caller applies.
 */
export function reconcile(input: ReconcileInput): ReconcilePlan {
  const desired = new Map<string, McpServerEntry>()
  for (const entry of input.entries) {
    // First entry wins a duplicated name; `validateEntries` refuses the write,
    // so this can only be reached by a hand-edited document.
    if (!desired.has(entry.serverName)) desired.set(entry.serverName, entry)
  }

  const statuses: McpServerStatus[] = []
  const toUnmount: string[] = []
  for (const serverName of input.mounted.keys()) {
    if (desired.get(serverName)?.enabled !== true) toUnmount.push(serverName)
  }

  const unmounting = new Set(toUnmount)
  const toMount: McpServerConfig[] = []
  const mounting = new Set<string>()
  const claimed = new Set<string>()

  for (const entry of input.entries) {
    const { serverName } = entry
    if (claimed.has(serverName)) {
      statuses.push({ id: entry.id, serverName, state: 'invalid', reason: `serverName "${serverName}" is declared by an earlier entry` })
      continue
    }
    claimed.add(serverName)
    if (!entry.enabled) {
      statuses.push({ id: entry.id, serverName, state: 'disabled' })
      continue
    }
    const failure = input.failures?.get(serverName)
    if (failure !== undefined) {
      statuses.push({ id: entry.id, serverName, state: 'failed', reason: failure })
      continue
    }
    const live = input.mounted.get(serverName)
    // A conflict is only real when the namespace belongs to somebody else. A
    // mount of ours is being replaced by this very plan, so it is not one.
    const foreign = !mounting.has(serverName)
      && !unmounting.has(serverName)
      && live === undefined
      && ownsMcpToolNamespace(serverName, input.toolNames)
    if (foreign) {
      statuses.push({
        id: entry.id,
        serverName,
        state: 'conflict',
        reason: `a tool named mcp__${serverName}__… is already registered by another plugin or mount`,
      })
      continue
    }
    const config = resolveMcpServer(entry)
    if (live !== undefined && sameMcpServerConfig(live, config)) {
      statuses.push({
        id: entry.id,
        serverName,
        state: input.emptyNamespaces?.has(serverName) === true ? 'empty' : 'mounted',
      })
      continue
    }
    mounting.add(serverName)
    if (live !== undefined && !unmounting.has(serverName)) toUnmount.push(serverName)
    toMount.push(config)
    statuses.push({ id: entry.id, serverName, state: 'mounted' })
  }

  return { unmount: toUnmount, mount: toMount, statuses }
}

/**
 * The suffix appended to a raw MCP tool name to build its public name.
 * Exported so tests and the card can reason about the namespace without
 * restating the format.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Whether a tool name belongs to one server's namespace.
 * @param serverName - the candidate namespace.
 * @param toolName - one live tool name.
 * @returns true when the name carries this server's prefix.
 */
export function isMcpToolOf(serverName: string, toolName: string): boolean {
  return toolName.startsWith(`${MCP_TOOL_PREFIX}${serverName}__`)
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStringMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}
