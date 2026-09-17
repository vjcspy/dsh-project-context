/**
 * YAML frontmatter parsing and validation for one markdown command file.
 *
 * This module NEVER throws: command files are resolved inside a synchronous
 * `agent/created` listener, and a listener throw VETOES Agent publication
 * (`packages/core/agent/src/index.ts:545-553`), so a typo in one file must
 * never be able to abort Agent creation. Every failure is returned as a
 * {@link Diagnostic}.
 *
 * The contract is deliberately narrower than Claude Code's:
 *
 * - only `description` (required) and `argument-hint` (optional) are
 *   understood, and any other key is a rejection rather than a silent ignore;
 * - nothing in a command file is ever executed — there are no `` !`cmd` ``
 *   fragments, no `@` file references and no `${CLAUDE_*}` interpolation, so a
 *   project-controlled markdown file cannot become an execution entry point.
 *
 * @module dsh-project-context/command-frontmatter
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { basename } from 'node:path'
import { locationOf } from './diagnostics.ts'
import { findInterpolationHazard, splitFrontmatter } from './frontmatter.ts'
import type { CommandFile, Diagnostic } from './types.ts'

/** Every top-level frontmatter key a command file may declare. */
const KNOWN_KEYS = new Set(['description', 'argument-hint'])

/**
 * Command names are lower-kebab/snake words.
 *
 * This is DSH's own rule for `CommandDefinition.name`
 * (`packages/interaction/commands/src/index.ts`, `normalizeDefinition`), and the
 * name is taken from the FILENAME so the `/` menu and the filesystem can never
 * disagree about what the operator can type.
 */
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u

/**
 * Upper bound on a command description, in characters.
 *
 * Chosen with headroom over the real corpus: the longest `description` among
 * Aweave's thirteen `agent/commands/common/*.md` files is 192 characters. DSH
 * itself imposes no cap — `normalizeDefinition` only requires a non-empty
 * string — so this bound is ours; it keeps one `/` menu row readable and is
 * enforced so an over-long description is reported rather than silently taken.
 */
export const MAX_COMMAND_DESCRIPTION_CHARS = 256

/** Upper bound on an `argument-hint` value, in characters. */
export const MAX_ARGUMENT_HINT_CHARS = 64

/**
 * The `input.hint` declared when a file sets no `argument-hint`.
 *
 * Zero of the thirteen corpus files set `argument-hint`, so without a default
 * the `/` menu would offer no argument affordance on any distributed command.
 * `rawInput` reaches the handler regardless of the hint, so this is
 * presentation only and never gates argument delivery.
 */
export const DEFAULT_ARGUMENT_HINT = '[arguments]'

/** A successful parse, or the diagnostic explaining the rejection. */
export type CommandParseResult =
  | { readonly ok: true; readonly fields: CommandFile }
  | { readonly ok: false; readonly diagnostic: Diagnostic }

function fail(
  path: string,
  reason: string,
  field?: string,
  offset?: { text: string; at: number },
): CommandParseResult {
  return {
    ok: false,
    diagnostic: {
      // A rejected file is never usable, so it is always an `error`.
      severity: 'error',
      capability: 'commands',
      path,
      reason,
      ...(field === undefined ? {} : { field }),
      ...(offset === undefined ? {} : { location: locationOf(offset.text, offset.at) }),
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one non-empty single-line string field, or explain why it is unusable.
 */
function readLine(
  document: Record<string, unknown>,
  key: string,
  path: string,
  maxChars: number,
): { ok: true; value: string } | { ok: false; result: CommandParseResult } {
  const raw = document[key]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, result: fail(path, `\`${key}\` must be a non-empty string when present`, key) }
  }
  if (raw.length > maxChars) {
    return { ok: false, result: fail(path, `\`${key}\` must be at most ${String(maxChars)} characters`, key) }
  }
  if (/[\r\n]/u.test(raw)) {
    return { ok: false, result: fail(path, `\`${key}\` must be a single line`, key) }
  }
  return { ok: true, value: raw }
}

/**
 * Parse and validate one markdown command file.
 *
 * @param path - absolute path of the file. Its basename is the command name and
 *   it is used by every diagnostic.
 * @param raw - the complete file text.
 * @returns the validated fields, or the diagnostic explaining the rejection.
 */
export function parseCommandFile(path: string, raw: string): CommandParseResult {
  const name = basename(path).replace(/\.md$/u, '')
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return fail(
      path,
      `the filename must yield a command name matching ${String(COMMAND_NAME_PATTERN)}; got "${name}"`,
      'name',
    )
  }

  // A UTF-8 BOM would defeat the leading `---` match; strip it before splitting
  // so diagnostics are computed against the same text the parser saw.
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const split = splitFrontmatter(text)
  if (split === undefined) {
    return fail(path, 'missing a leading `---` YAML frontmatter block declaring `description`')
  }

  let document: unknown
  try {
    document = loadYaml(split.yaml, { filename: path })
  } catch (error: unknown) {
    const mark = error instanceof YAMLException ? error.mark : undefined
    const at = mark === undefined ? split.yamlOffset : split.yamlOffset + mark.position
    return fail(
      path,
      `invalid YAML frontmatter: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`,
      undefined,
      { text, at },
    )
  }
  if (!isPlainObject(document)) {
    return fail(path, 'frontmatter must be a YAML mapping')
  }

  for (const key of Object.keys(document)) {
    if (!KNOWN_KEYS.has(key)) {
      return fail(path, `unknown frontmatter key "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`)
    }
  }

  const description = Object.hasOwn(document, 'description')
    ? readLine(document, 'description', path, MAX_COMMAND_DESCRIPTION_CHARS)
    : undefined
  if (description === undefined) {
    return fail(path, '`description` is required and must be a non-empty string', 'description')
  }
  if (!description.ok) return description.result
  // The description is a public, operator-visible string that this plugin also
  // reports and advertises; keeping it free of the system-prompt interpolation
  // token is a cheap invariant that survives the description being surfaced
  // into any prompt-shaped channel later.
  const descriptionHazard = findInterpolationHazard(description.value)
  if (descriptionHazard >= 0) {
    // Point at the hazard inside the raw block when the scalar appears verbatim
    // there; a folded or quoted scalar falls back to the block start.
    const verbatim = split.yaml.indexOf(description.value)
    const at = verbatim >= 0
      ? split.yamlOffset + verbatim + descriptionHazard
      : split.yamlOffset
    return fail(
      path,
      'contains a balanced `{{ \u2026 }}` reference, which system-prompt assembly rejects',
      'description',
      { text, at },
    )
  }

  let hint = DEFAULT_ARGUMENT_HINT
  if (Object.hasOwn(document, 'argument-hint')) {
    const parsed = readLine(document, 'argument-hint', path, MAX_ARGUMENT_HINT_CHARS)
    if (!parsed.ok) return parsed.result
    hint = parsed.value
  }

  // The body is delivered VERBATIM as a user message, exactly like a rule body,
  // so it is deliberately not brace-checked: it never enters a system-prompt
  // section and the operator wrote it.
  const body = split.body
  if (body.trim().length === 0) {
    return fail(path, 'body is empty — the markdown body becomes the prompt template', 'body')
  }

  return {
    ok: true,
    fields: { name, description: description.value, hint, body },
  }
}
