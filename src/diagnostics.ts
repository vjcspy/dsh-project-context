/**
 * Aggregated reporting for skipped files and cap violations.
 *
 * This plugin owns no tool description to surface a problem in, and the host
 * logger alone cannot reach the operator: cordis delivers `ctx.logger` records
 * to registered exporters only, and the composed `web` profile mounts none, so
 * a warning is buffered in memory and dropped. One discovery pass therefore
 * produces three channels:
 *
 * - {@link renderReport} — the complete host-logger report. Authoritative, but
 *   invisible on a profile without a log exporter.
 * - {@link renderSurfacedDiagnostics} — a bounded, prompt-safe block carried by
 *   the Agent-scoped catalog section, so the model can answer "why is the agent
 *   I declared missing?" on every surface, including surfaces with no UI.
 * - {@link renderWebNotice} — a body script row for `webserver/index-inject`,
 *   which paints a dismissible banner in the web GUI.
 *
 * @module dsh-project-agents/diagnostics
 */

import type { Diagnostic, SourceLocation } from './types.ts'

/** Rows a surfaced block may carry before it is truncated. */
export const MAX_SURFACED_DIAGNOSTICS = 5

/** Characters one surfaced reason may occupy. */
export const MAX_SURFACED_REASON_CHARS = 200

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

/**
 * Keep only the diagnostics the operator has to act on. A `notice` records an
 * ordinary precedence outcome (the project file shadowing a global one), which
 * is not something to report as a problem.
 * @param diagnostics - every diagnostic from one pass.
 * @returns the diagnostics whose definitions are genuinely unavailable.
 */
export function errorsOf(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.filter(diagnostic => diagnostic.severity === 'error')
}

/** Render `path:line:column [field]`, the location part of a diagnostic line. */
function position(diagnostic: Diagnostic): string {
  const where = diagnostic.location === undefined
    ? ''
    : `:${String(diagnostic.location.line)}:${String(diagnostic.location.column)}`
  const field = diagnostic.field === undefined ? '' : ` [${diagnostic.field}]`
  return `${diagnostic.path}${where}${field}`
}

/**
 * Render one diagnostic as a single line, labelled with its severity.
 * @param diagnostic - the diagnostic to render.
 * @returns the line, with no leading indentation.
 */
export function renderLine(diagnostic: Diagnostic): string {
  return `${diagnostic.severity}: ${position(diagnostic)}: ${diagnostic.reason}`
}

/**
 * Render one aggregated report for a discovery pass.
 * @param diagnostics - everything skipped during that pass.
 * @param mountedCount - how many agents did resolve, for context.
 * @param cwd - the Agent cwd the pass ran for.
 * @returns the multi-line report, or undefined when nothing was recorded.
 */
export function renderReport(
  diagnostics: readonly Diagnostic[],
  mountedCount: number,
  cwd: string,
): string | undefined {
  if (diagnostics.length === 0) return undefined
  const skipped = errorsOf(diagnostics).length
  const notices = diagnostics.length - skipped
  const plural = (count: number): string => (count === 1 ? '' : 's')
  const header = `dsh-project-agents: ${String(skipped)} agent definition${plural(skipped)}`
    + ` skipped for cwd "${cwd}" (${String(mountedCount)} mounted)`
    + (notices === 0 ? '' : `; ${String(notices)} notice${plural(notices)}`)
  return [header, ...diagnostics.map(diagnostic => `  ${renderLine(diagnostic)}`)].join('\n')
}

/**
 * Break every `{{` and `}}` pair so the text can never be read as a
 * system-prompt variable reference.
 *
 * This matters for the surfaced block specifically: a rejection reason quotes
 * the offending construct, so the diagnostic text itself contains the very
 * pattern the frontmatter guard rejects, and interpolation throws on any
 * balanced `{{ … }}` in an assembled section
 * (`packages/core/system-prompt/src/index.ts:327-350`). Surfacing an
 * unfiltered reason would therefore kill prompt assembly — the exact failure
 * the guard exists to prevent. Pairs are split by a space rather than removed
 * so the operator still sees what the file contained.
 * @param text - any diagnostic text bound for a model-facing section.
 * @returns the same text with no adjacent braces.
 */
export function sanitizeForPrompt(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    out += (char === '{' && next === '{') || (char === '}' && next === '}')
      ? `${String(char)} `
      : String(char)
  }
  return out
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`
}

/**
 * Render the bounded, prompt-safe block that goes into the catalog section.
 * @param diagnostics - every diagnostic from one pass.
 * @returns one line per surfaced error, or an empty array when none apply.
 */
export function renderSurfacedDiagnostics(diagnostics: readonly Diagnostic[]): readonly string[] {
  const errors = errorsOf(diagnostics)
  if (errors.length === 0) return []
  const shown = errors.slice(0, MAX_SURFACED_DIAGNOSTICS)
  const lines = shown.map(diagnostic => sanitizeForPrompt(
    renderLine({ ...diagnostic, reason: truncate(diagnostic.reason, MAX_SURFACED_REASON_CHARS) }),
  ))
  if (errors.length > shown.length) {
    lines.push(`- and ${String(errors.length - shown.length)} more skipped definition(s), listed in the host log`)
  }
  return lines
}

/** One Agent cwd's diagnostics, as the web notice needs them. */
export interface NoticeGroup {
  /** The cwd the discovery pass ran for. */
  readonly cwd: string
  /** Every diagnostic that pass recorded. */
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Build the `webserver/index-inject` body script that paints the operator a
 * banner naming the skipped definitions.
 *
 * A `script` row is used rather than an `html` row because the script kind has
 * a first-party precedent (`packages/client/ui-theme/src/index.ts:40-43`),
 * and because the banner is then built with `textContent` from a JSON payload:
 * no diagnostic text is ever parsed as markup, and the payload escapes `<` so
 * it cannot close the script element early.
 * @param groups - current diagnostics per cwd.
 * @returns the script source, or undefined when nothing needs reporting.
 */
export function renderWebNotice(groups: readonly NoticeGroup[]): string | undefined {
  const rows: Array<{ cwd: string; text: string }> = []
  for (const group of groups) {
    for (const diagnostic of errorsOf(group.diagnostics)) {
      rows.push({
        cwd: group.cwd,
        text: `${position(diagnostic)}: ${truncate(diagnostic.reason, MAX_SURFACED_REASON_CHARS)}`,
      })
      if (rows.length >= MAX_SURFACED_DIAGNOSTICS) break
    }
    if (rows.length >= MAX_SURFACED_DIAGNOSTICS) break
  }
  if (rows.length === 0) return undefined
  const payload = JSON.stringify(rows).replaceAll('<', '\\u003c')
  return ';(() => {'
    + ' try {'
    + ` const rows = ${payload};`
    + ' if (!rows.length) return;'
    + " const id = 'dsh-project-agents-notice';"
    + ' if (document.getElementById(id)) return;'
    + " const box = document.createElement('div'); box.id = id; box.setAttribute('role', 'alert');"
    + " box.style.cssText = 'position:fixed;z-index:2147483647;left:12px;right:12px;bottom:12px;"
    + 'max-width:720px;margin:0 auto;padding:10px 12px;border:1px solid #b45309;border-radius:8px;'
    + "background:#fffbeb;color:#78350f;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;"
    + "box-shadow:0 6px 20px rgba(0,0,0,.18)';"
    + " const title = document.createElement('div');"
    + " title.textContent = 'dsh-project-agents: ' + rows.length + ' agent definition(s) skipped';"
    + " title.style.cssText = 'font-weight:600;margin-bottom:4px'; box.appendChild(title);"
    + " const list = document.createElement('ul'); list.style.cssText = 'margin:0;padding-left:18px';"
    + ' for (const row of rows) {'
    + "  const item = document.createElement('li');"
    + "  item.textContent = row.cwd + ' \u2014 ' + row.text; list.appendChild(item);"
    + ' }'
    + ' box.appendChild(list);'
    + " const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Dismiss';"
    + " close.style.cssText = 'margin-top:6px;cursor:pointer;border:1px solid #b45309;border-radius:6px;"
    + "background:transparent;color:inherit;padding:2px 8px';"
    + " close.addEventListener('click', () => { box.remove() }); box.appendChild(close);"
    + ' document.body.appendChild(box);'
    + ' } catch {}'
    + '})();'
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
