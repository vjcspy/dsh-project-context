/**
 * The one class of project file this plugin writes.
 *
 * The plugin's documented property is that it writes no project files; a route
 * edit inverts that on purpose, so the write path is deliberately narrow and
 * every refusal happens BEFORE a byte is replaced:
 *
 * - **Path.** A regular file directly inside `<root>/.dsh/agents/`, checked on
 *   the real path, so neither a symlinked file nor a `..` segment can be used to
 *   reach out of the directory.
 * - **Revision.** The client sends the digest it read; a mismatch is a `stale`
 *   refusal, and the digest is re-read once more immediately before the rename so
 *   a concurrent write from another tab cannot be silently lost.
 * - **Content.** Only the `llm` mapping of the front-matter is replaced. The body
 *   is spliced back byte-for-byte, and the result must re-parse through
 *   `src/frontmatter.ts` before it is written.
 * - **Eligibility.** The new bytes must still survive discovery's own rules, so a
 *   file that parses but would vanish from the next roster is refused instead.
 *
 * Output goes to a same-directory temp file created with the original mode and
 * is then renamed onto the target, so a reader never observes a torn file. The
 * temp name ends in `.tmp`, never `.md`, so discovery ignores it even if a crash
 * leaves it behind.
 *
 * Residual race, accepted and documented: an editor saving the same file outside
 * this plugin between the re-hash and the rename is not detected.
 *
 * @module dsh-project-context/subagent-routes/writer
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import type { AgentBounds } from '../discovery.ts'
import { PROJECT_AGENTS_SUBDIR } from '../discovery.ts'
import { parseAgentFile, splitFrontmatter } from '../frontmatter.ts'
import type { LlmRoute } from '../types.ts'

/** The document extension every definition must carry. */
const DEFINITION_EXTENSION = '.md'

/** A write refusal, in the vocabulary the service maps onto HTTP statuses. */
export type RouteWriteFailureCode =
  /** The file changed since the client read it. */
  | 'stale'
  /** The request is refused on its merits: unsafe path, unparsable or ineligible content. */
  | 'rejected'
  /** The filesystem refused the write. */
  | 'write-failed'

/** One route write's outcome. */
export type RouteWriteResult =
  | { readonly ok: true; readonly sha256: string }
  | { readonly ok: false; readonly code: RouteWriteFailureCode; readonly error: string }

/** Everything one route write needs. */
export interface RouteWriteInput {
  /** The validated platform root. */
  readonly root: string
  /** The definition's path, relative to {@link root}. */
  readonly file: string
  /** The route to store. */
  readonly llm: LlmRoute
  /** The digest the client read; the write is refused when it no longer matches. */
  readonly expectedSha256: string
  /** Discovery's byte budgets, re-applied to the new content. */
  readonly bounds: AgentBounds
}

/** One pending write per target path; concurrent saves of one file queue here. */
const queues = new Map<string, Promise<unknown>>()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function rejected(error: string): RouteWriteResult {
  return { ok: false, code: 'rejected', error }
}

/**
 * Strip one trailing line terminator from a YAML document body.
 * @param text - the dumped document.
 * @returns the document without its final newline.
 */
function withoutTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * Replace the `llm` mapping of one definition, keeping the body bytes.
 *
 * The front-matter block is re-serialized, which normalizes it and drops any YAML
 * comment inside it; the body after the closing delimiter is spliced back
 * verbatim, and the file's own line ending is reused for the delimiters.
 *
 * @param raw - the complete file text as read from disk.
 * @param llm - the route to store.
 * @param path - absolute path, used only in error text.
 * @returns the rewritten text, or the refusal.
 */
function rewriteLlm(
  raw: string,
  llm: LlmRoute,
  path: string,
): { readonly text: string } | { readonly error: string } {
  // `parseAgentFile` strips a BOM before splitting; the offsets below are
  // therefore computed on the same text, and the BOM is restored on output.
  const bom = raw.charCodeAt(0) === 0xFEFF ? '\uFEFF' : ''
  const text = bom.length > 0 ? raw.slice(1) : raw
  const split = splitFrontmatter(text)
  if (split === undefined) {
    return { error: `${path} has no leading \`---\` front-matter block to rewrite` }
  }
  let document: unknown
  try {
    document = load(split.yaml, { filename: path })
  } catch (error: unknown) {
    return { error: `the front-matter of ${path} is not valid YAML: ${messageOf(error)}` }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { error: `the front-matter of ${path} is not a YAML mapping` }
  }
  const record = document as Record<string, unknown>
  // Assigning an existing key keeps its position; a definition with no `llm`
  // block gains one at the end. Either way the body below is untouched.
  record['llm'] = {
    provider: llm.provider,
    model: llm.model,
    ...(llm.reasoningEffort === undefined ? {} : { reasoningEffort: llm.reasoningEffort }),
  }
  let block: string
  try {
    block = withoutTrailingNewline(dump(record, { lineWidth: -1, noRefs: true }))
  } catch (error: unknown) {
    return { error: `the front-matter of ${path} could not be re-serialized: ${messageOf(error)}` }
  }
  const eol = /^---[ \t]*(\r?\n)/.exec(text)?.[1] ?? '\n'
  return { text: `${bom}---${eol}${block}${eol}---${eol}${split.body}` }
}

/**
 * Sum the definition bytes sitting next to the target, as discovery counts them.
 *
 * Mirrors `scanLayer` (`discovery.ts:137-153`): every `*.md` whose own size is
 * within the per-file cap contributes, and the target contributes its NEW size.
 *
 * @param directory - the real `.dsh/agents` directory.
 * @param targetPath - the file being replaced, on the real path.
 * @param targetBytes - the size the replaced file will have.
 * @param bounds - discovery's byte budgets.
 * @returns the prospective total, or undefined when the neighbours cannot be read.
 */
function prospectiveTotal(
  directory: string,
  targetPath: string,
  targetBytes: number,
  bounds: AgentBounds,
): number | undefined {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  let total = targetBytes
  for (const name of names) {
    const path = join(directory, name)
    if (path === targetPath) continue
    if (!name.endsWith(DEFINITION_EXTENSION)) continue
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      if (stats.size > bounds.maxFileBytes) continue
      total += stats.size
    } catch {
      return undefined
    }
  }
  return total
}

/**
 * Resolve the target's real path under `<root>/.dsh/agents/`, or the refusal.
 * @param root - the validated platform root.
 * @param file - the root-relative path the client sent.
 * @returns the real target path and its directory, or the refusal.
 */
function targetOf(
  root: string,
  file: string,
): { readonly path: string; readonly directory: string } | { readonly error: string } {
  if (isAbsolute(file)) return { error: '`file` must be relative to the platform root' }
  if (file.split(/[\\/]/).includes('..')) return { error: '`file` must not contain a `..` segment' }
  if (!file.endsWith(DEFINITION_EXTENSION)) return { error: `\`file\` must name a ${DEFINITION_EXTENSION} definition` }
  let realRoot: string
  let directory: string
  try {
    realRoot = realpathSync(root)
    // The real path of the agents directory is the only prefix a write may land
    // in; comparing real paths is what makes a symlinked `agents` entry useless
    // as an escape hatch.
    directory = realpathSync(join(realRoot, PROJECT_AGENTS_SUBDIR))
  } catch (error: unknown) {
    return { error: `${root}/${PROJECT_AGENTS_SUBDIR} cannot be resolved: ${messageOf(error)}` }
  }
  const path = resolve(realRoot, file)
  if (dirname(path) !== directory) {
    return { error: `\`file\` must point directly inside ${PROJECT_AGENTS_SUBDIR}/ of the platform root` }
  }
  try {
    // `lstat` on purpose: a symlink reports `isFile() === false` here, so a
    // definition that is a link is refused rather than written through.
    if (!lstatSync(path).isFile()) return { error: `${file} is not a regular file` }
    if (realpathSync(path) !== path) return { error: `${file} resolves through a symbolic link` }
  } catch (error: unknown) {
    return { error: `${file} cannot be read: ${messageOf(error)}` }
  }
  return { path, directory }
}

/**
 * Perform one write, start to finish. Synchronous internally: the atomic
 * replace must not interleave with another pass of the same file.
 * @param input - the write request.
 * @returns the new digest, or the refusal.
 */
function performWrite(input: RouteWriteInput): RouteWriteResult {
  const target = targetOf(input.root, input.file)
  if ('error' in target) return rejected(target.error)

  let current: Buffer
  try {
    current = readFileSync(target.path)
  } catch (error: unknown) {
    return rejected(`${input.file} cannot be read: ${messageOf(error)}`)
  }
  if (sha256(current) !== input.expectedSha256) {
    return {
      ok: false,
      code: 'stale',
      error: `${input.file} changed since it was read; reload the card and try again`,
    }
  }

  const rewritten = rewriteLlm(current.toString('utf8'), input.llm, target.path)
  if ('error' in rewritten) return rejected(rewritten.error)
  const next = Buffer.from(rewritten.text, 'utf8')

  // Discovery's own per-file byte cap, re-applied to the NEW content.
  if (next.length > input.bounds.maxFileBytes) {
    return rejected(
      `the rewritten definition is ${String(next.length)} bytes, above the ${String(input.bounds.maxFileBytes)}-byte per-file cap`,
    )
  }
  // `parseAgentFile` is the single front-matter authority; a rewrite that does
  // not survive it must never reach the disk.
  const parsed = parseAgentFile(target.path, rewritten.text)
  if (!parsed.ok) {
    return rejected(`the rewritten definition would no longer be accepted: ${parsed.diagnostic.reason}`)
  }
  const total = prospectiveTotal(target.directory, target.path, next.length, input.bounds)
  if (total === undefined) {
    return rejected(`${PROJECT_AGENTS_SUBDIR} could not be re-scanned to check the total byte budget`)
  }
  if (total > input.bounds.maxTotalBytes) {
    return rejected(
      `the definitions in ${PROJECT_AGENTS_SUBDIR} would total ${String(total)} bytes, above the ${String(input.bounds.maxTotalBytes)}-byte cap`,
    )
  }

  let mode: number
  try {
    mode = statSync(target.path).mode & 0o777
  } catch (error: unknown) {
    return rejected(`${input.file} cannot be inspected: ${messageOf(error)}`)
  }
  const temp = join(target.directory, `.${basename(target.path)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, next, { mode })
  } catch (error: unknown) {
    return { ok: false, code: 'write-failed', error: `the temporary file could not be written: ${messageOf(error)}` }
  }
  try {
    // Re-checked immediately before the replace: the queue serializes THIS
    // plugin's own writers, and this check covers everything else.
    if (sha256(readFileSync(target.path)) !== input.expectedSha256) {
      return {
        ok: false,
        code: 'stale',
        error: `${input.file} changed while the route was being prepared; reload the card and try again`,
      }
    }
    renameSync(temp, target.path)
  } catch (error: unknown) {
    return { ok: false, code: 'write-failed', error: `the definition could not be replaced: ${messageOf(error)}` }
  } finally {
    // A successful rename moved the temp file; a failed one leaves it behind.
    try {
      unlinkSync(temp)
    } catch {
      // Already renamed, or never created: nothing to clean up.
    }
  }
  return { ok: true, sha256: sha256(next) }
}

/**
 * Write one route, serialized per target path.
 *
 * @param input - the write request.
 * @returns the new digest, or the refusal with its code.
 */
export function writeRoute(input: RouteWriteInput): Promise<RouteWriteResult> {
  const key = resolve(input.root, input.file)
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(
    () => performWrite(input),
    () => performWrite(input),
  )
  const tail = run.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    // Drop the queue entry when this write is still the last one, so a long-lived
    // host does not accumulate one promise per file ever edited.
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}
