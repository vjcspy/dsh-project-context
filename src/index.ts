/**
 * Project-scoped context: markdown subagents, markdown rules and markdown
 * commands.
 *
 * Three capabilities share one project-root resolver and one diagnostics stack.
 * (A fourth concern — this deployment's MCP servers — is a separate settings
 * namespace, not a member of the {@link Capability} union.)
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
 * **Commands.** Every `*.md` under `<projectRoot>/.dsh/commands/` becomes one
 * Agent-scoped DSH slash command. Registration MUST be Agent-scoped: a global
 * `ctx.commands.register` cannot express per-project visibility, so each Agent
 * gets its own `agent.ctx.inject(['commands'], …)` fiber. A name that collides
 * with a first-party command is rejected rather than allowed to shadow it, and
 * provenance for that decision is read off the registered `definitionId`. See
 * `commands-install.ts`.
 *
 * @module dsh-project-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
// Side-effect type imports: these declare the `tools`, `subagents`,
// `systemPrompt` and `webserver/index-inject` seams this module reads.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { resolveCommandBounds, scanCommands } from './commands-discovery.ts'
import { installCommands, resolveCommands } from './commands-install.ts'
import { capabilityRejection, renderCatalog, resolveAgents, toSubagentConfig } from './config-mapping.ts'
import { capabilityOf, DiagnosticSink, errorsOf, forCapability, MCP_HEALTH_ROUTE, renderMcpHealthScript, renderReport, renderWebNotice, replaceCapability } from './diagnostics.ts'
import { discover, resolveBounds } from './discovery.ts'
import { CircuitBreaker, lookupLinkedDocuments } from './linked-documents/backend.ts'
import { absoluteReadPath, AweaveRootResolver, readPathOf, toResourcesRelPath } from './linked-documents/filter.ts'
import { linkedDocumentsMessage, ReadPathSkips, renderLinkedDocuments } from './linked-documents/payload.ts'
import { createHealthLoop, healthPayload, MCP_HEALTH_INTERVAL_MS } from './mcp/health.ts'
import { createMcpManager } from './mcp/manager.ts'
import { installMcpNamespace, MCP_NAMESPACE, MCP_NAMESPACE_BASE } from './mcp/namespace.ts'
import type { McpManagerConfig } from './mcp/types.ts'
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
import type { Capability, Config, Diagnostic, ResolvedAgent, ResourceBounds, Roster } from './types.ts'

export const name = 'dsh-project-context'

/**
 * Only the Agent registry is required at load. `tools` and `systemPrompt` are
 * read through optional `ctx.get()` lookups inside an Agent's own scope, and
 * the delegation tool's own dependencies are injected per mount.
 */
export const inject = ['agents']

export type {
  CommandBounds,
  CommandFile,
  CommandObservation,
  CommandScan,
  Config,
  Observation,
  ResolvedAgent,
  ResolvedCommand,
  RuleObservation,
  RuleScan,
  Roster,
} from './types.ts'
export type { ProjectRuleChange, ProjectRulesSource } from './message-source.ts'
export type { McpManagerConfig, McpServerEntry, McpTransport } from './mcp/types.ts'
export type { McpServerState, McpServerStatus } from './mcp/reconcile.ts'
export { MCP_NAMESPACE } from './mcp/namespace.ts'

/** Name of the Agent-scoped catalog section. */
export const CATALOG_SECTION = 'project-agents:catalog'

/**
 * Delay before the health loop's first tick, in milliseconds.
 *
 * Long enough for the mount pass armed by the namespace install to finish its
 * own settle window, so the first tick observes real per-server states instead
 * of the empty `statuses` a zero-delay tick would see.
 */
const MCP_HEALTH_FIRST_TICK_MS = 1_000

/**
 * Capabilities that get their own web-notice banner, in render order.
 *
 * Kept as a named constant so adding a third capability cannot quietly skip
 * the banner the way the rules capability did.
 */
const RENDERED_CAPABILITIES = ['agents', 'rules', 'commands'] as const

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
  const bounds: ResourceBounds = {
    ...resolveBounds(config),
    ...resolveRuleBounds(config),
    ...resolveCommandBounds(config),
  }
  // Absence, not `?? true`: an explicit YAML `null` is a configuration mistake
  // and must not silently read as "enabled".
  const rulesEnabled = !Object.hasOwn(config, 'rules') || config.rules === true
  const commandsEnabled = !Object.hasOwn(config, 'commands') || config.commands === true
  // The composition base for the MCP namespace. Defaults stay credential-free,
  // so a repository under version control never carries a server secret; the
  // user layer of the namespace holds the operator's own servers. Entries
  // written in a `cordis.yml` config block are unresolved input — the schema
  // resolves them once the namespace is installed.
  const entryMcpConfig: McpManagerConfig = {
    servers: (config.mcp?.servers ?? MCP_NAMESPACE_BASE.servers) as McpManagerConfig['servers'],
  }

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
    // Resolved in the SAME pass as the agent roster so a child Agent inherits
    // them by reusing the parent's roster object, exactly like its agents.
    const commands = commandsEnabled
      ? resolveCommands(scanCommands(cwd, config, bounds, sink), sink)
      : []
    return { agents, commands, diagnostics: sink.drain(), projectRoot: discovered.projectRoot, cwd }
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
    //
    // ONE SLICE PER CAPABILITY. Every capability publishes into the same
    // banner, so a pass must replace its OWN slice and preserve the others.
    // This filter used to be the hardcoded `entry.capability === 'rules'`,
    // which silently erased the commands slice on every Agent creation; the
    // rules pass had the mirror-image `!== 'rules'` and happened to survive.
    // `capabilityOf()` is reused so the untagged-default is applied the same
    // way everywhere.
    const publish = (
      capability: Capability,
      diagnostics: readonly Diagnostic[],
      retainedCount: number,
    ): void => {
      const merged = replaceCapability(reports.get(roster.cwd) ?? [], capability, diagnostics)
      if (merged.length === 0) reports.delete(roster.cwd)
      else reports.set(roster.cwd, merged)
      const report = renderReport(diagnostics, retainedCount, roster.cwd, capability)
      if (report !== undefined) ctx.logger.warn(report)
    }
    publish('agents', forCapability(roster.diagnostics, 'agents'), roster.agents.length)
    publish('commands', forCapability(roster.diagnostics, 'commands'), roster.commands.length)
    // Nothing to mount and nothing for the operator to fix: stay out of the way.
    if (
      roster.agents.length === 0
      && roster.commands.length === 0
      && errorsOf(roster.diagnostics).length === 0
    ) return

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
            // Agents only: the catalog tells the model which DELEGATION TOOLS
            // are missing, so a command-file rejection here would be a lie.
            forCapability(roster.diagnostics, 'agents'),
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

      // ── project commands ────────────────────────────────────────────────
      // ONE fiber for the whole command set, not one per command: the service
      // is injected once, and every registration it makes is an effect of this
      // fiber, disposed with it by the same per-Agent transaction as the tools.
      if (roster.commands.length > 0) {
        // `inject` defers until the service exists, so a composition whose
        // commands bundle activates later still gets its commands. If it NEVER
        // appears the callback simply never runs — a silent no-op — so that
        // case is reported here rather than left to be discovered by hand.
        if (agent.ctx.get('commands') === undefined) {
          publish('commands', [
            ...forCapability(roster.diagnostics, 'commands'),
            {
              severity: 'error',
              capability: 'commands',
              path: roster.projectRoot ?? roster.cwd,
              reason: `the "commands" service is not mounted in this composition; ${String(roster.commands.length)} project command file(s) were not registered`,
            },
          ], 0)
        }
        const fiber = agent.ctx.inject(['commands'], (runtimeCtx) => {
          const outcome = installCommands({
            agent,
            runtimeCtx,
            commands: roster.commands,
            maxExpandedBytes: bounds.maxExpandedBytes,
            log: { warn: message => ctx.logger.warn(message) },
          })
          // Re-publish the WHOLE commands slice: the scan-time rejections are
          // still true, so they must not be replaced by the registration set.
          publish(
            'commands',
            [...forCapability(roster.diagnostics, 'commands'), ...outcome.diagnostics],
            outcome.registered,
          )
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
    // The MCP outage banner. Unlike the capability banners it is unconditional
    // and carries no diagnostics: its script polls the plugin-owned health route
    // so an outage that starts (or ends) AFTER this render still appears and
    // clears without a page refresh. The script's own `window` sentinel keeps
    // repeated index renders from stacking timers.
    table.push({ kind: 'script', placement: 'body', text: renderMcpHealthScript() })
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
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    rosters.delete(agent)
    rulesStates.delete(agent)
  })

  // ── linked documents ─────────────────────────────────────────────────────
  // A DSH agent `read` of a `resources/**/*.md(c)` file inside the Aweave root
  // is enriched with the compact linked-documents block the Claude/Cursor hook
  // injects, carried to the next step inbox through `additionalContexts`
  // (`packages/core/agent-loop/src/agent.ts:489-492`).
  //
  // The listener is registered with a plain `ctx.on`: a waterfall listener needs
  // no service injection (both reference plugins prove it), and adding `tools` to
  // `inject` would hold this plugin's whole mount hostage to one service name.
  //
  // Fail-open is the contract, not a nicety. Every branch below — agent-less
  // call, non-`read` tool, non-`resources/` path, non-Aweave root, no server,
  // missing CLI, unparsable payload — resolves to accept with no contexts. A
  // throw out of a post-execute listener would turn the successful `read` into an
  // `isError` result, which is the opposite of what silence means here.
  const aweaveRoots = new AweaveRootResolver()
  const breaker = new CircuitBreaker()
  const skips = new ReadPathSkips()

  /**
   * Resolve the block to inject for one settled read, or undefined.
   * @param exec - the settled tool call.
   * @returns the injected message, or undefined when this read stays silent.
   */
  const linkedDocumentsFor = async (exec: ToolExecution): Promise<UserMessage | undefined> => {
    const filePath = readPathOf(exec)
    if (filePath === undefined) return undefined
    // `SessionHeader.cwd` is optional, so the process cwd is the documented
    // fallback rather than a defensive one.
    const header = exec.agent?.session.header
    const cwd = header?.cwd ?? process.cwd()
    const projectRoot = aweaveRoots.resolve(cwd)
    if (projectRoot === undefined) return undefined
    const absolute = absoluteReadPath(filePath, cwd)
    if (absolute === undefined) return undefined
    const relPath = toResourcesRelPath(absolute, projectRoot)
    if (relPath === undefined) return undefined

    const sessionKey = header?.id
    if (sessionKey === undefined) return undefined
    if (skips.has(sessionKey, relPath)) return undefined
    if (breaker.isOpen(sessionKey)) return undefined

    const result = await lookupLinkedDocuments({
      aweaveRoot: projectRoot,
      relPath,
      sessionKey,
      signal: exec.signal,
    })
    // The breaker counts only transport failures. An empty answer from a live
    // backend is a fact about the graph, not a symptom, so it clears the run
    // instead of advancing it — otherwise three reads of unlinked documents
    // would silently disable injection for the rest of the session.
    if (result.transportFailed) breaker.recordFailure(sessionKey)
    else breaker.recordSuccess(sessionKey)
    skips.record(sessionKey, relPath, result.omitted)
    const block = renderLinkedDocuments(result)
    return block === undefined ? undefined : linkedDocumentsMessage(block)
  }

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    // First branch, before any other work: a direct `ctx.tools.execute()` caller
    // has no agent, and reading `exec.agent.session` would throw out of the
    // waterfall. `readPathOf` re-checks it because that is where the contract is
    // documented.
    if (!exec.agent) return next()
    let context: UserMessage | undefined
    try {
      context = await linkedDocumentsFor(exec)
    } catch (error: unknown) {
      // Containment here is deliberate and total: this plugin must never convert
      // a successful read into a failed one.
      ctx.logger.warn(`dsh-project-context: linked-documents lookup failed: ${String(error)}`)
      context = undefined
    }
    // Observe-and-enrich, never veto: delegate first so a later listener can
    // still block or replace, then fold the block onto whatever came back —
    // `additionalContexts` rides both decision variants.
    const downstream = await next()
    if (context === undefined) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [...downstream.additionalContexts ?? [], context],
      }
    }
    return { ...downstream, additionalContexts: [...downstream.additionalContexts ?? [], context] }
  })

  ctx.effect(() => () => {
    aweaveRoots.clear()
    breaker.clear()
    skips.clear()
  }, 'dsh-project-context.linkedDocuments()')

  // ── managed MCP servers ──────────────────────────────────────────────────
  // The namespace is the store of record; the manager diffs it against the
  // live mounts. Both are plugin-owned, and every mount is an effect of this
  // context, so plugin teardown disconnects every server it started.
  let mcpSource = (): McpManagerConfig => entryMcpConfig
  const mcpManager = createMcpManager({
    ctx,
    read: () => mcpSource(),
    log: { warn: message => ctx.logger.warn(message) },
  })
  installMcpNamespace(ctx, entryMcpConfig, {
    setSource: (source) => { mcpSource = source },
    // Fires at install as well, which is what arms the first pass. The pass is
    // deliberately not awaited: a server that takes seconds to connect must not
    // hold up Agent publication.
    onChange: () => { void mcpManager.reconcile() },
  })
  // Registered before the first pass so a fast unload still disposes anything
  // the pass mounted; the manager ignores a reconcile that arrives after stop.
  ctx.effect(() => () => mcpManager.dispose(), 'dsh-project-context.mcpManager()')

  // ── MCP health loop ──────────────────────────────────────────────────────
  // `statuses()` is a CACHE: it is assigned only at the end of a pass, and a
  // pass runs only on a settings commit. A server that connected once and dies
  // later therefore keeps reporting `mounted` forever. This loop is the only
  // periodic caller: it re-derives liveness from the LIVE tool registry, tries
  // to reconnect whatever is down, and only then tells the operator — once per
  // outage, cleared on recovery.
  const health = createHealthLoop({
    intervalMs: MCP_HEALTH_INTERVAL_MS,
    snapshot: exhausted => mcpManager.healthSnapshot(exhausted),
    retry: servers => mcpManager.retryUnhealthy(servers),
    exhausted: () => mcpManager.exhaustedServerNames(),
    // ONE state machine, TWO sinks. The logger line fires on every host — web
    // and headless alike — with no "is there a webserver?" branch here.
    notify: (notice) => {
      ctx.logger.warn(
        `dsh-project-context: MCP server "${notice.serverName}" is not connected — reconnect attempted (${notice.reasonCode})`,
      )
    },
    log: {
      info: message => ctx.logger.info(message),
      warn: message => ctx.logger.warn(message),
    },
  })

  ctx.effect(() => {
    health.start()
    return () => health.stop()
  }, 'dsh-project-context.mcpHealth()')

  /**
   * One tick, fully contained.
   *
   * The tick body is wrapped rather than the interval callback: an unhandled
   * rejection out of a timer would be a process-level error, and this loop must
   * never be able to break Agent publication or the Web server. The loop itself
   * also contains its own failures; this is the second, outermost belt.
   * @param waitMs - delay before ticking, in milliseconds.
   * @returns nothing; the tick's result is published through the notice registry.
   */
  const tickHealth = async (waitMs = 0): Promise<void> => {
    try {
      if (waitMs > 0) await new Promise(resolve => {
        const timer = setTimeout(resolve, waitMs) as unknown as { unref?: () => void }
        timer.unref?.()
      })
      await health.tick()
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-project-context: the MCP health tick escaped: ${String(error)}`)
    }
  }
  // One immediate tick, one second in. The first mount pass is armed by the
  // namespace install and its own settle window runs ~150 ms, so a tick at zero
  // would observe an empty `statuses` and publish nothing until the next
  // interval — leaving the route and the banner blank for a full minute after
  // every boot and every plugin reload. Nothing awaits either tick, and a tick
  // whose predecessor is still running is skipped inside the loop.
  void tickHealth(MCP_HEALTH_FIRST_TICK_MS)

  // The route that feeds the injected banner. An optional service inject, not a
  // required one: `dsh-host-webserver` is an optional peer, and a headless
  // profile must keep loading with the logger as its only sink. This is a
  // deliberate move from the plugin's previous EVENT-only, type-only coupling to
  // that package (the `webserver/index-inject` listener) to an optional service
  // consumer.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      try {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path: MCP_HEALTH_ROUTE,
          handler: (_req, res) => {
            try {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(healthPayload(health.notices())))
            } catch (error: unknown) {
              // The handler owns the whole response lifecycle, so a throw here
              // would leave the request hanging rather than failing loudly.
              webCtx.logger.warn(`dsh-project-context: the MCP health route failed: ${String(error)}`)
              try {
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('dsh-project-context: mcp health unavailable')
              } catch {}
            }
          },
        })
        return () => dispose()
      } catch (error: unknown) {
        // `register` throws on a duplicate (kind, path), which a plugin reload
        // or an HMR re-mount can produce. Soft-fail: the route is an optional
        // convenience, and losing it must not fail the plugin load.
        webCtx.logger.warn(
          `dsh-project-context: registering the MCP health route failed (another registration may already own it): ${String(error)}`,
        )
        return () => {}
      }
    }, 'dsh-project-context.mcpHealthRoute()')
  })

  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    reports.clear()
  }, 'dsh-project-context.scopedContext()')
}
