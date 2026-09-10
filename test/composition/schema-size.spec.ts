/**
 * Phase 1 measurement: what N generated tools actually cost in the FIRST model
 * request. Measured against the real request the AgentLoop issues, not against
 * a reconstruction, so the supported bound is evidence-based.
 */

import { afterEach, expect, test } from 'vitest'
import { boot, definition, makeWorkspace, recordedRequests } from './harness.ts'
import type { Booted, Workspace } from './harness.ts'
import { CATALOG_SECTION } from '../../src/index.ts'

let booted: Booted | undefined
let workspace: Workspace | undefined

afterEach(async () => {
  await booted?.dispose()
  workspace?.dispose()
  booted = undefined
  workspace = undefined
})

const MEASURED_COUNTS = [1, 10, 16]

for (const count of MEASURED_COUNTS) {
  test(`serialized tool-schema and catalog cost at ${String(count)} agents`, async () => {
    workspace = makeWorkspace(`size-${String(count)}`)
    for (let i = 0; i < count; i++) {
      workspace.write(
        `analyst-${String(i)}`,
        definition(
          `analyst-${String(i)}`,
          `Reads code across files and returns a synthesis with file references. Instance ${String(i)}.`,
        ),
      )
    }
    booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
    const agent = await booted.createAgent(`measure-${String(count)}`, workspace.root)
    await booted.prompt(agent, 'hello')

    const request = recordedRequests[0]
    expect(request).toBeDefined()
    const tools = request?.tools ?? []
    const generated = tools.filter(tool => tool.name.startsWith('agent_'))
    expect(generated).toHaveLength(count)

    const generatedBytes = Buffer.byteLength(JSON.stringify(generated), 'utf8')
    const perTool = Math.round(generatedBytes / count)

    const systemMessage = request?.messages.find(message => message.role === 'system')
    const systemText = (systemMessage?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const catalogStart = systemText.indexOf('Project-scoped subagents available')
    expect(catalogStart).toBeGreaterThanOrEqual(0)
    // The section is a 3-line intro, a blank line, then one row per agent.
    const tail = systemText.slice(catalogStart).split('\n')
    const kept: string[] = []
    for (const [index, line] of tail.entries()) {
      if (index < 4 || line.startsWith('- `agent_')) kept.push(line)
      else break
    }
    const catalogText = kept.join('\n')
    expect(kept.filter(line => line.startsWith('- `agent_'))).toHaveLength(count)
    const catalogBytes = Buffer.byteLength(catalogText, 'utf8')

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      measurement: 'first-model-request',
      section: CATALOG_SECTION,
      agents: count,
      generatedToolSchemaBytes: generatedBytes,
      bytesPerGeneratedTool: perTool,
      catalogSectionBytes: catalogBytes,
      totalAddedBytes: generatedBytes + catalogBytes,
      allToolCount: tools.length,
      allToolSchemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    }))
  })
}
