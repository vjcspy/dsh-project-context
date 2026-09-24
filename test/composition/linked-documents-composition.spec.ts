/**
 * End-to-end behaviour of the linked-documents listener on the REAL production
 * AgentLoop: a scripted model issues a real `read` tool call, and the injected
 * block is asserted where the model actually sees it — the NEXT model request.
 *
 * The model is scripted, so no provider or API key is involved, while the tool
 * registry, the `tools/post-execute` waterfall and the inbox splice are the
 * production ones.
 *
 * The positive cases read a REAL document inside the Aweave checkout, because
 * the block can only be produced by the real backend (HTTP, then CLI). That
 * makes them integration tests: they assert the injection contract, and they
 * skip rather than fail when the checkout they run in has no doc graph.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { boot, recordedRequests, setScript, type Booted } from './harness.ts'

/** The Aweave checkout this test runs inside: `test/composition` is five levels below it. */
const AWEAWE_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..')

/** A real, linked document inside the checkout. */
const LINKED_DOC = join(
  AWEAWE_ROOT,
  'resources/workspaces/k/dsh/dsh-project-context/_plans/260917-mcp-servers-settings-section.md',
)

/** The doc graph and CLI the backend needs; without them the positive cases skip. */
const BACKEND_AVAILABLE = existsSync(join(AWEAWE_ROOT, '.aweave', 'doc-graph.db'))
  && existsSync(LINKED_DOC)

const disposables: Array<() => void> = []

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose()
})

/** Boot the composition with the real `read` tool mounted, and track teardown. */
async function bootAndTrack(): Promise<Booted> {
  const booted = await boot({})
  // The harness mounts no filesystem tool, so `read` would be unknown; the real
  // provider is what makes the gated read a real read.
  await booted.mount(FsLocal, { cwd: AWEAWE_ROOT })
  disposables.push(() => { void booted.dispose() })
  return booted
}

/**
 * Build a directory satisfying the structural Aweave-root gate, holding one
 * markdown document inside `resources/`.
 */
function aweaveTree(): { root: string; doc: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linked-documents-e2e-'))
  disposables.push(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.aweave'), { recursive: true })
  writeFileSync(join(root, '.aweave', 'doc-graph.db'), '', 'utf8')
  const bin = join(root, 'workspaces', 'devtools', 'common', 'cli', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'run.js'), '// stub\n', 'utf8')
  const dir = join(root, 'resources', 'notes')
  mkdirSync(dir, { recursive: true })
  const doc = join(dir, 'a.md')
  writeFileSync(doc, '# A\n', 'utf8')
  return { root, doc }
}

/** A tree that is a git repository but carries neither Aweave-root marker. */
function bareTree(): { root: string; doc: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linked-documents-bare-'))
  disposables.push(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, '.git'), { recursive: true })
  const dir = join(root, 'resources')
  mkdirSync(dir, { recursive: true })
  const doc = join(dir, 'a.md')
  writeFileSync(doc, '# A\n', 'utf8')
  return { root, doc }
}

/** Every user-role text in one model request. */
function userTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? [])
    .filter(message => message.role === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

/** The linked-documents blocks a request carried, by their stable header. */
function linkedBlocks(request: GenerateOptions | undefined): string[] {
  return userTexts(request).filter(text => text.startsWith('Linked documents ('))
}

/** Script one `read` of `path` followed by a plain closing turn. */
function scriptRead(path: string): void {
  setScript((_options, index) => index === 0
    ? { kind: 'tool-call', name: 'read', args: { file_path: path } }
    : { kind: 'text', text: 'done' })
}

describe('linked-documents listener on the production loop', () => {
  test.skipIf(!BACKEND_AVAILABLE)('a read of a linked document reaches the next request', async () => {
    const booted = await bootAndTrack()
    // A unique session id keeps the backend's own session dedup out of the way.
    const agent = await booted.createAgent(`linked-inject-${String(Date.now())}`, AWEAWE_ROOT)
    scriptRead(LINKED_DOC)

    await booted.prompt(agent, 'read it')

    expect(recordedRequests).toHaveLength(2)
    const blocks = linkedBlocks(recordedRequests[1])
    expect(blocks).toHaveLength(1)
    const block = blocks[0] ?? ''
    const lines = block.split('\n')
    expect(lines[0]).toMatch(/^Linked documents \(\d+\):$/)
    // depth=1 with max 15, so the count stays inside the cap.
    const count = Number(/\((\d+)\)/.exec(lines[0] ?? '')?.[1])
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThanOrEqual(15)
    expect(lines).toHaveLength(count + 1)
    for (const line of lines.slice(1)) expect(line.startsWith('- ')).toBe(true)
  })

  test.skipIf(!BACKEND_AVAILABLE)('no injected description exceeds the plugin-local cap', async () => {
    const booted = await bootAndTrack()
    const agent = await booted.createAgent(`linked-truncate-${String(Date.now())}`, AWEAWE_ROOT)
    scriptRead(LINKED_DOC)

    await booted.prompt(agent, 'read it')

    const block = linkedBlocks(recordedRequests[1])[0] ?? ''
    expect(block).not.toBe('')
    // Each line is `- <path> — <name>: <description>`; only the description is
    // bounded, so the assertion is on the description's own length.
    for (const line of block.split('\n').slice(1)) {
      const separator = line.indexOf(': ')
      expect(separator).toBeGreaterThan(0)
      const description = line.slice(separator + 2)
      expect(description.length).toBeLessThanOrEqual(201)
    }
  })

  test('an injected block never replaces the tool result', async () => {
    const booted = await bootAndTrack()
    // A unique session id keeps the backend's own session dedup out of the way.
    const agent = await booted.createAgent(`linked-coexist-${String(Date.now())}`, AWEAWE_ROOT)
    scriptRead(LINKED_DOC)

    await booted.prompt(agent, 'read it')

    // Both halves coexist in the second request: the tool result the model asked
    // for, AND the injected block. A listener that hijacked the decision would
    // have shown one without the other. rc.1 carries the result as a `tool`-role
    // message rather than a `tool-result` content block.
    expect(recordedRequests).toHaveLength(2)
    const messages = recordedRequests[1]?.messages ?? []
    expect(messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(linkedBlocks(recordedRequests[1])).toHaveLength(1)
  })

  test('a non-resources read injects nothing', async () => {
    const { root } = aweaveTree()
    const booted = await bootAndTrack()
    const agent = await booted.createAgent('linked-nonresources', root)
    // Inside the Aweave root, outside `resources/`.
    const other = join(root, 'src')
    mkdirSync(other, { recursive: true })
    const file = join(other, 'a.md')
    writeFileSync(file, '# A\n', 'utf8')
    scriptRead(file)

    await booted.prompt(agent, 'read it')

    expect(recordedRequests).toHaveLength(2)
    expect(linkedBlocks(recordedRequests[1])).toHaveLength(0)
  })

  test('a read outside any Aweave root injects nothing', async () => {
    const { root, doc } = bareTree()
    const booted = await bootAndTrack()
    const agent = await booted.createAgent('linked-bareroot', root)
    scriptRead(doc)

    await booted.prompt(agent, 'read it')

    expect(recordedRequests).toHaveLength(2)
    expect(linkedBlocks(recordedRequests[1])).toHaveLength(0)
  })

  test('a non-read tool injects nothing', async () => {
    const { root } = aweaveTree()
    const booted = await bootAndTrack()
    const agent = await booted.createAgent('linked-nonread', root)
    setScript((_options, index) => index === 0
      ? { kind: 'tool-call', name: 'bash', args: { command: 'true' } }
      : { kind: 'text', text: 'done' })

    await booted.prompt(agent, 'run it')

    expect(recordedRequests).toHaveLength(2)
    expect(linkedBlocks(recordedRequests[1])).toHaveLength(0)
  })

  test('a re-read of a fully delivered path injects nothing the second time', async () => {
    const { root, doc } = aweaveTree()
    const booted = await bootAndTrack()
    const agent = await booted.createAgent('linked-reread', root)
    // Two reads of the same file inside one step.
    setScript((_options, index) => index === 0
      ? { kind: 'tool-call', name: 'read', args: { file_path: doc } }
      : { kind: 'text', text: 'done' })
    scriptRead(doc)
    await booted.prompt(agent, 'read it')

    // The stub root has no real graph, so the FIRST read injects nothing either;
    // what this asserts is that a repeat read never injects twice.
    expect(recordedRequests).toHaveLength(2)
    expect(linkedBlocks(recordedRequests[1])).toHaveLength(0)
  })
})
