/**
 * Unit coverage for the tri-state rules scan: ordering, caps, and every Phase 1
 * edge case. The tri-state contract is the subject here — `absent` and
 * `unavailable` must never be conflated, because only the former may retract a
 * rule and supersession is durable.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import {
  DEFAULT_RULE_BOUNDS,
  classifyFsError,
  digestOf,
  resolveRuleBounds,
  scanRules,
} from '../../src/rules-discovery.ts'
import type { Config, ResourceBounds } from '../../src/types.ts'

const BOUNDS: Pick<ResourceBounds, 'maxRules' | 'maxRuleFileBytes'> = {
  maxRules: DEFAULT_RULE_BOUNDS.maxRules,
  maxRuleFileBytes: DEFAULT_RULE_BOUNDS.maxRuleFileBytes,
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, '.dsh', 'rules'), 0o755) } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true })
  }
})

interface Project {
  readonly root: string
  readonly rulesDir: string
  write(name: string, body: string): string
}

function project(label = 'rules', options: { readonly makeRulesDir?: boolean } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), `dsh-rules-${label}-`))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  const rulesDir = join(root, '.dsh', 'rules')
  if (options.makeRulesDir !== false) mkdirSync(rulesDir, { recursive: true })
  return {
    root,
    rulesDir,
    write(name, body) {
      const path = join(rulesDir, name)
      writeFileSync(path, body, 'utf8')
      return path
    },
  }
}

function scan(cwd: string, config: Config = {}, bounds = BOUNDS) {
  const sink = new DiagnosticSink()
  return { result: scanRules(cwd, config, bounds, sink), diagnostics: sink.drain() }
}

describe('bounds resolution', () => {
  test('defaults apply when nothing is configured', () => {
    expect(resolveRuleBounds({})).toEqual(DEFAULT_RULE_BOUNDS)
  })

  test('an explicit null is a configuration error, not a request for the default', () => {
    // `?? default` would silently accept this; `Object.hasOwn` does not.
    expect(() => resolveRuleBounds({ maxRules: null } as unknown as Config)).toThrow(/maxRules/)
  })

  test.each([0, -1, 1.5, Number.NaN])('a nonsense cap fails loud at load: %s', (value) => {
    expect(() => resolveRuleBounds({ maxRules: value })).toThrow(/positive safe integer/)
  })
})

describe('error classification', () => {
  test('only ENOENT and ENOTDIR confirm absence', () => {
    expect(classifyFsError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('absent')
    expect(classifyFsError(Object.assign(new Error('x'), { code: 'ENOTDIR' }))).toBe('absent')
  })

  test.each(['EACCES', 'EIO', 'ELOOP', 'EMFILE', undefined])(
    'everything else leaves the state undetermined: %s',
    (code) => {
      const error = code === undefined ? new Error('x') : Object.assign(new Error('x'), { code })
      expect(classifyFsError(error)).toBe('unavailable')
    },
  )
})

describe('ordering and contents', () => {
  test('flat *.md files load sorted by filename, verbatim', () => {
    const p = project('order')
    p.write('20-second.md', 'second body\n')
    p.write('10-first.md', 'first body\n')
    p.write('30-third.md', 'third body\n')
    const { result } = scan(p.root)
    expect(result.directoryObservation).toBe('present')
    expect(result.files.map(file => file.scope)).toEqual(['10-first.md', '20-second.md', '30-third.md'])
    expect(result.files.map(file => file.body)).toEqual(['first body\n', 'second body\n', 'third body\n'])
  })

  test('bodies are hashed on every pass and the digest matches the content', () => {
    const p = project('digest')
    p.write('a.md', 'exact bytes')
    const { result } = scan(p.root)
    expect(result.files[0]?.digest).toBe(digestOf('exact bytes'))
  })

  test('the advisory metadata stamp is recorded but is not the change detector', () => {
    const p = project('stamp')
    const path = p.write('a.md', 'AAAAA')
    const before = scan(p.root).result.files[0]
    expect(before?.stamp?.size).toBe(5)
    expect(before?.stamp?.ino).toBeGreaterThan(0)

    // Same length, different content, mtime restored: the (path, size, mtime)
    // tuple compares equal, which is exactly the blind spot the digest closes.
    const stamp = before?.stamp
    writeFileSync(path, 'BBBBB', 'utf8')
    const seconds = Number(stamp?.mtimeNs ?? 0n) / 1e9
    utimesSync(path, seconds, seconds)
    const after = scan(p.root).result.files[0]
    expect(after?.stamp?.size).toBe(before?.stamp?.size)
    expect(after?.digest).not.toBe(before?.digest)
  })
})

describe('confirmed absence', () => {
  test('a missing .dsh/rules directory is absent, not an error', () => {
    const p = project('missing', { makeRulesDir: false })
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('absent')
    expect(result.files).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('no project root is absent, not an error', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'dsh-rules-orphan-'))
    roots.push(orphan)
    const { result, diagnostics } = scan(orphan)
    expect(result.projectRoot).toBeUndefined()
    expect(result.directory).toBeUndefined()
    expect(result.directoryObservation).toBe('absent')
    expect(diagnostics).toEqual([])
  })

  test('an empty directory is present with zero files', () => {
    const p = project('empty')
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('present')
    expect(result.files).toEqual([])
    expect(diagnostics).toEqual([])
  })

  test('a file where the rules directory should be is absent, not unavailable', () => {
    const p = project('notdir', { makeRulesDir: false })
    mkdirSync(join(p.root, '.dsh'), { recursive: true })
    writeFileSync(join(p.root, '.dsh', 'rules'), 'not a directory', 'utf8')
    expect(scan(p.root).result.directoryObservation).toBe('absent')
  })
})

describe('undetermined state', () => {
  test('an unreadable directory is unavailable and says the rules stay in force', () => {
    const p = project('nodir')
    p.write('a.md', 'body')
    chmodSync(p.rulesDir, 0o000)
    // Assert the precondition: a test that passes because permissions were
    // ignored proves nothing about the tri-state contract.
    let denied = false
    try { readdirSync(p.rulesDir) } catch { denied = true }
    expect(denied).toBe(true)
    const { result, diagnostics } = scan(p.root)
    expect(result.directoryObservation).toBe('unavailable')
    expect(diagnostics[0]?.reason).toMatch(/stays in force/)
    expect(diagnostics[0]?.capability).toBe('rules')
  })

  test('an unreadable file is reported as unavailable, not dropped', () => {
    const p = project('nofile')
    const path = p.write('locked.md', 'secret')
    p.write('open.md', 'visible')
    chmodSync(path, 0o000)
    let denied = false
    try { readFileSync(path, 'utf8') } catch { denied = true }
    expect(denied).toBe(true)
    const { result, diagnostics } = scan(p.root)
    const locked = result.files.find(file => file.scope === 'locked.md')
    expect(locked?.observation).toBe('unavailable')
    expect(locked?.body).toBeUndefined()
    expect(result.files.find(file => file.scope === 'open.md')?.body).toBe('visible')
    expect(diagnostics.some(entry => /last known content stays in force/.test(entry.reason))).toBe(true)
    chmodSync(path, 0o644)
  })

  test('a broken symlink resolves to confirmed absence, not to unavailable', () => {
    const p = project('brokenlink')
    symlinkSync(join(p.rulesDir, 'nowhere.md'), join(p.rulesDir, 'dangling.md'))
    const { result } = scan(p.root)
    // stat follows the link, gets ENOENT, and the entry simply is not there.
    expect(result.files.map(file => file.scope)).toEqual([])
  })
})

describe('bounds and skipping', () => {
  test('a file over the per-file cap is skipped with a diagnostic; the rest still load', () => {
    const p = project('percap')
    p.write('big.md', 'x'.repeat(200))
    p.write('small.md', 'ok')
    const { result, diagnostics } = scan(p.root, {}, { maxRules: 32, maxRuleFileBytes: 100 })
    expect(result.files.map(file => file.scope)).toEqual(['small.md'])
    expect(diagnostics[0]?.reason).toMatch(/above the 100-byte per-file cap/)
    expect(diagnostics[0]?.capability).toBe('rules')
  })

  test('maxRules keeps the first N by filename and diagnoses each drop', () => {
    const p = project('maxrules')
    for (const name of ['a', 'b', 'c', 'd']) p.write(`${name}.md`, name)
    const { result, diagnostics } = scan(p.root, {}, { maxRules: 2, maxRuleFileBytes: 1024 })
    expect(result.files.map(file => file.scope)).toEqual(['a.md', 'b.md'])
    expect(diagnostics.map(entry => entry.path.endsWith('c.md') || entry.path.endsWith('d.md')))
      .toEqual([true, true])
    expect(diagnostics.every(entry => /above the 2-rule cap/.test(entry.reason))).toBe(true)
  })

  test('a non-.md file is ignored silently', () => {
    const p = project('nonmd')
    p.write('notes.txt', 'ignored')
    p.write('README', 'ignored')
    p.write('real.md', 'kept')
    const { result, diagnostics } = scan(p.root)
    expect(result.files.map(file => file.scope)).toEqual(['real.md'])
    expect(diagnostics).toEqual([])
  })

  test('a subdirectory is ignored, not recursed and not an error', () => {
    const p = project('subdir')
    mkdirSync(join(p.rulesDir, 'nested.md'), { recursive: true })
    writeFileSync(join(p.rulesDir, 'nested.md', 'inner.md'), 'hidden', 'utf8')
    mkdirSync(join(p.rulesDir, 'plain'), { recursive: true })
    p.write('top.md', 'kept')
    const { result, diagnostics } = scan(p.root)
    expect(result.files.map(file => file.scope)).toEqual(['top.md'])
    expect(diagnostics).toEqual([])
  })

  test('a file that is empty after trim contributes nothing and needs no action', () => {
    const p = project('blank')
    p.write('blank.md', '   \n\n\t\n')
    p.write('real.md', 'kept')
    const { result, diagnostics } = scan(p.root)
    expect(result.files.map(file => file.scope)).toEqual(['real.md'])
    expect(diagnostics).toEqual([])
  })
})

describe('verbatim content', () => {
  test('a rule documenting {{example}} is loaded unchanged', () => {
    const p = project('braces')
    const body = 'Use `{{model}}` and `{{cwd}}` in a persona. A stray {{ is fine too.\n'
    p.write('braces.md', body)
    expect(scan(p.root).result.files[0]?.body).toBe(body)
  })

  test('multibyte content survives byte-for-byte', () => {
    const p = project('utf8')
    const body = 'Quy tắc: không dùng `git checkout`. 日本語テキスト。🎌\n'
    p.write('utf8.md', body)
    const file = scan(p.root).result.files[0]
    expect(file?.body).toBe(body)
    expect(file?.stamp?.size).toBe(Buffer.byteLength(body, 'utf8'))
  })
})

describe('configuration', () => {
  test('rulesSubdir redirects discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rules-subdir-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'a.md'), 'custom body', 'utf8')
    const { result } = scan(root, { rulesSubdir: 'custom' })
    expect(result.files.map(file => file.body)).toEqual(['custom body'])
  })
})
