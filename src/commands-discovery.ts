/**
 * Bounded, synchronous, tri-state discovery of `<projectRoot>/.dsh/commands/*.md`.
 *
 * Three constraints shape this module, and all three are inherited from
 * `rules-discovery.ts` rather than re-derived:
 *
 * - **Synchronous.** Command resolution runs inside the synchronous
 *   `agent/created` listener, so an async scan would miss the Agent it was
 *   meant to serve.
 * - **Tri-state.** Every observation is `present`, `absent` (confirmed
 *   non-existence) or `unavailable` (state could not be determined).
 * - **Always digest.** Bounded contents are hashed on every pass; the metadata
 *   stamp is recorded but never consulted to decide "nothing changed", because
 *   a same-length rewrite with a restored mtime compares equal on
 *   `(path, size, mtime)`.
 *
 * Unlike rules, a confirmed `absent` here is terminal for registration: a
 * command that disappears is simply not registered for the next Agent, and
 * there is no durable supersession to retract.
 *
 * @module dsh-project-context/commands-discovery
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { DiagnosticSink } from './diagnostics.ts'
import { findProjectRoot } from './discovery.ts'
import { classifyFsError, digestOf } from './rules-discovery.ts'
import type {
  CommandBounds,
  CommandObservation,
  CommandScan,
  Config,
  MetadataStamp,
  Observation,
  ResourceBounds,
} from './types.ts'

/** Directory holding project command files, relative to the project root. */
export const PROJECT_COMMANDS_SUBDIR = join('.dsh', 'commands')

/** Hard ceiling on directory entries examined, independent of `maxCommands`. */
const MAX_COMMAND_DIRECTORY_ENTRIES = 1000

/** Default commands bounds; each is overridable on the plugin entry. */
export const DEFAULT_COMMAND_BOUNDS = {
  maxCommands: 32,
  maxCommandFileBytes: 64 * 1024,
  maxExpandedBytes: 256 * 1024,
} as const

/** The slice of {@link ResourceBounds} one commands scan actually reads. */
export type CommandScanBounds = Pick<ResourceBounds, 'maxCommands' | 'maxCommandFileBytes'>

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
 * Resolve the commands bounds from the plugin entry configuration.
 *
 * Fails loud at plugin load, before any Agent exists: a nonsense cap is a
 * deployment error, not a per-file one. `Object.hasOwn` rather than `??`
 * because an explicit YAML `null` is a configuration mistake worth reporting,
 * not a request for the default.
 * @param config - the plugin entry configuration.
 * @returns the three resolved command bounds.
 * @throws when any override is not a positive safe integer.
 */
export function resolveCommandBounds(config: Config): CommandBounds {
  const read = (key: 'maxCommands' | 'maxCommandFileBytes' | 'maxExpandedBytes', fallback: number): number => {
    if (!Object.hasOwn(config, key)) return fallback
    const value: unknown = config[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`dsh-project-context: \`${key}\` must be a positive safe integer, got ${String(value)}`)
    }
    return value
  }
  return {
    maxCommands: read('maxCommands', DEFAULT_COMMAND_BOUNDS.maxCommands),
    maxCommandFileBytes: read('maxCommandFileBytes', DEFAULT_COMMAND_BOUNDS.maxCommandFileBytes),
    maxExpandedBytes: read('maxExpandedBytes', DEFAULT_COMMAND_BOUNDS.maxExpandedBytes),
  }
}

/** Absolute commands directory for one cwd, or undefined when no project root exists. */
export function commandsDirectoryFor(cwd: string, config: Config): string | undefined {
  const projectRoot = findProjectRoot(cwd)
  if (projectRoot === undefined) return undefined
  return join(projectRoot, config.commandsSubdir ?? PROJECT_COMMANDS_SUBDIR)
}

/**
 * List the directory, distinguishing confirmed absence from an undetermined
 * state.
 */
function listCommandFilenames(
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
        capability: 'commands',
        path: directory,
        reason: `commands directory could not be read (${String(error)}); no command from it is registered`,
      })
    }
    return { observation, names: [] }
  }
  if (names.length > MAX_COMMAND_DIRECTORY_ENTRIES) {
    sink.add({
      severity: 'error',
      capability: 'commands',
      path: directory,
      reason: `commands directory holds more than ${String(MAX_COMMAND_DIRECTORY_ENTRIES)} entries; not scanned`,
    })
    // The listing succeeded, so this is a deliberate refusal rather than an
    // undetermined state. It reports as `unavailable` so a caller can tell
    // "the directory is unreadable" from "there are no commands here".
    return { observation: 'unavailable', names: [] }
  }
  return { observation: 'present', names: names.filter(name => name.endsWith('.md')).sort() }
}

/**
 * Run one bounded, synchronous commands scan for a given cwd.
 * @param cwd - the Agent's absolute working directory.
 * @param config - the plugin entry configuration.
 * @param bounds - the resolved scan bounds.
 * @param sink - diagnostics accumulator for skipped, oversized and unreadable files.
 * @returns the tri-state scan; never throws for a filesystem reason.
 */
export function scanCommands(
  cwd: string,
  config: Config,
  bounds: CommandScanBounds,
  sink: DiagnosticSink,
): CommandScan {
  const projectRoot = findProjectRoot(cwd)
  const directory = projectRoot === undefined
    ? undefined
    : join(projectRoot, config.commandsSubdir ?? PROJECT_COMMANDS_SUBDIR)
  // No project root is an ordinary, confirmed "there are no project commands".
  if (directory === undefined) {
    return { directory: undefined, directoryObservation: 'absent', files: [], projectRoot }
  }

  const listing = listCommandFilenames(directory, sink)
  if (listing.observation !== 'present') {
    return { directory, directoryObservation: listing.observation, files: [], projectRoot }
  }

  // The cap is applied over the sorted filename list, BEFORE any read, so it
  // bounds I/O as well as output and truncates deterministically.
  const retained = listing.names.slice(0, bounds.maxCommands)
  for (const dropped of listing.names.slice(bounds.maxCommands)) {
    sink.add({
      severity: 'error',
      capability: 'commands',
      path: join(directory, dropped),
      reason: `above the ${String(bounds.maxCommands)}-command cap for this project; not registered`,
    })
  }

  const files: CommandObservation[] = []
  for (const name of retained) {
    const path = join(directory, name)
    let stats: BigIntStats
    try {
      // `statSync` (not `lstatSync`) follows symlinks, which is what makes the
      // Aweave `build-commands` distribution model — absolute symlinks — work.
      // Phase 1 probed this empirically rather than trusting the read.
      stats = statSync(path, { bigint: true })
    } catch (error: unknown) {
      const observation = classifyFsError(error)
      // A file that vanished between readdir and stat is confirmed absent, and
      // simply is not part of this snapshot; nothing to report.
      if (observation === 'unavailable') {
        sink.add({
          severity: 'error',
          capability: 'commands',
          path,
          reason: `cannot stat command file (${String(error)}); it is not registered`,
        })
        files.push({ scope: name, path, observation })
      }
      continue
    }
    // A directory named `something.md` is ignored, not an error.
    if (!stats.isFile()) continue
    const size = Number(stats.size)
    if (size > bounds.maxCommandFileBytes) {
      sink.add({
        severity: 'error',
        capability: 'commands',
        path,
        reason: `command file is ${String(size)} bytes, above the ${String(bounds.maxCommandFileBytes)}-byte per-file cap; skipped`,
      })
      // A confirmed decision to exclude, not an undetermined state.
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
          capability: 'commands',
          path,
          reason: `cannot read command file (${String(error)}); it is not registered`,
        })
        files.push({ scope: name, path, observation })
      }
      continue
    }
    // Unlike a rule, an empty command file is NOT skipped silently: it is
    // recorded as `present` so the frontmatter parser rejects it with a
    // diagnostic naming the file, which is what the operator needs to act on.
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
