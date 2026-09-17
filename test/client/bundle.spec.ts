/**
 * The shipped browser bundle's contract with the client module system.
 *
 * The page loads `lib/client.js` as a lazy CommonJS factory handed to
 * `window.__ModuleLoader__.load({ id, factory })`, so the ARTIFACT is the
 * contract: this spec reads the built file, checks the handoff the loader
 * requires, and runs the factory with the `require` the module table would
 * supply. It parses no source and mocks no bundler, which is what makes it
 * evidence about what a deployment receives.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, test } from 'vitest'
import { bind, en, zh } from '../../src/client/locales.ts'
import { parseEditor, parseMapLines } from '../../src/client/McpServersSection.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundlePath = join(packageRoot, 'lib', 'client.js')

/** One loader registration captured from the bundle's handoff. */
interface Registration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** Evaluate the built bundle once and hand back the registration it made. */
function captureRegistration(): Registration {
  const registrations: Registration[] = []
  const globals = globalThis as unknown as { window?: unknown }
  const previous = globals.window
  globals.window = {
    __ModuleLoader__: {
      load(registration: Registration) { registrations.push(registration) },
    },
  }
  try {
    const require = createRequire(join(packageRoot, 'index.js'))
    // The artifact is a script, evaluated exactly as the page evaluates it.
    const evaluate = new Function(readFileSync(bundlePath, 'utf8'))
    evaluate()
    const registration = registrations[0]
    if (registration === undefined) throw new Error('the bundle registered nothing')
    return registration
  } finally {
    globals.window = previous
  }
}

/** Run the built bundle against a recording module loader and return what it registered. */
function loadBundle(): Registration {
  const registration = captureRegistration()
  const require = createRequire(join(packageRoot, 'index.js'))
  return { id: registration.id, factory: () => registration.factory(specifier => require(specifier) as unknown) }
}

/** The injected face the card's registration supplies to the shell. */
interface CardFace {
  readonly read: () => {
    readonly served: boolean
    readonly revision: number | undefined
    readonly servers: readonly Record<string, unknown>[]
  }
}

/** A minimal stand-in for a settings-scope mirror holding one namespace view. */
function mirrorOf(value: unknown, revision = 7): EventTarget & { getSnapshot: () => unknown } {
  const target = new EventTarget() as EventTarget & { getSnapshot: () => unknown }
  target.getSnapshot = () => ({ status: 'ready', view: { namespaces: [{ ns: 'dsh-project-context-mcp', revision, value }] } })
  return target
}

/**
 * Run the built bundle's `apply` against a stub browser context.
 *
 * Nothing here is a mock of the plugin: the bundle's OWN `read()` face is what
 * answers, so this is evidence about the value the card renders.
 *
 * @param value - the redacted namespace document the mirror holds.
 * @returns the injected face the shell would receive.
 */
function cardFace(value: unknown): CardFace {
  const { factory } = loadBundle()
  const exports = factory()
  let captured: { inject: () => CardFace } | undefined
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'en' }) },
    settingsScope: { describe: () => mirrorOf(value) },
    slots: {
      inject(_name: string, contribute: () => unknown) { contribute() },
      register(registration: { inject: () => CardFace }) { captured = registration },
    },
  }
  ;(exports['apply'] as (context: unknown) => void)(ctx)
  if (captured === undefined) throw new Error('the bundle registered no settings.section entry')
  return (captured as unknown as { inject: () => CardFace }).inject()
}

describe('client bundle', () => {
  beforeAll(() => {
    expect(existsSync(bundlePath), `${bundlePath} must exist; run \`pnpm run build:client\``).toBe(true)
  })

  test('hands the loader one registration under the package id, carrying the plugin face', () => {
    const { id, factory } = loadBundle()
    expect(id).toBe('dsh-project-context')
    const exports = factory()
    expect(typeof exports['apply']).toBe('function')
    expect(exports['inject']).toEqual(['slots', 'settingsScope', 'locale'])
    expect(exports['MCP_NAMESPACE']).toBe('dsh-project-context-mcp')
    expect(typeof exports['McpServersSection']).toBe('function')
  })

  test('requires only the module-table rows the shell seeds', () => {
    const source = readFileSync(bundlePath, 'utf8')
    const specifiers = [...source.matchAll(/require\("([^"]+)"\)/g)]
      .map(match => match[1])
      .filter((specifier): specifier is string => specifier !== undefined)
    // React is the only shared module this half reads; every other cross-plugin
    // relationship is a cordis service reached through `inject`, which the
    // bundle-purity rule requires and the module table can answer.
    expect(new Set(specifiers)).toEqual(new Set(['react']))
  })
})

describe('card snapshot stability', () => {
  /**
   * Evaluate the bundle against a mirror whose snapshot reference changes only
   * on demand, which is the contract `useSyncExternalStore` compares against.
   *
   * @param value - the redacted namespace document the mirror starts with.
   * @returns the injected face accessor and a hook that replaces the snapshot.
   */
  function stableCard(value: unknown): {
    face: () => { read: () => unknown }
    change: (next: unknown) => void
  } {
    const { factory } = loadBundle()
    const exports = factory()
    const view = (document: unknown, revision: number): unknown => ({
      status: 'ready',
      view: { namespaces: [{ ns: 'dsh-project-context-mcp', revision, value: document }] },
    })
    let snapshot: unknown = view(value, 1)
    let captured: { inject: () => { read: () => unknown } } | undefined
    const ctx = {
      locale: { getSnapshot: () => ({ active: 'en' }) },
      settingsScope: {
        describe: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {} }),
        bind: () => ({ mutate: () => Promise.resolve() }),
      },
      slots: {
        inject(_name: string, contribute: () => unknown) { contribute() },
        register(registration: { inject: () => { read: () => unknown } }) { captured = registration },
      },
    }
    ;(exports['apply'] as (context: unknown) => void)(ctx)
    if (captured === undefined) throw new Error('the bundle registered no settings.section entry')
    const registration = captured as { inject: () => { read: () => unknown } }
    return {
      face: () => registration.inject(),
      change: (next: unknown) => { snapshot = view(next, 2) },
    }
  }

  test('the injected face keeps one identity and read() is referentially stable', () => {
    const card = stableCard({ servers: [] })
    const first = card.face()
    // A fresh face per `inject()` call would hand the shell a new `subscribe`
    // identity, which tears down and re-adds the subscription on every render.
    expect(card.face()).toBe(first)
    const before = first.read()
    // React compares `getSnapshot()` results with `Object.is`; an uncached
    // projection re-renders forever and dies on error #185.
    expect(first.read()).toBe(before)
    card.change({ servers: [{ serverName: 'Monolith', transport: 'streamable-http' }] })
    const after = first.read()
    expect(after).not.toBe(before)
    expect(first.read()).toBe(after)
  })
})

describe('card writes', () => {
  /**
   * Build the injected face over a recording write channel.
   *
   * @param value - the redacted namespace document the mirror holds.
   * @param revision - the revision the mirror reports for that document.
   * @returns the write entry point and the operations it recorded.
   */
  function writingCard(value: unknown, revision = 3): {
    put: (index: number, entry: Record<string, unknown>) => Promise<void>
    ops: () => { readonly path: readonly string[]; readonly value: unknown }[]
    expectedRevisions: () => (number | undefined)[]
  } {
    const { factory } = loadBundle()
    const exports = factory()
    const ops: { path: readonly string[]; value: unknown }[] = []
    const revisions: (number | undefined)[] = []
    let captured: { inject: () => unknown } | undefined
    const ctx = {
      locale: { getSnapshot: () => ({ active: 'en' }) },
      settingsScope: {
        describe: () => ({
          getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: 'dsh-project-context-mcp', revision, value }] } }),
          subscribe: () => () => {},
        }),
        bind: () => ({
          mutate: (incoming: { path: readonly string[]; value: unknown }[], expected: number | undefined) => {
            ops.push(...incoming)
            revisions.push(expected)
            return Promise.resolve()
          },
        }),
      },
      slots: {
        inject(_name: string, contribute: () => unknown) { contribute() },
        register(registration: { inject: () => unknown }) { captured = registration },
      },
    }
    ;(exports['apply'] as (context: unknown) => void)(ctx)
    if (captured === undefined) throw new Error('the bundle registered no settings.section entry')
    const registration = captured as { inject: () => { put: (index: number, entry: Record<string, unknown>) => Promise<void> } }
    return {
      put: (index, entry) => registration.inject().put(index, entry),
      ops: () => ops,
      expectedRevisions: () => revisions,
    }
  }

  test('a new entry appends, because the editor addresses it with -1', async () => {
    const card = writingCard({ servers: [] })
    await card.put(-1, { serverName: 'monolith-managed', transport: 'streamable-http' })
    expect(card.ops()).toHaveLength(1)
    expect(card.ops()[0]?.path).toEqual(['servers'])
    // Assigning index -1 onto the array would attach a non-index property and
    // serialise as `[]`, which is silent data loss rather than a rejection.
    expect(card.ops()[0]?.value).toEqual([{ serverName: 'monolith-managed', transport: 'streamable-http' }])
    expect(card.expectedRevisions()).toEqual([3])
  })

  test('an existing entry is replaced in place', async () => {
    const card = writingCard({ servers: [{ serverName: 'alpha' }, { serverName: 'beta' }] })
    await card.put(1, { serverName: 'beta-2' })
    const written = card.ops()[0]?.value as { serverName?: string }[]
    // The mirror projects every entry through the card's own shape, so the
    // untouched neighbour is compared by identity fields rather than literally.
    expect(written).toHaveLength(2)
    expect(written[0]?.serverName).toBe('alpha')
    expect(written[1]?.serverName).toBe('beta-2')
  })
})

describe('card copy and staging', () => {
  test('both dictionaries define the same key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
  test('the bound translate function substitutes placeholders and falls back to the key', () => {
    const t = bind(en)
    expect(t('writeFailed', { message: 'conflict' })).toContain('conflict')
    expect(bind({})( 'nav' as never)).toBe(en.nav)
  })

  test('a header line that is not KEY=value is refused with its line number', () => {
    const t = bind(en)
    expect(parseMapLines('A=1\nbroken\n', t)).toContain('Line 2')
    expect(parseMapLines('A=1\nB=two\n', t)).toEqual({ A: '1', B: 'two' })
  })

  test('a streamable-http edit with an untouched header box omits headers, so stored values survive', () => {
    const t = bind(en)
    const base = {
      index: -1,
      id: 'entry',
      serverName: 'ctx7',
      enabled: true,
      transport: 'streamable-http' as const,
      storedTransport: 'streamable-http' as const,
      command: '',
      args: '',
      env: '',
      cwd: '',
      url: 'https://mcp.context7.com/mcp',
      storedHeaderNames: ['CONTEXT7_API_KEY'],
      storedEnvNames: [],
    }
    const untouched = parseEditor({ ...base, headers: '' }, t)
    expect(typeof untouched).toBe('object')
    expect(Object.hasOwn(untouched as object, 'headers')).toBe(false)

    const replaced = parseEditor({ ...base, headers: 'CONTEXT7_API_KEY=new-key' }, t)
    expect((replaced as Record<string, unknown>)['headers']).toEqual({ CONTEXT7_API_KEY: 'new-key' })
  })

  test('a stdio edit with an untouched env box omits env, so stored values survive', () => {
    const t = bind(en)
    // The stdio mirror of the header case above: `env` is the position a stdio
    // server carries its credential in, and the wire never returned the value.
    const base = {
      index: 0,
      id: 'entry',
      serverName: 'github',
      enabled: true,
      transport: 'stdio' as const,
      storedTransport: 'stdio' as const,
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-github',
      env: '',
      headers: '',
      cwd: '',
      url: '',
      storedHeaderNames: [],
      storedEnvNames: ['GITHUB_TOKEN'],
    }
    const untouched = parseEditor({ ...base, env: '' }, t)
    expect(typeof untouched).toBe('object')
    expect(Object.hasOwn(untouched as object, 'env')).toBe(false)
    expect((untouched as Record<string, unknown>)['command']).toBe('npx')

    const replaced = parseEditor({ ...base, env: 'GITHUB_TOKEN=new-token' }, t)
    expect((replaced as Record<string, unknown>)['env']).toEqual({ GITHUB_TOKEN: 'new-token' })
  })

  test('switching transport drops the other transport\'s secret position', () => {
    const t = bind(en)
    // An env entry re-pointed at streamable-http: the header box is untouched,
    // but it belongs to the transport being LEFT, so the exemption from the
    // test above must not keep an `env` a streamable-http entry cannot use.
    const switched = parseEditor({
      index: 0,
      id: 'entry',
      serverName: 'github',
      enabled: true,
      transport: 'streamable-http',
      storedTransport: 'stdio',
      command: '',
      args: '',
      env: '',
      headers: '',
      cwd: '',
      url: 'https://example.test/mcp',
      storedHeaderNames: [],
      storedEnvNames: ['GITHUB_TOKEN'],
    }, t)
    expect(typeof switched).toBe('object')
    expect(Object.hasOwn(switched as object, 'env')).toBe(false)
    expect((switched as Record<string, unknown>)['headers']).toEqual({})
  })

  test('an invalid server name is refused before any write', () => {
    const t = bind(en)
    const refused = parseEditor({
      index: -1,
      id: 'entry',
      serverName: 'bad name!',
      enabled: true,
      transport: 'stdio',
      storedTransport: 'stdio',
      command: 'echo',
      args: '',
      env: '',
      headers: '',
      cwd: '',
      url: '',
      storedHeaderNames: [],
      storedEnvNames: [],
    }, t)
    expect(typeof refused).toBe('string')
  })
})

describe('card view over a redacted wire', () => {
  test('the card receives env and header NAMES and never their values', () => {
    // The value the settings wire actually carries for both secret positions:
    // the walker strips each one and leaves the key set behind. A value is
    // planted here as well, so a projection that read values would fail.
    const face = cardFace({
      servers: [
        {
          id: 'github',
          serverName: 'mcp-github',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: { GITHUB_TOKEN: 'ghp-env-super-secret-value' },
          cwd: '',
          url: '',
          headers: {},
          toolCallTimeoutMs: 60_000,
          maxInstructionBytes: 0,
        },
        {
          id: 'doccontext',
          serverName: 'mcp-doccontext',
          enabled: true,
          transport: 'streamable-http',
          command: '',
          args: [],
          env: {},
          cwd: '',
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7-sk-super-secret-value' },
          toolCallTimeoutMs: 60_000,
          maxInstructionBytes: 0,
        },
      ],
    })

    const snapshot = face.read()
    expect(snapshot.served).toBe(true)
    expect(snapshot.revision).toBe(7)
    expect(snapshot.servers[0]?.['envNames']).toEqual(['GITHUB_TOKEN'])
    expect(snapshot.servers[1]?.['headerNames']).toEqual(['CONTEXT7_API_KEY'])
    // The card is handed names only: nothing it renders can carry a credential.
    expect(JSON.stringify(snapshot)).not.toContain('ghp-env-super-secret-value')
    expect(JSON.stringify(snapshot)).not.toContain('ctx7-sk-super-secret-value')
  })
})
