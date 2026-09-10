/**
 * Aggregated reporting for skipped files and cap violations.
 *
 * This plugin owns no tool description to surface a problem in, so a broken
 * agent file is visible only through the host logger. One report per discovery
 * keeps a directory of bad files from flooding the log.
 *
 * @module dsh-project-agents/diagnostics
 */

import type { Diagnostic, SourceLocation } from './types.ts'

/** Mutable accumulator handed through one discovery + mapping pass. */
export class DiagnosticSink {
  private readonly entries: Diagnostic[] = []

  /**
   * Record one skipped file or cap violation.
   * @param diagnostic - the cause, with its path and optional field/location.
   */
  add(diagnostic: Diagnostic): void {
    this.entries.push(diagnostic)
  }

  /** @returns every recorded diagnostic, in insertion order. */
  drain(): readonly Diagnostic[] {
    return [...this.entries]
  }

  /** @returns whether anything was recorded. */
  get isEmpty(): boolean {
    return this.entries.length === 0
  }
}

/** Render one diagnostic as a single log line fragment. */
function renderOne(diagnostic: Diagnostic): string {
  const where = diagnostic.location === undefined
    ? ''
    : `:${String(diagnostic.location.line)}:${String(diagnostic.location.column)}`
  const field = diagnostic.field === undefined ? '' : ` [${diagnostic.field}]`
  return `  - ${diagnostic.path}${where}${field}: ${diagnostic.reason}`
}

/**
 * Render one aggregated report for a discovery pass.
 * @param diagnostics - everything skipped during that pass.
 * @param mountedCount - how many agents did resolve, for context.
 * @param cwd - the Agent cwd the pass ran for.
 * @returns the multi-line report, or undefined when nothing was skipped.
 */
export function renderReport(
  diagnostics: readonly Diagnostic[],
  mountedCount: number,
  cwd: string,
): string | undefined {
  if (diagnostics.length === 0) return undefined
  const header = `dsh-project-agents: ${String(diagnostics.length)} agent definition`
    + `${diagnostics.length === 1 ? '' : 's'} skipped for cwd "${cwd}" `
    + `(${String(mountedCount)} mounted)`
  return [header, ...diagnostics.map(renderOne)].join('\n')
}

/**
 * Translate a byte offset in a file into a one-based line/column.
 * @param text - the complete file text the offset indexes into.
 * @param offset - a zero-based character offset.
 * @returns the one-based position.
 */
export function locationOf(text: string, offset: number): SourceLocation {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1
      lineStart = i + 1
    }
  }
  return { line, column: clamped - lineStart + 1 }
}
