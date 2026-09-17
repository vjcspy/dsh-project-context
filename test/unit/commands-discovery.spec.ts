/**
 * Unit coverage for the tri-state commands scan: deterministic ordering, both
 * caps, and the `absent` / `unavailable` distinction. A missing directory is an
 * ordinary "there are no project commands" (no diagnostic), while an unreadable
 * one is an undetermined state that must be reported.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_COMMAND_BOUNDS,
  PROJECT_COMMANDS_SUBDIR,
  commandsDirectoryFor,
  resolveCommandBounds,
  scanCommands,
} from '../../src/commands-discovery.ts'
import type { CommandScanBounds } from '../../src/commands-discovery.ts'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import { digestOf } from '../../src/rules-discovery.ts'
import type { Config } from '../../src/types.ts'

const BOUNDS: CommandScanBounds = {
  maxCommands: DEFAULT_COMMAND_BOUNDS.maxCommands,
  maxCommandFileBytes: DEFAULT_COMMAND_BOUNDS.maxCommandFileBytes,
}

const roots: string[] = []

// Running as root defeats the permission bits, so the unreadable-directory
// assertions are skipped there rather than passing for the wrong reason.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, '.dsh', 'commands'), 0o755) } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true })
  }
})

interface Project {
  readonly root: string
  readonly commandsDir: string
  write(name: string, body: string): string
}

function project(label = 'commands', options: { readonly makeCommandsDir?: boolean } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), `dsh-commands-${label}-`))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  const commandsDir = join(root, '.dsh', 'commands')
  if (options.makeCommandsDir !== false) mkdirSync(commandsDir, { recursive: true })
  return {
    root,
    commandsDir,
    write(name, body) {
      const path = join(commandsDir, name)
      writeFileSync(path, body, 'utf8')
      return path
    },
  }
}

function scan(cwd: string, config: Config = {}, bounds: CommandScanBounds = BOUNDS) {
  const sink = new DiagnosticSink()
  return { result: scanCommands(cwd, config, bounds, sink), diagnostics: sink.drain() }
}

describe('bounds resolution', () => {
  test('defaults apply when nothing is configured', () => {
    expect(resolveCommandBounds({})).toEqual(DEFAULT_COMMAND_BOUNDS)
  })

  test('explicit overrides win', () => {
    expect(resolveCommandBounds({ maxCommands: 1, maxCommandFileBytes: 2, maxExpandedBytes: 3 }))
      .toEqual({ maxCommands: 1, maxCommandFileBytes: 2, maxExpandedBytes: 3 })
  })

  test.each([0, -1, 1.5, Number.NaN])('a nonsense cap fails loud at load: %s', (value) => {
    expect(() => resolveCommandBounds({ maxCommands: value })).toThrow(/positive safe integer/)
  })

  test('an explicit null is a configuration error, not a request for the default', () => {
    // `?? default` would silently accept this; `Object.hasOwn` does not.
    expect(() => resolveCommandBounds({ maxCommands: null } as unknown as Config)).toThrow(/maxCommands/)
    expect(() => resolveCommandBounds({ maxExpandedBytes: null } as unknown as Config)).toThrow(/maxExpandedBytes/)
  })
})

describe('ordering and contents', () => {
  test('files are listed sorted by filename regardless of write order', () => {
    const p = project('order')
    p.write('20-second.md', 'second body\n')
    p.write('10-first.md', 'first body\n')
    p.write('30-third.md', 'third body\n')
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('present')
    expect(result.projectRoot).toBe(p.root)
    expect(result.directory).toBe(join(p.root, PROJECT_COMMANDS_SUBDIR))
    expect(result.files.map(file => file.scope)).toEqual(['10-first.md', '20-second.md', '30-third.md'])
    expect(result.files.map(file => file.body)).toEqual(['first body\n', 'second body\n', 'third body\n'])
    expect(diagnostics).toEqual([])
  })

  test('a non-.md entry is ignored silently', () => {
    const p = project('nonmd')
    p.write('notes.txt', 'ignored')
    p.write('README', 'ignored')
    p.write('real.md', 'kept')
    const { result, diagnostics } = scan(p.root)
    expect(result.files.map(file => file.scope)).toEqual(['real.md'])
    expect(diagnostics).toEqual([])
  })

  test('a directory named x.md is ignored, not reported', () => {
    const p = project('subdir')
    mkdirSync(join(p.commandsDir, 'nested.md'), { recursive: true })
    writeFileSync(join(p.commandsDir, 'nested.md', 'inner.md'), 'hidden', 'utf8')
    p.write('top.md', 'kept')
    const { result, diagnostics } = scan(p.root)
    expect(result.files.map(file => file.scope)).toEqual(['top.md'])
    expect(diagnostics).toEqual([])
  })

  test('commandsSubdir redirects discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-commands-subdir-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'a.md'), 'custom body', 'utf8')
    const { result } = scan(root, { commandsSubdir: 'custom' })
    expect(result.directory).toBe(join(root, 'custom'))
    expect(result.files.map(file => file.body)).toEqual(['custom body'])
    expect(commandsDirectoryFor(root, {})).toBe(join(root, PROJECT_COMMANDS_SUBDIR))
  })
})

describe('caps', () => {
  test('maxCommands keeps the first N by filename and diagnoses each drop', () => {
    const p = project('maxcommands')
    for (const name of ['a', 'b', 'c', 'd']) p.write(`${name}.md`, name)
    const { result, diagnostics } = scan(p.root, {}, { maxCommands: 2, maxCommandFileBytes: 1024 })
    expect(result.files.map(file => file.scope)).toEqual(['a.md', 'b.md'])
    expect(diagnostics.map(entry => entry.path.endsWith('c.md') || entry.path.endsWith('d.md')))
      .toEqual([true, true])
    expect(diagnostics.every(entry => /above the 2-command cap/.test(entry.reason))).toBe(true)
    expect(diagnostics.every(entry => entry.severity === 'error')).toBe(true)
    expect(diagnostics.every(entry => entry.capability === 'commands')).toBe(true)
  })

  test('a file over the per-file cap is skipped with a diagnostic; the rest still load', () => {
    const p = project('percap')
    p.write('big.md', 'x'.repeat(200))
    p.write('small.md', 'ok')
    const { result, diagnostics } = scan(p.root, {}, { maxCommands: 32, maxCommandFileBytes: 100 })
    expect(result.files.map(file => file.scope)).toEqual(['small.md'])
    expect(diagnostics[0]?.reason).toMatch(/above the 100-byte per-file cap/)
    expect(diagnostics[0]?.severity).toBe('error')
    expect(diagnostics[0]?.capability).toBe('commands')
  })
})

describe('confirmed absence', () => {
  test('a missing .dsh/commands directory is absent, not an error', () => {
    const p = project('missing', { makeCommandsDir: false })
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('absent')
    expect(result.directory).toBe(join(p.root, PROJECT_COMMANDS_SUBDIR))
    expect(result.files).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('no project root means no directory at all, and no diagnostic', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'dsh-commands-orphan-'))
    roots.push(orphan)
    const { result, diagnostics } = scan(orphan)
    expect(result.projectRoot).toBeUndefined()
    expect(result.directory).toBeUndefined()
    expect(result.directoryObservation).toBe('absent')
    expect(result.files).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('a file where the commands directory should be is absent, not unavailable', () => {
    const p = project('notdir', { makeCommandsDir: false })
    mkdirSync(join(p.root, '.dsh'), { recursive: true })
    writeFileSync(join(p.root, '.dsh', 'commands'), 'not a directory', 'utf8')
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('absent')
    expect(diagnostics).toEqual([])
  })
})

describe('undetermined state', () => {
  test.skipIf(IS_ROOT)('an unreadable directory is unavailable, WITH a diagnostic', () => {
    const p = project('locked')
    p.write('a.md', 'body')
    chmodSync(p.commandsDir, 0o000)
    try {
      // Assert the precondition: a test that passes because permissions were
      // ignored proves nothing about the tri-state contract.
      let denied = false
      try { readdirSync(p.commandsDir) } catch { denied = true }
      expect(denied).toBe(true)
      const { result, diagnostics } = scan(p.root)
      expect(result.directoryObservation).toBe('unavailable')
      expect(result.files).toEqual([])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.severity).toBe('error')
      expect(diagnostics[0]?.capability).toBe('commands')
      expect(diagnostics[0]?.path).toBe(p.commandsDir)
      expect(diagnostics[0]?.reason).toMatch(/could not be read/)
    } finally {
      chmodSync(p.commandsDir, 0o755)
    }
  })
})

describe('digest', () => {
  test('the digest is the sha256 of the body', () => {
    const p = project('digest')
    p.write('a.md', 'exact bytes')
    const file = scan(p.root).result.files[0]
    expect(file?.digest).toBe(digestOf('exact bytes'))
    expect(file?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(file?.digest).toBe(digestOf(file?.body ?? ''))
  })

  test('an identical rewrite yields an identical digest', () => {
    const p = project('stable')
    const path = p.write('a.md', 'BODY-A')
    const before = scan(p.root).result.files[0]?.digest
    writeFileSync(path, 'BODY-A', 'utf8')
    expect(scan(p.root).result.files[0]?.digest).toBe(before)
  })

  test('a same-length rewrite with different content changes the digest', () => {
    const p = project('changed')
    const path = p.write('a.md', 'AAAAA')
    const before = scan(p.root).result.files[0]
    writeFileSync(path, 'BBBBB', 'utf8')
    const after = scan(p.root).result.files[0]
    expect(after?.stamp?.size).toBe(before?.stamp?.size)
    expect(after?.digest).not.toBe(before?.digest)
    expect(after?.body).toBe('BBBBB')
  })
})
