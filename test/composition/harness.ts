/**
 * Real-composition harness: the production AgentLoop, tool registry,
 * system-prompt registry, subagent runtime and the real in-process `spawn`
 * provider, with a recording LLM adapter so the FIRST model request can be
 * asserted rather than merely the registry contents.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ProjectAgents from '../../src/index.ts'
import type { Config } from '../../src/types.ts'

/** Every request this adapter was asked to stream, in order. */
export const recordedRequests: GenerateOptions[] = []

/** One scripted model turn: plain text, or a single tool call. */
export type ScriptedTurn =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly name: string; readonly args: Record<string, unknown> }

type Script = (options: GenerateOptions, index: number) => ScriptedTurn

let script: Script = () => ({ kind: 'text', text: 'ok' })

/**
 * Replace the scripted model behaviour for the next boot.
 * @param next - decides each turn's response from the request and its index.
 */
export function setScript(next: Script): void {
  script = next
}

class RecordingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = recordedRequests.length
    recordedRequests.push(options)
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

/** One disposable temporary project tree with a `.git` marker. */
export interface Workspace {
  readonly root: string
  readonly agentsDir: string
  /** Write one `<name>.md` agent definition into `<root>/.dsh/agents`. */
  write(name: string, text: string): string
  /** Remove one previously written definition. */
  remove(name: string): void
  dispose(): void
}

/**
 * Create a temporary project root marked with `.git`.
 * @param label - directory-name hint.
 * @returns the workspace handle.
 */
export function makeWorkspace(label = 'project'): Workspace {
  const root = mkdtempSync(join(tmpdir(), `dsh-project-context-${label}-`))
  mkdirSync(join(root, '.git'), { recursive: true })
  const agentsDir = join(root, '.dsh', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  return {
    root,
    agentsDir,
    write(name, text) {
      const path = join(agentsDir, `${name}.md`)
      writeFileSync(path, text, 'utf8')
      return path
    },
    remove(name) {
      rmSync(join(agentsDir, `${name}.md`), { force: true })
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** A booted composition. */
export interface Booted {
  readonly ctx: Context
  /** Mount one more plugin into the booted context (late-provider tests). */
  mount(plugin: unknown, config?: unknown): Promise<void>
  /** Dispose only this plugin's own fiber, simulating unload/HMR. */
  unloadPlugin(): Promise<void>
  /** Mount this plugin after the fact (deferred boot, pre-existing Agents). */
  mountProjectAgents(config?: Config): Promise<void>
  /** Create one Agent directly on the registry, returning its owning handle. */
  createOwnedAgent(id: string, meta?: Record<string, unknown>): Promise<{
    agent: Agent
    dispose: () => Promise<void>
  }>
  /** Create one top-level Agent whose session header carries `cwd`. */
  createAgent(id: string, cwd?: string): Promise<Agent>
  /** Drive one turn so the loop issues a real model request. */
  prompt(agent: Agent, text: string): Promise<void>
  dispose(): Promise<void>
}

/** Standard agent definition text used by most composition assertions. */
export function definition(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nYou are the ${name} agent.\n`
}

/**
 * Boot the real service stack with this plugin mounted.
 * @param config - plugin entry configuration.
 * @param options - whether to mount the subagent provider (late-provider tests
 *   mount it themselves afterwards).
 * @returns the booted composition.
 */
export async function boot(
  config: Config = {},
  options: { readonly withProvider?: boolean; readonly deferPlugin?: boolean } = {},
): Promise<Booted> {
  recordedRequests.length = 0
  script = () => ({ kind: 'text', text: 'ok' })
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new RecordingAdapter())
  const fibers: Array<{ dispose: () => Promise<void> }> = []
  fibers.push(await ctx.plugin(SubagentRuntime))
  if (options.withProvider !== false) fibers.push(await ctx.plugin(SpawnProvider, { providerName: 'spawn' }))
  let pluginFiber = options.deferPlugin === true ? undefined : await ctx.plugin(ProjectAgents, config)
  if (pluginFiber !== undefined) fibers.push(pluginFiber)
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }))
  return {
    ctx,
    async mount(plugin, pluginConfig) {
      fibers.push(await ctx.plugin(plugin as never, pluginConfig as never))
    },
    async mountProjectAgents(laterConfig = config) {
      pluginFiber = await ctx.plugin(ProjectAgents, laterConfig)
      fibers.push(pluginFiber)
    },
    async unloadPlugin() {
      await pluginFiber?.dispose()
    },
    async createOwnedAgent(id, meta = {}) {
      const handle = await ctx.agents.create({
        sessionId: sessionId(id) as SessionId,
        agentOptions: { provider: 'mock', model: 'mock-model' },
        meta: meta as never,
      })
      return { agent: handle.agent, dispose: () => handle.dispose() }
    },
    createAgent: (id, cwd) => ctx.agentLoop.create(
      sessionId(id) as SessionId,
      { provider: 'mock', model: 'mock-model' },
      cwd === undefined ? {} : { cwd },
    ),
    async prompt(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    async dispose() {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    },
  }
}
