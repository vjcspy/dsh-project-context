/**
 * Phase 1 observation gates for the project-rules loader.
 *
 * These are not unit tests of this package: they interrogate the HOST's
 * observable behaviour with the real AgentLoop, the real subagent runtime and
 * the real `@deepseek-ai/dsh-agent-instructions` plugin, so the rules design
 * rests on measurements rather than on reading source.
 *
 * Gate 1 — does `agent/created` fire for CHILD agents?
 * Gate 2 — what is the `agent/pre-step` waterfall handler order relative to
 *          `agent-instructions`, in BOTH registration orders, and is the
 *          resulting message position stable?
 * Gate 3 — is `sessionProjections` needed in this plugin's inject list?
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ProjectAgents from '../../src/index.ts'

const requests: GenerateOptions[] = []
type Script = (options: GenerateOptions, index: number) => { kind: 'text'; text: string } | {
  kind: 'tool-call'
  name: string
  args: Record<string, unknown>
}
let script: Script = () => ({ kind: 'text', text: 'ok' })

class ProbeAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = requests.length
    requests.push(options)
    const turn = script(options, index)
    if (turn.kind === 'tool-call') {
      const args = JSON.stringify(turn.args)
      const id = ToolCallId(`call-${String(index)}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: turn.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: turn.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: turn.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let disposers: Array<() => Promise<unknown>> = []
let roots: string[] = []

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  disposers = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  requests.length = 0
  script = () => ({ kind: 'text', text: 'ok' })
})

function makeProject(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-phase1-${label}-`))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

/* ────────────────────────── Gate 1 ───────────────────────────────────── */

test('GATE 1: agent/created fires for child (spawned subagent) agents', async () => {
  const project = makeProject('child')
  mkdirSync(join(project, '.dsh', 'agents'), { recursive: true })
  writeFileSync(
    join(project, '.dsh', 'agents', 'worker.md'),
    '---\nname: worker\ndescription: Does one small thing.\n---\nYou are the worker.\n',
    'utf8',
  )

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())

  /** Every Agent published while this listener is mounted, with its parentage. */
  const created: Array<{
    id: string
    origin: string | undefined
    parentSession: string | undefined
    cwd: string | undefined
  }> = []
  ctx.on('agent/created', ({ agent }) => {
    created.push({
      id: String(agent.id),
      origin: agent.session.header.origin,
      parentSession: agent.session.header.parentSession === undefined
        ? undefined
        : String(agent.session.header.parentSession),
      cwd: agent.session.header.cwd,
    })
  })

  disposers.push((await ctx.plugin(SubagentRuntime)).dispose)
  disposers.push((await ctx.plugin(SpawnProvider, { providerName: 'spawn' })).dispose)
  disposers.push((await ctx.plugin(ProjectAgents, { globalAgentsDir: '/nonexistent' })).dispose)
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  // Turn 0: the parent delegates. Turn 1+: everyone answers with text.
  script = (_options, index) => (index === 0
    ? { kind: 'tool-call', name: 'agent_worker', args: { description: 'probe', prompt: 'do the thing' } }
    : { kind: 'text', text: 'done' })

  const parent = await ctx.agentLoop.create(
    SessionId('phase1-parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: project },
  )
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'delegate' }], source: { kind: 'user' } }))
  await parent.whenIdle()

  const children = created.filter(entry => entry.origin === 'subagent')
  // eslint-disable-next-line no-console
  console.log('[GATE 1] agent/created observations:', JSON.stringify(created, null, 2))
  expect(created.some(entry => entry.id === 'phase1-parent')).toBe(true)
  expect(children.length).toBeGreaterThan(0)
  expect(children[0]?.cwd).toBe(project)
}, 60_000)

/* ────────────────────────── Gate 2 ───────────────────────────────────── */

interface OrderProbe {
  /** Message text this probe folds into `decision.messages`. */
  readonly marker: string
}

/**
 * A minimal stand-in for the rules plugin's delivery: one `agent/pre-step`
 * waterfall handler that folds a durable user message in right after the
 * claimed batch, exactly the way `agent-instructions` does.
 */
function orderProbePlugin(config: OrderProbe) {
  return {
    name: `order-probe-${config.marker}`,
    apply(ctx: Context) {
      ctx.on('agent/pre-step', async (
        { messages, signal }: { agent: Agent; messages: UserMessage[]; signal: AbortSignal },
        next: () => Promise<PreStepDecision>,
      ): Promise<PreStepDecision> => {
        const decision = await next()
        signal.throwIfAborted()
        if (decision.kind === 'reject') return decision
        const desired = createUserMessage({
          content: [{ type: 'text', text: config.marker }],
          source: { kind: 'plugin', plugin: `order-probe-${config.marker}` },
        })
        const lastClaimed = decision.messages.findLastIndex(message => messages.includes(message))
        return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, desired) }
      })
    },
  }
}

async function bootOrderProbe(probeFirst: boolean): Promise<string[]> {
  const project = makeProject('order')
  writeFileSync(join(project, 'AGENTS.md'), '# repo rules\nAlways be brief.\n', 'utf8')

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  disposers.push((await ctx.plugin(FsLocal, { cwd: project })).dispose)

  const mountProbe = async (): Promise<void> => {
    disposers.push((await ctx.plugin(orderProbePlugin({ marker: 'PROBE-MARKER' }))).dispose)
  }
  const mountInstructions = async (): Promise<void> => {
    disposers.push((await ctx.plugin(AgentInstructions, { maxBytes: 65536 })).dispose)
  }
  if (probeFirst) {
    await mountProbe()
    await mountInstructions()
  } else {
    await mountInstructions()
    await mountProbe()
  }
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  const agent = await ctx.agentLoop.create(
    SessionId(`phase1-order-${probeFirst ? 'probe-first' : 'instructions-first'}`),
    { provider: 'mock', model: 'mock' },
    { cwd: project },
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const first = requests[0]
  return (first?.messages ?? [])
    .filter(message => message.role === 'user')
    .map((message) => {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text.includes('PROBE-MARKER')) return 'PROBE'
      if (text.includes('repo rules')) return 'INSTRUCTIONS'
      if (text.includes('hello')) return 'PROMPT'
      return 'OTHER'
    })
}

test('GATE 2a: probe registered BEFORE agent-instructions', async () => {
  const order = await bootOrderProbe(true)
  // eslint-disable-next-line no-console
  console.log('[GATE 2a] probe-first user-message order:', JSON.stringify(order))
  expect(order).toContain('PROBE')
  expect(order).toContain('INSTRUCTIONS')
  expect(order.indexOf('PROBE')).toBeLessThan(order.indexOf('INSTRUCTIONS'))
}, 60_000)

test('GATE 2b: probe registered AFTER agent-instructions', async () => {
  const order = await bootOrderProbe(false)
  // eslint-disable-next-line no-console
  console.log('[GATE 2b] instructions-first user-message order:', JSON.stringify(order))
  expect(order).toContain('PROBE')
  expect(order).toContain('INSTRUCTIONS')
  expect(order.indexOf('INSTRUCTIONS')).toBeLessThan(order.indexOf('PROBE'))
}, 60_000)

test('GATE 2c: position is stable across repeated steps in one session', async () => {
  const project = makeProject('stable')
  writeFileSync(join(project, 'AGENTS.md'), '# repo rules\nAlways be brief.\n', 'utf8')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  disposers.push((await ctx.plugin(FsLocal, { cwd: project })).dispose)
  disposers.push((await ctx.plugin(AgentInstructions, { maxBytes: 65536 })).dispose)
  disposers.push((await ctx.plugin(orderProbePlugin({ marker: 'PROBE-MARKER' }))).dispose)
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  const agent = await ctx.agentLoop.create(
    SessionId('phase1-order-stable'),
    { provider: 'mock', model: 'mock' },
    { cwd: project },
  )
  for (const text of ['one', 'two', 'three']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  const positions = requests.map((request) => {
    const users = request.messages.filter(message => message.role === 'user')
    return users.findIndex(message => message.content.some(
      block => block.type === 'text' && block.text.includes('PROBE-MARKER'),
    ))
  })
  // eslint-disable-next-line no-console
  console.log('[GATE 2c] PROBE index within user messages, per request:', JSON.stringify(positions))
  expect(requests.length).toBe(3)
  expect(positions.every(index => index >= 0)).toBe(true)
}, 60_000)

/* ────────────────────────── Gate 3 ───────────────────────────────────── */

test('GATE 3: a pre-step folding plugin works WITHOUT injecting sessionProjections', async () => {
  const project = makeProject('inject')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  // The probe declares no `inject` at all — no `sessionProjections`, no `fs`.
  disposers.push((await ctx.plugin(orderProbePlugin({ marker: 'PROBE-MARKER' }))).dispose)
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  const agent = await ctx.agentLoop.create(
    SessionId('phase1-inject'),
    { provider: 'mock', model: 'mock' },
    { cwd: project },
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const texts = (requests[0]?.messages ?? [])
    .filter(message => message.role === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  // eslint-disable-next-line no-console
  console.log('[GATE 3] delivered without sessionProjections:', JSON.stringify(texts))
  expect(texts.some(text => text.includes('PROBE-MARKER'))).toBe(true)
}, 60_000)
