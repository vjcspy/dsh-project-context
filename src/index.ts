/**
 * Project-scoped context: markdown subagents and markdown rules.
 *
 * Two capabilities share one project-root resolver and one diagnostics stack.
 *
 * **Agents.** This plugin registers NO tool of its own. It discovers markdown
 * agent definitions under each Agent's project root and mounts one first-party
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
 * **Rules.** Every `*.md` under `<projectRoot>/.dsh/rules/` is loaded verbatim
 * and delivered as one durable, self-superseding user message, reconciled
 * inside the `agent/pre-step` waterfall. Delivery CANNOT go through the inbox:
 * `preStep` claims and empties the `next-step` batch before dispatching the
 * waterfall (`packages/core/agent-loop/src/agent.ts:245,249`), so `prepend`
 * would land on a later step and `replace` would return `false`. See
 * `rules-reconcile.ts` for the full argument.
 *
 * @module dsh-project-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// Side-effect type imports: these declare the `tools`, `subagents`,
// `systemPrompt` and `webserver/index-inject` seams this module reads.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { capabilityRejection, renderCatalog, resolveAgents, toSubagentConfig } from './config-mapping.ts'
import { DiagnosticSink, errorsOf, renderReport, renderWebNotice } from './diagnostics.ts'
import { discover, resolveBounds } from './discovery.ts'
import './message-source.ts'
import { resolveRuleBounds, scanRules } from './rules-discovery.ts'
import {
  dropPendingRules,
  emptyRulesState,
  reconcileRules,
  recoverStateFromHistory,
  sameRulesPayload,
  syncRulesInbox,
  type RulesState,
} from './rules-reconcile.ts'
import type { Config, Diagnostic, ResolvedAgent, ResourceBounds, Roster } from './types.ts'

export const name = 'dsh-project-context'

/**
 * Only the Agent registry is required at load. `tools` and `systemPrompt` are
 * read through optional `ctx.get()` lookups inside an Agent's own scope, and
 * the delegation tool's own dependencies are injected per mount.
 */
export const inject = ['agents']

export type { Config, Observation, ResolvedAgent, RuleObservation, RuleScan, Roster } from './types.ts'
export type { ProjectRuleChange, ProjectRulesSource } from './message-source.ts'

/** Name of the Agent-scoped catalog section. */
export const CATALOG_SECTION = 'project-agents:catalog'

/**
 * Capabilities that get their own web-notice banner, in render order.
 *
 * Kept as a named constant so adding a third capability cannot quietly skip
 * the banner the way the rules capability did.
 */
const RENDERED_CAPABILITIES = ['agents', 'rules'] as const

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
  const bounds: ResourceBounds = { ...resolveBounds(config), ...resolveRuleBounds(config) }
  // Absence, not `?? true`: an explicit YAML `null` is a configuration mistake
  // and must not silently read as "enabled".
  const rulesEnabled = !Object.hasOwn(config, 'rules') || config.rules === true

  const installed = new Map<Agent, () => void>()
  const rosters = new WeakMap<Agent, Roster>()
  /**
   * The most recent diagnostics per Agent cwd. Kept only so the web notice can
   * report them: the host logger is not visible on a profile without a log
   * exporter, so this is the one channel that reaches the operator unasked.
   */
  const reports = new Map<string, readonly Diagnostic[]>()

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
      ctx.logger.warn(`dsh-project-context: discovery failed for agent "${agent.id}": ${String(error)}`)
      return
    }
    rosters.set(agent, roster)
    // Publish the pass for the web notice even when nothing mounted — a pass
    // that skipped every file is exactly the case a log-only report lost. A
    // later Agent for the same cwd replaces the entry, so fixing a file clears
    // the banner as soon as the next roster is resolved.
    // Preserve any rule diagnostics already recorded for this cwd: the two
    // capabilities publish into the same banner and must not erase each other.
    reports.set(roster.cwd, [
      ...(reports.get(roster.cwd) ?? []).filter(entry => entry.capability === 'rules'),
      ...roster.diagnostics,
    ])
    const report = renderReport(roster.diagnostics, roster.agents.length, roster.cwd)
    if (report !== undefined) ctx.logger.warn(report)
    // Nothing to mount and nothing for the operator to fix: stay out of the way.
    if (roster.agents.length === 0 && errorsOf(roster.diagnostics).length === 0) return

    const disposers: Array<() => unknown> = []
    // Populated by each fiber that actually registered its tool; the catalog
    // text follows it so a deferred or rejected mount is never advertised.
    const mountedToolNames = new Set<string>()
    try {
      // Registered only after the final resolved roster is known, and owned by
      // the same per-Agent install transaction as the tool fibers.
      const systemPrompt = agent.ctx.get('systemPrompt')
      if (systemPrompt === undefined) {
        ctx.logger.warn('dsh-project-context: the systemPrompt service is unavailable; the agent catalog was not registered')
      } else {
        disposers.push(systemPrompt.section({
          name: CATALOG_SECTION,
          // Immediately after the first-party delegation-tool guidance.
          order: systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 1,
          text: () => renderCatalog(
            roster.agents.filter(entry => mountedToolNames.has(entry.toolName)),
            roster.diagnostics,
          ),
        }))
      }

      for (const resolved of roster.agents) {
        const fiber = agent.ctx.inject(ToolSubagent.inject, (runtimeCtx) => {
          // Final pre-mount guard, evaluated at the moment of registration:
          // shadowing is a VALID registration, so it cannot be caught by a
          // transactional rollback and must be prevented here.
          if (runtimeCtx.tools.get(resolved.toolName, agent) !== undefined) {
            ctx.logger.warn(
              `dsh-project-context: skipped ${resolved.path} — tool "${resolved.toolName}" already exists in this Agent's scope`,
            )
            return
          }
          const rejection = capabilityRejection(resolved, runtimeCtx.subagents.getProvider(resolved.transport))
          if (rejection !== undefined) {
            ctx.logger.warn(`dsh-project-context: skipped ${resolved.path} — ${rejection}`)
            return
          }
          try {
            // Registration is deferred to this fiber precisely so a provider
            // that activates in parallel is not lost to a synchronous race;
            // `ToolSubagent.apply` itself handles a provider that appears later.
            ToolSubagent.apply(runtimeCtx, toSubagentConfig(resolved), agent.session)
            mountedToolNames.add(resolved.toolName)
          } catch (error: unknown) {
            ctx.logger.warn(`dsh-project-context: skipped ${resolved.path} — mount failed: ${String(error)}`)
          }
        })
        disposers.push(fiber.dispose)
      }
    } catch (error: unknown) {
      for (const dispose of disposers.reverse()) void dispose()
      ctx.logger.warn(`dsh-project-context: install failed for agent "${agent.id}"; nothing was mounted: ${String(error)}`)
      return
    }

    installed.set(agent, () => {
      for (const dispose of disposers.reverse()) void dispose()
    })
  }

  // The host logger reaches registered exporters only, and a profile that
  // mounts none (the shipped `web` profile among them) drops every warning into
  // an in-memory ring buffer nobody reads. This listener is therefore the only
  // channel that tells the operator about a skipped file without being asked,
  // and it needs no client bundle: `webserver/index-inject` is a host-plane seam
  // (`packages/host/webserver/src/index.ts:341-351`). When no webserver is
  // composed the event simply never fires.
  ctx.on('webserver/index-inject', (table) => {
    const groups = [...reports.entries()].map(([cwd, diagnostics]) => ({ cwd, diagnostics }))
    // ONE ROW PER CAPABILITY. `renderWebNotice` filters the groups to the
    // capability it is given and defaults to `agents`, so calling it once —
    // as this handler did until the rules capability shipped — silently
    // dropped every rules diagnostic on the floor. Each capability also owns
    // its own DOM id, so the two banners coexist instead of one suppressing
    // the other through the `getElementById` guard.
    for (const capability of RENDERED_CAPABILITIES) {
      const notice = renderWebNotice(groups, capability)
      if (notice !== undefined) table.push({ kind: 'script', placement: 'body', text: notice })
    }
  })

  // ── project rules ────────────────────────────────────────────────────────
  // Delivered by folding into `decision.messages` inside the `agent/pre-step`
  // waterfall. Nothing here touches `agent/created`: a throw there would VETO
  // Agent publication (`packages/core/agent/src/index.ts:545-553`), and every
  // Agent — parent and child alike, as Phase 1 GATE 1 measured — traverses
  // pre-step on its own, so the snapshot needs no inheritance path.
  const rulesStates = new WeakMap<Agent, RulesState>()

  /**
   * Resolve the state this Agent should reconcile against.
   *
   * A cold in-memory cache does NOT mean a cold session: after a resume, a
   * fork or a plugin reload the transcript may already carry snapshots the
   * model has read. Recovering from history is what stops a resume from
   * re-delivering rules the model already has.
   */
  const rulesStateFor = (agent: Agent, claimed: readonly UserMessage[]): RulesState => {
    const known = rulesStates.get(agent)
    if (known !== undefined) return known
    const recovered = recoverStateFromHistory(agent, claimed) ?? emptyRulesState()
    rulesStates.set(agent, recovered)
    return recovered
  }

  if (rulesEnabled) {
    ctx.on('agent/pre-step', async (
      { agent, messages, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      // Deliberately OUTSIDE any containment: a rejected `next()`, an abort or
      // an invariant error is a real failure and must propagate. Only expected
      // filesystem outcomes are contained, and they are contained inside the
      // scan itself, which reports them as tri-state observations.
      const decision = await next()
      signal.throwIfAborted()

      const sink = new DiagnosticSink()
      const cwd = agent.session.header.cwd ?? config.fallbackCwd ?? process.cwd()
      const scan = scanRules(cwd, config, bounds, sink)
      const state = rulesStateFor(agent, messages)
      const outcome = reconcileRules(scan, state, bounds, sink)

      const diagnostics = sink.drain()
      if (diagnostics.length > 0) {
        // Republish the cwd's diagnostics so the web banner reflects the
        // CURRENT pass: rule diagnostics change on every refresh, unlike the
        // immutable per-Agent agent roster.
        const existing = reports.get(cwd) ?? []
        reports.set(cwd, [...existing.filter(entry => (entry.capability ?? 'agents') !== 'rules'), ...diagnostics])
        const loaded = scan.files.filter(file => file.observation === 'present').length
        const report = renderReport(diagnostics, loaded, cwd, 'rules')
        if (report !== undefined) ctx.logger.warn(report)
      } else if (reports.has(cwd)) {
        // A clean pass clears this cwd's rule diagnostics, so fixing a file
        // takes the banner down on the next step.
        const kept = (reports.get(cwd) ?? []).filter(entry => (entry.capability ?? 'agents') !== 'rules')
        if (kept.length === 0) reports.delete(cwd)
        else reports.set(cwd, kept)
      }

      const desired = outcome.desired
      // An empty first entry owns a no-step turn; keep the snapshot pending
      // rather than turning it into a standalone request. Mirrors
      // `packages/context/agent-instructions/src/index.ts:324-327`.
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
        syncRulesInbox(agent, messages, desired)
        return decision
      }
      // A proceeding step settles the pending snapshot: it either enters below
      // or its payload is already covered by the batch.
      dropPendingRules(agent)
      if (desired === undefined) return decision
      if (decision.messages.some(message => sameRulesPayload(message, desired))) {
        rulesStates.set(agent, outcome.next)
        return decision
      }
      // Right after the claimed batch, so the direct prompt precedes the rules
      // and the driver-appended runtime context follows them.
      const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
      // Committed only now, because only now has the model actually been shown
      // the snapshot. An `unavailable` observation never advances the retained
      // content for the unobserved scope, so the next step re-reads it.
      rulesStates.set(agent, outcome.next)
      return { ...decision, messages: entered }
    })
  }

  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    rosters.delete(agent)
    rulesStates.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    reports.clear()
  }, 'dsh-project-context.scopedContext()')
}
