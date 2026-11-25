/**
 * The live provider/model catalog behind the route card's dropdowns, and the
 * lazy reasoning-effort lookup for the ONE model a row has selected.
 *
 * Two cost facts shape this module:
 * - `listModels` is one adapter call per provider, so the listing fans out with
 *   bounded concurrency under ONE overall deadline, and a provider that fails
 *   or hangs is named instead of silently omitted.
 * - `resolveModelInfo` is a second, exact-route adapter call that multiplies by
 *   the number of models. It is therefore never run for the whole catalog: the
 *   card asks for it only when a model is selected, and the answer is cached
 *   per `provider/model` on the client.
 *
 * The status vocabulary keeps three different situations apart, because the card
 * must not present them the same way: a successful empty catalog is a fact, a
 * partial one is a degraded fact, and an unavailable one is a failure.
 *
 * @module dsh-project-context/subagent-routes/catalog
 */

/** Overall budget for one catalog listing pass, in milliseconds. */
export const CATALOG_DEADLINE_MS = 5_000

/** Budget for one exact-route reasoning-effort lookup, in milliseconds. */
export const EFFORT_DEADLINE_MS = 5_000

/** Providers whose model list is fetched at the same time. */
export const CATALOG_CONCURRENCY = 4

/**
 * The slice of `ctx.get('llm')` this module reads.
 *
 * Structural rather than the concrete `LlmRuntime` so the module owns no
 * dependency direction, matching `ProviderCapabilityView` in `config-mapping.ts`.
 */
export interface CatalogSource {
  /** @returns every provider route with a registered adapter. */
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  /**
   * Discover the models one provider advertises.
   * @param provider - provider route key.
   */
  listModels(provider: string): Promise<readonly { readonly id: string }[]>
  /**
   * Resolve exact-route metadata, including reasoning efforts.
   * @param provider - provider route key.
   * @param model - exact model id.
   * @param signal - cancellation for the adapter-owned lookup.
   */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: unknown }[]
      readonly defaultEffort?: unknown
    }
  }>
}

/** How trustworthy one catalog listing is. */
export type CatalogStatus = 'ok' | 'partial' | 'unavailable'

/** One provider as the card renders it. */
export interface CatalogProvider {
  /** Provider route key, the value a route stores. */
  readonly provider: string
  /** Human-readable provider name. */
  readonly name: string
  /** Advertised model ids, in adapter-preferred order. */
  readonly models: readonly string[]
}

/** One catalog listing. */
export interface CatalogListing {
  /** `ok` for a complete answer (including an empty one), `partial` when a provider failed, `unavailable` when nothing could be trusted. */
  readonly status: CatalogStatus
  readonly providers: readonly CatalogProvider[]
  /** Per-provider failures and the deadline, named for the operator. */
  readonly errors: readonly string[]
}

/** Selectable efforts for one exact route. */
export interface Efforts {
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
}

/** One effort lookup's outcome. */
export type EffortsOutcome =
  | { readonly ok: true; readonly value: Efforts }
  | { readonly ok: false; readonly error: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bound one promise by a deadline, without leaving an unhandled rejection.
 * @param work - the promise to bound.
 * @param deadlineMs - the budget in milliseconds.
 * @param label - the operation name used in the error text.
 * @returns the settled value, or the typed error.
 */
async function bounded<T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${String(deadlineMs)} ms`))
    }, deadlineMs)
    // A pending deadline must never hold the host process open.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    return { ok: true, value: await Promise.race([work, deadline]) }
  } catch (error: unknown) {
    // The loser of the race still settles; its rejection is absorbed here so a
    // slow adapter cannot surface as an unhandled rejection.
    void work.catch(() => undefined)
    return { ok: false, error: messageOf(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * List every provider with the models it advertises.
 *
 * Providers are fetched in bounded batches. A provider that fails is recorded by
 * name and the pass continues, so one broken adapter cannot hide the rest.
 *
 * @param llm - the live LLM runtime view.
 * @param deadlineMs - overall budget for the pass.
 * @returns the listing with its trust level.
 */
export async function listCatalog(
  llm: CatalogSource,
  deadlineMs = CATALOG_DEADLINE_MS,
): Promise<CatalogListing> {
  let providers: readonly { readonly id: string; readonly name: string }[]
  try {
    providers = llm.listProviders()
  } catch (error: unknown) {
    return { status: 'unavailable', providers: [], errors: [`the provider registry could not be read: ${messageOf(error)}`] }
  }
  // A genuinely empty registry is a successful empty answer, not a failure.
  if (providers.length === 0) return { status: 'ok', providers: [], errors: [] }

  const listed: CatalogProvider[] = []
  const errors: string[] = []
  let failed = 0
  let expired = false
  const startedAt = Date.now()

  for (let offset = 0; offset < providers.length; offset += CATALOG_CONCURRENCY) {
    const batch = providers.slice(offset, offset + CATALOG_CONCURRENCY)
    const remaining = deadlineMs - (Date.now() - startedAt)
    if (remaining <= 0) {
      const skipped = providers.slice(offset)
      failed += skipped.length
      expired = true
      errors.push(`the catalog deadline of ${String(deadlineMs)} ms expired before ${String(skipped.length)} provider(s) could be listed`)
      break
    }
    const results = await Promise.all(batch.map(async (provider) => {
      const outcome = await bounded(llm.listModels(provider.id), remaining, `listModels("${provider.id}")`)
      return { provider, outcome }
    }))
    for (const { provider, outcome } of results) {
      if (!outcome.ok) {
        failed++
        errors.push(`${provider.id}: ${outcome.error}`)
        continue
      }
      listed.push({
        provider: provider.id,
        name: provider.name,
        models: outcome.value.map(model => model.id),
      })
    }
  }

  if (listed.length === 0) return { status: 'unavailable', providers: [], errors }
  if (failed === 0) return { status: 'ok', providers: listed, errors }
  // A deadline makes the whole pass untrustworthy: the missing providers were
  // never given a chance, unlike an adapter that actively failed.
  return { status: expired ? 'unavailable' : 'partial', providers: listed, errors }
}

/**
 * Resolve the reasoning efforts one exact provider/model route accepts.
 *
 * Bounded by `deadlineMs` and cancellable: the caller's signal aborts the
 * adapter lookup, so a route change or a page unload does not leave a request
 * running in the host.
 *
 * @param llm - the live LLM runtime view.
 * @param provider - provider route key.
 * @param model - exact model id.
 * @param options - deadline and an external cancellation signal.
 * @returns the efforts, or the typed error naming what failed.
 */
export async function resolveEfforts(
  llm: CatalogSource,
  provider: string,
  model: string,
  options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<EffortsOutcome> {
  const deadlineMs = options.deadlineMs ?? EFFORT_DEADLINE_MS
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (options.signal !== undefined) {
    if (options.signal.aborted) return { ok: false, error: 'the lookup was cancelled' }
    options.signal.addEventListener('abort', abort, { once: true })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`resolveModelInfo("${provider}", "${model}") did not settle within ${String(deadlineMs)} ms`))
      }, deadlineMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const lookup = llm.resolveModelInfo(provider, model, controller.signal)
    const info = await Promise.race([lookup, timeout])
    const reasoning = info.reasoning
    const efforts = reasoning === undefined ? [] : reasoning.efforts.map(effort => String(effort.id))
    const defaultEffort = reasoning?.defaultEffort
    return {
      ok: true,
      value: {
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort: String(defaultEffort) }),
      },
    }
  } catch (error: unknown) {
    return { ok: false, error: messageOf(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
