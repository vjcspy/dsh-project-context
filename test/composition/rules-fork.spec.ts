/**
 * Fork inheritance for the project-rules snapshot.
 *
 * A forked child is SEEDED with the parent's completed-turn prefix — every
 * event up to and including the last `turn/end`
 * (`packages/subagent/subagent-fork-in-process/src/index.ts:47-54`), and the
 * provider declares `inheritsParentContext = true` (`:70`). So a snapshot the
 * parent already had admitted is present in the CHILD's own session log before
 * the child's first pre-step runs, and `recoverStateFromHistory` must find it.
 *
 * **The decisive discriminator is message IDENTITY, not the digest.**
 * `snapshotDigest` is a pure function of the rendered text and the file
 * identities, and a child shares its parent's cwd — so a child that
 * *recomputed* the snapshot from scratch would produce a byte-identical
 * digest. Only the message `id` separates the two: an inherited message
 * carries the parent's id, while `createUserMessage` mints a fresh one. Every
 * "did not duplicate" claim here rests on that.
 *
 * The fork is deliberately issued on a LATER turn. The seed ends at the last
 * `turn/end`, so a fork inside the very first turn inherits nothing and the
 * child correctly starts fresh — a separate case, covered at the end.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ForkProvider from '@deepseek-ai/dsh-subagent-fork-in-process'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import * as ProjectContext from '../../src/index.ts'
import { DEFAULT_RULE_BOUNDS, digestOf } from '../../src/rules-discovery.ts'
import { reconcileRules, recoverStateFromHistory } from '../../src/rules-reconcile.ts'
import type { RuleScan } from '../../src/types.ts'

/** Marker planted in the forked child's persona so its requests are identifiable. */
const CHILD_MARKER = 'I AM THE FORKED CHILD'

const requests: GenerateOptions[] = []
type Turn = { kind: 'text'; text: string } | { kind: 'tool-call'; name: string; args: Record<string, unknown> }
let script: (options: GenerateOptions, index: number) => Turn = () => ({ kind: 'text', text: 'ok' })

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
const roots: string[] = []

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  disposers = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  requests.length = 0
  script = () => ({ kind: 'text', text: 'ok' })
})

interface Fixture {
  readonly root: string
  readonly rulePath: string
  readonly children: Agent[]
  readonly parent: Agent
  prompt(agent: Agent, text: string): Promise<void>
}

/** A project carrying one rule file and one fork-transport agent definition. */
async function fixture(label: string, ruleBody: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `dsh-rulesfork-${label}-`))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.dsh', 'rules'), { recursive: true })
  mkdirSync(join(root, '.dsh', 'agents'), { recursive: true })
  const rulePath = join(root, '.dsh', 'rules', 'a.md')
  writeFileSync(rulePath, ruleBody, 'utf8')
  writeFileSync(
    join(root, '.dsh', 'agents', 'forked.md'),
    `---\nname: forked\ndescription: A forked child.\ntransport: fork\n---\n${CHILD_MARKER}\n`,
    'utf8',
  )

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  const children: Agent[] = []
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') children.push(agent)
  })
  disposers.push((await ctx.plugin(SubagentRuntime)).dispose)
  disposers.push((await ctx.plugin(ForkProvider, { providerName: 'fork' })).dispose)
  disposers.push((await ctx.plugin(ProjectContext, { globalAgentsDir: '/nonexistent' })).dispose)
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  const parent = await ctx.agentLoop.create(
    SessionId(`fork-parent-${label}`),
    { provider: 'mock', model: 'mock' },
    { cwd: root },
  )
  return {
    root,
    rulePath,
    children,
    parent,
    async prompt(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

function rulesOf(request: GenerateOptions | undefined): Message[] {
  return (request?.messages ?? []).filter(message => message.source.kind === 'project-rules')
}

function systemTextOf(request: GenerateOptions): string {
  return (request.messages.find(message => message.role === 'system')?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Requests issued by a forked child, identified by its shadowing persona. */
function childRequests(): GenerateOptions[] {
  return requests.filter(request => systemTextOf(request).includes(CHILD_MARKER))
}

/** Requests issued by the parent. */
function parentRequests(): GenerateOptions[] {
  return requests.filter(request => !systemTextOf(request).includes(CHILD_MARKER))
}

function textOf(message: Message | undefined): string {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Every `project-rules` message durably recorded on one Agent's surface. */
function rulesEventsOf(agent: Agent): Array<{ id: string; snapshot: string; cleared: boolean }> {
  const out: Array<{ id: string; snapshot: string; cleared: boolean }> = []
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'project-rules') continue
    out.push({ id: String(event.data.id), snapshot: source.snapshot, cleared: source.cleared === true })
  }
  return out
}

/** Fire the fork tool on exactly one parent request index. */
function forkOnParentRequest(index: number): void {
  script = (options, current) => (
    current === index && !systemTextOf(options).includes(CHILD_MARKER)
      ? { kind: 'tool-call', name: 'agent_forked', args: { description: 'probe', prompt: 'go' } }
      : { kind: 'text', text: 'done' }
  )
}

describe('fork inheritance', () => {
  test('a child forked after a completed turn INHERITS the snapshot and emits no duplicate', async () => {
    const body = 'FORK INHERITED RULE BODY'
    const f = await fixture('inherit', body)

    // Turn 1 completes: the snapshot is admitted and `turn/end` is recorded,
    // which is what makes the fork seed non-empty.
    await f.prompt(f.parent, 'one')
    const parentMessage = rulesOf(requests[0])[0]
    expect(parentMessage).toBeDefined()

    forkOnParentRequest(1)
    await f.prompt(f.parent, 'two')

    expect(f.children).toHaveLength(1)
    const child = f.children[0]
    expect(child).toBeDefined()
    const childReqs = childRequests()
    expect(childReqs.length).toBeGreaterThan(0)

    const inherited = rulesOf(childReqs[0])
    // Exactly one snapshot reaches the child's request…
    expect(inherited).toHaveLength(1)
    // …and it is the PARENT'S OWN MESSAGE, not a recomputed twin. This is the
    // only assertion that can tell the two apart: the digest would match
    // either way, because the child shares the parent's cwd and files.
    expect(inherited[0]?.id).toBe(parentMessage?.id)
    expect(textOf(inherited[0])).toContain(body)

    // Durably too: the child's own transcript carries exactly that one message,
    // with no clearing message and no second snapshot.
    const events = rulesEventsOf(child as Agent)
    expect(events.map(entry => entry.id)).toEqual([String(parentMessage?.id)])
    expect(events.some(entry => entry.cleared)).toBe(false)
  }, 60_000)

  test('the inherited DELTA STATE is complete: a later edit reconciles to `replace`, not `set`', async () => {
    // A one-shot fork child is disposed the moment its run ends, so it cannot
    // be driven for a second live turn. What CAN be asserted — and is what
    // actually matters — is that the state recovered from the child's real
    // seeded transcript carries the per-scope digest, so the next
    // reconciliation against an edited file yields `replace`. The recovery
    // input here is the child's genuine inherited history, and the reconciler
    // is the production one; only the second turn is simulated.
    const original = 'ORIGINAL FORK BODY'
    const f = await fixture('delta', original)
    await f.prompt(f.parent, 'one')
    forkOnParentRequest(1)
    await f.prompt(f.parent, 'two')
    const child = f.children[0]
    expect(child).toBeDefined()

    const recovered = recoverStateFromHistory(child as Agent, [])
    expect(recovered).toBeDefined()
    if (recovered === undefined) return
    // The full per-scope state, not merely the snapshot digest.
    expect(recovered.deliveredScopes).toEqual(['a.md'])
    expect(recovered.deliveredDigests.get('a.md')).toBe(digestOf(original))
    expect(recovered.retained.get('a.md')?.body).toBe(original)

    // Feed the child's real recovered state to the real reconciler with an
    // edited file: a `set` here would mean the inheritance was incomplete.
    const edited = 'EDITED AFTER FORK'
    const scan: RuleScan = {
      directory: join(f.root, '.dsh', 'rules'),
      directoryObservation: 'present',
      files: [{
        scope: 'a.md',
        path: f.rulePath,
        observation: 'present',
        body: edited,
        digest: digestOf(edited),
      }],
      projectRoot: f.root,
    }
    const outcome = reconcileRules(
      scan,
      recovered,
      { maxRenderedBytes: DEFAULT_RULE_BOUNDS.maxRenderedBytes },
      new DiagnosticSink(),
    )
    const source = outcome.desired?.source
    expect(source?.kind).toBe('project-rules')
    if (source?.kind !== 'project-rules') return
    expect(source.changes.map(change => `${change.action}:${change.scope}`)).toEqual(['replace:a.md'])
    expect(textOf(outcome.desired)).toContain(edited)
  }, 60_000)

  test('a child forked AFTER an edit inherits the UPDATED snapshot and still emits no duplicate', async () => {
    // Fully live end-to-end: the parent sees the edit on turn 2, and the fork
    // on turn 3 therefore seeds both snapshots. The child must add nothing.
    const f = await fixture('updated', 'FIRST FORK BODY')
    await f.prompt(f.parent, 'one')

    writeFileSync(f.rulePath, 'SECOND FORK BODY', 'utf8')
    await f.prompt(f.parent, 'two')
    const parentLatest = rulesOf(parentRequests().at(-1)).at(-1)
    expect(textOf(parentLatest)).toContain('SECOND FORK BODY')

    forkOnParentRequest(2)
    await f.prompt(f.parent, 'three')

    expect(f.children).toHaveLength(1)
    const childReqs = childRequests()
    expect(childReqs.length).toBeGreaterThan(0)
    const inherited = rulesOf(childReqs[0])
    // Both snapshots ride the inherited append-only history…
    expect(inherited).toHaveLength(2)
    // …and every one of them is a parent message, so the child added none.
    const parentIds = new Set(rulesEventsOf(f.parent).map(entry => entry.id))
    expect(inherited.every(message => parentIds.has(String(message.id)))).toBe(true)
    // The governing (latest) one is the edited body.
    expect(textOf(inherited.at(-1))).toContain('SECOND FORK BODY')

    const childState = recoverStateFromHistory(f.children[0] as Agent, [])
    expect(childState?.deliveredDigests.get('a.md')).toBe(digestOf('SECOND FORK BODY'))
  }, 60_000)

  test('a child forked BEFORE any completed turn inherits nothing and correctly starts fresh', async () => {
    // The seed ends at the last `turn/end`, so a fork inside the FIRST turn
    // carries no history. The child must then deliver its own snapshot, which
    // is not a duplicate: the model in that child has seen nothing.
    const f = await fixture('fresh', 'FRESH FORK BODY')
    forkOnParentRequest(0)
    await f.prompt(f.parent, 'one')

    expect(f.children).toHaveLength(1)
    const childReqs = childRequests()
    expect(childReqs.length).toBeGreaterThan(0)
    const delivered = rulesOf(childReqs[0])
    expect(delivered).toHaveLength(1)
    const source = delivered[0]?.source
    if (source?.kind !== 'project-rules') throw new Error('expected a project-rules source')
    // A first sighting for this child, so `set` — and a FRESH message id,
    // because nothing was inherited to reuse.
    expect(source.changes.map(change => change.action)).toEqual(['set'])
    const parentIds = new Set(rulesEventsOf(f.parent).map(entry => entry.id))
    expect(parentIds.has(String(delivered[0]?.id))).toBe(false)
    expect(textOf(delivered[0])).toContain('FRESH FORK BODY')
  }, 60_000)
})
