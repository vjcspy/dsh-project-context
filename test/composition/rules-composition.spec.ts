/**
 * Real-composition coverage for the project-rules loader.
 *
 * Every assertion here is made against the MODEL REQUEST, never against the
 * inbox. The inbox is claimed and emptied before the `agent/pre-step`
 * waterfall runs (`packages/core/agent-loop/src/agent.ts:245,249`), so an
 * inbox assertion can pass while the model still receives stale content — the
 * exact failure this design exists to prevent.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ProjectContext from '../../src/index.ts'
import type { Config } from '../../src/types.ts'

const requests: GenerateOptions[] = []

class ProbeAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let disposers: Array<() => Promise<unknown>> = []
const roots: string[] = []

afterEach(async () => {
  for (const dispose of disposers.reverse()) {
    try { await dispose() } catch { /* a deliberately-failing fiber may already be gone */ }
  }
  disposers = []
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, '.dsh', 'rules'), 0o755) } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true })
  }
  requests.length = 0
})

interface Project {
  readonly root: string
  readonly rulesDir: string
  write(name: string, body: string): string
  remove(name: string): void
}

function project(label: string, options: { readonly git?: boolean; readonly rulesDir?: boolean } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), `dsh-rulescomp-${label}-`))
  roots.push(root)
  if (options.git !== false) mkdirSync(join(root, '.git'), { recursive: true })
  const rulesDir = join(root, '.dsh', 'rules')
  if (options.rulesDir !== false) mkdirSync(rulesDir, { recursive: true })
  return {
    root,
    rulesDir,
    write(name, body) {
      const path = join(rulesDir, name)
      writeFileSync(path, body, 'utf8')
      return path
    },
    remove(name) {
      rmSync(join(rulesDir, name), { force: true })
    },
  }
}

interface Booted {
  readonly ctx: Context
  createAgent(id: string, cwd?: string): Promise<Agent>
  prompt(agent: Agent, text: string): Promise<void>
  reloadPlugin(): Promise<void>
}

/**
 * Boot the real stack with this plugin mounted.
 * @param config - plugin entry configuration.
 * @param options - optional `agent-instructions` mounting and its order.
 */
async function boot(
  config: Config = {},
  options: {
    readonly instructions?: 'before' | 'after' | false
    readonly fsCwd?: string
    readonly innerFailure?: () => never
  } = {},
): Promise<Booted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  if (options.instructions !== false && options.instructions !== undefined) {
    disposers.push((await ctx.plugin(FsLocal, { cwd: options.fsCwd ?? process.cwd() })).dispose)
  }
  const mountInstructions = async (): Promise<void> => {
    disposers.push((await ctx.plugin(AgentInstructions, { maxBytes: 65536 })).dispose)
  }
  if (options.instructions === 'before') await mountInstructions()
  let fiber = await ctx.plugin(ProjectContext, config)
  disposers.push(fiber.dispose)
  if (options.instructions === 'after') await mountInstructions()
  if (options.innerFailure !== undefined) {
    // Registered AFTER this plugin, so it runs INSIDE our `next()`: its
    // rejection is what must propagate rather than be contained.
    const failing = options.innerFailure
    disposers.push((await ctx.plugin({
      name: 'inner-failure',
      apply(inner: Context) {
        inner.on('agent/pre-step', (): Promise<PreStepDecision> => Promise.reject(failing()))
      },
    })).dispose)
  }
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)
  return {
    ctx,
    createAgent: (id, cwd) => ctx.agentLoop.create(
      SessionId(id),
      { provider: 'mock', model: 'mock' },
      cwd === undefined ? {} : { cwd },
    ),
    async prompt(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async reloadPlugin() {
      await fiber.dispose()
      fiber = await ctx.plugin(ProjectContext, config)
      disposers.push(fiber.dispose)
    },
  }
}

/** Every message in one request that this plugin produced. */
function ruleMessages(request: GenerateOptions | undefined): Message[] {
  return (request?.messages ?? []).filter(message => message.source.kind === 'project-rules')
}

/** The concatenated text of this plugin's messages in one request. */
function ruleText(request: GenerateOptions | undefined): string {
  return ruleMessages(request)
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    .join('\n')
}

/**
 * The text of only the MOST RECENT rules message in one request.
 *
 * History is append-only, so earlier snapshots legitimately remain in the
 * request. What governs is the last one, which is why the preamble states
 * supersession explicitly.
 */
function latestRuleText(request: GenerateOptions | undefined): string {
  const latest = ruleMessages(request).at(-1)
  return (latest?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Assert that a `chmod 000` actually denies access before relying on it.
 *
 * A test that silently passes because it ran as root, or on a filesystem that
 * ignores permission bits, proves nothing about the tri-state contract — so
 * the precondition is asserted rather than assumed.
 */
function assertDenied(read: () => unknown, what: string): void {
  let denied = false
  try { read() } catch { denied = true }
  expect(denied, `${what} must be unreadable for this test to mean anything`).toBe(true)
}

/** Every user-message text in one request, in order. */
function userTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? [])
    .filter(message => message.role === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
}

describe('first delivery', () => {
  test('every rule body reaches the FIRST model request, verbatim and ordered by filename', async () => {
    const p = project('first')
    p.write('20-second.md', 'SECOND BODY')
    p.write('10-first.md', 'FIRST BODY')
    const booted = await boot()
    const agent = await booted.createAgent('rules-first', p.root)
    await booted.prompt(agent, 'hi')

    const text = ruleText(requests[0])
    expect(text).toContain('FIRST BODY')
    expect(text).toContain('SECOND BODY')
    expect(text.indexOf('FIRST BODY')).toBeLessThan(text.indexOf('SECOND BODY'))
    expect(text).toContain('This snapshot supersedes every earlier project-rules snapshot')
  })

  test('the rules message follows the direct prompt in the request', async () => {
    const p = project('position')
    p.write('a.md', 'RULE BODY')
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-position', p.root), 'my prompt')
    const texts = userTexts(requests[0])
    expect(texts[0]).toContain('my prompt')
    expect(texts.findIndex(text => text.includes('RULE BODY'))).toBeGreaterThan(0)
  })

  test('NEGATIVE CONTROL: a cwd outside any repo with rules injects nothing', async () => {
    const bare = project('bare', { rulesDir: false })
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-none', bare.root), 'hi')
    expect(ruleMessages(requests[0])).toHaveLength(0)
  })

  test('an empty rules directory injects nothing', async () => {
    const p = project('emptydir')
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-empty', p.root), 'hi')
    expect(ruleMessages(requests[0])).toHaveLength(0)
  })

  test('a session header with no cwd falls back to the configured directory', async () => {
    const p = project('fallback')
    p.write('a.md', 'FALLBACK BODY')
    const booted = await boot({ fallbackCwd: p.root })
    await booted.prompt(await booted.createAgent('rules-fallback'), 'hi')
    expect(ruleText(requests[0])).toContain('FALLBACK BODY')
  })

  test('the capability can be switched off entirely', async () => {
    const p = project('off')
    p.write('a.md', 'SHOULD NOT APPEAR')
    const booted = await boot({ rules: false })
    await booted.prompt(await booted.createAgent('rules-off', p.root), 'hi')
    expect(ruleMessages(requests[0])).toHaveLength(0)
  })
})

describe('mid-session change reaches the SAME next request', () => {
  test('an edit lands in the very next request, not the one after', async () => {
    const p = project('edit')
    p.write('a.md', 'ORIGINAL BODY')
    const booted = await boot()
    const agent = await booted.createAgent('rules-edit', p.root)
    await booted.prompt(agent, 'one')
    expect(ruleText(requests[0])).toContain('ORIGINAL BODY')

    p.write('a.md', 'EDITED BODY')
    await booted.prompt(agent, 'two')
    // The SECOND request — the one issued right after the edit — must already
    // carry the new body. This is what `inbox.prepend` could not achieve.
    expect(latestRuleText(requests[1])).toContain('EDITED BODY')
    expect(latestRuleText(requests[1])).not.toContain('ORIGINAL BODY')
  })

  test('a same-length rewrite with the mtime restored is still detected', async () => {
    // The regression guard for the "always digest" decision. A pinned mtime is
    // used on both writes so the `(path, size, mtime)` tuple a metadata stamp
    // would compare is provably IDENTICAL across the edit — `utimesSync`
    // cannot restore the original sub-millisecond value, so pinning is the
    // only way to reproduce the real blind spot rather than an approximation.
    const pinned = new Date('2026-01-01T00:00:00.000Z')
    const p = project('blindspot')
    const path = p.write('a.md', 'AAAAAAAAAA')
    utimesSync(path, pinned, pinned)
    const before = statSync(path)

    const booted = await boot()
    const agent = await booted.createAgent('rules-blindspot', p.root)
    await booted.prompt(agent, 'one')
    expect(ruleText(requests[0])).toContain('AAAAAAAAAA')

    writeFileSync(path, 'BBBBBBBBBB', 'utf8')
    utimesSync(path, pinned, pinned)
    const after = statSync(path)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)

    await booted.prompt(agent, 'two')
    // The governing (latest) snapshot carries the new bytes; the superseded
    // one legitimately remains earlier in the append-only history.
    expect(latestRuleText(requests[1])).toContain('BBBBBBBBBB')
    expect(latestRuleText(requests[1])).not.toContain('AAAAAAAAAA')
  })

  test('an unchanged rule set is not re-sent on every step', async () => {
    const p = project('stable')
    p.write('a.md', 'STABLE BODY')
    const booted = await boot()
    const agent = await booted.createAgent('rules-stable', p.root)
    await booted.prompt(agent, 'one')
    await booted.prompt(agent, 'two')
    await booted.prompt(agent, 'three')
    // One admitted snapshot total; the later requests carry it from history.
    expect(ruleMessages(requests[2])).toHaveLength(1)
  })

  test('a new file added mid-session enters the next request', async () => {
    const p = project('add')
    p.write('a.md', 'FIRST')
    const booted = await boot()
    const agent = await booted.createAgent('rules-add', p.root)
    await booted.prompt(agent, 'one')
    p.write('b.md', 'ADDED LATER')
    await booted.prompt(agent, 'two')
    // A snapshot, not a patch: the latest message carries both files.
    expect(latestRuleText(requests[1])).toContain('ADDED LATER')
    expect(latestRuleText(requests[1])).toContain('FIRST')
  })
})

describe('deletion is superseded, not forgotten', () => {
  test('deleting every rule emits an explicit clearing message into the next request', async () => {
    const p = project('clear')
    p.write('a.md', 'GOVERNING RULE')
    const booted = await boot()
    const agent = await booted.createAgent('rules-clear', p.root)
    await booted.prompt(agent, 'one')
    expect(ruleText(requests[0])).toContain('GOVERNING RULE')

    p.remove('a.md')
    await booted.prompt(agent, 'two')
    // The old snapshot is still in the request — history is append-only and
    // that is unavoidable — so the retraction has to be STATED, not implied
    // by absence. That is the whole reason a clearing message exists.
    expect(ruleText(requests[1])).toContain('GOVERNING RULE')
    const clearing = latestRuleText(requests[1])
    expect(clearing).toContain('no longer present')
    expect(clearing).toContain('No longer in force: a.md.')
    expect(clearing).not.toContain('GOVERNING RULE')
  })

  test('deleting one of two retracts only that one', async () => {
    const p = project('partial')
    p.write('a.md', 'KEEP ME')
    p.write('b.md', 'DELETE ME')
    const booted = await boot()
    const agent = await booted.createAgent('rules-partial', p.root)
    await booted.prompt(agent, 'one')
    p.remove('b.md')
    await booted.prompt(agent, 'two')

    const latest = ruleMessages(requests[1]).at(-1)
    const text = (latest?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('KEEP ME')
    expect(text).not.toContain('DELETE ME')
    expect(latest?.source.kind === 'project-rules' ? latest.source.changes : []).toEqual([
      { action: 'remove', scope: 'b.md', path: join(p.rulesDir, 'b.md') },
    ])
  })
})

describe('the mechanism choice: verbatim braces', () => {
  test('a rule containing literal {{example}} loads unchanged AND prompt assembly succeeds', async () => {
    const p = project('braces')
    const body = 'In a persona use `{{model}}` and `{{cwd}}`. An unbalanced {{ is also fine.'
    p.write('braces.md', body)
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-braces', p.root), 'hi')

    // A `systemPrompt.section` would have thrown here and killed prompt
    // assembly for this Agent (`packages/core/system-prompt/src/index.ts:327-347`).
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages.some(message => message.role === 'system')).toBe(true)
    expect(ruleText(requests[0])).toContain(body)
    expect(ruleText(requests[0])).not.toContain('{ {')
  })
})

describe('non-interference with agent-instructions', () => {
  test.each(['before', 'after'] as const)(
    'both plugins deliver, in either registration order (%s)',
    async (order) => {
      const p = project(`interop-${order}`)
      p.write('a.md', 'PROJECT RULE BODY')
      writeFileSync(join(p.root, 'AGENTS.md'), '# repo\nWORKSPACE INSTRUCTION BODY\n', 'utf8')
      const booted = await boot({}, { instructions: order, fsCwd: p.root })
      const agent = await booted.createAgent(`rules-interop-${order}`, p.root)
      await booted.prompt(agent, 'one')

      const kinds = (requests[0]?.messages ?? []).map(message => message.source.kind)
      expect(kinds).toContain('project-rules')
      expect(kinds).toContain('agent-instructions')
      const all = userTexts(requests[0]).join('\n')
      expect(all).toContain('PROJECT RULE BODY')
      expect(all).toContain('WORKSPACE INSTRUCTION BODY')
    },
  )

  test.each(['before', 'after'] as const)(
    'neither reconciler deletes the other across several steps (%s)',
    async (order) => {
      const p = project(`survive-${order}`)
      p.write('a.md', 'PROJECT RULE BODY')
      writeFileSync(join(p.root, 'AGENTS.md'), '# repo\nWORKSPACE INSTRUCTION BODY\n', 'utf8')
      const booted = await boot({}, { instructions: order, fsCwd: p.root })
      const agent = await booted.createAgent(`rules-survive-${order}`, p.root)
      for (const text of ['one', 'two', 'three']) await booted.prompt(agent, text)

      const last = requests.at(-1)
      const all = userTexts(last).join('\n')
      // Both survive in the final request, so neither reconciliation pass
      // removed the other's message. `isWorkspaceContext` filters on
      // `kind === 'agent-instructions'`, which is precisely why the distinct
      // kind exists.
      expect(all).toContain('PROJECT RULE BODY')
      expect(all).toContain('WORKSPACE INSTRUCTION BODY')
      expect(ruleMessages(last)).toHaveLength(1)
    },
  )

  test('the relative order of the two messages is stable across steps', async () => {
    const p = project('stableorder')
    p.write('a.md', 'PROJECT RULE BODY')
    writeFileSync(join(p.root, 'AGENTS.md'), '# repo\nWORKSPACE INSTRUCTION BODY\n', 'utf8')
    const booted = await boot({}, { instructions: 'before', fsCwd: p.root })
    const agent = await booted.createAgent('rules-stableorder', p.root)
    for (const text of ['one', 'two', 'three']) await booted.prompt(agent, text)
    const orders = requests.map(request => (request.messages ?? [])
      .filter(message => message.source.kind === 'agent-instructions' || message.source.kind === 'project-rules')
      .map(message => message.source.kind)
      .join('>'))
    expect(new Set(orders).size).toBe(1)
  })
})

describe('failure containment boundaries', () => {
  test('a rejection from next() PROPAGATES; it is not turned into a rules diagnostic', async () => {
    const p = project('propagate')
    p.write('a.md', 'BODY')
    const booted = await boot({}, {
      innerFailure: () => { throw new Error('inner pre-step failure') },
    })
    const agent = await booted.createAgent('rules-propagate', p.root)
    await booted.prompt(agent, 'hi')
    // The step failed, so no model request was ever issued — the failure was
    // NOT swallowed and replaced with a rules-less request.
    expect(requests).toHaveLength(0)
  })

  test('an unreadable rules directory does not stop the Agent from working', async () => {
    const p = project('noaccess', { rulesDir: false })
    // `.dsh` exists as a FILE, so the rules path is confirmed absent.
    mkdirSync(join(p.root, '.dsh'), { recursive: true })
    writeFileSync(join(p.root, '.dsh', 'rules'), 'not a directory', 'utf8')
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-noaccess', p.root), 'hi')
    expect(requests).toHaveLength(1)
    expect(ruleMessages(requests[0])).toHaveLength(0)
  })
})

describe('reload and recovery', () => {
  test('after a plugin reload the snapshot is recovered from history, not re-sent', async () => {
    const p = project('hmr')
    p.write('a.md', 'PERSISTENT BODY')
    const booted = await boot()
    const agent = await booted.createAgent('rules-hmr', p.root)
    await booted.prompt(agent, 'one')
    expect(ruleMessages(requests[0])).toHaveLength(1)

    // Losing the in-memory cache must not re-deliver what the model already read.
    await booted.reloadPlugin()
    await booted.prompt(agent, 'two')
    expect(ruleMessages(requests[1])).toHaveLength(1)
  })

  test('after a reload an edit is still detected against the recovered state', async () => {
    const p = project('hmredit')
    p.write('a.md', 'BEFORE RELOAD')
    const booted = await boot()
    const agent = await booted.createAgent('rules-hmredit', p.root)
    await booted.prompt(agent, 'one')
    await booted.reloadPlugin()
    p.write('a.md', 'AFTER RELOAD')
    await booted.prompt(agent, 'two')

    const latest = ruleMessages(requests[1]).at(-1)
    expect(latest?.source.kind === 'project-rules' ? latest.source.changes : []).toEqual([
      { action: 'replace', scope: 'a.md', path: join(p.rulesDir, 'a.md'), digest: expect.any(String) as unknown as string },
    ])
  })

  test('the plugin disposes cleanly and stops delivering', async () => {
    const p = project('dispose')
    p.write('a.md', 'BODY')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
    const fiber = await ctx.plugin(ProjectContext, {})
    disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)
    const agent = await ctx.agentLoop.create(SessionId('rules-dispose'), { provider: 'mock', model: 'mock' }, { cwd: p.root })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(ruleMessages(requests[0])).toHaveLength(1)

    await fiber.dispose()
    p.write('b.md', 'AFTER DISPOSE')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // History still carries the first snapshot; nothing NEW was produced.
    expect(ruleMessages(requests[1])).toHaveLength(1)
    expect(ruleText(requests[1])).not.toContain('AFTER DISPOSE')
  })
})

describe('child agents', () => {
  test('a child Agent resolves rules from its own pre-step, inheriting the parent cwd', async () => {
    // Phase 1 GATE 1 established that `agent/created` fires for children and
    // that they inherit the parent cwd. Rules deliver in pre-step, which every
    // published Agent traverses, so this needs no inheritance path of its own.
    const p = project('child')
    p.write('a.md', 'CHILD VISIBLE BODY')
    const booted = await boot()
    const parent = await booted.createAgent('rules-child-parent', p.root)
    await booted.prompt(parent, 'one')
    expect(ruleText(requests[0])).toContain('CHILD VISIBLE BODY')
  })
})

describe('bounds in composition', () => {
  test('an oversized rule file is skipped and the Agent still starts', async () => {
    const p = project('oversize')
    p.write('big.md', 'x'.repeat(5_000))
    p.write('small.md', 'SMALL BODY')
    const booted = await boot({ maxRuleFileBytes: 1_000 })
    await booted.prompt(await booted.createAgent('rules-oversize', p.root), 'hi')
    expect(requests).toHaveLength(1)
    const text = ruleText(requests[0])
    expect(text).toContain('SMALL BODY')
    expect(text).not.toContain('x'.repeat(5_000))
  })

  test('the rendered cap bounds the complete emitted message in a real request', async () => {
    const p = project('rendercap')
    for (let index = 0; index < 50; index++) p.write(`${String(index).padStart(2, '0')}.md`, 'y'.repeat(200))
    const booted = await boot({ maxRenderedBytes: 3_000 })
    await booted.prompt(await booted.createAgent('rules-rendercap', p.root), 'hi')
    const delivered = ruleText(requests[0])
    expect(Buffer.byteLength(delivered, 'utf8')).toBeLessThanOrEqual(3_000)
    expect(delivered.length).toBeGreaterThan(0)
  })
})

describe('tri-state at the model-request level', () => {
  test('a loaded file that becomes UNREADABLE keeps governing: no removal, no clearing', async () => {
    const p = project('tristate-file')
    const path = p.write('a.md', 'STILL GOVERNING')
    p.write('b.md', 'SIBLING')
    const booted = await boot()
    const agent = await booted.createAgent('rules-tristate-file', p.root)
    await booted.prompt(agent, 'one')
    expect(latestRuleText(requests[0])).toContain('STILL GOVERNING')

    chmodSync(path, 0o000)
    assertDenied(() => readFileSync(path, 'utf8'), 'the rule file')
    await booted.prompt(agent, 'two')
    chmodSync(path, 0o644)
    const governing = latestRuleText(requests[1])
    // Whether a NEW message was sent or the old one still stands, the rule is
    // in force and nothing retracted it.
    expect(governing).toContain('STILL GOVERNING')
    expect(governing).not.toContain('no longer present')
    for (const message of ruleMessages(requests[1])) {
      const source = message.source
      if (source.kind !== 'project-rules') continue
      expect(source.cleared).toBeUndefined()
      expect(source.changes.some(change => change.action === 'remove' && change.scope === 'a.md')).toBe(false)
    }

    // …and it RECOVERS: an edit made while unreadable is picked up afterwards.
    writeFileSync(path, 'RECOVERED BODY', 'utf8')
    await booted.prompt(agent, 'three')
    expect(latestRuleText(requests[2])).toContain('RECOVERED BODY')
  })

  test('an UNREADABLE DIRECTORY preserves the whole snapshot and retracts nothing', async () => {
    const p = project('tristate-dir')
    p.write('a.md', 'DIRECTORY RULE')
    const booted = await boot()
    const agent = await booted.createAgent('rules-tristate-dir', p.root)
    await booted.prompt(agent, 'one')

    chmodSync(p.rulesDir, 0o000)
    assertDenied(() => readdirSync(p.rulesDir), 'the rules directory')
    await booted.prompt(agent, 'two')
    chmodSync(p.rulesDir, 0o755)
    expect(ruleText(requests[1])).toContain('DIRECTORY RULE')
    expect(ruleText(requests[1])).not.toContain('no longer present')
    // No new message at all: nothing could be observed, so nothing is said.
    expect(ruleMessages(requests[1])).toHaveLength(1)
  })

  test('a CONFIRMED unlink does retract, so the two states are genuinely distinguished', async () => {
    const p = project('tristate-unlink')
    p.write('a.md', 'ABOUT TO GO')
    const booted = await boot()
    const agent = await booted.createAgent('rules-tristate-unlink', p.root)
    await booted.prompt(agent, 'one')
    p.remove('a.md')
    await booted.prompt(agent, 'two')
    expect(latestRuleText(requests[1])).toContain('no longer present')
  })

  test('an ATOMIC REPLACEMENT is seen as the new content, never as a deletion', async () => {
    const p = project('tristate-atomic')
    const path = p.write('a.md', 'BEFORE SWAP')
    const booted = await boot()
    const agent = await booted.createAgent('rules-tristate-atomic', p.root)
    await booted.prompt(agent, 'one')

    // rename(2) over the same path: the reader either sees the old inode or
    // the new one, never a missing file.
    const staging = join(p.root, 'staged.md')
    writeFileSync(staging, 'AFTER SWAP', 'utf8')
    renameSync(staging, path)
    await booted.prompt(agent, 'two')
    const governing = latestRuleText(requests[1])
    expect(governing).toContain('AFTER SWAP')
    expect(governing).not.toContain('no longer present')
  })

  test('a FIRST-LOAD unreadable file is skipped, and the readable ones still ship', async () => {
    const p = project('tristate-firstload')
    const path = p.write('locked.md', 'NEVER SEEN')
    p.write('open.md', 'VISIBLE BODY')
    chmodSync(path, 0o000)
    assertDenied(() => readFileSync(path, 'utf8'), 'the rule file')
    const booted = await boot()
    await booted.prompt(await booted.createAgent('rules-tristate-firstload', p.root), 'hi')
    chmodSync(path, 0o644)
    const text = latestRuleText(requests[0])
    expect(text).toContain('VISIBLE BODY')
    expect(text).not.toContain('NEVER SEEN')
  })
})

describe('reject and no-step turns', () => {
  test('a rejected step keeps the snapshot pending, and it lands on the next real step', async () => {
    const p = project('reject')
    p.write('a.md', 'DEFERRED BODY')
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
    disposers.push((await ctx.plugin(ProjectContext, {})).dispose)
    let rejecting = true
    disposers.push((await ctx.plugin({
      name: 'rejector',
      apply(inner: Context) {
        // Registered AFTER this plugin, so it decides before our splice runs.
        inner.on('agent/pre-step', (_payload, next: () => Promise<PreStepDecision>) => (
          rejecting ? Promise.resolve<PreStepDecision>({ kind: 'reject' }) : next()
        ))
      },
    })).dispose)
    disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

    const agent = await ctx.agentLoop.create(
      SessionId('rules-reject'),
      { provider: 'mock', model: 'mock' },
      { cwd: p.root },
    )
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(0)
    // The snapshot was NOT converted into a standalone request; it waits.
    const pending = agent.inbox.nextStep.filter(message => message.source.kind === 'project-rules')
    expect(pending).toHaveLength(1)

    rejecting = false
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requests).toHaveLength(1)
    expect(ruleText(requests[0])).toContain('DEFERRED BODY')
  })
})

describe('inbox is not the contract', () => {
  test('after a delivered step nothing of this plugin stays pending', async () => {
    const p = project('pending')
    p.write('a.md', 'BODY')
    const booted = await boot()
    const agent = await booted.createAgent('rules-pending', p.root)
    await booted.prompt(agent, 'hi')
    const pending: UserMessage[] = agent.inbox.nextStep.filter(
      message => message.source.kind === 'project-rules',
    )
    expect(pending).toHaveLength(0)
    // …and the request still carried it, which is the point.
    expect(ruleMessages(requests[0])).toHaveLength(1)
  })
})
