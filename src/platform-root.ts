/**
 * The one explicit, validated Aweave platform root the route card writes under.
 *
 * The Settings section has no Session context (`settings.section` is
 * `scope: 'root'`, `packages/client/ui-settings/src/client/contract/slots.ts:57`),
 * so the root cannot be inferred from whatever Session happens to be open. It
 * is instead resolved from three sources in a fixed order, and every candidate
 * must pass the SAME predicate before it can carry write authority:
 *
 * 1. `agents.platformRoot` — explicit configuration. An invalid value is an
 *    ERROR, never a fall-through: a root the operator pinned by hand must not be
 *    silently replaced by one derived from a Session cwd.
 * 2. `AWEAVE_DEVTOOLS_ROOT` — a deployment convenience. The value points at the
 *    devtools folder, so the platform root is its grandparent, mirroring
 *    `resolveProjectRootFromDevtools` (`workspaces/devtools/common/node-shared/src/paths/devtools-root.ts:124`).
 *    A value that does not validate is simply not a candidate.
 * 3. Live Agent cwds — convenience only. Distinct validated roots; zero or more
 *    than one without an explicit root fails closed instead of guessing.
 *
 * The predicate is deliberately stronger than "looks like a repo": it proves the
 * candidate is the root a top-level Session's `findProjectRoot` selects, which
 * is exactly the write-authority claim the card makes.
 *
 * @module dsh-project-context/platform-root
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { findProjectRoot } from './discovery.ts'

/** Environment variable holding a path INSIDE the Aweave platform. */
export const PLATFORM_ROOT_ENV = 'AWEAVE_DEVTOOLS_ROOT'

/** Which source produced the resolved root. */
export type PlatformRootSource = 'config' | 'env' | 'agents'

/** The configuration slice this resolver reads. */
export interface PlatformRootConfig {
  readonly agents?: { readonly platformRoot?: string }
}

/** A platform root that passed the predicate. */
export interface PlatformRootResolved {
  readonly root: string
  /** Which source produced {@link root}. */
  readonly via: PlatformRootSource
  /** Every distinct validated candidate this pass found. */
  readonly candidates: readonly string[]
}

/** No root could be established; nothing may be written. */
export interface PlatformRootFailure {
  readonly error: string
  /** Every distinct validated candidate this pass found, for the operator. */
  readonly candidates: readonly string[]
}

/** Result of one root resolution pass. */
export type PlatformRootResolution = PlatformRootResolved | PlatformRootFailure

/** The Session-header shape the candidate pass reads. */
export interface LiveAgentView {
  readonly session: { readonly header: { readonly cwd?: string } }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Validate one candidate against the platform-root predicate.
 *
 * Absolute directory that contains `AGENTS.md`, `agent/` and `workspaces/`, and
 * for which `findProjectRoot` returns the candidate itself. The last clause is
 * what makes the root the one a top-level Session resolving inside it will
 * select, so `discover` and `findProjectRoot` agree with the writer.
 *
 * @param candidate - the path to test, absolute.
 * @returns the normalized root, or undefined when the candidate is not one.
 */
export function platformRootOf(candidate: string): string | undefined {
  if (!isAbsolute(candidate)) return undefined
  let absolute: string
  try {
    absolute = resolve(candidate)
  } catch {
    return undefined
  }
  if (!isDirectory(absolute)) return undefined
  if (!isFile(join(absolute, 'AGENTS.md'))) return undefined
  if (!isDirectory(join(absolute, 'agent'))) return undefined
  if (!isDirectory(join(absolute, 'workspaces'))) return undefined
  // A nested repository resolves to its own `.git`, so this rejects any
  // candidate below the real platform root as well as any plain git checkout.
  if (findProjectRoot(absolute) !== absolute) return undefined
  return absolute
}

/**
 * Reduce live Agent cwds to distinct validated platform roots.
 * @param cwds - the cwds of every live Agent, in listing order.
 * @returns the validated roots, deduplicated, in first-seen order.
 */
function rootsFromCwds(cwds: readonly string[]): readonly string[] {
  const roots: string[] = []
  for (const cwd of cwds) {
    if (!isAbsolute(cwd)) continue
    const projectRoot = findProjectRoot(cwd)
    if (projectRoot === undefined) continue
    const root = platformRootOf(projectRoot)
    if (root !== undefined && !roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * Resolve distinct cwds from the live Agent list.
 * @param agents - the live Agents, as `ctx.agents.list()` returns them.
 * @returns the distinct absolute cwds, in listing order.
 */
export function liveAgentCwds(agents: readonly LiveAgentView[]): readonly string[] {
  const cwds: string[] = []
  for (const agent of agents) {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined && cwd.length > 0 && !cwds.includes(cwd)) cwds.push(cwd)
  }
  return cwds
}

/**
 * Resolve the platform root the route card writes under.
 * @param config - the plugin configuration (only `agents.platformRoot` is read).
 * @param agentCwds - distinct cwds of the live Agents.
 * @param env - process environment (injectable for tests).
 * @returns the resolved root with its source, or the failure with every candidate.
 */
export function resolvePlatformRoot(
  config: PlatformRootConfig,
  agentCwds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PlatformRootResolution {
  const devtoolsRaw = env[PLATFORM_ROOT_ENV]
  let envRoot: string | undefined
  if (devtoolsRaw !== undefined && devtoolsRaw.length > 0) {
    // `resolveProjectRootFromDevtools` takes the devtools folder's grandparent.
    const converted = resolve(devtoolsRaw, '..', '..')
    envRoot = platformRootOf(converted)
  }
  const candidates: string[] = []
  for (const root of [envRoot, ...rootsFromCwds(agentCwds)]) {
    if (root !== undefined && !candidates.includes(root)) candidates.push(root)
  }

  const configured = config.agents?.platformRoot
  if (configured !== undefined) {
    const root = platformRootOf(configured)
    if (root === undefined) {
      return {
        error: `\`agents.platformRoot\` is set to ${JSON.stringify(configured)}, which is not an Aweave platform root `
          + '(an absolute directory holding `AGENTS.md`, `agent/` and `workspaces/`, selected by `findProjectRoot`)',
        candidates,
      }
    }
    return {
      root,
      via: 'config',
      candidates: candidates.includes(root) ? candidates : [root, ...candidates],
    }
  }
  if (envRoot !== undefined) return { root: envRoot, via: 'env', candidates }
  if (candidates.length === 1) {
    const [only] = candidates
    // `noUncheckedIndexedAccess` cannot see the length guard above.
    if (only !== undefined) return { root: only, via: 'agents', candidates }
  }
  return {
    error: candidates.length === 0
      ? 'no Aweave platform root: set `agents.platformRoot` (or `AWEAVE_DEVTOOLS_ROOT`), or open a Session rooted inside the platform'
      : `${String(candidates.length)} distinct Aweave platform roots are in play; set \`agents.platformRoot\` to choose one`,
    candidates,
  }
}
