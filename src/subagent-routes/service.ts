/**
 * The route card's host-side operations: one GET listing and one POST write.
 *
 * Both ride the SAME exact Fetch route (`./index.ts`), which is mounted under the
 * authenticated `/api` channel, so this module never checks authentication: the
 * handler only runs after `connection.admit()` produced an owner Peer, and an
 * exact route answers `403` for every other principal. `401`/`403` therefore
 * never appear below.
 *
 * Status vocabulary, fixed by the plan:
 * - `400` — the body is not the documented shape (the size bound is checked
 *   BEFORE JSON parsing).
 * - `404` — not produced here: it is the channel's answer when no host half is
 *   mounted, which is exactly what the card renders as "unavailable".
 * - `409` — the digest the client read no longer matches the file.
 * - `413` — the request body exceeds the 8 KiB bound, enforced before parsing.
 * - `422` — the request is well formed but refused on its merits: no root, a
 *   target that is not a project-layer definition, a route that would not mount,
 *   or a provider/model/effort the live catalog does not know.
 * - `500` — the filesystem refused the write, or the handler escaped.
 *
 * The handler synthesizes no `405`: the registration declares exactly `GET` and
 * `POST`, so the connection service owns every other method.
 *
 * @module dsh-project-context/subagent-routes/service
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { ProviderCapabilityView } from '../config-mapping.ts'
import { resolveAgents } from '../config-mapping.ts'
import { DiagnosticSink, renderLine } from '../diagnostics.ts'
import type { AgentBounds } from '../discovery.ts'
import { discover, PROJECT_AGENTS_SUBDIR } from '../discovery.ts'
import { resolvePlatformRoot } from '../platform-root.ts'
import type { Config, LlmRoute, ResolvedAgent } from '../types.ts'
import type { CatalogListing, CatalogSource, Efforts } from './catalog.ts'
import { listCatalog, resolveEfforts } from './catalog.ts'
import { mountabilityOf, routeMountability } from './mountability.ts'
import type { Mountability } from './mountability.ts'
import type { RouteWriteResult } from './writer.ts'
import { writeRoute } from './writer.ts'

/** The exact path both verbs are registered on. */
export const SUBAGENT_ROUTES_PATH = '/api/dsh-project-context/subagent-routes'

/** Hard cap on one POST body, enforced before JSON parsing. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024

/** What a saved route does, and the only thing this feature can promise. */
export const APPLIES_TO = 'next-session'

/** A digest is a lowercase hex SHA-256, and nothing else is accepted. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/** Cap on the diagnostics echoed into one GET answer. */
const MAX_ERROR_LINES = 50

/** One project definition as the card lists it. */
export interface AgentRouteView {
  /** Path relative to the resolved root, always `/`-separated. */
  readonly file: string
  readonly name: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** SHA-256 of the bytes the card must send back with a write. */
  readonly sha256: string
  readonly mountable: Mountability
  /** Why it is not a plain yes, verbatim for the card. */
  readonly unavailableReason?: string
}

/** Everything one request needs, resolved lazily at request time. */
export interface RouteContext {
  /** The plugin's live configuration. */
  readonly config: Config
  /** Discovery's byte budgets. */
  readonly bounds: AgentBounds
  /** @returns the distinct cwds of the live Agents, at call time. */
  readonly listAgentCwds: () => readonly string[]
  /** @returns the live LLM runtime view, or undefined when `llm` is not mounted. */
  readonly llm: () => CatalogSource | undefined
  /** @returns the registered transport provider, or undefined when absent. */
  readonly subagentProvider: (transport: string) => ProviderCapabilityView | undefined
  /** Host log sink for contained failures. */
  readonly warn: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function sha256OfFile(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Convert an absolute path into a root-relative, `/`-separated one.
 * @param root - the resolved platform root.
 * @param path - the absolute definition path.
 * @returns the relative path the card sends back with a write.
 */
function toRelative(root: string, path: string): string {
  return relative(root, path).split('\\').join('/')
}

/**
 * Project one resolved definition onto the card's row.
 * @param agent - one resolved project definition.
 * @param root - the resolved platform root.
 * @param provider - its registered transport provider, if any.
 * @returns the row, including the digest a write must present.
 */
function toView(
  agent: ResolvedAgent,
  root: string,
  provider: ProviderCapabilityView | undefined,
): AgentRouteView {
  const verdict = mountabilityOf(agent, provider)
  const digest = sha256OfFile(agent.path)
  if (digest === undefined) {
    // The digest a write must present cannot be produced, so the row says why it
    // is not offered rather than presenting a Save that could only fail.
    return {
      file: toRelative(root, agent.path),
      name: agent.name,
      sha256: '',
      mountable: 'unknown',
      unavailableReason: 'the definition cannot be read right now, so it cannot be rewritten',
    }
  }
  const base = {
    file: toRelative(root, agent.path),
    name: agent.name,
    sha256: digest,
    mountable: verdict.mountable,
  }
  return {
    ...base,
    ...(agent.llm === undefined ? {} : { provider: agent.llm.provider, model: agent.llm.model }),
    ...(agent.llm?.reasoningEffort === undefined ? {} : { reasoningEffort: agent.llm.reasoningEffort }),
    ...(verdict.reason === undefined ? {} : { unavailableReason: verdict.reason }),
  }
}

/**
 * Spread an effort answer onto the wire.
 * @param efforts - the resolved efforts.
 * @returns the effort fields of the answer.
 */
function effortsBody(efforts: Efforts): Record<string, unknown> {
  return {
    efforts: efforts.efforts,
    ...(efforts.defaultEffort === undefined ? {} : { defaultEffort: efforts.defaultEffort }),
  }
}

/**
 * Answer the effort query: the selectable efforts for one exact route.
 * @param url - the request URL carrying `provider` and `model`.
 * @param deps - the request context.
 * @returns the effort answer; a lookup failure stays a `200` carrying `error`, so
 *   the card can label degraded metadata instead of losing the whole page.
 */
async function effortsResponse(url: URL, deps: RouteContext): Promise<Response> {
  const provider = url.searchParams.get('provider')
  const model = url.searchParams.get('model')
  if (provider === null || provider.length === 0 || model === null || model.length === 0) {
    return json({ error: 'both `provider` and `model` are required' }, 400)
  }
  const llm = deps.llm()
  if (llm === undefined) {
    return json({ provider, model, efforts: [], error: 'the "llm" service is not mounted in this host' })
  }
  const outcome = await resolveEfforts(llm, provider, model)
  if (!outcome.ok) return json({ provider, model, efforts: [], error: outcome.error })
  return json({ provider, model, ...effortsBody(outcome.value) })
}

/**
 * Answer the listing: root provenance, project definitions, catalog, diagnostics.
 * @param deps - the request context.
 * @returns the listing, or the root failure with its candidates.
 */
async function listingResponse(deps: RouteContext): Promise<Response> {
  const resolution = resolvePlatformRoot(deps.config, deps.listAgentCwds())
  if ('error' in resolution) {
    return json({
      candidates: resolution.candidates,
      error: resolution.error,
      agents: [],
      catalog: { status: 'unavailable', providers: [], errors: [] },
      errors: [resolution.error],
    })
  }
  const sink = new DiagnosticSink()
  const discovered = discover(resolution.root, deps.config, deps.bounds, sink)
  // The install path's OWN resolver, so a listed row is a row the mount pass
  // would accept; whatever it drops is reported through `errors` below.
  const resolved = resolveAgents(
    discovered.files.filter(file => file.layer === 'project'),
    new Set<string>(),
    sink,
  )
  const agents = resolved.map(agent => toView(agent, resolution.root, deps.subagentProvider(agent.transport)))
  const llm = deps.llm()
  const catalog: CatalogListing = llm === undefined
    ? { status: 'unavailable', providers: [], errors: ['the "llm" service is not mounted in this host'] }
    : await listCatalog(llm)
  return json({
    root: resolution.root,
    via: resolution.via,
    candidates: resolution.candidates,
    agents,
    catalog,
    errors: sink.drain().map(renderLine).slice(0, MAX_ERROR_LINES),
  })
}

/**
 * Check the selected route against the live catalog.
 * @param deps - the request context.
 * @param route - the route the operator selected.
 * @returns the refusal reason, or undefined when the route is known.
 */
async function routeRejection(deps: RouteContext, route: LlmRoute): Promise<string | undefined> {
  const llm = deps.llm()
  if (llm === undefined) return 'the "llm" service is not mounted in this host, so the route cannot be validated'
  let providers: readonly { readonly id: string }[]
  try {
    providers = llm.listProviders()
  } catch (error: unknown) {
    return `the provider registry could not be read: ${messageOf(error)}`
  }
  if (!providers.some(provider => provider.id === route.provider)) {
    return `provider ${JSON.stringify(route.provider)} is not registered in this host`
  }
  let models: readonly { readonly id: string }[]
  try {
    models = await llm.listModels(route.provider)
  } catch (error: unknown) {
    return `the model catalog of provider ${JSON.stringify(route.provider)} is unavailable: ${messageOf(error)}`
  }
  if (!models.some(model => model.id === route.model)) {
    return `model ${JSON.stringify(route.model)} is not in the live catalog of provider ${JSON.stringify(route.provider)}`
  }
  if (route.reasoningEffort === undefined) return undefined
  const outcome = await resolveEfforts(llm, route.provider, route.model)
  if (!outcome.ok) {
    return `the reasoning efforts of ${JSON.stringify(route.provider)}/${JSON.stringify(route.model)} are unavailable: ${outcome.error}`
  }
  if (!outcome.value.efforts.includes(route.reasoningEffort)) {
    const available = outcome.value.efforts.length === 0 ? 'none' : outcome.value.efforts.join(', ')
    return `${JSON.stringify(route.reasoningEffort)} is not a reasoning effort of `
      + `${JSON.stringify(route.provider)}/${JSON.stringify(route.model)} (available: ${available})`
  }
  return undefined
}

/**
 * Read one string field off a parsed body.
 * @param body - the parsed JSON object.
 * @param key - the field name.
 * @returns the trimmed value, or undefined when absent or not a non-empty string.
 */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Map one writer outcome onto its status.
 * @param result - the writer's refusal.
 * @returns the response to send.
 */
function writeFailureResponse(result: Extract<RouteWriteResult, { readonly ok: false }>): Response {
  const status = result.code === 'stale' ? 409 : result.code === 'rejected' ? 422 : 500
  return json({ error: result.error, code: result.code }, status)
}

/**
 * Resolve the write target as the install path sees it.
 * @param deps - the request context.
 * @param file - the root-relative path the client sent.
 * @returns the resolved definition, or the refusal response.
 */
function targetOf(
  deps: RouteContext,
  file: string,
): { readonly agent: ResolvedAgent; readonly root: string } | { readonly response: Response } {
  const resolution = resolvePlatformRoot(deps.config, deps.listAgentCwds())
  if ('error' in resolution) {
    return { response: json({ error: resolution.error, candidates: resolution.candidates }, 422) }
  }
  const sink = new DiagnosticSink()
  const discovered = discover(resolution.root, deps.config, deps.bounds, new DiagnosticSink())
  const wanted = resolve(resolution.root, file)
  const entry = discovered.files.find(candidate => candidate.layer === 'project' && candidate.path === wanted)
  const notListed = `${file} is not a project-layer agent definition under ${PROJECT_AGENTS_SUBDIR}/ of the resolved root`
  if (entry === undefined) return { response: json({ error: notListed }, 422) }
  const agent = resolveAgents([entry], new Set<string>(), sink)[0]
  if (agent === undefined) {
    const reason = sink.drain().map(diagnostic => diagnostic.reason).join('; ')
    return { response: json({ error: `${notListed}: ${reason}` }, 422) }
  }
  return { agent, root: resolution.root }
}

/**
 * Answer a write: validate everything, then replace the file atomically.
 * @param request - the incoming Fetch request.
 * @param deps - the request context.
 * @returns the new digest, or the refusal with its status.
 */
async function writeResponse(request: Request, deps: RouteContext): Promise<Response> {
  // The bound is enforced BEFORE JSON parsing, so an oversized body produces a
  // precise 413 instead of a generic parse failure after work has begun. The
  // shared transport caps the body independently; this is the plugin's own limit.
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    return json({ error: `the request body must not exceed ${String(MAX_REQUEST_BODY_BYTES)} bytes` }, 413)
  }
  let text: string
  try {
    text = await request.text()
  } catch (error: unknown) {
    return json({ error: `the request body could not be read: ${messageOf(error)}` }, 400)
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BODY_BYTES) {
    return json({ error: `the request body must not exceed ${String(MAX_REQUEST_BODY_BYTES)} bytes` }, 413)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'the request body is not valid JSON' }, 400)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return json({ error: 'the request body must be a JSON object' }, 400)
  }
  const body = parsed as Record<string, unknown>
  const file = stringField(body, 'file')
  const provider = stringField(body, 'provider')
  const model = stringField(body, 'model')
  const expectedSha256 = stringField(body, 'expectedSha256')
  if (file === undefined || provider === undefined || model === undefined || expectedSha256 === undefined) {
    return json({ error: '`file`, `provider`, `model` and `expectedSha256` are all required' }, 400)
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    return json({ error: '`expectedSha256` must be a lowercase hex SHA-256 digest' }, 400)
  }
  // Presence, not truthiness: an explicit `null` is the card's "Default (route)"
  // choice and simply omits the field, so anything else must be a non-empty string.
  const rawEffort = body['reasoningEffort']
  let reasoningEffort: string | undefined
  if (rawEffort !== undefined && rawEffort !== null) {
    if (typeof rawEffort !== 'string' || rawEffort.trim().length === 0) {
      return json({ error: '`reasoningEffort` must be a non-empty string when present' }, 400)
    }
    reasoningEffort = rawEffort.trim()
  }
  const route: LlmRoute = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }

  const target = targetOf(deps, file)
  if ('response' in target) return target.response
  // The gate a valid YAML block and a valid catalog model both hide: without it a
  // successful Save would silently remove the tool at the next install.
  const verdict = routeMountability(target.agent, route, deps.subagentProvider(target.agent.transport))
  if (verdict.mountable !== 'yes') {
    return json({ error: verdict.reason ?? 'the selected route would not mount' }, 422)
  }
  const rejection = await routeRejection(deps, route)
  if (rejection !== undefined) return json({ error: rejection }, 422)

  const result = await writeRoute({
    root: target.root,
    file,
    llm: route,
    expectedSha256,
    bounds: deps.bounds,
  })
  if (!result.ok) return writeFailureResponse(result)
  return json({ ok: true, appliesTo: APPLIES_TO, sha256: result.sha256 })
}

/**
 * Dispatch one request on the registered path.
 * @param request - the incoming Fetch request.
 * @param deps - the request context.
 * @returns the response; never throws.
 */
export async function handleSubagentRoutes(request: Request, deps: RouteContext): Promise<Response> {
  try {
    // The registration declares exactly GET and POST, so the channel never
    // dispatches a third method here and there is no 405 branch to synthesize.
    if (request.method === 'GET') {
      const url = new URL(request.url)
      if (url.searchParams.has('provider') || url.searchParams.has('model')) {
        return await effortsResponse(url, deps)
      }
      return await listingResponse(deps)
    }
    return await writeResponse(request, deps)
  } catch (error: unknown) {
    // A throw out of a Fetch route would surface as a bridge failure with no
    // useful body; the card needs a reason it can render.
    deps.warn(`dsh-project-context: the subagent-routes request failed: ${messageOf(error)}`)
    return json({ error: `the host could not complete the request: ${messageOf(error)}` }, 500)
  }
}
