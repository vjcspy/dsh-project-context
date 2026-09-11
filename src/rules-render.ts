/**
 * Rendering and bounding of the project-rules snapshot message.
 *
 * Two properties are non-negotiable here.
 *
 * **Bodies pass through VERBATIM.** No sanitization, no escaping, no
 * rejection. `interpolate()` runs only over system-prompt sections and
 * contexts (`packages/core/system-prompt/src/index.ts:275,314,319`), never over
 * inbox messages, so a `{{example}}` in a rule file is inert on this path.
 * Rewriting it — as `sanitizeForPrompt` does for diagnostics bound for a
 * prompt SECTION — would make a rule teach the wrong syntax, which is a defect
 * in an instruction channel. This is the whole reason the inbox mechanism was
 * chosen over `systemPrompt.section`.
 *
 * **The bound covers the emitted value.** `packages/AGENTS.md:16` requires
 * limits "where the complete emitted or retained value, including wrappers and
 * metadata, is known". The cap here is measured on the fully rendered message
 * — preamble, every per-file header, separators and the closing frame — not on
 * the sum of the bodies, because many tiny files would otherwise blow the
 * prompt budget while every per-file check passed.
 *
 * @module dsh-project-context/rules-render
 */

import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { DiagnosticSink } from './diagnostics.ts'
import { digestOf } from './rules-discovery.ts'

/** Opening frame of every rendered snapshot. */
const FRAME_OPEN = '<system-reminder>\n'

/** Closing frame of every rendered snapshot. */
const FRAME_CLOSE = '\n</system-reminder>'

/** One rule body plus the identity it is rendered under. */
export interface RenderableRule {
  /** Filename inside the rules directory; the stable scope identity. */
  readonly scope: string
  /** Absolute path, quoted in the per-file header. */
  readonly path: string
  /** The verbatim body. */
  readonly body: string
  /** SHA-256 of {@link body}. */
  readonly digest: string
}

/** A rendered snapshot plus what the byte budget actually allowed in. */
export interface RenderedRules {
  /** The complete model-facing text, framing included. */
  readonly text: string
  /** One entry per represented file, in delivery order. */
  readonly sections: readonly ContextSnapshotSection[]
  /** The rules actually represented by {@link text}. */
  readonly included: readonly RenderableRule[]
  /** Scopes the byte budget forced out, in the order they were dropped. */
  readonly dropped: readonly string[]
}

/**
 * The snapshot preamble.
 *
 * The supersession sentence is the model-facing half of the mechanism, and it
 * is required: history is append-only, every admitted user message is
 * serialized to the provider in order, and `source.kind` is invisible to the
 * model. Without this sentence an edited rule would sit in the transcript
 * beside its replacement with nothing to say which one governs. The wording
 * follows the host's own runtime-context snapshot
 * (`packages/core/system-prompt/src/index.ts:300`).
 * @param directory - absolute rules directory, quoted for the operator.
 * @returns the preamble text, without framing.
 */
export function rulesPreamble(directory: string): string {
  return 'Project rules loaded from '
    + `\`${directory}\`.`
    + ' This snapshot supersedes every earlier project-rules snapshot in this conversation:'
    + ' the files below are the complete, current rule set, and any project rule shown earlier'
    + ' that does not appear here no longer applies.'
    + ' Follow them as guidance for work in this project.'
    + ' They do not override system, developer, or direct user instructions.'
}

/**
 * The message emitted when a previously non-empty rule set is CONFIRMED empty.
 *
 * Dropping a pending message would not do this job: the earlier snapshots are
 * already in history and keep governing the Agent until something says
 * otherwise. Only emitted for confirmed absence, never for `unavailable`.
 * @param directory - absolute rules directory that is now empty or gone.
 * @param removed - the scopes that are no longer in force.
 * @returns the complete clearing message, framing included.
 */
export function renderClearingMessage(directory: string, removed: readonly string[]): string {
  const list = removed.length === 0
    ? ''
    : `\n\nNo longer in force: ${[...removed].sort().join(', ')}.`
  return FRAME_OPEN
    + `Project rules from \`${directory}\` are no longer present.`
    + ' Every earlier project-rules snapshot in this conversation is superseded and no longer applies.'
    + ' Disregard those project rules entirely; the rest of this conversation is unaffected.'
    + list
    + FRAME_CLOSE
}

/** Per-file header. Stable, so a body change is the only thing that moves. */
function sectionHeader(rule: RenderableRule): string {
  return `Rule file: ${rule.scope}\nSource: ${rule.path}`
}

/** The exact text one rule contributes, header included. */
function sectionText(rule: RenderableRule): string {
  return `${sectionHeader(rule)}\n\n${rule.body}`
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Render one bounded snapshot.
 *
 * The budget is applied by composing the final string incrementally and
 * measuring the WHOLE thing at every step, so the returned text is guaranteed
 * to satisfy the cap. Overflow drops whole files, never a partial body: a
 * half-quoted instruction is worse than an absent one, and dropping whole
 * files also removes any possibility of splitting a multibyte code point.
 * Files are dropped from the first one that does not fit onward, so the result
 * is a deterministic prefix of the sorted order.
 * @param rules - the present rules, already sorted by filename.
 * @param directory - absolute rules directory.
 * @param maxRenderedBytes - cap on the complete rendered message.
 * @param sink - diagnostics accumulator for dropped files.
 * @returns the rendered snapshot, or undefined when nothing can be represented.
 */
export function renderRuleSnapshot(
  rules: readonly RenderableRule[],
  directory: string,
  maxRenderedBytes: number,
  sink: DiagnosticSink,
): RenderedRules | undefined {
  if (rules.length === 0) return undefined
  const preamble = rulesPreamble(directory)
  const base = FRAME_OPEN + preamble + FRAME_CLOSE
  if (byteLength(base) > maxRenderedBytes) {
    sink.add({
      severity: 'error',
      capability: 'rules',
      path: directory,
      reason: `the ${String(maxRenderedBytes)}-byte rendered cap cannot fit the snapshot preamble; no rules were loaded`,
    })
    return undefined
  }

  const included: RenderableRule[] = []
  const sections: ContextSnapshotSection[] = []
  const dropped: string[] = []
  let body = preamble
  let capped = false
  for (const rule of rules) {
    if (capped) {
      dropped.push(rule.scope)
      sink.add({
        severity: 'error',
        capability: 'rules',
        path: rule.path,
        reason: `dropped: the ${String(maxRenderedBytes)}-byte rendered cap was already reached`,
      })
      continue
    }
    const text = sectionText(rule)
    const candidate = `${body}\n\n${text}`
    if (byteLength(FRAME_OPEN + candidate + FRAME_CLOSE) > maxRenderedBytes) {
      capped = true
      dropped.push(rule.scope)
      sink.add({
        severity: 'error',
        capability: 'rules',
        path: rule.path,
        reason: `dropped: adding it would exceed the ${String(maxRenderedBytes)}-byte rendered cap`,
      })
      continue
    }
    body = candidate
    included.push(rule)
    sections.push({ name: rule.scope, text })
  }

  if (included.length === 0) return undefined
  return { text: FRAME_OPEN + body + FRAME_CLOSE, sections, included, dropped }
}

/**
 * Identity of one delivered snapshot.
 *
 * Covers the rendered text AND the represented file identities, so two
 * snapshots that happen to render the same prose from different files are
 * still distinguishable. Used for dedup within a session and for post-resume
 * reconciliation, where the in-memory cache is gone and the last delivered
 * message in history is the only record of what the model has seen.
 * @param text - the complete rendered message.
 * @param rules - the rules that message represents.
 * @returns the lowercase hex digest.
 */
export function snapshotDigest(text: string, rules: readonly RenderableRule[]): string {
  const identity = rules.map(rule => `${rule.scope} ${rule.digest}`).join('')
  return digestOf(`${identity}${text}`)
}
