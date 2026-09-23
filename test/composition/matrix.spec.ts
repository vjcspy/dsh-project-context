/**
 * Real-composition matrix required by `packages/AGENTS.md`: assertions are made
 * against the FIRST model request the production AgentLoop issues, not against
 * the tool registry alone.
 */

import { afterEach, expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as SpawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MCP_HEALTH_DOM_ID } from '../../src/diagnostics.ts'
import { boot, definition, makeWorkspace, recordedRequests, setScript } from './harness.ts'
import type { Booted, Workspace } from './harness.ts'

let booted: Booted | undefined
const workspaces: Workspace[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const workspace of workspaces.splice(0)) workspace.dispose()
})

function workspace(label: string): Workspace {
  const created = makeWorkspace(label)
  workspaces.push(created)
  return created
}

const NO_GLOBAL = { globalAgentsDir: '/nonexistent-global-agents' }

function toolNames(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? []).map(tool => tool.name)
}

/**
 * The capability-notice rows only.
 *
 * The MCP outage row is UNCONDITIONAL — it carries no diagnostics, because its
 * script polls the health route and decides for itself whether to paint — so
 * these assertions filter it out and keep asserting what they always did: which
 * capability banners a given pass produced.
 * @param table - the raw injection table.
 * @returns every row that is not the MCP health poller.
 */
function noticeRows(table: IndexInjection[]): IndexInjection[] {
  return table.filter(row => !(row.kind === 'script' && row.text.includes(MCP_HEALTH_DOM_ID)))
}

function systemText(request: GenerateOptions | undefined): string {
  return (request?.messages.find(message => message.role === 'system')?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

test('the generated tool and its catalog row are in the FIRST model request', async () => {
  const project = workspace('first-request')
  project.write('analyst', definition('analyst', 'Reads code and returns a synthesis.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('first-request', project.root)
  await booted.prompt(agent, 'hi')

  const first = recordedRequests[0]
  expect(toolNames(first)).toContain('agent_analyst')
  expect(systemText(first)).toContain('- `agent_analyst` — Reads code and returns a synthesis.')
})

test('a cwd outside the project does not expose the tool', async () => {
  const project = workspace('scoped-in')
  const other = workspace('scoped-out')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('scoped-out', other.root)
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).not.toContain('agent_analyst')
})

test('a project definition shadows the global one of the same name', async () => {
  const project = workspace('shadow-project')
  const globalHome = workspace('shadow-global')
  project.write('analyst', definition('analyst', 'PROJECT analyst.'))
  globalHome.write('analyst', definition('analyst', 'GLOBAL analyst.'))
  booted = await boot({ globalAgentsDir: globalHome.agentsDir })
  const agent = await booted.createAgent('shadowing', project.root)
  await booted.prompt(agent, 'hi')
  const text = systemText(recordedRequests[0])
  expect(text).toContain('PROJECT analyst.')
  expect(text).not.toContain('GLOBAL analyst.')
})

test('an Agent with no cwd falls back to the configured directory', async () => {
  const project = workspace('fallback')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot({ ...NO_GLOBAL, fallbackCwd: project.root })
  const agent = await booted.createAgent('no-cwd')
  expect(agent.session.header.cwd).toBeUndefined()
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).toContain('agent_analyst')
})

test('an Agent that already exists when the plugin loads is installed too', async () => {
  const project = workspace('pre-existing')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL, { deferPlugin: true })
  const agent = await booted.createAgent('pre-existing', project.root)
  await booted.mountProjectAgents(NO_GLOBAL)
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).toContain('agent_analyst')
})

test('a provider that registers after the Agent still gets the tool mounted', async () => {
  const project = workspace('late-provider')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL, { withProvider: false })
  const agent = await booted.createAgent('late-provider', project.root)
  await booted.mount(SpawnProvider, { providerName: 'spawn' })
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).toContain('agent_analyst')
})

test('a malformed file is reported and skipped while Agent creation still succeeds', async () => {
  const project = workspace('invalid')
  project.write('broken', '---\nname: Not A Slug\ndescription: d\n---\nbody\n')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('invalid', project.root)
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).toContain('agent_analyst')
  expect(toolNames(recordedRequests[0])).not.toContain('agent_not_a_slug')
})

test('a skipped file is named in the FIRST model request, not only in the host log', async () => {
  const project = workspace('surfaced-error')
  project.write('analyst', definition('analyst', 'Reads code.'))
  project.write('broken', '---\nname: broken\ndescription: d\nbogusKey: 1\n---\nbody\n')
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('surfaced-error', project.root)
  await booted.prompt(agent, 'hi')

  const text = systemText(recordedRequests[0])
  expect(toolNames(recordedRequests[0])).toEqual(['agent_analyst'])
  // The host logger cannot reach the operator on a profile without a log
  // exporter, so the model has to be able to answer "why is my agent missing?".
  expect(text).toContain('broken.md')
  expect(text).toContain('unknown frontmatter key')
})

test('a roster that mounted nothing still explains itself in the FIRST model request', async () => {
  const project = workspace('surfaced-only-error')
  project.write('broken', '---\nname: broken\ndescription: d\nbogusKey: 1\n---\nbody\n')
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('surfaced-only-error', project.root)
  await booted.prompt(agent, 'hi')

  expect(toolNames(recordedRequests[0])).toEqual([])
  const text = systemText(recordedRequests[0])
  expect(text).toContain('broken.md')
  expect(text).not.toContain('Project-scoped subagents')
})

test('a surfaced reason quoting `{{ }}` cannot break prompt assembly', async () => {
  const project = workspace('surfaced-hazard')
  project.write('templater', definition('templater', 'Renders {{name}} templates.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('surfaced-hazard', project.root)
  // The rejection reason itself quotes `{{ … }}`; surfaced unfiltered it would
  // throw inside prompt assembly, so a single completed request is the proof.
  await booted.prompt(agent, 'hi')

  expect(recordedRequests).toHaveLength(1)
  const text = systemText(recordedRequests[0])
  expect(text).toContain('templater.md')
  expect(text).not.toContain('{{')
  expect(text).not.toContain('}}')
})

test('the web notice row names the skipped file for the operator', async () => {
  const project = workspace('web-notice')
  project.write('broken', '---\nname: broken\ndescription: d\nbogusKey: 1\n---\nbody\n')
  booted = await boot(NO_GLOBAL)
  await booted.createAgent('web-notice', project.root)
  await Promise.resolve()

  const table: IndexInjection[] = []
  booted.ctx.emit('webserver/index-inject', table)

  const notices = noticeRows(table)
  expect(notices).toHaveLength(1)
  const row = notices[0]
  expect(row?.kind).toBe('script')
  const text = row?.kind === 'script' ? row.text : ''
  expect(text).toContain('broken.md')
  expect(text).toContain(project.root)
})

test('a clean project injects no web notice at all', async () => {
  const project = workspace('web-notice-clean')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  await booted.createAgent('web-notice-clean', project.root)
  await Promise.resolve()

  const table: IndexInjection[] = []
  booted.ctx.emit('webserver/index-inject', table)
  expect(noticeRows(table)).toEqual([])
  // The MCP health row is still there: it is unconditional by design.
  expect(table).toHaveLength(1)
  expect(table[0]?.kind === 'script' ? table[0].text.includes(MCP_HEALTH_DOM_ID) : false).toBe(true)
})

test('a safe body with an unsafe `{{ }}` description is rejected without breaking assembly', async () => {
  const project = workspace('description-hazard')
  project.write('templater', definition('templater', 'Renders {{name}} templates.'))
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('description-hazard', project.root)
  // Assembly would throw on the balanced reference; the request proves it did not.
  await booted.prompt(agent, 'hi')
  expect(recordedRequests).toHaveLength(1)
  expect(toolNames(recordedRequests[0])).toEqual(['agent_analyst'])
  expect(systemText(recordedRequests[0])).not.toContain('{{name}}')
})

test('roster freshness: a later Agent sees a newly dropped file, an existing one does not', async () => {
  const project = workspace('freshness')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)

  const first = await booted.createAgent('freshness-a', project.root)
  await booted.prompt(first, 'hi')
  expect(toolNames(recordedRequests[0])).toEqual(['agent_analyst'])

  project.write('reviewer', definition('reviewer', 'Reviews diffs.'))

  const second = await booted.createAgent('freshness-b', project.root)
  await booted.prompt(second, 'hi')
  expect(toolNames(recordedRequests[1])?.sort()).toEqual(['agent_analyst', 'agent_reviewer'])

  // The already-created Agent keeps its resolved roster: no live refresh.
  await booted.prompt(first, 'again')
  expect(toolNames(recordedRequests[2])).toEqual(['agent_analyst'])
})

test('plugin unload removes both the tools and the catalog section from a live Agent', async () => {
  const project = workspace('hmr')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const agent = await booted.createAgent('hmr', project.root)
  await booted.prompt(agent, 'hi')
  expect(toolNames(recordedRequests[0])).toContain('agent_analyst')
  expect(systemText(recordedRequests[0])).toContain('Project-scoped subagents')

  await booted.unloadPlugin()

  await booted.prompt(agent, 'again')
  expect(toolNames(recordedRequests[1])).not.toContain('agent_analyst')
  expect(systemText(recordedRequests[1])).not.toContain('Project-scoped subagents')
})

test('Agent disposal removes that Agent\'s install and leaves the global scope clean', async () => {
  const project = workspace('disposal')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const owned = await booted.createOwnedAgent('disposal', { cwd: project.root })
  await Promise.resolve()
  expect(booted.ctx.tools.schemas(owned.agent).map(tool => tool.name)).toContain('agent_analyst')

  await owned.dispose()

  expect(booted.ctx.tools.schemas().map(tool => tool.name)).not.toContain('agent_analyst')
})

test('a child Agent sees the tools its parent resolved', async () => {
  const project = workspace('child')
  project.write('analyst', definition('analyst', 'Reads code.'))
  booted = await boot(NO_GLOBAL)
  const children: Agent[] = []
  booted.ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') children.push(agent)
  })

  setScript((_options, index) => index === 0
    ? { kind: 'tool-call', name: 'agent_analyst', args: { description: 'probe', prompt: 'say hello' } }
    : { kind: 'text', text: 'done' })

  const parent = await booted.createAgent('child-parent', project.root)
  await booted.prompt(parent, 'delegate please')

  expect(children).toHaveLength(1)
  // The child's own first request carries the inherited roster.
  const childRequest = recordedRequests.find((request, index) =>
    index > 0 && toolNames(request).includes('agent_analyst'))
  expect(childRequest).toBeDefined()
  const child = children[0]
  expect(child).toBeDefined()
  expect(child?.session.header.cwd).toBe(project.root)
})

test('the markdown llm route reaches the child request, not just the mount', async () => {
  const project = workspace('llm-route')
  project.write('analyst', definition(
    'analyst',
    'Reads code.',
    'llm:\n  provider: mock\n  model: child-model\n',
  ))
  booted = await boot(NO_GLOBAL)
  setScript((_options, index) => index === 0
    ? { kind: 'tool-call', name: 'agent_analyst', args: { description: 'probe', prompt: 'hello' } }
    : { kind: 'text', text: 'done' })

  const parent = await booted.createAgent('llm-route', project.root)
  await booted.prompt(parent, 'delegate')

  const routes = recordedRequests.map(request => `${request.provider}/${request.model}`)
  // The parent runs the deployment route; the child runs the markdown route.
  expect(routes[0]).toBe('mock/mock-model')
  expect(routes).toContain('mock/child-model')
})
