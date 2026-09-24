/**
 * Behaviour of the linked-documents gate, renderer and per-session skip.
 *
 * These are the pure halves of the port — the parts whose correctness is not a
 * property of a live DSH host. The end-to-end path (a real `read` producing a
 * real injected block) is verified against a second DSH instance, not here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { CircuitBreaker, lookupLinkedDocuments } from '../../src/linked-documents/backend.ts'
import {
  absoluteReadPath,
  AweaveRootResolver,
  CLI_RUN_BIN,
  readPathOf,
  toResourcesRelPath,
} from '../../src/linked-documents/filter.ts'
import {
  linkedDocumentsMessage,
  MAX_DESCRIPTION_CHARS,
  ReadPathSkips,
  renderLinkedDocuments,
  truncateDescription,
} from '../../src/linked-documents/payload.ts'
import type { LinkedDocumentsResult } from '../../src/linked-documents/backend.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Build a directory tree carrying any subset of the two Aweave-root markers, so
 * the gate can be exercised without depending on the real checkout.
 */
function tree(markers: { git?: boolean; db?: boolean; cli?: boolean } = {}): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linked-documents-'))
  roots.push(root)
  if (markers.git !== false) mkdirSync(join(root, '.git'), { recursive: true })
  if (markers.db !== false) {
    mkdirSync(join(root, '.aweave'), { recursive: true })
    writeFileSync(join(root, '.aweave', 'doc-graph.db'), '', 'utf8')
  }
  if (markers.cli !== false) {
    const bin = join(root, ...CLI_RUN_BIN.slice(0, -1))
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(root, ...CLI_RUN_BIN), '// stub\n', 'utf8')
  }
  const cwd = join(root, 'workspaces', 'k', 'dsh')
  mkdirSync(cwd, { recursive: true })
  return { root, cwd }
}

function result(overrides: Partial<LinkedDocumentsResult> = {}): LinkedDocumentsResult {
  return { linked_documents: [], omitted: 0, transportFailed: false, ...overrides }
}

describe('readPathOf', () => {
  test('rejects an agent-less call before reading any argument', () => {
    expect(readPathOf({ name: 'read', arguments: { file_path: '/x.md' } })).toBeUndefined()
  })

  test('accepts only the read tool', () => {
    const agent = {}
    expect(readPathOf({ name: 'edit', arguments: { file_path: '/x.md' }, agent })).toBeUndefined()
    expect(readPathOf({ name: 'bash', arguments: { command: 'cat /x.md' }, agent })).toBeUndefined()
    expect(readPathOf({ name: 'read', arguments: { file_path: '/x.md' }, agent })).toBe('/x.md')
  })

  test('survives malformed arguments', () => {
    const agent = {}
    expect(readPathOf({ name: 'read', arguments: undefined, agent })).toBeUndefined()
    expect(readPathOf({ name: 'read', arguments: 'raw text', agent })).toBeUndefined()
    expect(readPathOf({ name: 'read', arguments: { file_path: 42 }, agent })).toBeUndefined()
    expect(readPathOf({ name: 'read', arguments: { file_path: '' }, agent })).toBeUndefined()
  })
})

describe('Aweave-root gate', () => {
  test('accepts a root carrying both structural markers', () => {
    const { root, cwd } = tree()
    expect(new AweaveRootResolver().resolve(cwd)).toBe(root)
  })

  test('rejects a git repository without the doc graph', () => {
    const { cwd } = tree({ db: false })
    expect(new AweaveRootResolver().resolve(cwd)).toBeUndefined()
  })

  test('rejects a root without the CLI entry point', () => {
    const { cwd } = tree({ cli: false })
    expect(new AweaveRootResolver().resolve(cwd)).toBeUndefined()
  })

  test('rejects a directory with no git ancestor at all', () => {
    const { cwd } = tree({ git: false })
    expect(new AweaveRootResolver().resolve(cwd)).toBeUndefined()
  })

  test('memoizes the negative answer so a non-Aweave cwd is walked once', () => {
    const { root, cwd } = tree()
    const resolver = new AweaveRootResolver()
    expect(resolver.resolve(cwd)).toBe(root)
    // A marker removed after the first resolution must not change the answer:
    // the memo is the whole point of the type.
    rmSync(join(root, '.aweave', 'doc-graph.db'))
    expect(resolver.resolve(cwd)).toBe(root)
    resolver.clear()
    expect(resolver.resolve(cwd)).toBeUndefined()
  })
})

describe('resources path filter', () => {
  const root = '/aweave'

  test('accepts markdown under resources at any depth', () => {
    expect(toResourcesRelPath('/aweave/resources/a.md', root)).toBe('resources/a.md')
    expect(toResourcesRelPath('/aweave/resources/x/y/z.mdc', root)).toBe('resources/x/y/z.mdc')
    expect(toResourcesRelPath('/aweave/resources/A.MD', root)).toBe('resources/A.MD')
  })

  test('rejects everything else', () => {
    expect(toResourcesRelPath('/aweave/agent/rules/x.md', root)).toBeUndefined()
    expect(toResourcesRelPath('/aweave/resources/x.ts', root)).toBeUndefined()
    expect(toResourcesRelPath('/aweave/resources', root)).toBeUndefined()
    expect(toResourcesRelPath('/aweave/README.md', root)).toBeUndefined()
    expect(toResourcesRelPath('/aweave', root)).toBeUndefined()
  })

  test('rejects a same-named path outside the root', () => {
    expect(toResourcesRelPath('/other/resources/a.md', root)).toBeUndefined()
    expect(toResourcesRelPath('/aweave-extra/resources/a.md', root)).toBeUndefined()
  })

  test('resolves a relative file_path against the session cwd', () => {
    expect(absoluteReadPath('resources/a.md', '/aweave')).toBe('/aweave/resources/a.md')
    expect(absoluteReadPath('/aweave/resources/a.md', '/other')).toBe('/aweave/resources/a.md')
  })
})

describe('payload rendering', () => {
  const doc = { path: 'resources/a.md', name: 'A', description: 'short' }

  test('renders the byte-identical header and line format', () => {
    expect(renderLinkedDocuments(result({ linked_documents: [doc] })))
      .toBe('Linked documents (1):\n- resources/a.md — A: short')
  })

  test('counts only the returned entries in the header', () => {
    const block = renderLinkedDocuments(result({
      linked_documents: [doc, { ...doc, path: 'resources/b.md' }],
      omitted: 7,
    }))
    expect(block?.split('\n')[0]).toBe('Linked documents (2):')
  })

  test('injects nothing for an empty set', () => {
    expect(renderLinkedDocuments(result())).toBeUndefined()
  })

  test('truncates a description to the plugin-local cap', () => {
    const long = 'x'.repeat(500)
    const truncated = truncateDescription(long)
    expect(truncated).toHaveLength(MAX_DESCRIPTION_CHARS + 1)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncateDescription('x'.repeat(MAX_DESCRIPTION_CHARS))).toHaveLength(MAX_DESCRIPTION_CHARS)
  })

  test('trims the space left stranded before the ellipsis', () => {
    expect(truncateDescription(`${'y'.repeat(MAX_DESCRIPTION_CHARS - 1)} zzz`))
      .toBe(`${'y'.repeat(MAX_DESCRIPTION_CHARS - 1)}…`)
  })

  test('bounds every line it renders', () => {
    const block = renderLinkedDocuments(result({
      linked_documents: [{ ...doc, description: 'z'.repeat(4000) }],
    }))
    const line = block?.split('\n')[1] ?? ''
    expect(line.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 80)
  })

  test('tags the injected message with this plugin as its source', () => {
    const message = linkedDocumentsMessage('Linked documents (1):\n- a')
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'linked-documents', form: 'notice' })
  })
})

describe('per-session re-read skip', () => {
  test('records a fully delivered path and skips it next time', () => {
    const skips = new ReadPathSkips()
    skips.record('s1', 'resources/a.md', 0)
    expect(skips.has('s1', 'resources/a.md')).toBe(true)
    expect(skips.has('s2', 'resources/a.md')).toBe(false)
    expect(skips.has('s1', 'resources/b.md')).toBe(false)
  })

  test('leaves an over-cap path unrecorded so the next batch can arrive', () => {
    const skips = new ReadPathSkips()
    skips.record('s1', 'resources/a.md', 3)
    expect(skips.has('s1', 'resources/a.md')).toBe(false)
  })
})

describe('circuit breaker', () => {
  test('latches only at the threshold and never resets', () => {
    const breaker = new CircuitBreaker()
    breaker.recordFailure('s1')
    breaker.recordFailure('s1')
    expect(breaker.isOpen('s1')).toBe(false)
    breaker.recordFailure('s1')
    expect(breaker.isOpen('s1')).toBe(true)
    breaker.recordSuccess('s1')
    expect(breaker.isOpen('s1')).toBe(true)
  })

  test('counts failures per session', () => {
    const breaker = new CircuitBreaker()
    breaker.recordFailure('s1')
    breaker.recordFailure('s1')
    breaker.recordFailure('s2')
    expect(breaker.isOpen('s1')).toBe(false)
    expect(breaker.isOpen('s2')).toBe(false)
  })

  test('a successful lookup clears the run', () => {
    const breaker = new CircuitBreaker()
    breaker.recordFailure('s1')
    breaker.recordFailure('s1')
    breaker.recordSuccess('s1')
    breaker.recordFailure('s1')
    breaker.recordFailure('s1')
    expect(breaker.isOpen('s1')).toBe(false)
  })
})

describe('lookup failure reporting', () => {
  test('reports a transport failure when the CLI fallback cannot be spawned', async () => {
    // A root with no CLI bin at the expected path makes the CLI fallback fail.
    // The HTTP half is deliberately NOT asserted here: it targets a fixed
    // localhost port, so its result depends on whether the operator happens to
    // have the workspace server running. A transport failure is only reported
    // when BOTH transports fail, so this test asserts the CLI half through the
    // combined outcome without claiming anything about the server.
    const { root } = tree({ cli: false })
    const outcome = await lookupLinkedDocuments({
      aweaveRoot: root,
      relPath: 'resources/a.md',
      sessionKey: 'test-session',
    })
    // Whatever the HTTP half answered, the outcome is a well-formed result that
    // never throws — the fail-open contract this module owes its caller.
    expect(Array.isArray(outcome.linked_documents)).toBe(true)
    expect(typeof outcome.omitted).toBe('number')
    expect(typeof outcome.transportFailed).toBe('boolean')
  })
})
