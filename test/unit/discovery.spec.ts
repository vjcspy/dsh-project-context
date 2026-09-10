import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import { DEFAULT_BOUNDS, discover, findProjectRoot, globalAgentsDir, resolveBounds } from '../../src/discovery.ts'
import type { ResourceBounds } from '../../src/types.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(): { root: string; project: string; global: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-agents-unit-'))
  roots.push(root)
  const project = join(root, 'repo')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(join(project, '.dsh', 'agents'), { recursive: true })
  const global = join(root, 'home', 'agents')
  mkdirSync(global, { recursive: true })
  return { root, project, global }
}

function write(directory: string, name: string, frontmatter: string, body = 'Persona body.'): string {
  const path = join(directory, `${name}.md`)
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}\n`, 'utf8')
  return path
}

function run(cwd: string, global: string, bounds: ResourceBounds = DEFAULT_BOUNDS) {
  const sink = new DiagnosticSink()
  const result = discover(cwd, { globalAgentsDir: global }, bounds, sink, {})
  return { result, diagnostics: sink.drain() }
}

describe('project root resolution', () => {
  test('walks up to the nearest ancestor holding .git', () => {
    const { project } = tree()
    const nested = join(project, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    expect(findProjectRoot(nested)).toBe(project)
  })

  test('a relative cwd resolves to no project root', () => {
    expect(findProjectRoot('relative/path')).toBeUndefined()
  })

  test('global definitions still load when no project root exists', () => {
    const { global } = tree()
    write(global, 'shared', 'name: shared\ndescription: Global helper.')
    const outside = mkdtempSync(join(tmpdir(), 'dsh-project-agents-nogit-'))
    roots.push(outside)
    const { result } = run(outside, global)
    expect(result.projectRoot).toBeUndefined()
    expect(result.files.map(file => file.fields.name)).toEqual(['shared'])
  })
})

describe('global directory resolution', () => {
  test('an explicit override wins', () => {
    expect(globalAgentsDir({ globalAgentsDir: '/x/agents' }, {})).toBe('/x/agents')
  })

  test('DSH_HOME is honoured', () => {
    expect(globalAgentsDir({}, { DSH_HOME: '/scratch/dsh' })).toBe(join('/scratch/dsh', 'agents'))
  })

  test('an empty DSH_HOME falls back to the home directory', () => {
    expect(globalAgentsDir({}, { DSH_HOME: '' })).toContain(join('.dsh', 'agents'))
  })
})

describe('precedence and shadowing', () => {
  test('a project definition shadows the global one of the same name', () => {
    const { project, global } = tree()
    const projectPath = write(join(project, '.dsh', 'agents'), 'analyst', 'name: analyst\ndescription: Project analyst.')
    const globalPath = write(global, 'analyst', 'name: analyst\ndescription: Global analyst.')
    const { result, diagnostics } = run(project, global)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.path).toBe(projectPath)
    expect(result.files[0]?.layer).toBe('project')
    expect(diagnostics.some(entry => entry.path === globalPath && entry.reason.includes('shadowed'))).toBe(true)
  })

  test('layers merge when names differ', () => {
    const { project, global } = tree()
    write(join(project, '.dsh', 'agents'), 'analyst', 'name: analyst\ndescription: Project analyst.')
    write(global, 'reviewer', 'name: reviewer\ndescription: Global reviewer.')
    const { result } = run(project, global)
    expect(result.files.map(file => file.fields.name).sort()).toEqual(['analyst', 'reviewer'])
  })

  test('the filename does not decide identity — `name` does', () => {
    const { project, global } = tree()
    write(join(project, '.dsh', 'agents'), 'zzz', 'name: analyst\ndescription: Project analyst.')
    write(global, 'analyst', 'name: analyst\ndescription: Global analyst.')
    const { result } = run(project, global)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.layer).toBe('project')
  })

  test('two files in the same layer claiming one name are reported, not last-wins', () => {
    const { project, global } = tree()
    write(join(project, '.dsh', 'agents'), 'a-first', 'name: analyst\ndescription: One.')
    write(join(project, '.dsh', 'agents'), 'b-second', 'name: analyst\ndescription: Two.')
    const { result, diagnostics } = run(project, global)
    expect(result.files).toHaveLength(1)
    expect(diagnostics.some(entry => entry.reason.includes('duplicate agent name'))).toBe(true)
  })

  test('non-markdown files and subdirectories are ignored', () => {
    const { project, global } = tree()
    const agents = join(project, '.dsh', 'agents')
    writeFileSync(join(agents, 'notes.txt'), 'ignored', 'utf8')
    mkdirSync(join(agents, 'nested.md'), { recursive: true })
    write(agents, 'analyst', 'name: analyst\ndescription: Project analyst.')
    const { result } = run(project, global)
    expect(result.files.map(file => file.fields.name)).toEqual(['analyst'])
  })

  test('an invalid file is skipped with a diagnostic while its siblings still load', () => {
    const { project, global } = tree()
    const agents = join(project, '.dsh', 'agents')
    const broken = write(agents, 'broken', 'name: Broken Name\ndescription: d')
    write(agents, 'analyst', 'name: analyst\ndescription: Project analyst.')
    const { result, diagnostics } = run(project, global)
    expect(result.files.map(file => file.fields.name)).toEqual(['analyst'])
    expect(diagnostics.some(entry => entry.path === broken)).toBe(true)
  })
})

describe('caps', () => {
  test('maxAgents truncates deterministically and reports every drop', () => {
    const { project, global } = tree()
    const agents = join(project, '.dsh', 'agents')
    for (let i = 0; i < 5; i++) write(agents, `a${String(i)}`, `name: a${String(i)}\ndescription: d${String(i)}`)
    const { result, diagnostics } = run(project, global, { ...DEFAULT_BOUNDS, maxAgents: 2 })
    expect(result.files.map(file => file.fields.name)).toEqual(['a0', 'a1'])
    expect(diagnostics.filter(entry => entry.reason.includes('2-agent cap'))).toHaveLength(3)
  })

  test('a file above the per-file byte cap is skipped, not truncated', () => {
    const { project, global } = tree()
    const agents = join(project, '.dsh', 'agents')
    write(agents, 'big', 'name: big\ndescription: d', 'x'.repeat(4096))
    write(agents, 'small', 'name: small\ndescription: d')
    const { result, diagnostics } = run(project, global, { ...DEFAULT_BOUNDS, maxFileBytes: 512 })
    expect(result.files.map(file => file.fields.name)).toEqual(['small'])
    expect(diagnostics.some(entry => entry.reason.includes('per-file cap'))).toBe(true)
  })

  test('the total byte cap stops the scan with a diagnostic', () => {
    const { project, global } = tree()
    const agents = join(project, '.dsh', 'agents')
    for (let i = 0; i < 4; i++) {
      write(agents, `a${String(i)}`, `name: a${String(i)}\ndescription: d`, 'y'.repeat(400))
    }
    const { result, diagnostics } = run(project, global, { ...DEFAULT_BOUNDS, maxTotalBytes: 900 })
    expect(result.files.length).toBeLessThan(4)
    expect(diagnostics.some(entry => entry.reason.includes('total definition bytes'))).toBe(true)
  })
})

describe('bounds validation', () => {
  test('defaults apply when nothing is configured', () => {
    expect(resolveBounds({})).toEqual(DEFAULT_BOUNDS)
  })

  test.each([
    ['maxAgents', 0],
    ['maxAgents', -1],
    ['maxFileBytes', 1.5],
    ['maxTotalBytes', Number.NaN],
  ])('%s = %s fails loud at load', (key, value) => {
    expect(() => resolveBounds({ [key]: value })).toThrow(/positive safe integer/)
  })
})
