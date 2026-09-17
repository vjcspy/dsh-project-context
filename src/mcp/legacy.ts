/**
 * Read-only parser for the legacy MCP rows.
 *
 * Before this plugin owned an MCP namespace, every server on this machine was
 * one `@deepseek-ai/dsh-mcp-client` plugin row inside a cordis patch layer
 * (`$DSH_HOME/cordis.patch.yml` and the profile's own `cordis.patch.yml`).
 * The rows are the migration INPUT: the cut-over seeds the namespace with what
 * this parser returns, then retires the file. Nothing here writes, and nothing
 * here is consulted for conflict detection — a patch file cannot see a bundle
 * patch row or a runtime mount, which is what the tool registry is for.
 *
 * Row forms a patch layer may hold:
 * - a bare row `- id: mcp-x` `name: '@deepseek-ai/dsh-mcp-client'` `config: {…}`
 * - an `- insert: [ …rows ]` group, which is how the generated block held all
 *   four servers of the retired file.
 *
 * @module dsh-project-context/mcp/legacy
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { McpServerEntry, McpTransport } from './types.ts'

/** The cordis plugin name every legacy MCP row is installed under. */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** One parsed legacy row, ready to become a namespace entry. */
export interface LegacyMcpRow {
  /** The patch row's `id`. */
  readonly id: string
  /** The file the row was read from. */
  readonly source: string
  /** The entry this row would seed, with a fresh identity and no secrets dropped. */
  readonly entry: McpServerEntry
}

/** The parser's result: what it found, and what it could not read. */
export interface LegacyScan {
  /** Parsed rows, in patch-layer order then in-row order. */
  readonly rows: readonly LegacyMcpRow[]
  /** Absolute paths that were read, whether or not they held any row. */
  readonly sources: readonly string[]
  /** Non-fatal problems: an unreadable file, or a row that is not an MCP row. */
  readonly problems: readonly string[]
}

/** Where the patch layers live, and which exist. */
export interface LegacyMounts {
  /** `$DSH_HOME`, defaulting to `~/.dsh`. */
  readonly home: string
  /** The profile whose own patch layer is read as well, when it has one. */
  readonly profile: string | undefined
}

/**
 * Resolve the patch layers to read, matching the loader's application order
 * (profile layer first, then the home layer, then an overlay).
 * @param mounts - the resolved home directory and profile name.
 * @returns absolute patch file paths, in application order.
 */
export function legacyPatchPaths(mounts: LegacyMounts): string[] {
  const paths: string[] = []
  if (mounts.profile !== undefined && mounts.profile.length > 0) {
    paths.push(join(mounts.home, 'profiles', mounts.profile, 'cordis.patch.yml'))
  }
  paths.push(join(mounts.home, 'cordis.patch.yml'))
  return paths
}

/**
 * Resolve `$DSH_HOME`, matching the harness convention.
 * @returns the settings home directory.
 */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Read every patch layer and return the MCP rows it holds.
 *
 * A file that cannot be read, or that does not parse, is reported as a problem
 * rather than thrown: the migration must still be able to show the operator
 * what it found, and one unreadable layer is not a reason to lose the others.
 *
 * @param mounts - the patch layers to read.
 * @returns the parsed rows plus any problems.
 */
export function scanLegacyPatch(mounts: LegacyMounts): LegacyScan {
  const rows: LegacyMcpRow[] = []
  const sources: string[] = []
  const problems: string[] = []
  for (const path of legacyPatchPaths(mounts)) {
    let document: unknown
    try {
      document = load(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      const code: unknown = (error as { code?: unknown }).code
      // A missing layer is the normal case for a profile that has none.
      if (code !== 'ENOENT') problems.push(`${path}: ${String(error)}`)
      continue
    }
    sources.push(path)
    collectRows(document, path, rows, problems)
  }
  return { rows, sources, problems }
}

function collectRows(document: unknown, source: string, rows: LegacyMcpRow[], problems: string[]): void {
  if (!Array.isArray(document)) {
    if (document !== null && document !== undefined) problems.push(`${source}: the patch layer is not a list of rows`)
    return
  }
  for (const patch of document) {
    if (!isRecord(patch)) {
      problems.push(`${source}: a patch entry is not a mapping`)
      continue
    }
    const inserted = patch['insert']
    if (Array.isArray(inserted)) {
      for (const row of inserted) readRow(row, source, rows, problems)
      continue
    }
    readRow(patch, source, rows, problems)
  }
}

function readRow(row: unknown, source: string, rows: LegacyMcpRow[], problems: string[]): void {
  if (!isRecord(row)) {
    problems.push(`${source}: an entry is not a mapping`)
    return
  }
  if (row['name'] !== MCP_CLIENT_PLUGIN) return
  if (row['disabled'] === true) return
  const id = typeof row['id'] === 'string' && row['id'].length > 0 ? row['id'] : undefined
  if (id === undefined) {
    problems.push(`${source}: an ${MCP_CLIENT_PLUGIN} row has no id`)
    return
  }
  const config = row['config']
  if (!isRecord(config)) {
    problems.push(`${source}: row "${id}" has no config`)
    return
  }
  const entry = toEntry(id, config)
  if (entry === undefined) {
    problems.push(`${source}: row "${id}" is not a stdio or streamable-http server config`)
    return
  }
  rows.push({ id, source, entry })
}

/** One optional string in a legacy config. */
function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** Whether every present member of a legacy string map is a string. */
function readStringMap(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key]
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') return undefined
    out[entryKey] = entryValue
  }
  return out
}

/** Whether a legacy `args` list holds only strings. */
function readStringList(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

/**
 * Convert one legacy config into a namespace entry.
 *
 * Only fields the MCP client's own config declares are read; the transport
 * discriminant selects which ones apply. A `serverName` is required, and the
 * transport must be one the client knows — anything else is a row this plugin
 * cannot take over.
 *
 * @param id - the patch row's id, reused as the entry's stable id.
 * @param config - the row's raw `config` mapping.
 * @returns the entry, or undefined when the config is not a server config.
 */
export function toEntry(id: string, config: Record<string, unknown>): McpServerEntry | undefined {
  const transport: unknown = config['transport']
  const serverName: unknown = config['serverName']
  if (typeof serverName !== 'string' || serverName.length === 0) return undefined
  if (!isTransport(transport)) return undefined
  const common = {
    id,
    serverName,
    enabled: config['enabled'] !== false,
    toolCallTimeoutMs: typeof config['toolCallTimeoutMs'] === 'number' ? config['toolCallTimeoutMs'] : 60_000,
    maxInstructionBytes: typeof config['maxInstructionBytes'] === 'number' ? config['maxInstructionBytes'] : 0,
  }
  if (transport === 'stdio') {
    const command: unknown = config['command']
    if (typeof command !== 'string' || command.length === 0) return undefined
    const args = readStringList(config, 'args')
    const env = readStringMap(config, 'env')
    if (args === undefined || env === undefined) return undefined
    return {
      ...common,
      transport,
      command,
      args,
      env,
      cwd: readString(config, 'cwd'),
      url: '',
      headers: {},
    }
  }
  const url: unknown = config['url']
  if (typeof url !== 'string' || url.length === 0) return undefined
  const headers = readStringMap(config, 'headers')
  if (headers === undefined) return undefined
  return {
    ...common,
    transport,
    command: '',
    args: [],
    env: {},
    cwd: '',
    url,
    headers,
  }
}

function isTransport(value: unknown): value is McpTransport {
  return value === 'stdio' || value === 'streamable-http'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
