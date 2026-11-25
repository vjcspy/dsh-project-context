/**
 * The Subagents route Settings card.
 *
 * Presentation plus transport only: it renders the host half's listing, stages
 * one route per row, and rides the plugin's own exact Fetch route for both the
 * read and the write. No service object crosses into this file — the shell hands
 * it the bound `copy` dictionary and nothing else, exactly like the MCP card.
 *
 * Why plain `fetch` and not a client RPC: the route is mounted on the shared
 * `/api` channel under the same authority the page was served from, so a
 * same-origin `fetch` carries the admission cookie automatically. That is also
 * why `credentials: 'same-origin'` is stated rather than relied on.
 *
 * Four states are deliberately distinct, because the shell renders this section
 * whether or not the host half is mounted: loading, a served listing, a missing
 * route (`404` — no host half or no `connection` service), and a failed read.
 * Collapsing the third into an empty listing would present a broken deployment as
 * a configured one.
 *
 * A route edit is a project-file write, so the interaction is deliberate: a row
 * grows a Save button only when it is dirty, and the digest the listing carried
 * travels back with the write so a concurrent edit is refused instead of lost.
 */

import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { styles } from './styles.ts'
import type { LocaleKey, Translate } from './locales.ts'

/** The path both verbs live on. Spelled identically in the host half. */
export const SUBAGENT_ROUTES = '/api/dsh-project-context/subagent-routes'

/** Tri-state preflight the host computes for one row. */
export type RowMountability = 'yes' | 'no' | 'unknown'

/** One project definition as the host lists it. */
export interface SubagentRouteRow {
  /** Path relative to the resolved root. */
  readonly file: string
  readonly name: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  /** Digest of the bytes the write must be based on; empty when unreadable. */
  readonly sha256: string
  readonly mountable: RowMountability
  readonly unavailableReason?: string
}

/** One provider with the models it advertises. */
export interface SubagentCatalogProvider {
  readonly provider: string
  readonly name: string
  readonly models: readonly string[]
}

/** The live catalog, with its trust level. */
export interface SubagentCatalog {
  readonly status: string
  readonly providers: readonly SubagentCatalogProvider[]
  readonly errors: readonly string[]
}

/** The GET listing. */
export interface SubagentRoutesListing {
  /** The resolved platform root; absent when resolution failed. */
  readonly root?: string
  /** Which source produced the root. */
  readonly via?: string
  readonly candidates?: readonly string[]
  /** Why no root could be established. */
  readonly error?: string
  readonly agents?: readonly SubagentRouteRow[]
  readonly catalog?: SubagentCatalog
  readonly errors?: readonly string[]
}

/** The effort answer for one exact route. */
export interface SubagentEffortsBody {
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
  readonly error?: string
}

/** What the card needs from its registration. */
export interface SubagentRoutesSectionInjected {
  /** Bound translate function over the card's dictionary. */
  readonly copy: Translate
}

/** Props assembled by the settings shell for this section. */
export type SubagentRoutesSectionProps =
  PropsRuntime<'settings.section'> & SubagentRoutesSectionInjected

/** One row's staged selection; the empty effort string means "Default (route)". */
interface StagedRow {
  readonly provider: string
  readonly model: string
  readonly effort: string
}

/** One cached effort answer. */
interface EffortsEntry {
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
  readonly error?: string
  readonly pending?: boolean
}

/** One load attempt's state. */
type Phase = 'loading' | 'ready' | 'unavailable' | 'failed'

const GRID: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const WARNING: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  color: 'var(--dsw-alias-label-warning, #b45309)',
}

const META: CSSProperties = {
  fontSize: '12px',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  wordBreak: 'break-word',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Seed the staged selections from one listing.
 * @param listing - the served listing.
 * @returns one staged row per listed definition.
 */
function stagedOfListing(listing: SubagentRoutesListing): Record<string, StagedRow> {
  const staged: Record<string, StagedRow> = {}
  for (const row of listing.agents ?? []) {
    staged[row.file] = {
      provider: row.provider ?? '',
      model: row.model ?? '',
      effort: row.reasoningEffort ?? '',
    }
  }
  return staged
}

/**
 * The staged selection a row starts from.
 * @param row - the served row.
 * @returns its staged equivalent.
 */
function stagedOf(row: SubagentRouteRow): StagedRow {
  return { provider: row.provider ?? '', model: row.model ?? '', effort: row.reasoningEffort ?? '' }
}

/**
 * The effort cache key for one exact route.
 * @param provider - provider route key.
 * @param model - exact model id.
 * @returns a collision-free key.
 */
function effortKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * The models one provider advertises.
 * @param providers - the catalog's providers.
 * @param provider - the selected provider key.
 * @returns the model ids, or none when the provider is not in the catalog.
 */
function modelsOf(providers: readonly SubagentCatalogProvider[], provider: string): readonly string[] {
  return providers.find(entry => entry.provider === provider)?.models ?? []
}

/**
 * Turn one failed write into the card's copy.
 * @param status - the HTTP status.
 * @param body - the parsed answer, of unknown shape.
 * @param copy - bound translate function.
 * @returns the message to show on the row.
 */
function describeFailure(status: number, body: unknown, copy: Translate): string {
  const detail = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? String((body as { error: string }).error)
    : ''
  switch (status) {
    case 401: return copy('routesCode401')
    case 403: return copy('routesCode403')
    case 409: return copy('routesStale')
    case 413: return copy('routesCode413')
    case 422: return copy('routesCode422', { message: detail })
    case 500: return copy('routesCode500', { message: detail })
    default: return copy('routesUnknownError', { status, message: detail.length > 0 ? detail : '—' })
  }
}

/**
 * Render one labelled control.
 * @param label - the field's visible label.
 * @param control - the control element.
 * @returns the field element.
 */
function field(label: string, control: ReactNode): ReactNode {
  return createElement('label', { style: styles.field },
    createElement('span', { style: styles.label }, label),
    control)
}

/**
 * Render one `<option>`.
 * @param value - the option value.
 * @param label - the option text.
 * @returns the option element.
 */
function option(value: string, label: string): ReactNode {
  return createElement('option', { key: value, value }, label)
}

/**
 * Render the Subagents route settings section.
 * @param props - composed slot props (see {@link SubagentRoutesSectionProps}).
 * @returns the section element tree.
 */
export function SubagentRoutesSection(props: SubagentRoutesSectionProps): ReactNode {
  const { copy } = props
  const [phase, setPhase] = useState<Phase>('loading')
  const [listing, setListing] = useState<SubagentRoutesListing | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [staged, setStaged] = useState<Record<string, StagedRow>>({})
  const [efforts, setEfforts] = useState<Record<string, EffortsEntry>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const inFlight = useRef<Set<string>>(new Set())

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    setFailure(undefined)
    try {
      const response = await fetch(SUBAGENT_ROUTES, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      // The channel answers 404 when no host half registered the path: that is a
      // deployment state, not an error, and it has its own copy.
      if (response.status === 404) {
        setListing(undefined)
        setPhase('unavailable')
        return
      }
      if (!response.ok) {
        setPhase('failed')
        setFailure(`HTTP ${String(response.status)} ${response.statusText}`)
        return
      }
      const body = await response.json() as SubagentRoutesListing
      setListing(body)
      setStaged(stagedOfListing(body))
      setRowErrors({})
      setPhase('ready')
    } catch (error: unknown) {
      setPhase('failed')
      setFailure(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Resolve one route's reasoning efforts, once, caching the answer.
   * @param provider - provider route key.
   * @param model - exact model id.
   */
  const loadEfforts = useCallback((provider: string, model: string): void => {
    if (provider.length === 0 || model.length === 0) return
    const key = effortKey(provider, model)
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setEfforts(current => current[key] === undefined
      ? { ...current, [key]: { efforts: [], pending: true } }
      : current)
    void (async () => {
      try {
        const url = `${SUBAGENT_ROUTES}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const body = await response.json() as SubagentEffortsBody
        setEfforts(current => ({
          ...current,
          [key]: {
            efforts: body.efforts ?? [],
            ...(body.defaultEffort === undefined ? {} : { defaultEffort: body.defaultEffort }),
            ...(body.error === undefined ? {} : { error: body.error }),
          },
        }))
      } catch (error: unknown) {
        setEfforts(current => ({ ...current, [key]: { efforts: [], error: messageOf(error) } }))
      } finally {
        inFlight.current.delete(key)
      }
    })()
  }, [])

  // Every row with a route needs its effort options; the answer is cached per
  // route, so a reload does not repeat a lookup it already has.
  useEffect(() => {
    for (const row of listing?.agents ?? []) {
      if (row.provider !== undefined && row.model !== undefined) loadEfforts(row.provider, row.model)
    }
  }, [listing, loadEfforts])

  /**
   * Write one row's staged route.
   * @param row - the served row being edited.
   * @param selection - its staged selection.
   */
  const save = useCallback((row: SubagentRouteRow, selection: StagedRow): void => {
    setRowErrors(current => {
      const next = { ...current }
      delete next[row.file]
      return next
    })
    void (async () => {
      try {
        const response = await fetch(SUBAGENT_ROUTES, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            file: row.file,
            provider: selection.provider,
            model: selection.model,
            // `null` is the documented "Default (route)" choice: the host omits
            // the field rather than writing a concrete effort.
            reasoningEffort: selection.effort.length === 0 ? null : selection.effort,
            expectedSha256: row.sha256,
          }),
        })
        const body: unknown = await response.json().catch(() => undefined)
        if (response.ok) {
          // The file now has a new digest and the host may have refused nothing,
          // so the only consistent next view is a fresh listing.
          await load()
          return
        }
        setRowErrors(current => ({ ...current, [row.file]: describeFailure(response.status, body, copy) }))
      } catch (error: unknown) {
        setRowErrors(current => ({
          ...current,
          [row.file]: copy('routesUnknownError', { status: 0, message: messageOf(error) }),
        }))
      }
    })()
  }, [copy, load])

  if (phase === 'unavailable') {
    return createElement('div', { style: styles.section },
      createElement('p', { style: styles.notice }, copy('routesUnavailable')))
  }

  const catalog = listing?.catalog
  const providers = catalog?.providers ?? []
  const rows = listing?.agents ?? []
  const canEdit = providers.length > 0
  const rootFailure = listing !== undefined && listing.root === undefined
  const rootLine = listing?.root === undefined
    ? undefined
    : `${listing.root}${listing.via === undefined ? '' : ` · ${copy('routesVia', { via: listing.via })}`}`
  const candidates = listing?.candidates ?? []

  return createElement('div', { style: styles.section },
    createElement('p', { style: styles.intro }, copy('routesIntro')),
    createElement('p', { style: META }, copy('routesApplies')),
    createElement('div', { style: styles.rowGroup },
      createElement('button', { type: 'button', style: styles.button, onClick: () => { void load() } }, copy('routesReload'))),
    phase === 'loading' ? createElement('p', { style: styles.intro }, '…') : null,
    phase === 'failed'
      ? createElement('p', { style: styles.error }, copy('routesLoadFailed', { message: failure ?? '' }))
      : null,
    rootFailure
      ? createElement('p', { style: styles.notice },
        copy('routesRootFailed', { message: listing?.error ?? '' }),
        createElement('br'),
        createElement('span', { style: META }, copy('routesRootFailedHint')))
      : null,
    rootFailure && candidates.length > 0
      ? createElement('p', { style: META }, copy('routesCandidates', { list: candidates.join(', ') }))
      : null,
    rootLine === undefined ? null : createElement('p', { style: META }, `${copy('routesRoot')}: ${rootLine}`),
    catalog?.status === 'partial'
      ? createElement('p', { style: WARNING }, copy('routesCatalogPartial', { count: catalog.errors.length }))
      : null,
    catalog !== undefined && catalog.status === 'unavailable'
      ? createElement('p', { style: WARNING }, copy('routesCatalogUnavailable'))
      : null,
    catalog === undefined || catalog.errors.length === 0
      ? null
      : createElement('p', { style: META }, catalog.errors.join(' · ')),
    (listing?.errors ?? []).length === 0
      ? null
      : createElement('p', { style: META }, (listing?.errors ?? []).join(' · ')),
    phase === 'ready' && !rootFailure && rows.length === 0
      ? createElement('p', { style: styles.intro }, copy('routesEmpty'))
      : null,
    createElement('ul', { style: styles.list }, ...rows.map((row) => {
      const selection = staged[row.file] ?? stagedOf(row)
      const models = modelsOf(providers, selection.provider)
      const effortsFor = efforts[effortKey(selection.provider, selection.model)]
      const effortOptions = effortsFor?.efforts ?? []
      const editable = row.mountable === 'yes' && row.sha256.length > 0 && canEdit
      const dirty = selection.provider !== (row.provider ?? '')
        || selection.model !== (row.model ?? '')
        || selection.effort !== (row.reasoningEffort ?? '')
      const unmatched = [
        selection.provider.length > 0 && !providers.some(entry => entry.provider === selection.provider)
          ? selection.provider
          : undefined,
        selection.model.length > 0 && !models.includes(selection.model)
          ? selection.model
          : undefined,
        selection.effort.length > 0 && !effortOptions.includes(selection.effort)
          ? selection.effort
          : undefined,
      ].filter((value): value is string => value !== undefined)

      const providerSelect = createElement('select', {
        style: styles.input,
        value: selection.provider,
        disabled: !editable,
        onChange: (event: { currentTarget: { value: string } }) => {
          const provider = event.currentTarget.value
          const firstModel = modelsOf(providers, provider)[0] ?? ''
          setStaged(current => ({
            ...current,
            [row.file]: { provider, model: firstModel, effort: '' },
          }))
          // A provider change invalidates the model, and with it the effort list.
          if (firstModel.length > 0) loadEfforts(provider, firstModel)
        },
      },
      selection.provider.length > 0 && !providers.some(entry => entry.provider === selection.provider)
        ? option(selection.provider, selection.provider)
        : null,
      ...providers.map(entry => option(entry.provider, `${entry.name} (${entry.provider})`)))

      const modelSelect = createElement('select', {
        style: styles.input,
        value: selection.model,
        disabled: !editable,
        onChange: (event: { currentTarget: { value: string } }) => {
          const model = event.currentTarget.value
          setStaged(current => ({ ...current, [row.file]: { ...selection, model, effort: '' } }))
          loadEfforts(selection.provider, model)
        },
      },
      selection.model.length > 0 && !models.includes(selection.model)
        ? option(selection.model, selection.model)
        : null,
      ...models.map(model => option(model, model)))

      const effortSelect = createElement('select', {
        style: styles.input,
        value: selection.effort,
        disabled: !editable,
        onChange: (event: { currentTarget: { value: string } }) => {
          const effort = event.currentTarget.value
          setStaged(current => ({ ...current, [row.file]: { ...selection, effort } }))
        },
      },
      option(
        '',
        effortsFor?.defaultEffort === undefined
          ? copy('routesEffortDefault')
          : `${copy('routesEffortDefault')} (${effortsFor.defaultEffort})`,
      ),
      ...effortOptions.map(effort => option(effort, effort)),
      selection.effort.length > 0 && !effortOptions.includes(selection.effort)
        ? option(selection.effort, selection.effort)
        : null)

      return createElement('li', { key: row.file, style: styles.row },
        createElement('div', { style: styles.identity },
          createElement('span', { style: styles.name }, row.name),
          createElement('span', { style: styles.meta }, row.file),
          createElement('span', { style: styles.meta }, copy(mountKey(row.mountable))),
          row.unavailableReason === undefined
            ? null
            : createElement('span', { style: styles.meta }, copy('routesReadOnly', { reason: row.unavailableReason })),
          createElement('span', { style: styles.meta }, copy('routesPreflight')),
          unmatched.length === 0
            ? null
            : createElement('span', { style: WARNING }, copy('routesUnmatched', { value: unmatched.join(', ') })),
          effortsFor?.pending === true
            ? createElement('span', { style: styles.meta }, copy('routesEffortsPending'))
            : null,
          effortsFor?.error === undefined
            ? null
            : createElement('span', { style: WARNING }, copy('routesEffortsUnavailable', { message: effortsFor.error }))),
        createElement('div', { style: GRID },
          field(copy('routesProvider'), providerSelect),
          field(copy('routesModel'), modelSelect),
          field(copy('routesEffort'), effortSelect),
          dirty && editable
            ? createElement('button', {
              type: 'button',
              style: styles.primary,
              onClick: () => { save(row, selection) },
            }, copy('routesSave'))
            : null,
          rowErrors[row.file] === undefined
            ? null
            : createElement('p', { style: styles.error }, rowErrors[row.file])))
    })))
}

/**
 * The copy key for one mountability verdict.
 * @param value - `yes`, `no` or `unknown`.
 * @returns the locale key naming it.
 */
function mountKey(value: RowMountability): LocaleKey {
  switch (value) {
    case 'yes': return 'routesMountYes'
    case 'no': return 'routesMountNo'
    case 'unknown': return 'routesMountUnknown'
  }
}
