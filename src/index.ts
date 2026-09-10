/**
 * Project-scoped markdown subagents.
 *
 * This plugin registers NO tool of its own. It discovers markdown agent
 * definitions under each Agent's project root and mounts one first-party
 * `@deepseek-ai/dsh-tool-subagent` instance per definition into that Agent's
 * own context scope, following the precedent at
 * `packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/scoped-tool-subagent.ts`
 * and the install-ownership pattern at
 * `packages/experimental/tool-agent-team/src/index.ts:394-410`.
 *
 * Two lifecycle facts constrain everything here:
 * - `agent/created` is dispatched synchronously and a listener throw VETOES
 *   Agent publication (`packages/core/agent/src/index.ts:545-553`), so this
 *   module never lets an exception escape its handler.
 * - Child agents also traverse `agent/created`
 *   (`packages/subagent/subagent-in-process-driver/src/index.ts:134`), so a
 *   child reuses its parent's already-resolved immutable roster.
 *
 * @module dsh-project-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Side-effect type imports: these declare the `tools`, `subagents` and
// `systemPrompt` service keys this module reads through `ctx.get()`.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { capabilityRejection, renderCatalog, resolveAgents, toSubagentConfig } from './config-mapping.ts'
import { DiagnosticSink, renderReport } from './diagnostics.ts'
import { discover, resolveBounds } from './discovery.ts'
import type { Config, ResolvedAgent, ResourceBounds, Roster } from './types.ts'

export const name = 'dsh-project-agents'

/**
 * Only the Agent registry is required at load. `tools` and `systemPrompt` are
 * read through optional `ctx.get()` lookups inside an Agent's own scope, and
 * the delegation tool's own dependencies are injected per mount.
 */
export const inject = ['agents']

export type { Config, ResolvedAgent, Roster } from './types.ts'

/** Name of the Agent-scoped catalog section. */
export const CATALOG_SECTION = 'project-agents:catalog'

/**
 * Read the effective pre-mount tool-name universe for one Agent scope. A
 * scoped tool silently shadows a global one, so a generated name must be
 * checked against what the Agent can already see.
 * @param agent - the Agent whose scope is inspected.
 * @returns every visible tool name, or an empty set when `tools` is unavailable.
 */
function visibleToolNames(agent: Agent): ReadonlySet<string> {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) return new Set()
  try {
    return new Set(tools.schemas(agent).map(schema => schema.name))
  } catch {
    return new Set()
  }
}

/**
 * Install the discovered roster in every live and subsequently published Agent
 * scope.
 * @param ctx - Host context carrying Agent lifecycle events.
 * @param config - plugin entry configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Fail loud at load: a nonsense cap is a deployment error, and it must be
  // rejected before any Agent can mount anything.
  const bounds: ResourceBounds = resolveBounds(config)

  const installed = new Map<Agent, () => void>()
  const rosters = new WeakMap<Agent, Roster>()

  /**
   * Resolve the roster for one Agent. A child Agent reuses its parent's
   * already-resolved roster; a top-level Agent always rescans, which is what
   * makes a newly dropped markdown file take effect in the next session.
   * Never cache on the project root alone — that cache would never expire.
   */
  const rosterFor = (agent: Agent): Roster => {
    const header = agent.session.header
    const parentSession = header.parentSession
    if (parentSession !== undefined) {
      const parent = ctx.agents.get(parentSession)
      const inherited = parent === undefined ? undefined : rosters.get(parent)
      if (inherited !== undefined) return inherited
    }
    const sink = new DiagnosticSink()
    const cwd = header.cwd ?? config.fallbackCwd ?? process.cwd()
    const discovered = discover(cwd, config, bounds, sink)
    const agents = resolveAgents(discovered.files, visibleToolNames(agent), sink)
    return { agents, diagnostics: sink.drain(), projectRoot: discovered.projectRoot, cwd }
  }

  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    let roster: Roster
    try {
      roster = rosterFor(agent)
    } catch (error: unknown) {
      // Discovery must never veto Agent publication.
      ctx.logger.warn(`dsh-project-agents: discovery failed for agent "${agent.id}": ${String(error)}`)
      return
    }
    rosters.set(agent, roster)
    const report = renderReport(roster.diagnostics, roster.agents.length, roster.cwd)
    if (report !== undefined) ctx.logger.warn(report)
    if (roster.agents.length === 0) return

    const disposers: Array<() => unknown> = []
    // Populated by each fiber that actually registered its tool; the catalog
    // text follows it so a deferred or rejected mount is never advertised.
    const mountedToolNames = new Set<string>()
    try {
      // Registered only after the final resolved roster is known, and owned by
      // the same per-Agent install transaction as the tool fibers.
      const systemPrompt = agent.ctx.get('systemPrompt')
      if (systemPrompt === undefined) {
        ctx.logger.warn('dsh-project-agents: the systemPrompt service is unavailable; the agent catalog was not registered')
      } else {
        disposers.push(systemPrompt.section({
          name: CATALOG_SECTION,
          // Immediately after the first-party delegation-tool guidance.
          order: systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
          text: () => renderCatalog(roster.agents.filter(entry => mountedToolNames.has(entry.toolName))),
        }))
      }

      for (const resolved of roster.agents) {
        const fiber = agent.ctx.inject(ToolSubagent.inject, (runtimeCtx) => {
          // Final pre-mount guard, evaluated at the moment of registration:
          // shadowing is a VALID registration, so it cannot be caught by a
          // transactional rollback and must be prevented here.
          if (runtimeCtx.tools.get(resolved.toolName, agent) !== undefined) {
            ctx.logger.warn(
              `dsh-project-agents: skipped ${resolved.path} — tool "${resolved.toolName}" already exists in this Agent's scope`,
            )
            return
          }
          const rejection = capabilityRejection(resolved, runtimeCtx.subagents.getProvider(resolved.transport))
          if (rejection !== undefined) {
            ctx.logger.warn(`dsh-project-agents: skipped ${resolved.path} — ${rejection}`)
            return
          }
          try {
            // Registration is deferred to this fiber precisely so a provider
            // that activates in parallel is not lost to a synchronous race;
            // `ToolSubagent.apply` itself handles a provider that appears later.
            ToolSubagent.apply(runtimeCtx, toSubagentConfig(resolved), agent.session)
            mountedToolNames.add(resolved.toolName)
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-project-agents: skipped ${resolved.path} — mount failed: ${String(error)}`)
          }
        })
        disposers.push(fiber.dispose)
      }
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) void dispose()
      ctx.logger.warn(`dsh-project-agents: install failed for agent "${agent.id}"; nothing was mounted: ${String(error)}`)
      return
    }

    installed.set(agent, () => {
      for (const dispose of disposers.reverse()) void dispose()
    })
  }

  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    rosters.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'dsh-project-agents.scopedAgents()')
}
