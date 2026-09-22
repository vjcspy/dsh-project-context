/**
 * Rendering of the linked-documents block and the per-session re-read skip.
 *
 * The rendered text is byte-identical to what the Claude/Cursor hook injects
 * (`agent/hooks/linked-docs.mjs` and `renderLinkedDocumentsText` in
 * `workspace-memory`): the same `Linked documents (N):` header and the same
 * `- <path> — <name>: <description>` line. Two things deliberately differ, and
 * both are plugin-local because neither transport exposes them:
 *
 * - descriptions are truncated to {@link MAX_DESCRIPTION_CHARS}, since the
 *   backend default is `Infinity` and `paths|session|max|depth` is the whole
 *   parameter surface;
 * - the lookup runs at `depth=1` (direct links only) — a depth-3 probe of one
 *   plan returned 93 candidates with 78 omitted, which is not a block worth
 *   injecting on every read.
 *
 * @module dsh-project-context/linked-documents/payload
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { LinkedDocumentsResult } from './backend.ts'

/**
 * Plugin-local description cap. The header and the line format stay
 * byte-identical to the hook; only the description body is bounded.
 */
export const MAX_DESCRIPTION_CHARS = 200

/** Ellipsis appended to a truncated description — the backend's own truncator. */
const ELLIPSIS = '…'

/** Plugin provenance stamped on every injected block. */
const PLUGIN_SOURCE = {
  kind: 'plugin',
  plugin: 'dsh-project-context',
  form: 'notice',
} as const

/**
 * Bound one description to {@link MAX_DESCRIPTION_CHARS}, trimming the trailing
 * space the ellipsis would otherwise leave stranded.
 * @param value - the backend-supplied description.
 * @returns the description, ellipsized when it exceeded the cap.
 */
export function truncateDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value
  return `${value.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}${ELLIPSIS}`
}

/**
 * Render the injected block, or undefined when there is nothing to inject.
 *
 * An empty link set injects NOTHING — not even a header — so a read of an
 * unlinked document stays completely silent.
 * @param result - the backend outcome.
 * @returns the block text, or undefined.
 */
export function renderLinkedDocuments(result: LinkedDocumentsResult): string | undefined {
  const docs = result.linked_documents
  if (docs.length === 0) return undefined
  const lines = docs.map(
    doc => `- ${doc.path} — ${doc.name}: ${truncateDescription(doc.description)}`,
  )
  return [`Linked documents (${String(docs.length)}):`, ...lines].join('\n')
}

/**
 * Wrap the block as the user message delivered through `additionalContexts`.
 * @param block - the rendered block text.
 * @returns the message, tagged with this plugin as its source.
 */
export function linkedDocumentsMessage(block: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: block }],
    source: { ...PLUGIN_SOURCE, summary: 'linked documents' },
  })
}

/**
 * Per-session record of read paths whose lookup is finished.
 *
 * The backend owns cross-document dedup: it filters already-seen paths OUT
 * before the cap, so a repeat read returns a DIFFERENT batch rather than a
 * repeat. That is why a path is only recorded once its lookup reported
 * `omitted === 0` — recording an over-cap path would drop the documents the cap
 * still owes the session. The cost of not recording it is one extra backend call
 * per over-cap document per session, which is the cheaper error.
 */
export class ReadPathSkips {
  readonly #bySession = new Map<string, Set<string>>()

  /**
   * Whether this read path was already fully delivered to this session.
   * @param sessionKey - the session identity.
   * @param relPath - the root-relative read path.
   * @returns true when the lookup can be skipped.
   */
  has(sessionKey: string, relPath: string): boolean {
    return this.#bySession.get(sessionKey)?.has(relPath) ?? false
  }

  /**
   * Record one completed lookup.
   * @param sessionKey - the session identity.
   * @param relPath - the root-relative read path.
   * @param omitted - how many fresh documents the cap dropped; a non-zero count
   * leaves the path unrecorded so a later re-read fetches the next batch.
   */
  record(sessionKey: string, relPath: string, omitted: number): void {
    if (omitted !== 0) return
    const paths = this.#bySession.get(sessionKey) ?? new Set<string>()
    paths.add(relPath)
    this.#bySession.set(sessionKey, paths)
  }

  /**
   * Drop one session's record.
   * @param sessionKey - the session identity.
   */
  forget(sessionKey: string): void {
    this.#bySession.delete(sessionKey)
  }

  /** Drop every record — used when the owning plugin context is disposed. */
  clear(): void {
    this.#bySession.clear()
  }
}
