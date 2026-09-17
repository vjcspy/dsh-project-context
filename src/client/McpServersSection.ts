/**
 * The MCP servers Settings card.
 *
 * Presentation only: it renders the host half's view, stages an editor, and
 * routes every write back through the injected callbacks. It subscribes to the
 * settings snapshot through `useSyncExternalStore` rather than a declared
 * store — the observable it reads belongs to the settings transport, which is
 * a framework-hook-shaped source this plugin cannot declare.
 *
 * Three states are deliberately distinct, because the section slot renders
 * whether or not the host half is mounted: a served namespace with servers, a
 * served namespace that is empty, and NO served namespace at all. Collapsing
 * the last into "empty" would present a broken deployment as a configured one.
 */

import { createElement, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { styles } from './styles.ts'
import type { LocaleKey, Translate } from './locales.ts'

/** One namespace section as the host serves it, with secrets already stripped. */
export interface McpServerSection {
  readonly serverName: string
  readonly enabled: boolean
  readonly transport: 'stdio' | 'streamable-http'
  readonly command: string
  readonly args: readonly string[]
  /** Environment NAMES only; every value is stripped from the wire document. */
  readonly envNames: readonly string[]
  readonly cwd: string
  readonly url: string
  /** Header NAMES only; every value is stripped from the wire document. */
  readonly headerNames: readonly string[]
  readonly toolCallTimeoutMs: number
  readonly maxInstructionBytes: number
}

/** One entry's rendered state, computed by the host half. */
export interface McpServerStatusView {
  readonly serverName: string
  readonly state: 'mounted' | 'empty' | 'disabled' | 'conflict' | 'invalid' | 'failed'
  readonly reason?: string
}

/** The namespace view the card renders. */
export interface McpSectionSnapshot {
  /** Whether the host half serves the namespace at all. */
  readonly served: boolean
  /** Whether the host document accepts writes. */
  readonly writable: boolean
  /** Fencing revision for the next write. */
  readonly revision: number | undefined
  /** Managed servers, in list order. */
  readonly servers: readonly McpServerSection[]
  /** Per-server state, keyed by `serverName`. */
  readonly statuses: readonly McpServerStatusView[]
}

/** One field of a namespace entry, addressed by list index. */
export type McpPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * The card's injected face: a value read, a subscription, and two writes.
 *
 * Every member is plain data or a callback, as the UI-domain rule requires; no
 * service object, hook factory, or renderer state crosses this seam.
 */
export interface McpServersSectionInjected {
  /** @returns the current namespace snapshot. */
  read: () => McpSectionSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each replacement.
   * @returns the disposer removing this listener.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Replace one entry, or create it at the given index.
   * @param index - the entry's position in the list.
   * @param value - the complete field set for that entry.
   */
  put: (index: number, value: Record<string, unknown>) => Promise<void>
  /**
   * Drop one entry.
   * @param index - the entry's position in the list.
   */
  drop: (index: number) => Promise<void>
  /** Bound translate function over the card's dictionary. */
  copy: Translate
}

/** Props assembled by the settings shell for this section. */
export type McpServersSectionProps =
  PropsRuntime<'settings.section'> & McpServersSectionInjected

/** The editor's staged field values, all strings because every input is text. */
interface EditorState {
  /** Index being edited, or -1 for a new entry. */
  readonly index: number
  readonly id: string
  readonly serverName: string
  readonly enabled: boolean
  readonly transport: 'stdio' | 'streamable-http'
  /**
   * The transport the STORED entry has. A change here moves the entry between
   * the two secret positions, so the box that is untouched on the way in is
   * the other one's box on the way out.
   */
  readonly storedTransport: 'stdio' | 'streamable-http'
  readonly command: string
  readonly args: string
  readonly env: string
  readonly headers: string
  readonly cwd: string
  readonly url: string
  /** Header names the stored entry already has; their values are not readable. */
  readonly storedHeaderNames: readonly string[]
  /** Env names the stored entry already has; their values are not readable. */
  readonly storedEnvNames: readonly string[]
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Render the MCP servers settings section.
 * @param props - composed slot props (see {@link McpServersSectionProps}).
 * @returns the section element tree.
 */
export function McpServersSection(props: McpServersSectionProps): ReactNode {
  const { read, subscribe, put, drop, copy } = props
  const snapshot = useSyncExternalStore(subscribe, read, read)
  const [editor, setEditor] = useState<EditorState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pendingRemove, setPendingRemove] = useState<number | undefined>(undefined)

  const statusOf = useCallback((serverName: string): McpServerStatusView | undefined =>
    snapshot.statuses.find(status => status.serverName === serverName), [snapshot.statuses])

  const beginAdd = (): void => {
    setError(undefined)
    setEditor({
      index: -1,
      id: newId(),
      serverName: '',
      enabled: true,
      transport: 'stdio',
      storedTransport: 'stdio',
      command: '',
      args: '',
      env: '',
      headers: '',
      cwd: '',
      url: '',
      storedHeaderNames: [],
      storedEnvNames: [],
    })
  }

  const beginEdit = (index: number, server: McpServerSection): void => {
    setError(undefined)
    setEditor({
      index,
      // The namespace schema requires an id, and the redacted wire view does
      // not carry one. A fresh opaque id on each edit costs nothing: the entry
      // is addressed by its list index in the write path, and `id` is only the
      // document's own stability marker for a created entry.
      id: newId(),
      serverName: server.serverName,
      enabled: server.enabled,
      transport: server.transport,
      storedTransport: server.transport,
      command: server.command,
      args: server.args.join('\n'),
      // Both secret positions are write-only on the wire, so the editor opens
      // their boxes empty: a prefilled box would have nothing truthful to show.
      env: '',
      headers: '',
      cwd: server.cwd,
      url: server.url,
      storedHeaderNames: server.headerNames,
      storedEnvNames: server.envNames,
    })
  }

  const commit = (): void => {
    if (editor === undefined) return
    const parsed = parseEditor(editor, copy)
    if (typeof parsed === 'string') {
      setError(parsed)
      return
    }
    const target = editor.index
    put(target, parsed).then(() => {
      setEditor(undefined)
      setError(undefined)
    }).catch((reason: unknown) => {
      setError(copy('writeFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
  }

  const confirmRemove = (index: number): void => {
    drop(index).then(() => {
      setPendingRemove(undefined)
      setEditor(current => current?.index === index ? undefined : current)
    }).catch((reason: unknown) => {
      setError(copy('writeFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
  }

  if (!snapshot.served) {
    return createElement('div', { style: styles.section },
      createElement('p', { style: styles.notice }, copy('hostAbsent')))
  }

  return createElement('div', { style: styles.section },
    createElement('p', { style: styles.intro }, copy('intro')),
    snapshot.servers.length === 0 && editor === undefined
      ? createElement('p', { style: styles.intro }, copy('empty'))
      : null,
    createElement('ul', { style: styles.list }, ...snapshot.servers.map((server, index) =>
      renderRow({ server, index, status: statusOf(server.serverName), pendingRemove, copy, writable: snapshot.writable, onEdit: beginEdit, onAskRemove: setPendingRemove, onConfirmRemove: confirmRemove }))),
    editor === undefined ? null : renderEditor({ editor, copy, onChange: setEditor, onCancel: () => { setEditor(undefined); setError(undefined) }, onSave: commit }),
    error === undefined ? null : createElement('p', { style: styles.error }, error),
    snapshot.writable && editor === undefined
      ? createElement('div', { style: styles.rowGroup },
        createElement('button', { type: 'button', style: styles.primary, onClick: beginAdd }, copy('add')))
      : null,
  )
}

interface RowArgs {
  readonly server: McpServerSection
  readonly index: number
  readonly status: McpServerStatusView | undefined
  readonly pendingRemove: number | undefined
  readonly copy: Translate
  readonly writable: boolean
  readonly onEdit: (index: number, server: McpServerSection) => void
  readonly onAskRemove: (index: number) => void
  readonly onConfirmRemove: (index: number) => void
}

function renderRow(args: RowArgs): ReactNode {
  const { server, index, status } = args
  const state = status?.state ?? 'disabled'
  return createElement('li', { key: server.serverName, style: styles.row },
    createElement('span', { style: styles.identity },
      createElement('span', { style: styles.name }, server.serverName),
      createElement('span', { style: styles.meta }, [
        server.transport,
        args.copy(stateKey(state)),
        status?.reason,
      ].filter(part => part !== undefined && part.length > 0).join(' · ')),
      server.transport === 'streamable-http' && server.headerNames.length > 0
        ? createElement('span', { style: styles.meta }, args.copy('headersKept', { n: server.headerNames.length }))
        : null,
      server.transport === 'stdio' && server.envNames.length > 0
        ? createElement('span', { style: styles.meta }, args.copy('envKept', { n: server.envNames.length }))
        : null),
    createElement('span', { style: styles.actions },
      args.writable
        ? createElement('button', { type: 'button', style: styles.button, onClick: () => { args.onEdit(index, server) } }, args.copy('edit'))
        : null,
      args.writable
        ? args.pendingRemove === index
          ? createElement('button', { type: 'button', style: styles.button, onClick: () => { args.onConfirmRemove(index) } }, args.copy('confirmRemove'))
          : createElement('button', { type: 'button', style: styles.button, onClick: () => { args.onAskRemove(index) } }, args.copy('remove'))
        : null))
}

interface EditorArgs {
  readonly editor: EditorState
  readonly copy: Translate
  readonly onChange: (next: EditorState) => void
  readonly onCancel: () => void
  readonly onSave: () => void
}

function renderEditor(args: EditorArgs): ReactNode {
  const { editor, copy } = args
  const set = (patch: Partial<EditorState>): void => { args.onChange({ ...editor, ...patch }) }
  return createElement('div', { style: styles.form },
    createElement('strong', undefined, copy(editor.index < 0 ? 'editorTitleNew' : 'editorTitleEdit')),
    field(copy('serverName'), createElement('input', {
      style: styles.input,
      value: editor.serverName,
      onChange: (event: { currentTarget: { value: string } }) => { set({ serverName: event.currentTarget.value }) },
    })),
    field(copy('transport'), createElement('select', {
      style: styles.input,
      value: editor.transport,
      onChange: (event: { currentTarget: { value: string } }) => {
        set({ transport: event.currentTarget.value === 'streamable-http' ? 'streamable-http' : 'stdio' })
      },
    },
    createElement('option', { value: 'stdio' }, copy('transportStdio')),
    createElement('option', { value: 'streamable-http' }, copy('transportHttp')))),
    createElement('label', { style: styles.check },
      createElement('input', {
        type: 'checkbox',
        checked: editor.enabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => { set({ enabled: event.currentTarget.checked }) },
      }),
      copy('enabled')),
    editor.transport === 'stdio'
      ? field(copy('command'), textInput(editor.command, value => { set({ command: value }) }))
      : null,
    editor.transport === 'stdio'
      ? field(copy('args'), textarea(editor.args, value => { set({ args: value }) }))
      : null,
    editor.transport === 'stdio'
      ? field(copy('env'), textarea(editor.env, value => { set({ env: value }) }))
      : null,
    editor.transport === 'stdio'
      ? field(copy('cwd'), textInput(editor.cwd, value => { set({ cwd: value }) }))
      : null,
    editor.transport === 'streamable-http'
      ? field(copy('url'), textInput(editor.url, value => { set({ url: value }) }))
      : null,
    editor.transport === 'streamable-http'
      ? field(copy('headers'), textarea(editor.headers, value => { set({ headers: value }) }))
      : null,
    createElement('div', { style: styles.rowGroup },
      createElement('button', { type: 'button', style: styles.primary, onClick: args.onSave }, copy('save')),
      createElement('button', { type: 'button', style: styles.button, onClick: args.onCancel }, copy('cancel'))))
}

function field(label: string, control: ReactNode): ReactNode {
  return createElement('label', { style: styles.field },
    createElement('span', { style: styles.label }, label),
    control)
}

function textInput(value: string, onChange: (next: string) => void): ReactNode {
  return createElement('input', {
    style: styles.input,
    value,
    onChange: (event: { currentTarget: { value: string } }) => { onChange(event.currentTarget.value) },
  })
}

function textarea(value: string, onChange: (next: string) => void): ReactNode {
  return createElement('textarea', {
    style: styles.textarea,
    value,
    onChange: (event: { currentTarget: { value: string } }) => { onChange(event.currentTarget.value) },
  })
}

function stateKey(state: McpServerStatusView['state']): LocaleKey {
  switch (state) {
    case 'mounted': return 'stateMounted'
    case 'empty': return 'stateEmpty'
    case 'disabled': return 'stateDisabled'
    case 'conflict': return 'stateConflict'
    case 'invalid': return 'stateInvalid'
    case 'failed': return 'stateFailed'
  }
}

/**
 * Parse the env or header lines of one namespace section.
 * Exported for the card's own tests.
 * @param text - the textarea content.
 * @param copy - bound translate function for a malformed line.
 * @returns the parsed map, or the refusal message.
 */
export function parseMapLines(text: string, copy: Translate): Record<string, string> | string {
  const out: Record<string, string> = {}
  const lines = text.split('\n')
  for (const [position, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.length === 0) continue
    const separator = line.indexOf('=')
    if (separator <= 0) {
      return copy('invalidMapLine', { line: position + 1, text: line })
    }
    out[line.slice(0, separator).trim()] = line.slice(separator + 1)
  }
  return out
}

/**
 * Turn one staged editor state into a namespace entry payload.
 * Exported for the card's own tests.
 * @param editor - the staged field values.
 * @param copy - bound translate function for a refusal message.
 * @returns the entry payload, or the refusal message.
 */
export function parseEditor(editor: EditorState, copy: Translate): Record<string, unknown> | string {
  const serverName = editor.serverName.trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) return copy('invalidServerName')
  const args = editor.args.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const env = parseMapLines(editor.env, copy)
  if (typeof env === 'string') return env
  const headers = parseMapLines(editor.headers, copy)
  if (typeof headers === 'string') return headers
  const stdio = editor.transport === 'stdio'
  const payload: Record<string, unknown> = {
    id: editor.id,
    serverName,
    enabled: editor.enabled,
    transport: editor.transport,
    command: stdio ? editor.command.trim() : '',
    args: stdio ? args : [],
    cwd: stdio ? editor.cwd.trim() : '',
    url: stdio ? '' : editor.url.trim(),
    toolCallTimeoutMs: 60_000,
    maxInstructionBytes: 0,
  }
  // Neither secret position is readable from the wire, so an edit that leaves
  // one of those boxes empty must not restate the field: omitting it keeps
  // every stored value, while sending an empty map would delete them. That
  // exemption ends when the transport changes, because the two transports hold
  // their secrets in different fields — the untouched box is then the OTHER
  // field's box, and the entry's new transport must ship a map of its own.
  const switched = editor.transport !== editor.storedTransport
  if (stdio && (switched || editor.env.trim().length > 0)) payload['env'] = env
  if (!stdio && (switched || editor.headers.trim().length > 0)) payload['headers'] = headers
  return payload
}

/** A fresh entry identity. `crypto.randomUUID` is browser-native. */
function newId(): string {
  const random: unknown = globalThis.crypto
  if (typeof random === 'object' && random !== null && 'randomUUID' in random) {
    return String((random as { randomUUID(): string }).randomUUID())
  }
  return `mcp-${String(Date.now())}`
}
