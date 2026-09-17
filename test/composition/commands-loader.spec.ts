/**
 * Real-Loader composition over the BUILT artifact, for the commands capability.
 *
 * A source-only test cannot prove what a profile install actually loads. This
 * one imports `lib/index.js` — the exact file the `file:` install materializes —
 * through a real `cordis.yml` in the shape `cordis.patch.yml` inserts, so a
 * packaging error fails here: a missing export, a bad entry point, or the
 * `@deepseek-ai/dsh-commands` runtime import not being resolvable from the
 * installed artifact (the reason a version-range peer was added beside the
 * `link:` devDependency).
 *
 * It also proves the two facts the `dsh` build-commands provider depends on:
 * the loader picks up files from `<projectRoot>/.dsh/commands`, and a
 * placeholder-free body (every real corpus file) still carries the operator's
 * argument through to the model request.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
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

/** Sources whose change must invalidate the built artifact. */
const SOURCE_FILES = [
  'index.ts',
  'commands-discovery.ts',
  'commands-install.ts',
  'command-frontmatter.ts',
  'rules-discovery.ts',
  'rules-render.ts',
  'rules-reconcile.ts',
  'message-source.ts',
]

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
  // The built artifact is the subject, so build it when it is absent or older
  // than the sources — otherwise this test silently proves nothing.
  const newestSource = SOURCE_FILES
    .map(name => join(packageRoot, 'src', name))
    .filter(path => existsSync(path))
    .reduce((newest, path) => Math.max(newest, statSync(path).mtimeMs), 0)
  const stale = !existsSync(builtEntry) || statSync(builtEntry).mtimeMs < newestSource
  if (stale) execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: packageRoot, stdio: 'inherit' })
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  requests.length = 0
})

test('the BUILT plugin registers .dsh/commands and delivers the argument to a real Loader composition', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-project-context-commands-loader-'))
  const projectDir = join(root, 'repo')
  await mkdir(join(projectDir, '.git'), { recursive: true })
  await mkdir(join(projectDir, '.dsh', 'commands'), { recursive: true })
  const body = 'Ask the operator which chain they selected.\n'
  await writeFile(
    join(projectDir, '.dsh', 'commands', 'brainstorm.md'),
    `---\ndescription: Brainstorm a change\n---\n\n${body}`,
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
    // The service the capability injects on each Agent context. It is mounted
    // BEFORE the plugin so `agent.ctx.inject(['commands'], …)` resolves.
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
    // Exactly the entry `cordis.patch.yml` inserts.
    '- id: dsh-project-context',
    "  name: 'dsh-project-context'",
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
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SpawnProvider],
    ['dsh-project-context', built],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])

  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
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
    SessionId('loader-project-commands'),
    { provider: 'mock', model: 'mock' },
    { cwd: projectDir },
  )

  // The command is registered under our provenance prefix, not as a bare name.
  const definition = context.commands.find(agent, 'brainstorm')
  expect(definition?.definitionId).toBe('dsh-project-context/brainstorm')

  const execution = await context.commands.execute(
    agent,
    '/brainstorm Cách 3 — mở rộng plugin của chúng ta',
    [],
    new AbortController().signal,
  )
  expect(execution?.result.kind).toBe('success')

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const texts: string[] = []
  for (const request of requests) {
    for (const message of request.messages ?? []) {
      const text = (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text.length > 0) texts.push(text)
    }
  }
  const carrying = texts.find(text => text.includes(body.trimEnd()))
  expect(carrying).toBeDefined()
  // The placeholder-free body still carries the operator's argument, verbatim,
  // after exactly one blank line — the real-corpus path end to end.
  expect(carrying).toContain(`${body.trimEnd()}\n\nCách 3 — mở rộng plugin của chúng ta`)
}, 60_000)
