/**
 * The delegation-cap declaration in the `project-agents:catalog` section.
 *
 * The whole point of the declaration is that the model reads it BEFORE calling
 * an `agent_*` tool it cannot use, so the assertion is made against the FIRST
 * model request the production AgentLoop issues — not against the renderer.
 */

import { readdirSync } from 'node:fs'
import { afterEach, expect, test } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { renderCatalog } from '../../src/config-mapping.ts'
import type { ResolvedAgent } from '../../src/types.ts'
import { boot, definition, makeWorkspace, recordedRequests } from './harness.ts'
import type { Booted, Workspace } from './harness.ts'

let booted: Booted | undefined
const workspaces: Workspace[] = []
const owned: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  for (const handle of owned.splice(0)) await handle.dispose()
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

function systemText(request: GenerateOptions | undefined): string {
  return (request?.messages.find(message => message.role === 'system')?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** The declaration paragraph, pinned verbatim for depth 3 against a cap of 3. */
const DEPTH_3_CAP_3 = [
  'The project-scoped delegation tools listed below cannot be called from this',
  'session: it is already 3 levels of delegation deep, and they allow',
  'delegation up to 3 levels. Any call will be rejected, and that will',
  'not change for the rest of this session.',
].join('\n')

const ANALYST_DESCRIPTION = 'Reads code and returns a synthesis.'
const ANALYST_ROW = `- \`agent_analyst\` — ${ANALYST_DESCRIPTION}`
/** The catalog row plus the invitation the list always carries. */
const CATALOG_INVITATION = 'Project-scoped subagents declared in this working directory.'

/**
 * The resolved roster entry the fixture file produces, used to render the
 * expected section through the production renderer.
 * @param path - the fixture file's absolute path.
 * @returns the resolved agent for `analyst`.
 */
function analyst(path: string): ResolvedAgent {
  return {
    name: 'analyst',
    slug: 'analyst',
    toolName: 'agent_analyst',
    description: ANALYST_DESCRIPTION,
    transport: 'spawn',
    persona: 'You are the analyst agent.\n',
    maxDepth: 3,
    background: 'one-shot',
    path,
    layer: 'project',
  }
}

test('at depth = cap the FIRST model request declares the tools unusable', async () => {
  const project = workspace('at-cap')
  const path = project.write('analyst', definition('analyst', ANALYST_DESCRIPTION))
  booted = await boot(NO_GLOBAL)
  const handle = await booted.createOwnedAgent('at-cap', { cwd: project.root, delegationDepth: 3 })
  owned.push(handle)
  await booted.prompt(handle.agent, 'hi')

  const text = systemText(recordedRequests[0])
  expect(text).toContain(DEPTH_3_CAP_3)
  // The declaration frames the list it qualifies, so it comes first.
  expect(text.indexOf(DEPTH_3_CAP_3)).toBeLessThan(text.indexOf(CATALOG_INVITATION))
  // The tools it speaks for really did mount; the claim is not about nothing.
  expect(text).toContain(ANALYST_ROW)
})

test('a depth-0 Agent keeps the catalog section byte-identical to today\'s render', async () => {
  const project = workspace('at-root')
  const path = project.write('analyst', definition('analyst', ANALYST_DESCRIPTION))
  booted = await boot(NO_GLOBAL)
  const handle = await booted.createOwnedAgent('at-root', { cwd: project.root })
  owned.push(handle)
  await booted.prompt(handle.agent, 'hi')

  const request = recordedRequests[0]
  expect(request?.tools?.map(tool => tool.name)).toContain('agent_analyst')
  const text = systemText(request)
  // Full-section equality: the bytes in the prompt are exactly what the
  // renderer produces with no declaration input, which is what keeps the
  // depth-0 prompt prefix stable for KV cache.
  expect(text).toContain(renderCatalog([analyst(path)]))
  expect(text).not.toContain('levels of delegation deep')
})

test('mixed numeric caps still admit a child, so the request carries no declaration', async () => {
  const project = workspace('mixed-caps')
  project.write('analyst', definition('analyst', ANALYST_DESCRIPTION))
  project.write('reviewer', definition('reviewer', 'Reviews diffs.', 'maxDepth: 5\n'))
  booted = await boot(NO_GLOBAL)
  const handle = await booted.createOwnedAgent('mixed-caps', { cwd: project.root, delegationDepth: 4 })
  owned.push(handle)
  await booted.prompt(handle.agent, 'hi')

  const request = recordedRequests[0]
  // Silence is not proof: both tools mounted before the absence is asserted.
  expect(request?.tools?.map(tool => tool.name).sort()).toEqual(['agent_analyst', 'agent_reviewer'])
  const text = systemText(request)
  expect(text).toContain(CATALOG_INVITATION)
  expect(text).not.toContain('levels of delegation deep')
})

test('a provider-managed cap still admits a child, so the request carries no declaration', async () => {
  const project = workspace('provider-managed')
  project.write('analyst', definition('analyst', ANALYST_DESCRIPTION, 'maxDepth: provider-managed\n'))
  booted = await boot(NO_GLOBAL)
  const handle = await booted.createOwnedAgent('provider-managed', { cwd: project.root, delegationDepth: 3 })
  owned.push(handle)
  await booted.prompt(handle.agent, 'hi')

  const request = recordedRequests[0]
  expect(request?.tools?.map(tool => tool.name)).toContain('agent_analyst')
  const text = systemText(request)
  expect(text).toContain(ANALYST_ROW)
  expect(text).not.toContain('levels of delegation deep')
})

test('a project with no agent file stays silent even at the depth of a capped child', async () => {
  const project = workspace('empty-roster')
  // Count the input first: an empty fixture and a fixture the plugin failed to
  // read produce the same silence.
  expect(readdirSync(project.agentsDir)).toEqual([])
  booted = await boot(NO_GLOBAL)
  const handle = await booted.createOwnedAgent('empty-roster', { cwd: project.root, delegationDepth: 3 })
  owned.push(handle)
  await booted.prompt(handle.agent, 'hi')

  const text = systemText(recordedRequests[0])
  expect(text).not.toContain(CATALOG_INVITATION)
  expect(text).not.toContain('levels of delegation deep')
})
