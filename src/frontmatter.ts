/**
 * YAML frontmatter parsing and validation for one markdown agent definition.
 *
 * This module NEVER throws: a synchronous `agent/created` listener that throws
 * vetoes Agent publication, so a typo in one file must not be able to abort
 * Agent creation. Every failure is returned as a {@link Diagnostic}.
 *
 * @module dsh-project-agents/frontmatter
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { locationOf } from './diagnostics.ts'
import type {
  AgentFileFields,
  BackgroundMode,
  Diagnostic,
  LlmRoute,
  ToolRestrictionFields,
  Transport,
} from './types.ts'

/** Every top-level frontmatter key this plugin understands. */
const KNOWN_KEYS = new Set([
  'name', 'description', 'transport', 'llm', 'tools', 'maxDepth', 'background',
])

const TRANSPORTS: readonly Transport[] = ['spawn', 'fork']
const BACKGROUND_MODES: readonly BackgroundMode[] = ['one-shot', 'continuable']

/** Agent names are lower-kebab/snake words; this is also the slug source. */
const NAME_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/

/** Upper bound on the catalog line one description contributes. */
export const MAX_DESCRIPTION_CHARS = 200

/** Upper bound on an agent name, keeping the generated tool name short. */
export const MAX_NAME_CHARS = 48

/** A successful parse, or the diagnostic explaining the rejection. */
export type ParseResult =
  | { readonly ok: true; readonly fields: AgentFileFields }
  | { readonly ok: false; readonly diagnostic: Diagnostic }

function fail(path: string, reason: string, field?: string, offset?: { text: string; at: number }): ParseResult {
  return {
    ok: false,
    diagnostic: {
      // A rejected file is never usable, so it is always an `error`.
      severity: 'error',
      path,
      reason,
      ...(field === undefined ? {} : { field }),
      ...(offset === undefined ? {} : { location: locationOf(offset.text, offset.at) }),
    },
  }
}

/**
 * Find a balanced `{{ … }}` reference, which the system-prompt interpolator
 * treats as a variable reference and throws on when it is malformed, unknown,
 * or valueless (`packages/core/system-prompt/src/index.ts:327-350`). Any `{{`
 * followed anywhere later by `}}` reaches one of those throw paths, so the
 * conservative rule is to reject it rather than guess at an escape.
 * @param text - a model-facing field (a section text or the persona body).
 * @returns the offset of the offending `{{`, or -1 when the text is safe.
 */
export function findInterpolationHazard(text: string): number {
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', open + 2)) {
    if (text.indexOf('}}', open + 2) >= 0) return open
  }
  return -1
}

interface Split {
  readonly yaml: string
  /** Offset of the first frontmatter character inside the original text. */
  readonly yamlOffset: number
  readonly body: string
  /** Offset of the first body character inside the original text. */
  readonly bodyOffset: number
}

/**
 * Split a markdown file into its YAML frontmatter block and its body.
 * @param text - the complete file text (BOM already stripped).
 * @returns the split, or undefined when no frontmatter block delimits the file.
 */
function splitFrontmatter(text: string): Split | undefined {
  const openMatch = /^---[ \t]*\r?\n/.exec(text)
  if (openMatch === null) return undefined
  const yamlOffset = openMatch[0].length
  const closeMatch = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(yamlOffset))
  if (closeMatch === null) return undefined
  const closeAt = yamlOffset + (closeMatch.index ?? 0)
  const bodyOffset = closeAt + closeMatch[0].length
  return {
    yaml: text.slice(yamlOffset, closeAt),
    yamlOffset,
    body: text.slice(bodyOffset),
    bodyOffset,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringArray(
  raw: unknown,
  path: string,
  field: string,
): { ok: true; value: string[] } | { ok: false; result: ParseResult } {
  if (!Array.isArray(raw)) return { ok: false, result: fail(path, 'must be an array of tool names', field) }
  const value: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return { ok: false, result: fail(path, 'must contain only non-empty tool-name strings', field) }
    }
    value.push(item)
  }
  if (value.length === 0) return { ok: false, result: fail(path, 'must not be empty', field) }
  return { ok: true, value }
}

function parseLlm(raw: unknown, path: string): { ok: true; value: LlmRoute } | { ok: false; result: ParseResult } {
  if (!isPlainObject(raw)) return { ok: false, result: fail(path, 'must be a mapping with `provider` and `model`', 'llm') }
  for (const key of Object.keys(raw)) {
    if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') {
      return { ok: false, result: fail(path, `unknown key "${key}" (allowed: provider, model, reasoningEffort)`, 'llm') }
    }
  }
  const provider = raw['provider']
  const model = raw['model']
  const reasoningEffort = raw['reasoningEffort']
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return { ok: false, result: fail(path, '`provider` and `model` are both required and must be non-empty strings', 'llm') }
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
    return { ok: false, result: fail(path, '`reasoningEffort` must be a non-empty string when present', 'llm') }
  }
  return {
    ok: true,
    value: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
  }
}

function parseTools(
  raw: unknown,
  path: string,
): { ok: true; value: ToolRestrictionFields } | { ok: false; result: ParseResult } {
  if (!isPlainObject(raw)) return { ok: false, result: fail(path, 'must be a mapping with `allow` and/or `deny`', 'tools') }
  for (const key of Object.keys(raw)) {
    if (key !== 'allow' && key !== 'deny') {
      return { ok: false, result: fail(path, `unknown key "${key}" (allowed: allow, deny)`, 'tools') }
    }
  }
  const allowRaw = raw['allow']
  const denyRaw = raw['deny']
  if (allowRaw === undefined && denyRaw === undefined) {
    // An empty explicit filter is rejected by tool-subagent at mount; reject it
    // here instead so the file is reported rather than the Agent's mount.
    return { ok: false, result: fail(path, 'names neither `allow` nor `deny` — remove the key or fill the filter', 'tools') }
  }
  let allow: string[] | undefined
  let deny: string[] | undefined
  if (allowRaw !== undefined) {
    const read = readStringArray(allowRaw, path, 'tools.allow')
    if (!read.ok) return read
    allow = read.value
  }
  if (denyRaw !== undefined) {
    const read = readStringArray(denyRaw, path, 'tools.deny')
    if (!read.ok) return read
    deny = read.value
  }
  return {
    ok: true,
    value: { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) },
  }
}

/**
 * Parse and validate one markdown agent definition.
 * @param path - absolute path of the file, used by every diagnostic.
 * @param text - the complete file text.
 * @returns the validated fields, or the diagnostic explaining the rejection.
 */
export function parseAgentFile(path: string, raw: string): ParseResult {
  // A UTF-8 BOM would defeat the leading `---` match; strip it before splitting
  // so diagnostics are computed against the same text the parser saw.
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const split = splitFrontmatter(text)
  if (split === undefined) {
    return fail(path, 'missing a leading `---` YAML frontmatter block')
  }

  let document: unknown
  try {
    document = loadYaml(split.yaml, { filename: path })
  } catch (error: unknown) {
    const mark = error instanceof YAMLException ? error.mark : undefined
    const at = mark === undefined ? split.yamlOffset : split.yamlOffset + mark.position
    return fail(path, `invalid YAML frontmatter: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`, undefined, { text, at })
  }
  if (!isPlainObject(document)) {
    return fail(path, 'frontmatter must be a YAML mapping')
  }

  for (const key of Object.keys(document)) {
    if (!KNOWN_KEYS.has(key)) {
      return fail(path, `unknown frontmatter key "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`)
    }
  }

  const name = document['name']
  if (typeof name !== 'string') return fail(path, '`name` is required and must be a string', 'name')
  if (name.length > MAX_NAME_CHARS) {
    return fail(path, `\`name\` must be at most ${String(MAX_NAME_CHARS)} characters`, 'name')
  }
  if (!NAME_PATTERN.test(name)) {
    return fail(path, `\`name\` must match ${String(NAME_PATTERN)}`, 'name')
  }

  const description = document['description']
  if (typeof description !== 'string' || description.trim().length === 0) {
    return fail(path, '`description` is required and must be a non-empty string', 'description')
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return fail(path, `\`description\` must be at most ${String(MAX_DESCRIPTION_CHARS)} characters`, 'description')
  }
  if (/[\r\n]/.test(description)) {
    return fail(path, '`description` must be a single line — it becomes one agent-catalog row', 'description')
  }
  // The catalog puts `description` into a prompt section, and interpolation is
  // applied to every assembled section, so it needs the same guard as the body.
  const descriptionHazard = findInterpolationHazard(description)
  if (descriptionHazard >= 0) {
    // Point at the hazard inside the raw block when the scalar appears verbatim
    // there; a folded or quoted scalar falls back to the block start.
    const verbatim = split.yaml.indexOf(description)
    const at = verbatim >= 0
      ? split.yamlOffset + verbatim + descriptionHazard
      : split.yamlOffset
    return fail(path, 'contains a balanced `{{ \u2026 }}` reference, which system-prompt assembly rejects', 'description', { text, at })
  }

  // `?? default` would treat an explicit YAML `null` (or a bare `key:`) as an
  // omission and silently degrade it to the default; presence is what decides.
  const transportRaw = Object.hasOwn(document, 'transport') ? document['transport'] : 'spawn'
  if (typeof transportRaw !== 'string' || !TRANSPORTS.includes(transportRaw as Transport)) {
    return fail(path, `\`transport\` must be one of ${TRANSPORTS.join(', ')}`, 'transport')
  }
  const transport = transportRaw as Transport

  const backgroundRaw = Object.hasOwn(document, 'background') ? document['background'] : 'one-shot'
  if (typeof backgroundRaw !== 'string' || !BACKGROUND_MODES.includes(backgroundRaw as BackgroundMode)) {
    return fail(path, `\`background\` must be one of ${BACKGROUND_MODES.join(', ')}`, 'background')
  }
  const background = backgroundRaw as BackgroundMode

  const maxDepthRaw = Object.hasOwn(document, 'maxDepth') ? document['maxDepth'] : 3
  let maxDepth: number | 'provider-managed'
  if (maxDepthRaw === 'provider-managed') {
    maxDepth = 'provider-managed'
  } else if (typeof maxDepthRaw === 'number' && Number.isSafeInteger(maxDepthRaw) && maxDepthRaw >= 0) {
    maxDepth = maxDepthRaw
  } else {
    return fail(path, '`maxDepth` must be a non-negative safe integer or the string "provider-managed"', 'maxDepth')
  }

  let llm: LlmRoute | undefined
  if (Object.hasOwn(document, 'llm')) {
    const parsed = parseLlm(document['llm'], path)
    if (!parsed.ok) return parsed.result
    llm = parsed.value
  }

  let tools: ToolRestrictionFields | undefined
  if (Object.hasOwn(document, 'tools')) {
    const parsed = parseTools(document['tools'], path)
    if (!parsed.ok) return parsed.result
    tools = parsed.value
  }

  const persona = split.body
  const bodyHazard = findInterpolationHazard(persona)
  if (bodyHazard >= 0) {
    return fail(path, 'body contains a balanced `{{ … }}` reference, which system-prompt assembly rejects', 'body', {
      text,
      at: split.bodyOffset + bodyHazard,
    })
  }
  if (persona.trim().length === 0) {
    return fail(path, 'body is empty — the markdown body becomes the child persona', 'body')
  }

  return {
    ok: true,
    fields: {
      name,
      description,
      transport,
      maxDepth,
      background,
      persona,
      ...(llm === undefined ? {} : { llm }),
      ...(tools === undefined ? {} : { tools }),
    },
  }
}
