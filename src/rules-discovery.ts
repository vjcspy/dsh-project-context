/**
 * Bounded, synchronous, tri-state discovery of `<projectRoot>/.dsh/rules/*.md`.
 *
 * Three constraints shape this module:
 *
 * - **Synchronous.** The reconciler runs inside the `agent/pre-step` waterfall
 *   and must produce its answer before `decision.messages` is returned; a
 *   floating promise would miss the request it was meant to change.
 * - **Tri-state.** Every observation is `present`, `absent` (confirmed
 *   non-existence) or `unavailable` (state could not be determined). Only
 *   confirmed absence may retract a rule — see {@link Observation}.
 * - **Always digest.** The bounded contents are hashed on every pass. The
 *   metadata stamp is recorded but never consulted for a "nothing changed"
 *   decision, because a same-length rewrite with a restored mtime compares
 *   equal on `(path, size, mtime)` and a false negative here keeps a
 *   superseded instruction in force. Measured cost on the real 4-file /
 *   25 497-byte corpus: 0.21 ms.
 *
 * @module dsh-project-context/rules-discovery
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosticSink } from './diagnostics.ts'
import { findProjectRoot } from './discovery.ts'
import type {
  Config,
  MetadataStamp,
  Observation,
  ResourceBounds,
  RuleObservation,
  RuleScan,
} from './types.ts'

/** Directory holding project rules, relative to the project root. */
export const PROJECT_RULES_SUBDIR = join('.dsh', 'rules')

/** Hard ceiling on directory entries examined, independent of `maxRules`. */
const MAX_RULE_DIRECTORY_ENTRIES = 1000

/** Default rules bounds; each is overridable on the plugin entry. */
export const DEFAULT_RULE_BOUNDS = {
  maxRules: 32,
  maxRuleFileBytes: 64 * 1024,
  maxRenderedBytes: 256 * 1024,
} as const

/**
 * SHA-256 of one UTF-8 body, used as the content identity everywhere.
 * @param text - the exact body to hash.
 * @returns the lowercase hex digest.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Classify a filesystem error as confirmed absence or as an undetermined state.
 *
 * `ENOENT`/`ENOTDIR` are the two codes that positively establish "this path
 * does not exist". Everything else — `EACCES`, `EIO`, `EMFILE`, `ELOOP`, a
 * transient failure during an atomic replacement — leaves the state unknown,
 * and treating it as deletion would durably retract a live rule.
 * @param error - the caught filesystem error.
 * @returns `absent` for a confirmed non-existence, otherwise `unavailable`.
 */
export function classifyFsError(error: unknown): Extract<Observation, 'absent' | 'unavailable'> {
  const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable'
}

/** Capture the advisory identity of an already-stat'ed file. */
function stampOf(stats: {
  dev: number
  ino: number
  size: number
  mtimeNs: bigint
  ctimeNs: bigint
}): MetadataStamp {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
}

/**
 * Resolve the rules bounds from the plugin entry configuration.
 *
 * Fails loud at plugin load, before any Agent exists: a nonsense cap is a
 * deployment error, not a per-file one. `Object.hasOwn` rather than `??`
 * because an explicit YAML `null` is a configuration mistake worth reporting,
 * not a request for the default.
 * @param config - the plugin entry configuration.
 * @returns the three resolved rule bounds.
 * @throws when any override is not a positive safe integer.
 */
export function resolveRuleBounds(config: Config): Pick<
  ResourceBounds,
  'maxRules' | 'maxRuleFileBytes' | 'maxRenderedBytes'
> {
  const read = (key: 'maxRules' | 'maxRuleFileBytes' | 'maxRenderedBytes', fallback: number): number => {
    if (!Object.hasOwn(config, key)) return fallback
    const value: unknown = config[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-project-context: \`${key}\` must be a positive safe integer, got ${String(value)}`)
    }
    return value
  }
  return {
    maxRules: read('maxRules', DEFAULT_RULE_BOUNDS.maxRules),
    maxRuleFileBytes: read('maxRuleFileBytes', DEFAULT_RULE_BOUNDS.maxRuleFileBytes),
    maxRenderedBytes: read('maxRenderedBytes', DEFAULT_RULE_BOUNDS.maxRenderedBytes),
  }
}

/** Absolute rules directory for one cwd, or undefined when no project root exists. */
export function rulesDirectoryFor(cwd: string, config: Config): string | undefined {
  const projectRoot = findProjectRoot(cwd)
  if (projectRoot === undefined) return undefined
  return join(projectRoot, config.rulesSubdir ?? PROJECT_RULES_SUBDIR)
}

/**
 * List the directory, distinguishing confirmed absence from an undetermined
 * state.
 */
function listRuleFilenames(
  directory: string,
  sink: DiagnosticSink,
): { observation: Observation; names: string[] } {
  let names: string[]
  try {
    if (!statSync(directory).isDirectory()) return { observation: 'absent', names: [] }
    names = readdirSync(directory)
  } catch (error: unknown) {
    const observation = classifyFsError(error)
    if (observation === 'unavailable') {
      sink.add({
        severity: 'error',
        capability: 'rules',
        path: directory,
        reason: `rules directory could not be read (${String(error)}); the previous rule set stays in force`,
      })
    }
    return { observation, names: [] }
  }
  if (names.length > MAX_RULE_DIRECTORY_ENTRIES) {
    sink.add({
      severity: 'error',
      capability: 'rules',
      path: directory,
      reason: `rules directory holds more than ${String(MAX_RULE_DIRECTORY_ENTRIES)} entries; not scanned`,
    })
    // The listing succeeded, so this is a deliberate refusal rather than an
    // undetermined state — but retracting every rule because a directory got
    // large would be a policy failure, so it reports as unavailable.
    return { observation: 'unavailable', names: [] }
  }
  return { observation: 'present', names: names.filter(name => name.endsWith('.md')).sort() }
}

/**
 * Run one bounded, synchronous rules scan for a given cwd.
 * @param cwd - the Agent's absolute working directory.
 * @param config - the plugin entry configuration.
 * @param bounds - the resolved rule bounds.
 * @param sink - diagnostics accumulator for skipped, oversized and unreadable files.
 * @returns the tri-state scan; never throws for a filesystem reason.
 */
export function scanRules(
  cwd: string,
  config: Config,
  bounds: Pick<ResourceBounds, 'maxRules' | 'maxRuleFileBytes'>,
  sink: DiagnosticSink,
): RuleScan {
  const projectRoot = findProjectRoot(cwd)
  const directory = projectRoot === undefined
    ? undefined
    : join(projectRoot, config.rulesSubdir ?? PROJECT_RULES_SUBDIR)
  // No project root is an ordinary, confirmed "there are no project rules here".
  if (directory === undefined) {
    return { directory: undefined, directoryObservation: 'absent', files: [], projectRoot }
  }

  const listing = listRuleFilenames(directory, sink)
  if (listing.observation !== 'present') {
    return { directory, directoryObservation: listing.observation, files: [], projectRoot }
  }

  // The cap is applied over the sorted filename list, BEFORE any read, so it
  // bounds I/O as well as output and truncates deterministically.
  const retained = listing.names.slice(0, bounds.maxRules)
  for (const dropped of listing.names.slice(bounds.maxRules)) {
    sink.add({
      severity: 'error',
      capability: 'rules',
      path: join(directory, dropped),
      reason: `above the ${String(bounds.maxRules)}-rule cap for this project; not loaded`,
    })
  }

  const files: RuleObservation[] = []
  for (const name of retained) {
    const path = join(directory, name)
    let stats: BigIntStats
    try {
      stats = statSync(path, { bigint: true })
    } catch (error: unknown) {
      const observation = classifyFsError(error)
      // A file that vanished between readdir and stat is confirmed absent, and
      // simply is not part of this snapshot; nothing to report.
      if (observation === 'unavailable') {
        sink.add({
          severity: 'error',
          capability: 'rules',
          path,
          reason: `cannot stat rule file (${String(error)}); its last known content stays in force`,
        })
        files.push({ scope: name, path, observation })
      }
      continue
    }
    // A directory named `something.md` is ignored, not an error.
    if (!stats.isFile()) continue
    const size = Number(stats.size)
    if (size > bounds.maxRuleFileBytes) {
      sink.add({
        severity: 'error',
        capability: 'rules',
        path,
        reason: `rule file is ${String(size)} bytes, above the ${String(bounds.maxRuleFileBytes)}-byte per-file cap; skipped`,
      })
      // A confirmed decision to exclude, not an undetermined state: if this
      // file was previously in force it is correctly retracted.
      continue
    }
    let body: string
    try {
      body = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      const observation = classifyFsError(error)
      if (observation === 'unavailable') {
        sink.add({
          severity: 'error',
          capability: 'rules',
          path,
          reason: `cannot read rule file (${String(error)}); its last known content stays in force`,
        })
        files.push({ scope: name, path, observation })
      }
      continue
    }
    // An empty (or whitespace-only) rule file states nothing; it contributes
    // no section and needs no operator action.
    if (body.trim().length === 0) continue
    files.push({
      scope: name,
      path,
      observation: 'present',
      body,
      digest: digestOf(body),
      stamp: stampOf({
        dev: Number(stats.dev),
        ino: Number(stats.ino),
        size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
      }),
    })
  }

  return { directory, directoryObservation: 'present', files, projectRoot }
}
