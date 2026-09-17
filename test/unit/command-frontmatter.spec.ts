/**
 * Unit coverage for command-file frontmatter validation.
 *
 * The contract is deliberately narrower than Claude Code's: only `description`
 * and `argument-hint` are understood, the name comes from the FILENAME so the
 * `/` menu and the filesystem cannot disagree, and every rejection is an
 * `error` tagged with the `commands` capability so the aggregated banner can
 * select the right noun.
 */

import { describe, expect, test } from 'vitest'
import {
  DEFAULT_ARGUMENT_HINT,
  MAX_ARGUMENT_HINT_CHARS,
  MAX_COMMAND_DESCRIPTION_CHARS,
  parseCommandFile,
} from '../../src/command-frontmatter.ts'
import type { Diagnostic } from '../../src/types.ts'

const DIR = '/tmp/project/.dsh/commands'

function pathFor(name: string): string {
  return `${DIR}/${name}`
}

function file(frontmatter: string, body = '\nRun the deploy.\n'): string {
  return `---\n${frontmatter}\n---\n${body}`
}

function accept(name: string, frontmatter: string, body?: string) {
  const result = parseCommandFile(pathFor(name), file(frontmatter, body))
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.diagnostic.reason}`)
  return result.fields
}

function reject(name: string, frontmatter: string, body?: string): Diagnostic {
  const result = parseCommandFile(pathFor(name), file(frontmatter, body))
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result.fields)}`)
  return result.diagnostic
}

function rejectRaw(name: string, raw: string): Diagnostic {
  const result = parseCommandFile(pathFor(name), raw)
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result.fields)}`)
  return result.diagnostic
}

describe('acceptance', () => {
  test('a minimal file materializes the default argument hint', () => {
    expect(accept('deploy', 'description: Deploy the app to production.')).toEqual({
      name: 'deploy',
      description: 'Deploy the app to production.',
      hint: DEFAULT_ARGUMENT_HINT,
      body: '\nRun the deploy.\n',
    })
  })

  test('an explicit argument-hint is used verbatim', () => {
    const fields = accept('deploy', 'description: d\nargument-hint: "[target] [--dry-run]"')
    expect(fields.hint).toBe('[target] [--dry-run]')
    expect(fields.hint).not.toBe(DEFAULT_ARGUMENT_HINT)
  })

  test('a description exactly at the cap and a hint exactly at the cap are accepted', () => {
    const description = 'x'.repeat(MAX_COMMAND_DESCRIPTION_CHARS)
    const hint = 'y'.repeat(MAX_ARGUMENT_HINT_CHARS)
    const fields = accept('deploy', `description: ${description}\nargument-hint: "${hint}"`)
    expect(fields.description).toHaveLength(MAX_COMMAND_DESCRIPTION_CHARS)
    expect(fields.hint).toHaveLength(MAX_ARGUMENT_HINT_CHARS)
  })

  test('the body is NOT brace-checked — it is delivered verbatim as a user message', () => {
    // Unlike an agent persona, a command body never enters a system-prompt
    // section, so the interpolation hazard does not apply to it.
    const body = '\nUse {{ not a variable }} here.\n'
    expect(accept('deploy', 'description: d', body).body).toBe(body)
  })
})

describe('structural rejections', () => {
  test('a file without frontmatter is rejected', () => {
    const rejection = rejectRaw('deploy.md', '# deploy\n\nno frontmatter here\n')
    expect(rejection.reason).toContain('missing a leading `---`')
  })

  test('a missing description is rejected', () => {
    const rejection = reject('deploy', 'argument-hint: "[target]"')
    expect(rejection.field).toBe('description')
    expect(rejection.reason).toContain('`description` is required')
  })

  test.each([
    ['an empty string', 'description: ""'],
    ['whitespace only', 'description: "   "'],
  ])('%s description is rejected', (_label, frontmatter) => {
    const rejection = reject('deploy', frontmatter)
    expect(rejection.field).toBe('description')
    expect(rejection.reason).toContain('non-empty string')
  })

  test('a multi-line description is rejected', () => {
    const rejection = reject('deploy', 'description: |\n  first\n  second')
    expect(rejection.field).toBe('description')
    expect(rejection.reason).toContain('must be a single line')
  })

  test('a description one character over the cap is rejected', () => {
    const long = 'x'.repeat(MAX_COMMAND_DESCRIPTION_CHARS + 1)
    const rejection = reject('deploy', `description: ${long}`)
    expect(rejection.reason).toContain(`at most ${String(MAX_COMMAND_DESCRIPTION_CHARS)} characters`)
  })

  test('an unknown frontmatter key is rejected rather than ignored', () => {
    const rejection = reject('deploy', 'description: d\nallowed-tools: [Bash]')
    expect(rejection.reason).toContain('unknown frontmatter key "allowed-tools"')
  })

  test('an argument-hint over the cap is rejected', () => {
    const hint = 'y'.repeat(MAX_ARGUMENT_HINT_CHARS + 1)
    const rejection = reject('deploy', `description: d\nargument-hint: "${hint}"`)
    expect(rejection.field).toBe('argument-hint')
    expect(rejection.reason).toContain(`at most ${String(MAX_ARGUMENT_HINT_CHARS)} characters`)
  })

  test('a balanced reference in the description is rejected', () => {
    const rejection = reject('deploy', 'description: Handles {{name}} templates.')
    expect(rejection.field).toBe('description')
    expect(rejection.reason).toContain('balanced')
  })

  test('a missing body is rejected', () => {
    const rejection = reject('deploy', 'description: d', '')
    expect(rejection.field).toBe('body')
    expect(rejection.reason).toContain('body is empty')
  })

  test('a whitespace-only body is rejected', () => {
    const rejection = reject('deploy', 'description: d', '\n   \n\t\n')
    expect(rejection.field).toBe('body')
  })
})

describe('the filename is the command name', () => {
  test.each(['Bad-Name.md', '1bad.md', 'bad name.md', 'bad.name.md'])(
    'an illegal name derived from %s is rejected',
    (name) => {
      const rejection = rejectRaw(name, file('description: A valid description.'))
      expect(rejection.field).toBe('name')
      expect(rejection.reason).toContain('filename must yield a command name')
    },
  )

  test.each(['a.md', 'a-b_c.md', 'debate-proposer.md'])('%s is accepted', (name) => {
    expect(accept(name, 'description: A valid description.').name).toBe(name.replace(/\.md$/u, ''))
  })

  test('declaring `name` in frontmatter is rejected — the path is authoritative', () => {
    const rejection = reject('deploy', 'name: something-else\ndescription: d')
    expect(rejection.reason).toContain('unknown frontmatter key "name"')
  })
})

describe('capability tagging', () => {
  const REJECTIONS: readonly (readonly [string, string])[] = [
    ['deploy.md', '# no frontmatter'],
    ['deploy.md', file('argument-hint: "[x]"')],
    ['deploy.md', file('description: d\nmodel: gpt')],
    ['deploy.md', file('description: d', '')],
    ['Bad-Name.md', file('description: d')],
    ['deploy.md', `description: ${'x'.repeat(MAX_COMMAND_DESCRIPTION_CHARS + 1)}`],
  ]

  test.each(REJECTIONS)('%s is an error for the commands capability', (name, raw) => {
    const rejection = rejectRaw(name, raw)
    expect(rejection.severity).toBe('error')
    expect(rejection.capability).toBe('commands')
    expect(rejection.path).toBe(pathFor(name))
    expect(rejection.reason.length).toBeGreaterThan(0)
  })
})
