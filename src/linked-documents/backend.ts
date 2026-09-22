/**
 * Backend client for linked-document lookups: HTTP first, CLI second, silence
 * last.
 *
 * The two transports are the ones plan 260704 already owns (`getLinkedDocuments`
 * behind `GET /workspace/linked-documents` and behind
 * `aw workspace get-linked-documents`), reused verbatim so this plugin cannot
 * drift from the Claude/Cursor hook that reads the same graph. Neither transport
 * accepts a project root: the HTTP server answers from its indexer's root and
 * the CLI resolves its own, which is why {@link cliInvocation} pins the CLI cwd
 * to `<root>/workspaces/devtools`.
 *
 * Every failure branch returns an empty result. Nothing here throws, and nothing
 * here rebuilds the graph or writes `.aweave/` — the backend owns that state.
 *
 * @module dsh-project-context/linked-documents/backend
 */

import { execFile } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { resolve } from 'node:path'
import { CLI_CWD, CLI_RUN_BIN } from './filter.ts'

/**
 * Aweave MCP workspace server base URL. Fixed in the no-UI scope; a deployment
 * that moves the port would need the Settings tunable this plan excludes.
 */
export const SERVER_URL = 'http://127.0.0.1:3456/workspace/linked-documents'

/**
 * HTTP deadline. Measured 2.4 ms when the server is up, so this bound is never
 * reached on the fast path; it is what keeps a hung or absent server from
 * stalling the awaited `tools/post-execute` waterfall for a TCP timeout.
 */
const HTTP_TIMEOUT_MS = 500

/** CLI deadline. Measured ~1.2 s cold; a hung `node` spawn is abandoned here. */
const CLI_TIMEOUT_MS = 15_000

/** Cap on returned entries, shared by both transports. */
const MAX_ENTRIES = 15

/** BFS depth: direct links only, which is what keeps the injected block compact. */
const MAX_DEPTH = 1

/**
 * Consecutive backend failures after which this session stops asking. The slow
 * path costs ~1.4 s per gated read, so a session whose backend is simply absent
 * must not pay it on every read.
 */
const BREAKER_THRESHOLD = 3

/** One linked document as both transports return it. */
export interface LinkedDocument {
  readonly path: string
  readonly name: string
  readonly description: string
}

/** One lookup outcome. `omitted > 0` means the cap truncated the fresh set. */
export interface LinkedDocumentsResult {
  readonly linked_documents: readonly LinkedDocument[]
  readonly omitted: number
  /**
   * Whether BOTH transports failed, as opposed to answering "nothing linked".
   * The distinction is the only input the circuit breaker has: an empty answer
   * from a live backend is a fact, while two failed transports are a symptom
   * that will repeat on every subsequent read.
   */
  readonly transportFailed: boolean
}

/** The empty outcome every failure branch resolves to. */
const EMPTY: LinkedDocumentsResult = { linked_documents: [], omitted: 0, transportFailed: true }

/** A backend that answered, even if the answer was "no links". */
function answered(result: LinkedDocumentsResult | undefined): LinkedDocumentsResult | undefined {
  if (result === undefined) return undefined
  return { ...result, transportFailed: false }
}

/**
 * Per-session circuit breaker. Latched, never reset: once a session has proven
 * the backend is not there, re-probing it on every read would keep paying the
 * timeout for a result that has not changed.
 */
export class CircuitBreaker {
  readonly #failures = new Map<string, number>()
  readonly #latched = new Set<string>()

  /**
   * Whether this session has stopped asking.
   * @param sessionKey - the session identity.
   * @returns true when the breaker is open.
   */
  isOpen(sessionKey: string): boolean {
    return this.#latched.has(sessionKey)
  }

  /**
   * Record a failed lookup, latching the breaker at the threshold.
   * @param sessionKey - the session identity.
   */
  recordFailure(sessionKey: string): void {
    const failures = (this.#failures.get(sessionKey) ?? 0) + 1
    this.#failures.set(sessionKey, failures)
    if (failures >= BREAKER_THRESHOLD) this.#latched.add(sessionKey)
  }

  /**
   * Record a lookup that produced a usable answer, clearing the run.
   * @param sessionKey - the session identity.
   */
  recordSuccess(sessionKey: string): void {
    this.#failures.delete(sessionKey)
  }

  /** Drop all breaker state — used when the owning plugin context is disposed. */
  clear(): void {
    this.#failures.clear()
    this.#latched.clear()
  }
}

/** Everything one lookup needs; `signal` aborts the HTTP request with the call. */
export interface LookupRequest {
  readonly aweaveRoot: string
  readonly relPath: string
  readonly sessionKey: string
  readonly signal?: AbortSignal | undefined
}

/**
 * Look up the documents linked to one root-relative path.
 *
 * HTTP is the fast path; a non-200, a parse failure, a timeout or a socket error
 * falls through to the CLI, and a CLI failure resolves to the empty result.
 * @param request - the path, session and root to query.
 * @returns the linked documents, or the empty result on every failure branch.
 */
export async function lookupLinkedDocuments(request: LookupRequest): Promise<LinkedDocumentsResult> {
  const viaHttp = answered(await viaHttpTransport(request))
  if (viaHttp !== undefined) return viaHttp
  const viaCli = answered(await viaCliTransport(request))
  return viaCli ?? EMPTY
}

/**
 * Parse a backend payload into the result, or undefined when it does not carry
 * the documented `{linked_documents, omitted}` fields. A payload with an empty
 * document list is a valid answer, not a failure — the caller decides whether it
 * is worth recording as a success.
 */
function parseResult(raw: string): LinkedDocumentsResult | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { linked_documents: docs, omitted } = parsed as {
    linked_documents?: unknown
    omitted?: unknown
  }
  if (!Array.isArray(docs)) return undefined
  const entries: LinkedDocument[] = []
  for (const doc of docs) {
    if (typeof doc !== 'object' || doc === null) continue
    const { path, name, description } = doc as {
      path?: unknown
      name?: unknown
      description?: unknown
    }
    if (typeof path !== 'string') continue
    entries.push({
      path,
      name: typeof name === 'string' ? name : '',
      description: typeof description === 'string' ? description : '',
    })
  }
  return { linked_documents: entries, omitted: typeof omitted === 'number' ? omitted : 0, transportFailed: false }
}

/** Query parameters shared by both transports. */
function queryParams(request: LookupRequest): URLSearchParams {
  return new URLSearchParams({
    paths: request.relPath,
    session: request.sessionKey,
    max: String(MAX_ENTRIES),
    depth: String(MAX_DEPTH),
  })
}

/**
 * Ask the workspace server. Resolves undefined on every failure so the caller
 * falls through to the CLI.
 */
function viaHttpTransport(request: LookupRequest): Promise<LinkedDocumentsResult | undefined> {
  return new Promise((settle) => {
    let settled = false
    const done = (value: LinkedDocumentsResult | undefined): void => {
      if (settled) return
      settled = true
      settle(value)
    }
    const url = `${SERVER_URL}?${queryParams(request).toString()}`
    let req: ReturnType<typeof httpGet>
    try {
      req = httpGet(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          done(undefined)
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => { done(parseResult(body)) })
      })
    } catch {
      // A malformed URL or an unavailable transport must fall through, not throw.
      done(undefined)
      return
    }
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy()
      done(undefined)
    })
    // A socket error after the response started is still a failed lookup.
    req.on('error', () => { done(undefined) })
    const signal = request.signal
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy()
        done(undefined)
        return
      }
      signal.addEventListener('abort', () => {
        req.destroy()
        done(undefined)
      }, { once: true })
    }
  })
}

/**
 * Run the Aweave CLI directly through `node <root>/workspaces/devtools/common/cli/bin/run.js`.
 *
 * The `aw` shim is deliberately not used: it depends on a global link that a DSH
 * host does not need, and the hook's own `execFileSync('aw', …)` is the one part
 * of that port this plugin cannot reuse. The cwd is the root's
 * `workspaces/devtools` because the CLI resolves its project root from there.
 */
function cliInvocation(request: LookupRequest): { args: readonly string[]; cwd: string } {
  const cwd = resolve(request.aweaveRoot, ...CLI_CWD)
  const args = [
    resolve(request.aweaveRoot, ...CLI_RUN_BIN),
    'workspace',
    'get-linked-documents',
    '-p',
    request.relPath,
    '--session',
    request.sessionKey,
    '--max',
    String(MAX_ENTRIES),
    '--depth',
    String(MAX_DEPTH),
    '--format',
    'json',
  ]
  return { args, cwd }
}

/** Run the CLI fallback. Resolves undefined when the spawn, exit or parse fails. */
function viaCliTransport(request: LookupRequest): Promise<LinkedDocumentsResult | undefined> {
  return new Promise((settle) => {
    const { args, cwd } = cliInvocation(request)
    try {
      execFile('node', [...args], {
        cwd,
        timeout: CLI_TIMEOUT_MS,
        encoding: 'utf8',
        ...request.signal === undefined ? {} : { signal: request.signal },
      }, (error: Error | null, stdout: string) => {
        if (error) {
          settle(undefined)
          return
        }
        settle(parseResult(stdout))
      })
    } catch {
      // A synchronous spawn failure is a failed lookup, never a thrown listener.
      settle(undefined)
    }
  })
}
