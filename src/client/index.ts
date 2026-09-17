/**
 * MCP servers Settings section, browser half.
 *
 * The card is contributed to `settings.section`, so the shell renders it as
 * its own Settings page. Reads ride `ctx.settingsScope.describe()`, the one
 * shared describe mirror; writes go through `mutate` with an explicit path and
 * the revision that was read. `replace` is deliberately never used: a document
 * rebuilt from a redacted wire view would silently delete every env and header
 * value the wire never returned.
 *
 * @module dsh-project-context/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the `settings.section` slot declaration and the settings-scope
// Context merge. Cross-plugin collaboration goes through cordis services; a
// value import of another plugin's package is a bundle-purity error.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `ctx.slots` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `ctx.locale` service merge whose active locale selects
// the dictionary this card binds.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { McpSectionSnapshot, McpServerSection, McpServersSectionInjected } from './McpServersSection.ts'
import { McpServersSection } from './McpServersSection.ts'
import { bind, en, zh } from './locales.ts'

export type { McpSectionSnapshot, McpServerSection, McpServersSectionInjected } from './McpServersSection.ts'
export { McpServersSection } from './McpServersSection.ts'

/** Settings namespace the host half registers. Spelled identically in both halves. */
export const MCP_NAMESPACE = 'dsh-project-context-mcp'

/** Services this half reads. `slots` and `settingsScope` are shell-provided. */
export const inject = ['slots', 'settingsScope', 'locale']

/**
 * One namespace view as the mirror holds it.
 *
 * Declared locally rather than imported: the mirror's own types live in
 * `@deepseek-ai/dsh-client-ui-settings`, whose Client face is a module-table
 * row this plugin does not request, so only a structural reading of the same
 * snapshot crosses the seam.
 *
 * Exported because {@link toSnapshot} carries an identity contract the type
 * alone cannot state: the mirror returns the SAME object until its held view
 * changes, and the projection's cache is keyed on exactly that reference.
 */
export interface MirrorSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable' | string
  /** The last good answer; absent until the first successful read. */
  readonly view?: {
    readonly namespaces: readonly {
      readonly ns: string
      readonly revision: number
      readonly value: unknown
    }[]
  } | undefined
}

/** One namespace section as the describe response carries it, after redaction. */
interface WireSection {
  readonly serverName?: unknown
  readonly enabled?: unknown
  readonly transport?: unknown
  readonly command?: unknown
  readonly args?: unknown
  readonly env?: unknown
  readonly cwd?: unknown
  readonly url?: unknown
  readonly headers?: unknown
  readonly toolCallTimeoutMs?: unknown
  readonly maxInstructionBytes?: unknown
}

/**
 * Contribute the MCP servers page to Settings.
 * @param ctx - the browser-side plugin context.
 */
export function apply(ctx: ClientContext): void {
  const mirror = ctx.settingsScope.describe()
  const copy = bind(ctx.locale.getSnapshot().active === 'zh' ? zh : en)
  // `useSyncExternalStore` compares `getSnapshot()` results with `Object.is` on
  // every render AND after every subscription check, so an uncached projection
  // makes every pass see a "changed" store: React re-renders, the check runs
  // again, and the page dies on the maximum-update-depth error (#185). The
  // mirror documents the one caching key available here — its snapshot is
  // "stable reference until the next change" — so the derived view is reused
  // for as long as that reference is unchanged.
  let cachedSource: MirrorSnapshot | undefined
  let cachedSnapshot: McpSectionSnapshot | undefined
  const read = (): McpSectionSnapshot => {
    const source = mirror.getSnapshot()
    if (cachedSnapshot === undefined || source !== cachedSource) {
      cachedSource = source
      cachedSnapshot = toSnapshot(source, copy)
    }
    return cachedSnapshot
  }
  // Built once, not per `inject()` call: the shell may re-invoke `inject` on
  // every render, and a fresh face object would hand it a new `subscribe`
  // identity each time, tearing down and re-adding the subscription on every
  // pass of the same render loop.
  const face: McpServersSectionInjected = {
    read,
    // Hoisted out of the face literal for the same reason: one bound method,
    // one identity, for the lifetime of the plugin instance.
    subscribe: listener => mirror.subscribe(listener),
    put: (index, value) => {
      const snapshot = read()
      const payload = { ...value } as unknown as McpServerSection
      // Position, not identity: one `set` on the whole list is the only write
      // that cannot restate a field the wire never carried. A negative index is
      // the editor's "new entry" sentinel (`beginAdd` sets -1), and assigning it
      // directly would attach a non-index property that serialises as an empty
      // list — a silent data loss — so a new entry appends instead.
      const next = index < 0
        ? [...snapshot.servers, payload]
        : snapshot.servers.map((server, at) => at === index ? payload : server)
      return ctx.settingsScope.bind({ namespace: MCP_NAMESPACE })
        .mutate([{ op: 'set', path: ['servers'], value: next as never }], snapshot.revision)
    },
    drop: (index) => {
      const snapshot = read()
      return ctx.settingsScope.bind({ namespace: MCP_NAMESPACE })
        .mutate([{ op: 'set', path: ['servers'], value: snapshot.servers.filter((_, at) => at !== index) as never }], snapshot.revision)
    },
    copy,
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-servers',
    order: 30,
    label: () => copy('nav'),
    inject: (): McpServersSectionInjected => face,
  }, McpServersSection))
}

/**
 * Project one describe snapshot onto the card's view.
 *
 * `served` distinguishes "the host half registered the namespace and it is
 * empty" from "no host half is mounted": the section slot renders either way,
 * and the mirror reports `unavailable` for a namespace it does not hold.
 *
 * @param mirrored - the mirror's current snapshot.
 * @param copy - bound translate function used by nothing here but kept for symmetry with callers.
 * @returns the card's view.
 */
function toSnapshot(mirrored: MirrorSnapshot, copy: ReturnType<typeof bind>): McpSectionSnapshot {
  const view = mirrored.view?.namespaces.find(candidate => candidate.ns === MCP_NAMESPACE)
  if (mirrored.status === 'loading' || view === undefined) {
    return { served: false, writable: false, revision: undefined, servers: [], statuses: [] }
  }
  const servers = Array.isArray((view.value as { servers?: unknown } | null)?.servers)
    ? ((view.value as { servers: unknown[] }).servers).map(toSection)
    : []
  return {
    served: true,
    writable: true,
    revision: view.revision,
    servers,
    statuses: servers.map(server => ({ serverName: server.serverName, state: server.enabled ? 'mounted' : 'disabled' })),
  }
}

function toSection(raw: unknown): McpServerSection {
  const section = (typeof raw === 'object' && raw !== null ? raw : {}) as WireSection
  const headers = nameKeys(section.headers)
  const env = nameKeys(section.env)
  return {
    serverName: typeof section.serverName === 'string' ? section.serverName : '',
    enabled: section.enabled !== false,
    transport: section.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: typeof section.command === 'string' ? section.command : '',
    args: Array.isArray(section.args) ? section.args.filter((item): item is string => typeof item === 'string') : [],
    envNames: env,
    cwd: typeof section.cwd === 'string' ? section.cwd : '',
    url: typeof section.url === 'string' ? section.url : '',
    headerNames: headers,
    toolCallTimeoutMs: typeof section.toolCallTimeoutMs === 'number' ? section.toolCallTimeoutMs : 60_000,
    maxInstructionBytes: typeof section.maxInstructionBytes === 'number' ? section.maxInstructionBytes : 0,
  }
}

/**
 * The names of a redacted `dict` node on the wire.
 *
 * Both secret positions are stripped of their VALUES by the settings redaction
 * walker, which leaves the key set behind; only the names are read here, so a
 * value that survived redaction through some walker gap is never rendered.
 *
 * @param value - the redacted dict node, of unknown shape on the wire.
 * @returns the node's own key names, or none when it is absent.
 */
function nameKeys(value: unknown): string[] {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []
}
