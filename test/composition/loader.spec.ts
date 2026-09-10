/**
 * Real-Loader composition over the BUILT artifact.
 *
 * Two things are proven here that a source-only test cannot prove:
 * - the plugin composes through a real `cordis.yml` read by the Loader, in the
 *   same shape `cordis.patch.yml` inserts into a profile;
 * - `lib/index.js` — the file a profile install actually loads — is what runs,
 *   so a packaging error (a missing export, a bad entry point) fails here.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const builtEntry = join(packageRoot, 'lib', 'index.js')

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
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined
let root: string | undefined

beforeAll(() => {
  // The built artifact is the subject of this test, so build it if it is stale
  // or absent rather than silently testing nothing.
  if (!existsSync(builtEntry)) {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: packageRoot, stdio: 'inherit' })
  }
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  requests.length = 0
})

afterAll(() => { /* the built artifact is left in place for the profile install */ })

test('the built plugin composes through a real cordis.yml and reaches the first request', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-project-agents-loader-'))
  const project = join(root, 'repo')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh', 'agents'), { recursive: true })
  await writeFile(
    join(project, '.dsh', 'agents', 'analyst.md'),
    '---\nname: analyst\ndescription: Reads code and returns a synthesis.\n---\nYou are the analyst.\n',
    'utf8',
  )

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
    // Exactly the entry `cordis.patch.yml` inserts.
    '- id: dsh-project-agents',
    "  name: 'dsh-project-agents'",
    '  config:',
    "    globalAgentsDir: '/nonexistent-global-agents'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '',
  ].join('\n'), 'utf8')

  const built: unknown = await import(pathToFileURL(builtEntry).href)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SpawnProvider],
    ['dsh-project-agents', built],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])

  context.llm.registerAdapter(['mock'], new ProbeAdapter())
  const agent = await context.agentLoop.create(
    SessionId('loader-project-agents'),
    { provider: 'mock', model: 'mock' },
    { cwd: project },
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const first = requests[0]
  expect((first?.tools ?? []).map(tool => tool.name)).toContain('agent_analyst')
  const systemText = (first?.messages.find(message => message.role === 'system')?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  expect(systemText).toContain('- `agent_analyst` — Reads code and returns a synthesis.')
}, 60_000)
