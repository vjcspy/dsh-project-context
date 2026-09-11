/**
 * Reconciliation of the project-rules snapshot inside the `agent/pre-step`
 * waterfall.
 *
 * **Why the waterfall and not the inbox.** `AgentLoop.preStep()` CLAIMS — that
 * is, removes — the entire `next-step` batch before dispatching the waterfall
 * (`packages/core/agent-loop/src/agent.ts:245`, then `:249`;
 * `Inbox.claim` empties the queue at
 * `packages/core/agent-loop/src/inbox.ts:113`). `Inbox.replace`/`remove`
 * resolve through `locate` and therefore act only on still-pending messages
 * (`:136-158`), so by the time a listener runs, `replace` returns `false` and
 * `prepend` queues for a LATER step. The only way to change the request being
 * assembled is to fold the message into `decision.messages`, exactly as
 * `agent-instructions` does (`packages/context/agent-instructions/src/index.ts:313-339`).
 *
 * **Why supersession is durable.** An admitted message is appended to session
 * history permanently and every user-message body is serialized to the
 * provider in order, regardless of `source.kind`. Removing a pending message
 * therefore does nothing about rules the model has already read. Supersession
 * is carried twice: in the rendered preamble (for the model) and in `changes`
 * deltas (for consumers), and a confirmed emptiness produces an explicit
 * clearing message rather than silence.
 *
 * @module dsh-project-context/rules-reconcile
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { DiagnosticSink } from './diagnostics.ts'
import type { ProjectRuleChange, ProjectRulesSource } from './message-source.ts'
import { digestOf } from './rules-discovery.ts'
import {
  renderClearingMessage,
  renderRuleSnapshot,
  snapshotDigest,
  type RenderableRule,
} from './rules-render.ts'
import type { RuleScan } from './types.ts'

/** Last-good body retained for one scope between reconciliations. */
export interface RetainedRule {
  readonly path: string
  readonly body: string
  readonly digest: string
}

/**
 * Everything one Agent remembers between reconciliations.
 *
 * Two caches, kept apart on purpose:
 * - `retained` is last-good CONTENT. It is never advanced for an
 *   `unavailable` observation, so the next step re-reads and a recovered file
 *   whose content changed is still detected.
 * - `delivered*` is what the MODEL has already been shown. It is advanced
 *   whenever a message actually enters a request, because the model has in
 *   fact seen it and re-sending would duplicate.
 */
export interface RulesState {
  readonly retained: ReadonlyMap<string, RetainedRule>
  /** Snapshot digest of the last message actually delivered, if any. */
  readonly deliveredDigest: string | undefined
  /** Scopes the last delivered message represented. */
  readonly deliveredScopes: readonly string[]
  /** Per-scope digests as of the last delivered message. */
  readonly deliveredDigests: ReadonlyMap<string, string>
}

/** The empty starting state for an Agent with no history of its own. */
export function emptyRulesState(): RulesState {
  return {
    retained: new Map(),
    deliveredDigest: undefined,
    deliveredScopes: [],
    deliveredDigests: new Map(),
  }
}

function isProjectRules(message: UserMessage): boolean {
  return message.source.kind === 'project-rules'
}

/**
 * Rebuild delivered state from the transcript.
 *
 * Called when this process has no in-memory state for an Agent but the session
 * may already carry snapshots: a resume, a fork, or a plugin reload (HMR). The
 * `sections` carried on the source are exactly the per-file bodies, so the
 * last delivered message is a complete record of what the model has seen and
 * what content it saw — which is why `form: 'snapshot'` obliges a producer to
 * carry them. Mirrors `visibleBaselineSource`
 * (`packages/context/agent-instructions/src/index.ts:46-62`).
 * @param agent - the Agent whose history is inspected.
 * @param claimed - messages claimed for this step, searched first (newest wins).
 * @returns the recovered state, or undefined when the session carries none.
 */
export function recoverStateFromHistory(
  agent: Agent,
  claimed: readonly UserMessage[],
): RulesState | undefined {
  const fromSource = (source: ProjectRulesSource): RulesState => {
    const retained = new Map<string, RetainedRule>()
    const deliveredDigests = new Map<string, string>()
    for (const change of source.changes) {
      if (change.action === 'remove' || change.digest === undefined) continue
      deliveredDigests.set(change.scope, change.digest)
    }
    for (const section of source.sections) {
      // The section text is `header\n\nbody`; the body is everything after the
      // first blank line, which is how it was assembled in rules-render.
      const split = section.text.indexOf('\n\n')
      const body = split === -1 ? section.text : section.text.slice(split + 2)
      const digest = deliveredDigests.get(section.name) ?? digestOf(body)
      deliveredDigests.set(section.name, digest)
      retained.set(section.name, { path: `${source.directory}/${section.name}`, body, digest })
    }
    return {
      retained,
      deliveredDigest: source.snapshot,
      deliveredScopes: source.sections.map(section => section.name),
      deliveredDigests,
    }
  }

  for (const message of [...claimed].reverse()) {
    if (message.source.kind === 'project-rules') return fromSource(message.source)
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === 'project-rules') {
      return fromSource(event.data.source)
    }
  }
  return undefined
}

/** What one reconciliation concluded. */
export interface Reconciliation {
  /** The message to deliver, or undefined when nothing needs saying. */
  readonly desired: UserMessage | undefined
  /**
   * The state to commit IF `desired` is actually admitted. Never committed on
   * a preserve outcome, so the next step retries an unobserved file.
   */
  readonly next: RulesState
  /** True when an undetermined observation forced last-good preservation. */
  readonly preserved: boolean
}

/**
 * Reconcile one scan against what this Agent has already been shown.
 * @param scan - the tri-state scan for this Agent's cwd.
 * @param state - what the Agent remembers, possibly recovered from history.
 * @param bounds - the rendered-message cap.
 * @param sink - diagnostics accumulator.
 * @returns the message to deliver plus the state to commit on admission.
 */
export function reconcileRules(
  scan: RuleScan,
  state: RulesState,
  bounds: { readonly maxRenderedBytes: number },
  sink: DiagnosticSink,
): Reconciliation {
  const directory = scan.directory

  // ── The directory itself could not be observed ────────────────────────────
  // "Cannot observe" is not "deleted". Preserve the ENTIRE previous snapshot
  // and advance nothing, following the same-directory-group rollback at
  // `packages/context/agent-instructions/src/state.ts:351-364`, whose comment
  // states that cache warmth must never decide whether a transition is
  // emitted. Emitting `remove` here would durably deactivate live rules on a
  // transient EACCES.
  if (scan.directoryObservation === 'unavailable') {
    return { desired: undefined, next: state, preserved: true }
  }

  // ── The directory is confirmed absent ─────────────────────────────────────
  if (scan.directoryObservation === 'absent' || scan.files.length === 0) {
    if (state.deliveredScopes.length === 0) {
      return { desired: undefined, next: state, preserved: false }
    }
    // Confirmed non-empty → empty. Dropping pending input would leave the
    // already-admitted rules governing the Agent forever, so say so explicitly.
    const removals: ProjectRuleChange[] = state.deliveredScopes.map(scope => ({
      action: 'remove',
      scope,
      path: `${directory ?? ''}/${scope}`,
    }))
    const text = renderClearingMessage(directory ?? '(no project root)', state.deliveredScopes)
    const snapshot = digestOf(text)
    if (state.deliveredDigest === snapshot) {
      return { desired: undefined, next: state, preserved: false }
    }
    return {
      desired: createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'project-rules',
          form: 'snapshot',
          sections: [],
          snapshot,
          directory: directory ?? '',
          changes: removals,
          cleared: true,
        } satisfies ProjectRulesSource,
      }),
      next: { retained: new Map(), deliveredDigest: snapshot, deliveredScopes: [], deliveredDigests: new Map() },
      preserved: false,
    }
  }

  /* v8 ignore next -- a present directory always carries a path. */
  if (directory === undefined) return { desired: undefined, next: state, preserved: false }

  // ── The directory listing is authoritative; merge per file ────────────────
  const effective: RenderableRule[] = []
  const retained = new Map<string, RetainedRule>()
  let preserved = false
  for (const file of scan.files) {
    if (file.observation === 'present' && file.body !== undefined && file.digest !== undefined) {
      const rule: RenderableRule = { scope: file.scope, path: file.path, body: file.body, digest: file.digest }
      effective.push(rule)
      retained.set(file.scope, { path: file.path, body: file.body, digest: file.digest })
      continue
    }
    // Undetermined: keep this file's last-good body. The listing itself
    // succeeded, so the snapshot still names every file that exists — the only
    // unknown is one body, and substituting the last one we actually read is
    // strictly closer to the truth than dropping the rule.
    const last = state.retained.get(file.scope)
    if (last === undefined) {
      // First load: there is no last-good to preserve, so diagnose and skip.
      sink.add({
        severity: 'error',
        capability: 'rules',
        path: file.path,
        reason: 'rule file could not be read on first load; skipped (no previous content to fall back on)',
      })
      continue
    }
    preserved = true
    effective.push({ scope: file.scope, path: last.path, body: last.body, digest: last.digest })
    // Deliberately re-store the OLD entry: the content cache is not advanced
    // for an undetermined observation, so the next step retries.
    retained.set(file.scope, last)
  }

  const rendered = renderRuleSnapshot(effective, directory, bounds.maxRenderedBytes, sink)
  if (rendered === undefined) {
    // Nothing renderable. That is only a clearing event if something was in
    // force AND the emptiness is confirmed — which, with a `present` listing
    // and no preserved unknowns, it is.
    if (state.deliveredScopes.length === 0 || preserved) {
      return { desired: undefined, next: state, preserved }
    }
    const text = renderClearingMessage(directory, state.deliveredScopes)
    const snapshot = digestOf(text)
    if (state.deliveredDigest === snapshot) return { desired: undefined, next: state, preserved }
    return {
      desired: createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'project-rules',
          form: 'snapshot',
          sections: [],
          snapshot,
          directory,
          changes: state.deliveredScopes.map(scope => ({
            action: 'remove' as const,
            scope,
            path: `${directory}/${scope}`,
          })),
          cleared: true,
        } satisfies ProjectRulesSource,
      }),
      next: { retained: new Map(), deliveredDigest: snapshot, deliveredScopes: [], deliveredDigests: new Map() },
      preserved,
    }
  }

  const snapshot = snapshotDigest(rendered.text, rendered.included)
  const includedScopes = rendered.included.map(rule => rule.scope)
  const nextDigests = new Map(rendered.included.map(rule => [rule.scope, rule.digest] as const))
  const nextState: RulesState = {
    // Keep last-good for scopes the render budget dropped too: they still
    // exist on disk, and a later smaller edit should compare against what we
    // last read rather than look like a first sighting.
    retained,
    deliveredDigest: snapshot,
    deliveredScopes: includedScopes,
    deliveredDigests: nextDigests,
  }
  if (state.deliveredDigest === snapshot) {
    return { desired: undefined, next: nextState, preserved }
  }

  const changes: ProjectRuleChange[] = []
  for (const rule of rendered.included) {
    const previous = state.deliveredDigests.get(rule.scope)
    if (previous === undefined) changes.push({ action: 'set', scope: rule.scope, path: rule.path, digest: rule.digest })
    else if (previous !== rule.digest) {
      changes.push({ action: 'replace', scope: rule.scope, path: rule.path, digest: rule.digest })
    }
  }
  // A scope that was delivered and is no longer represented is retracted — but
  // only because the listing succeeded and did not name it, or because a
  // confirmed exclusion (oversize, empty, cap) removed it. An undetermined
  // file never reaches here: it was substituted with its last-good body above.
  const present = new Set(includedScopes)
  for (const scope of state.deliveredScopes) {
    if (present.has(scope)) continue
    changes.push({ action: 'remove', scope, path: `${directory}/${scope}` })
  }

  return {
    desired: createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: {
        kind: 'project-rules',
        form: 'snapshot',
        sections: rendered.sections,
        snapshot,
        directory,
        changes,
      } satisfies ProjectRulesSource,
    }),
    next: nextState,
    preserved,
  }
}

/**
 * Manage what stays PENDING when the current step will not carry the message.
 *
 * This mirrors `syncInbox` (`packages/context/agent-instructions/src/index.ts:226-250`)
 * with one deliberate difference: the filter is this plugin's own kind and
 * never `agent-instructions`, so the two reconcilers cannot delete each
 * other's pending input.
 * @param agent - the Agent whose inbox is managed.
 * @param claimed - the batch claimed for this step.
 * @param desired - the message that should be pending, if any.
 */
export function syncRulesInbox(
  agent: Agent,
  claimed: readonly UserMessage[],
  desired: UserMessage | undefined,
): void {
  const pending = agent.inbox.nextStep.filter(isProjectRules)
  const alreadySupplied = desired !== undefined && (
    claimed.some(message => sameRulesPayload(message, desired))
    || agent.session.surface.nodes.some((seq) => {
      const event = agent.session.eventAt(seq)
      return event?.type === 'user/message' && sameRulesPayload(event.data, desired)
    })
  )
  if (desired === undefined || alreadySupplied) {
    for (const message of pending) agent.inbox.remove(message.id)
    return
  }
  const reusable = pending.find(message => sameRulesPayload(message, desired))
  if (reusable !== undefined) {
    for (const message of pending) {
      if (message !== reusable) agent.inbox.remove(message.id)
    }
    return
  }
  const replaced = pending[0]
  if (replaced === undefined) agent.inbox.prepend('next-step', desired)
  else agent.inbox.replace(replaced.id, desired)
  for (const message of pending.slice(1)) agent.inbox.remove(message.id)
}

/**
 * Whether two messages carry the same rules payload.
 *
 * Compared on the snapshot digest rather than by deep equality: the digest
 * already covers the rendered text and the represented file identities, and it
 * is the same value used for post-resume recovery.
 */
export function sameRulesPayload(left: UserMessage, right: UserMessage): boolean {
  return left.source.kind === 'project-rules'
    && right.source.kind === 'project-rules'
    && left.source.snapshot === right.source.snapshot
}

/** Remove every pending message this plugin owns. */
export function dropPendingRules(agent: Agent): void {
  for (const message of agent.inbox.nextStep.filter(isProjectRules)) agent.inbox.remove(message.id)
}

export { isProjectRules }
