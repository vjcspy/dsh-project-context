/**
 * Bounded, synchronous discovery of markdown agent definitions.
 *
 * Discovery MUST be synchronous: `agent/created` is dispatched inline and a
 * returned Promise is not awaited (`packages/core/agent/src/index.ts:545-553`),
 * so an async scan would miss the first prompt assembly. It MUST also be
 * bounded, because the project root is arbitrary and only known per Agent.
 *
 * @module dsh-project-context/discovery
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DiagnosticSink } from './diagnostics.ts'
import { parseAgentFile } from './frontmatter.ts'
import type { Config, DiscoveredAgentFile, Layer, ResourceBounds } from './types.ts'

/** Agent-capability slice of {@link ResourceBounds}. */
export type AgentBounds = Pick<ResourceBounds, 'maxAgents' | 'maxFileBytes' | 'maxTotalBytes'>

/** Default agent resource bounds; each is overridable on the plugin entry. */
export const DEFAULT_BOUNDS: AgentBounds = {
  maxAgents: 16,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
}

/** Directory holding project-local definitions, relative to the project root. */
export const PROJECT_AGENTS_SUBDIR = join('.dsh', 'agents')

/** Repository marker that identifies the project root. */
const PROJECT_ROOT_MARKER = '.git'

/** Hard ceiling on directory entries examined per layer, independent of caps. */
const MAX_DIRECTORY_ENTRIES = 1000

/**
 * Validate and materialize the configured bounds. Fails loud at plugin load,
 * before any Agent can mount anything, because a nonsense cap is a deployment
 * error rather than a per-file one.
 * @param config - the plugin entry configuration.
 * @returns the resolved bounds.
 * @throws when any override is not a positive safe integer.
 */
export function resolveBounds(config: Config): AgentBounds {
  const read = (value: number | undefined, key: string, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-project-context: \`${key}\` must be a positive safe integer, got ${String(value)}`)
    }
    return value
  }
  return {
    maxAgents: read(config.maxAgents, 'maxAgents', DEFAULT_BOUNDS.maxAgents),
    maxFileBytes: read(config.maxFileBytes, 'maxFileBytes', DEFAULT_BOUNDS.maxFileBytes),
    maxTotalBytes: read(config.maxTotalBytes, 'maxTotalBytes', DEFAULT_BOUNDS.maxTotalBytes),
  }
}

/**
 * The global definitions directory. Mirrors `dshHome()`: `$DSH_HOME` wins,
 * otherwise `~/.dsh`.
 * @param config - the plugin entry configuration.
 * @param env - process environment (injectable for tests).
 * @returns the absolute global agents directory.
 */
export function globalAgentsDir(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (config.globalAgentsDir !== undefined) return config.globalAgentsDir
  const home = env['DSH_HOME']
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(root, 'agents')
}

/**
 * Walk up from `cwd` to the nearest ancestor containing `.git`, matching the
 * host convention used by skills and agent-instructions.
 * @param cwd - an absolute starting directory.
 * @returns the project root, or undefined when no ancestor carries the marker.
 */
export function findProjectRoot(cwd: string): string | undefined {
  if (!isAbsolute(cwd)) return undefined
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, PROJECT_ROOT_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

interface ScanState {
  total: number
  capped: boolean
}

/**
 * Read one layer's `*.md` files into validated definitions.
 * Sorted by filename so a cap truncates deterministically.
 */
function scanLayer(
  directory: string,
  layer: Layer,
  bounds: AgentBounds,
  sink: DiagnosticSink,
  state: ScanState,
): DiscoveredAgentFile[] {
  const found: DiscoveredAgentFile[] = []
  let names: string[]
  try {
    if (!statSync(directory).isDirectory()) return found
    names = readdirSync(directory)
  } catch {
    // An absent directory is the ordinary case, not a diagnostic.
    return found
  }
  if (names.length > MAX_DIRECTORY_ENTRIES) {
    sink.add({
      severity: 'error',
      path: directory,
      reason: `directory holds more than ${String(MAX_DIRECTORY_ENTRIES)} entries; not scanned`,
    })
    return found
  }
  for (const name of names.filter(entry => entry.endsWith('.md')).sort()) {
    if (state.capped) return found
    const path = join(directory, name)
    let size: number
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      size = stats.size
    } catch (error: unknown) {
      sink.add({ severity: 'error', path, reason: `cannot stat: ${String(error)}` })
      continue
    }
    if (size > bounds.maxFileBytes) {
      sink.add({
        severity: 'error',
        path,
        reason: `file is ${String(size)} bytes, above the ${String(bounds.maxFileBytes)}-byte per-file cap`,
      })
      continue
    }
    if (state.total + size > bounds.maxTotalBytes) {
      sink.add({
        severity: 'error',
        path,
        reason: `total definition bytes would exceed the ${String(bounds.maxTotalBytes)}-byte cap; discovery stopped here`,
      })
      state.capped = true
      return found
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      sink.add({ severity: 'error', path, reason: `cannot read: ${String(error)}` })
      continue
    }
    state.total += size
    const parsed = parseAgentFile(path, text)
    if (!parsed.ok) {
      sink.add(parsed.diagnostic)
      continue
    }
    found.push({ path, layer, fields: parsed.fields })
  }
  return found
}

/** Result of one bounded discovery pass, before tool-name resolution. */
export interface DiscoveryResult {
  readonly files: readonly DiscoveredAgentFile[]
  readonly projectRoot: string | undefined
}

/**
 * Run one bounded synchronous discovery pass for a given cwd.
 *
 * Project definitions shadow global ones by agent `name`. Duplicate names
 * WITHIN one layer are a rejection, not a silent last-wins.
 * @param cwd - the Agent's absolute working directory.
 * @param config - the plugin entry configuration.
 * @param bounds - the resolved resource bounds.
 * @param sink - diagnostics accumulator for skipped files and caps.
 * @param env - process environment (injectable for tests).
 * @returns the discovered files and the resolved project root.
 */
export function discover(
  cwd: string,
  config: Config,
  bounds: AgentBounds,
  sink: DiagnosticSink,
  env: NodeJS.ProcessEnv = process.env,
): DiscoveryResult {
  const state: ScanState = { total: 0, capped: false }
  const projectRoot = findProjectRoot(cwd)
  const globalDir = globalAgentsDir(config, env)
  // Project first: it wins a name collision, and it is also the layer worth
  // spending the byte budget on when the total cap bites.
  const projectFiles = projectRoot === undefined
    ? []
    : scanLayer(join(projectRoot, PROJECT_AGENTS_SUBDIR), 'project', bounds, sink, state)
  const globalFiles = scanLayer(globalDir, 'global', bounds, sink, state)

  const byName = new Map<string, DiscoveredAgentFile>()
  const claimed = new Map<string, string>()
  for (const layer of [projectFiles, globalFiles]) {
    const seenInLayer = new Set<string>()
    for (const file of layer) {
      const existing = byName.get(file.fields.name)
      if (seenInLayer.has(file.fields.name)) {
        sink.add({
          severity: 'error',
          path: file.path,
          field: 'name',
          reason: `duplicate agent name "${file.fields.name}" within the same layer (also declared by ${String(claimed.get(file.fields.name))})`,
        })
        continue
      }
      seenInLayer.add(file.fields.name)
      if (existing !== undefined) {
        // Project shadows global; report it so a surprising override is
        // visible, but as a notice: this is the chosen precedence working,
        // not a definition the operator has to repair.
        sink.add({
          severity: 'notice',
          path: file.path,
          field: 'name',
          reason: `shadowed by the project definition of "${file.fields.name}" at ${existing.path}`,
        })
        continue
      }
      byName.set(file.fields.name, file)
      claimed.set(file.fields.name, file.path)
    }
  }

  const ordered = [...byName.values()]
  if (ordered.length > bounds.maxAgents) {
    for (const dropped of ordered.slice(bounds.maxAgents)) {
      sink.add({
        severity: 'error',
        path: dropped.path,
        reason: `above the ${String(bounds.maxAgents)}-agent cap for this project; not mounted`,
      })
    }
  }
  return {
    files: ordered.slice(0, bounds.maxAgents),
    projectRoot,
  }
}
