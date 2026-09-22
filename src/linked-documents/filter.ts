/**
 * Gate for linked-document injection: does this `read` deserve a lookup, and
 * against which Aweave root?
 *
 * Everything here runs before any I/O beyond two `existsSync` probes per
 * distinct cwd, and the module never throws — a gate that threw would convert a
 * successful `read` into an `isError` result, which is the opposite of the
 * fail-open contract the injection inherits from the hook it ports
 * (`agent/hooks/linked-docs.mjs`).
 *
 * @module dsh-project-context/linked-documents/filter
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { findProjectRoot } from '../discovery.ts'

/**
 * Root-relative directory whose markdown documents participate in the doc
 * graph. Matches the hook's own filter, which accepts `resources/` only.
 */
const RESOURCES_PREFIX = 'resources/'

/** Markdown extensions the doc graph indexes. */
const MARKDOWN_PATTERN = /\.(md|mdc)$/i

/**
 * Doc-graph database that marks a directory as an Aweave root. Structural, not
 * a hardcoded path: the plugin ships as a `file:` install (a hardlink tree whose
 * runtime `__dirname` resolves inside `$DSH_HOME/profiles/<p>/node_modules`), so
 * no build-time or runtime path names the checkout.
 */
const DOC_GRAPH_MARKER = ['.aweave', 'doc-graph.db'] as const

/**
 * Aweave CLI entry point, relative to the root. It serves two purposes: the
 * second half of the root test, and the program the CLI fallback executes when
 * `pnpm aw` is unavailable.
 */
export const CLI_RUN_BIN = ['workspaces', 'devtools', 'common', 'cli', 'bin', 'run.js'] as const

/**
 * cwd of the CLI fallback. The Aweave CLI resolves the project root from its own
 * cwd, so the fallback must run from `<root>/workspaces/devtools` — running it
 * from the DSH process cwd would resolve a different (or no) root.
 */
export const CLI_CWD = ['workspaces', 'devtools'] as const

/**
 * Tool name carrying a file path whose read should surface its links. Only the
 * harness `read` tool is gated; `bash`, `grep` and `glob` can read markdown too
 * but carry no single file path to resolve.
 */
const READ_TOOL = 'read'

/**
 * Whether this call is a gated `read`. Agent-less calls are excluded first: a
 * direct `ctx.tools.execute()` caller has no session to key dedup on and no
 * model to inform.
 * @param exec - the settled tool call.
 * @returns the read path when the call should proceed to the root gate.
 */
export function readPathOf(exec: {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: unknown
}): string | undefined {
  if (exec.agent === undefined) return undefined
  if (exec.name !== READ_TOOL) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const path: unknown = (args as { file_path?: unknown }).file_path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * Resolve the absolute path of one read, or undefined when it cannot be
 * resolved. A relative `file_path` is resolved against the session cwd, matching
 * the tool's own behaviour.
 * @param filePath - the `file_path` argument as the model supplied it.
 * @param cwd - the Agent's session cwd.
 * @returns an absolute path, or undefined.
 */
export function absoluteReadPath(filePath: string, cwd: string): string | undefined {
  try {
    return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
  } catch {
    return undefined
  }
}

/**
 * Memoized `cwd → projectRoot` resolution with the structural Aweave-root test.
 *
 * `findProjectRoot` walks up to the nearest `.git`, which is correct for rules,
 * agents and commands but too weak here: a session rooted in an unrelated git
 * repository must be skipped, not answered empty by the backend. The second test
 * — a doc-graph database plus the Aweave CLI — is what distinguishes the two.
 *
 * A `null` result is memoized as well: a non-Aweave cwd stays non-Aweave for the
 * process lifetime, and re-walking it on every read would be pure cost.
 */
export class AweaveRootResolver {
  readonly #roots = new Map<string, string | null>()

  /**
   * Resolve the Aweave root for one cwd.
   * @param cwd - the Agent's session cwd (already defaulted by the caller).
   * @returns the absolute Aweave root, or undefined when this cwd is not one.
   */
  resolve(cwd: string): string | undefined {
    const cached = this.#roots.get(cwd)
    if (cached !== undefined) return cached ?? undefined
    const root = structuralRoot(cwd)
    this.#roots.set(cwd, root ?? null)
    return root
  }

  /** Drop the memo — used when the owning plugin context is disposed. */
  clear(): void {
    this.#roots.clear()
  }
}

/**
 * Run the structural Aweave-root test for one cwd.
 * @param cwd - an absolute starting directory.
 * @returns the root, or undefined when any marker is missing.
 */
function structuralRoot(cwd: string): string | undefined {
  const projectRoot = findProjectRoot(cwd)
  if (projectRoot === undefined) return undefined
  if (!existsSync(resolve(projectRoot, ...DOC_GRAPH_MARKER))) return undefined
  if (!existsSync(resolve(projectRoot, ...CLI_RUN_BIN))) return undefined
  return projectRoot
}

/**
 * Project the read path onto its root-relative form and apply the markdown and
 * `resources/` filters.
 *
 * The comparison is textual on the resolved absolute path rather than a
 * `realpath` call: the backend matches paths by their indexed form, and a
 * symlinked read that resolves elsewhere would be answered empty anyway.
 * @param absolutePath - the resolved read path.
 * @param projectRoot - the resolved Aweave root.
 * @returns the root-relative path to query, or undefined when it is out of scope.
 */
export function toResourcesRelPath(absolutePath: string, projectRoot: string): string | undefined {
  const rel = relative(projectRoot, absolutePath)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const normalized = rel.split(sep).join('/')
  if (!normalized.startsWith(RESOURCES_PREFIX)) return undefined
  if (!MARKDOWN_PATTERN.test(normalized)) return undefined
  return normalized
}
