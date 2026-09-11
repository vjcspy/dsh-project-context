/**
 * The `project-rules` message source.
 *
 * `MessageSourceMap` is a merge-extensible interface in `@deepseek-ai/dsh-llm`
 * (`packages/llm/llm/src/message.ts:100-105`) and first-party packages already
 * augment it — `webhook` (`packages/webhook/webhook/src/types.ts:70-83`) and
 * `agent-team` (`packages/experimental/agent-team/src/types.ts:123-127`). A
 * distinct kind is required here for ONE reason and it is not supersession:
 * `agent-instructions` reconciliation removes every pending message matching
 * `message.source.kind === 'agent-instructions'`
 * (`packages/context/agent-instructions/src/index.ts:65,227`), so sharing that
 * kind would let the two plugins delete each other's pending input. The kind is
 * a non-interference property. It says nothing at all to the model — that is
 * what the rendered preamble is for.
 *
 * @module dsh-project-context/message-source
 */

import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

/**
 * One per-file transition relative to the previously delivered snapshot,
 * following the `AgentInstructionChange` precedent
 * (`packages/context/agent-instructions/src/render.ts:47-52`).
 *
 * These deltas are the machine-readable half of supersession. The human/model
 * half is carried in the rendered preamble, because history is append-only and
 * a consumer that ignores `changes` must still be told, in prose, that an
 * earlier snapshot no longer applies.
 */
export interface ProjectRuleChange {
  /** `set` first delivery, `replace` a changed body, `remove` a confirmed disappearance. */
  readonly action: 'set' | 'replace' | 'remove'
  /** Stable identity of the rule: its filename inside `.dsh/rules`. */
  readonly scope: string
  /** Absolute path observed at the time of the transition. */
  readonly path: string
  /** SHA-256 of the retained body. Absent for `remove`. */
  readonly digest?: string
}

/**
 * Source of one durable `project-rules` user message.
 *
 * `form: 'snapshot'` is the host's own vocabulary for "current state, where a
 * later snapshot from the same producer supersedes an earlier one"
 * (`packages/llm/llm/src/message.ts:56`), and it obliges the producer to carry
 * its named contributions in `sections`, which is exactly one entry per rule
 * file. Those sections are also what post-resume reconciliation reads back to
 * rebuild last-good state when this process's in-memory cache is gone.
 */
export interface ProjectRulesSource {
  readonly kind: 'project-rules'
  readonly form: 'snapshot'
  /** One entry per rule file actually represented, in delivery order. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Digest over the rendered text plus the represented file identities. */
  readonly snapshot: string
  /** The absolute rules directory this snapshot describes. */
  readonly directory: string
  /** Per-file transitions against the previously delivered snapshot. */
  readonly changes: readonly ProjectRuleChange[]
  /** Present only on the clearing message emitted for a confirmed non-empty → empty. */
  readonly cleared?: true
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-rules': ProjectRulesSource
  }
}
