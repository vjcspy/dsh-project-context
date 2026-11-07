/**
 * The settings-write guard for managed MCP servers.
 *
 * The schema covers shape and bounds; the per-transport and cross-entry rules
 * live in `validateManagerConfig`, which the plugin runs from an
 * `internal/config` listener so a settings write is refused before it persists
 * (`ConfigEditor.edit` calls `fiber.resolveConfig(next)` before writing).
 *
 * The candidate is raw JSON, which is what a settings write hands over, and the
 * assertion is the validator's own message. A listener that never runs lets
 * the candidate through, and one that runs inside the schema resolver throws
 * on the raw `servers` array instead, so both regressions fail here.
 */

import { afterEach, expect, test } from 'vitest'
import * as ProjectAgents from '../../src/index.ts'
import { boot } from './harness.ts'
import type { Booted } from './harness.ts'

let booted: Booted | undefined
const owned: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  for (const fiber of owned.splice(0).reverse()) await fiber.dispose()
  await booted?.dispose()
  booted = undefined
})

test('a settings candidate whose MCP servers break a per-transport rule is refused', async () => {
  booted = await boot({}, { deferPlugin: true })
  const fiber = await booted.ctx.plugin(ProjectAgents, {})
  owned.push(fiber)
  const server = { id: 'one', serverName: 'fixture', transport: 'stdio', command: 'node' }
  const candidate = { mcp: { servers: [server, { ...server, id: 'two' }] } }
  expect(() => fiber.resolveConfig(candidate)).toThrow(
    'mcp servers: servers[1].serverName "fixture" duplicates servers[0].serverName',
  )
})
