import { describe, expect, test } from 'vitest'
import { findInterpolationHazard, MAX_DESCRIPTION_CHARS, parseAgentFile } from '../../src/frontmatter.ts'

const PATH = '/tmp/project/.dsh/agents/analyst.md'

function file(frontmatter: string, body = '\nYou are the analyst.\n'): string {
  return `---\n${frontmatter}\n---\n${body}`
}

function reject(text: string): { reason: string; field?: string; line?: number; column?: number } {
  const result = parseAgentFile(PATH, text)
  if (result.ok) throw new Error(`expected a rejection, got ${JSON.stringify(result.fields)}`)
  return {
    reason: result.diagnostic.reason,
    ...(result.diagnostic.field === undefined ? {} : { field: result.diagnostic.field }),
    ...(result.diagnostic.location === undefined
      ? {}
      : { line: result.diagnostic.location.line, column: result.diagnostic.location.column }),
  }
}

function accept(text: string) {
  const result = parseAgentFile(PATH, text)
  if (!result.ok) throw new Error(`expected acceptance, got ${result.diagnostic.reason}`)
  return result.fields
}

describe('defaults', () => {
  test('a minimal file materializes every default', () => {
    const fields = accept(file('name: analyst\ndescription: Reads code.'))
    expect(fields).toMatchObject({
      name: 'analyst',
      description: 'Reads code.',
      transport: 'spawn',
      background: 'one-shot',
      maxDepth: 3,
    })
    expect(fields.persona).toContain('You are the analyst.')
    expect(fields.llm).toBeUndefined()
    expect(fields.tools).toBeUndefined()
  })

  test('a full file maps every supported key', () => {
    const fields = accept(file([
      'name: reviewer',
      'description: Reviews diffs.',
      'transport: fork',
      'background: continuable',
      'maxDepth: 1',
      'llm:',
      '  provider: deepseek',
      '  model: deepseek-chat',
      '  reasoningEffort: high',
      'tools:',
      '  allow: [read, grep]',
      '  deny: [write]',
    ].join('\n')))
    expect(fields).toMatchObject({
      name: 'reviewer',
      transport: 'fork',
      background: 'continuable',
      maxDepth: 1,
      llm: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      tools: { allow: ['read', 'grep'], deny: ['write'] },
    })
  })

  test('CRLF line endings and a leading BOM parse', () => {
    const text = `﻿---\r\nname: analyst\r\ndescription: Reads code.\r\n---\r\nBody text.\r\n`
    expect(accept(text).name).toBe('analyst')
  })
})

describe('structural rejections', () => {
  test('a file without frontmatter is rejected', () => {
    expect(reject('# analyst\n\nno frontmatter here').reason).toContain('missing a leading `---`')
  })

  test('an unclosed frontmatter block is rejected', () => {
    expect(reject('---\nname: analyst\n').reason).toContain('missing a leading `---`')
  })

  test('invalid YAML is rejected with a position', () => {
    const rejection = reject(file('name: analyst\n  description: [unclosed'))
    expect(rejection.reason).toContain('invalid YAML frontmatter')
    expect(rejection.line).toBeGreaterThan(0)
  })

  test('a non-mapping frontmatter is rejected', () => {
    expect(reject(file('- analyst')).reason).toContain('must be a YAML mapping')
  })

  test('an unknown top-level key is rejected rather than ignored', () => {
    expect(reject(file('name: analyst\ndescription: d\nmodel: gpt')).reason)
      .toContain('unknown frontmatter key "model"')
  })

  test('an empty body is rejected', () => {
    expect(reject(file('name: analyst\ndescription: d', '\n   \n')).field).toBe('body')
  })
})

describe('field validation', () => {
  test.each([
    ['name missing', 'description: d', '`name` is required'],
    ['name not a string', 'name: 12\ndescription: d', '`name` is required'],
    ['name uppercase', 'name: Analyst\ndescription: d', '`name` must match'],
    ['name with a space', 'name: code review\ndescription: d', '`name` must match'],
    ['name with a slash', 'name: a/b\ndescription: d', '`name` must match'],
    ['name too long', `name: ${'a'.repeat(49)}\ndescription: d`, 'at most 48 characters'],
    ['description missing', 'name: analyst', '`description` is required'],
    ['description empty', 'name: analyst\ndescription: "   "', '`description` is required'],
    ['transport invalid', 'name: analyst\ndescription: d\ntransport: codex', '`transport` must be one of'],
    ['background invalid', 'name: analyst\ndescription: d\nbackground: forever', '`background` must be one of'],
    ['llm not a mapping', 'name: analyst\ndescription: d\nllm: deepseek', 'must be a mapping'],
    ['llm without model', 'name: analyst\ndescription: d\nllm:\n  provider: deepseek', 'both required'],
    ['llm unknown key', 'name: analyst\ndescription: d\nllm:\n  provider: p\n  model: m\n  temp: 1', 'unknown key "temp"'],
    ['tools empty', 'name: analyst\ndescription: d\ntools: {}', 'names neither `allow` nor `deny`'],
    ['tools allow not an array', 'name: analyst\ndescription: d\ntools:\n  allow: read', 'must be an array'],
    ['tools allow empty', 'name: analyst\ndescription: d\ntools:\n  allow: []', 'must not be empty'],
    ['tools allow non-string', 'name: analyst\ndescription: d\ntools:\n  allow: [1]', 'non-empty tool-name strings'],
    ['tools unknown key', 'name: analyst\ndescription: d\ntools:\n  ban: [x]', 'unknown key "ban"'],
  ])('%s is rejected', (_label, frontmatter, expected) => {
    expect(reject(file(frontmatter)).reason).toContain(expected)
  })

  test('a description above the cap is rejected', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_CHARS + 1)
    expect(reject(file(`name: analyst\ndescription: ${long}`)).reason)
      .toContain(`at most ${String(MAX_DESCRIPTION_CHARS)} characters`)
  })

  test('a multi-line description is rejected — it becomes one catalog row', () => {
    expect(reject(file('name: analyst\ndescription: |\n  first\n  second')).reason)
      .toContain('must be a single line')
  })
})

describe('maxDepth resolution', () => {
  test('omission resolves to the explicit default 3, never to capless', () => {
    expect(accept(file('name: a\ndescription: d')).maxDepth).toBe(3)
  })

  test('0 is preserved and forbids delegation', () => {
    expect(accept(file('name: a\ndescription: d\nmaxDepth: 0')).maxDepth).toBe(0)
  })

  test('provider-managed is preserved', () => {
    expect(accept(file('name: a\ndescription: d\nmaxDepth: provider-managed')).maxDepth).toBe('provider-managed')
  })

  test.each([
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['a string', 'unlimited'],
    ['null', 'null'],
  ])('%s is rejected rather than silently degraded', (_label, value) => {
    expect(reject(file(`name: a\ndescription: d\nmaxDepth: ${value}`)).field).toBe('maxDepth')
  })
})

describe('interpolation guard', () => {
  test.each([
    ['a balanced simple reference', 'Use {{cwd}} here.'],
    ['a malformed reference', 'Use {{ not a name }} here.'],
    ['an empty reference', 'Use {{}} here.'],
    ['a Vue/Handlebars fragment in prose', 'Render {{ item.name }} in the template.'],
  ])('%s in the body is rejected', (_label, body) => {
    const rejection = reject(file('name: a\ndescription: d', `\n${body}\n`))
    expect(rejection.field).toBe('body')
    expect(rejection.line).toBeGreaterThan(0)
    expect(rejection.column).toBeGreaterThan(0)
  })

  test('a lone `{{` with no later `}}` is literal prose and accepted', () => {
    expect(accept(file('name: a\ndescription: d', '\nAn unclosed {{ is literal prose.\n')).persona)
      .toContain('{{')
  })

  test('a hazard in the description is rejected — the catalog puts it in a section', () => {
    const rejection = reject(file('name: a\ndescription: Handles {{name}} templates.'))
    expect(rejection.field).toBe('description')
    expect(rejection.reason).toContain('balanced')
  })

  test('findInterpolationHazard reports the offset of the offending open brace', () => {
    expect(findInterpolationHazard('safe')).toBe(-1)
    expect(findInterpolationHazard('a {{ b')).toBe(-1)
    expect(findInterpolationHazard('a {{b}} c')).toBe(2)
  })
})
