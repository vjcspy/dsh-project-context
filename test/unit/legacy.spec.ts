/**
 * The legacy MCP row parser.
 *
 * These rows are the migration INPUT: they are read once, seeded into the
 * namespace, and then retired. The parser is read-only by construction, so
 * what this spec pins is the translation — a row that loses its headers would
 * silently drop a credential out of the migration.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { legacyPatchPaths, scanLegacyPatch, toEntry } from '../../src/mcp/legacy.ts'

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake `$DSH_HOME` holding one home layer and one profile layer. */
function makeHome(userLayer: string, profileLayer?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-'))
  made.push(home)
  writeFileSync(join(home, 'cordis.patch.yml'), userLayer, 'utf8')
  if (profileLayer !== undefined) {
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), profileLayer, 'utf8')
  }
  return home
}

/** The retired generated block: one `insert` list holding all four servers. */
const GENERATED_BLOCK = `# >>> dsh-movein
- insert:
    - id: mcp-monolith
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: mcp-monolith
        url: http://localhost:3845/mcp
    - id: mcp-doccontext
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: mcp-doccontext
        url: https://mcp.context7.com/mcp
        headers:
          CONTEXT7_API_KEY: ctx7-secret
    - id: mcp-pinchtab
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: mcp-pinchtab
        command: pinchtab
        args: [mcp]
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: mcp-playwright
        command: npx
        args: ['@playwright/mcp@latest']
# <<< dsh-movein
`

test('reads every server out of the generated block, secret included', () => {
  const home = makeHome(GENERATED_BLOCK)
  const scan = scanLegacyPatch({ home, profile: 'web' })

  expect(scan.problems).toEqual([])
  expect(scan.rows.map(row => row.id)).toEqual(['mcp-monolith', 'mcp-doccontext', 'mcp-pinchtab', 'mcp-playwright'])

  const doccontext = scan.rows.find(row => row.id === 'mcp-doccontext')
  expect(doccontext?.entry.headers).toEqual({ CONTEXT7_API_KEY: 'ctx7-secret' })
  expect(doccontext?.entry.url).toBe('https://mcp.context7.com/mcp')
  expect(doccontext?.entry.transport).toBe('streamable-http')
  // The stdio branch carries no HTTP fields, so a seeded entry validates.
  expect(doccontext?.entry.command).toBe('')

  const playwright = scan.rows.find(row => row.id === 'mcp-playwright')
  expect(playwright?.entry.command).toBe('npx')
  expect(playwright?.entry.args).toEqual(['@playwright/mcp@latest'])
  expect(playwright?.entry.url).toBe('')
})

test('reads a bare row and ignores rows of other plugins', () => {
  const home = makeHome(`- id: something-else
  name: '@deepseek-ai/dsh-other-plugin'
- id: mcp-solo
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: mcp-solo
    command: echo
`)
  const scan = scanLegacyPatch({ home, profile: undefined })
  expect(scan.rows.map(row => row.id)).toEqual(['mcp-solo'])
})

test('applies the layer order the loader uses and reports unreadable layers', () => {
  const home = makeHome('- id: home-row\n  name: nope\n', '- id: profile-row\n  name: nope\n')
  const paths = legacyPatchPaths({ home, profile: 'web' })
  expect(paths[1]).toBe(join(home, 'cordis.patch.yml'))

  // A malformed layer is a reported problem, never a thrown migration.
  writeFileSync(paths[0] ?? '', 'name: [unclosed\n', 'utf8')
  const scan = scanLegacyPatch({ home, profile: 'web' })
  expect(scan.problems.some(problem => problem.includes('profiles'))).toBe(true)
  expect(scan.sources).toContain(paths[1])
})

test('a disabled row and an incomplete config are not migrated', () => {
  const home = makeHome(`- insert:
    - id: mcp-off
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        transport: stdio
        serverName: mcp-off
        command: echo
    - id: mcp-noconfig
      name: '@deepseek-ai/dsh-mcp-client'
`)
  const scan = scanLegacyPatch({ home, profile: undefined })
  expect(scan.rows).toEqual([])
  expect(scan.problems.some(problem => problem.includes('mcp-noconfig'))).toBe(true)
})

test('an unknown transport is refused rather than migrated as something else', () => {
  expect(toEntry('row', { serverName: 'x', transport: 'websocket' })).toBeUndefined()
  expect(toEntry('row', { transport: 'stdio', serverName: 'x', command: '' })).toBeUndefined()
  expect(toEntry('row', { transport: 'stdio', serverName: 'x', command: 'echo', env: { A: 1 } })).toBeUndefined()
})
