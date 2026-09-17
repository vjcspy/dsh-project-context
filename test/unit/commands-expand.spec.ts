/**
 * Unit coverage for command-body expansion and Agent-scoped registration.
 *
 * The load-bearing property is the two-branch contract. Zero of Aweave's
 * thirteen `agent/commands/common/*.md` files carry `$ARGUMENTS`, yet they ARE
 * invoked with arguments, so a substitute-only expansion would silently drop
 * the operator's text while still delivering a plausible prompt. Both branches
 * are therefore asserted explicitly, together with the byte cap that bounds the
 * COMPLETE emitted value.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { DEFAULT_COMMAND_BOUNDS } from '../../src/commands-discovery.ts'
import {
  ARGUMENTS_TOKEN,
  DEFINITION_ID_PREFIX,
  commandDefinitionId,
  expandCommandBody,
  installCommands,
  toCommandDefinition,
} from '../../src/commands-install.ts'
import type { Diagnostic, ResolvedCommand } from '../../src/types.ts'

const CAP = DEFAULT_COMMAND_BOUNDS.maxExpandedBytes

const LOG = { warn: (): void => { /* captured where a test needs it */ } }

function expanded(body: string, rawInput: string, cap = CAP): string {
  const result = expandCommandBody(body, rawInput, cap)
  if (!result.ok) throw new Error(`expected an expansion, got: ${result.reason}`)
  return result.text
}

function refused(body: string, rawInput: string, cap: number): string {
  const result = expandCommandBody(body, rawInput, cap)
  if (result.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(result.text)}`)
  return result.reason
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('placeholder branch', () => {
  test('the token is substituted in place and the input is NOT appended a second time', () => {
    const text = expanded('Review $ARGUMENTS for bugs.\n', 'src/app.ts')
    expect(text).toBe('Review src/app.ts for bugs.\n')
    expect(occurrences(text, 'src/app.ts')).toBe(1)
    expect(text).not.toContain(`\n\nsrc/app.ts`)
  })

  test('every occurrence of the token is replaced', () => {
    expect(expanded('A $ARGUMENTS B $ARGUMENTS C\n', 'x')).toBe('A x B x C\n')
    expect(expanded('$ARGUMENTS', 'y')).toBe('y')
  })

  test('a token with no input is removed in place — branch 1 wins over branch 2', () => {
    // With no token present the same empty input leaves the body untouched, so
    // the absence of the token here is what proves substitution ran.
    const text = expanded('Before $ARGUMENTS after\n', '')
    expect(text).toBe('Before  after\n')
    expect(text).not.toContain(ARGUMENTS_TOKEN)
  })

  test('the substituted input is trimmed, so a separator space is not doubled', () => {
    expect(expanded('Review $ARGUMENTS now.\n', ' src/app.ts')).toBe('Review src/app.ts now.\n')
  })
})

describe('placeholder-free branch (the real corpus)', () => {
  const CORPUS = '# Deploy\n\nRun the deploy steps.\n\n'

  test('non-empty input is appended after exactly one blank line', () => {
    const text = expanded(CORPUS, 'staging')
    expect(text).toBe('# Deploy\n\nRun the deploy steps.\n\nstaging')
    expect(text.endsWith('\n\nstaging')).toBe(true)
    expect(occurrences(text, 'staging')).toBe(1)
    expect(text).not.toContain('\n\n\n')
  })

  test('the body is preserved verbatim ahead of the appended input', () => {
    const text = expanded(CORPUS, 'staging')
    expect(text).toContain('# Deploy\n\nRun the deploy steps.')
    expect(text.startsWith('# Deploy')).toBe(true)
  })

  test('an empty input leaves the body unchanged', () => {
    expect(expanded(CORPUS, '')).toBe(CORPUS)
  })

  test('a whitespace-only input counts as no input', () => {
    expect(expanded(CORPUS, '   ')).toBe(CORPUS)
    expect(expanded(CORPUS, '\t\n ')).toBe(CORPUS)
  })

  test('the appended input is normalized, never duplicated', () => {
    // `parseCommand` hands the handler the separator whitespace too
    // (`/deploy  --dry-run` yields `"  --dry-run"`), so the input is trimmed
    // before it is appended; the words themselves are kept verbatim.
    const text = expanded('# Deploy\n\nRun the deploy steps.\n', '  --dry-run  ')
    expect(text).toBe('# Deploy\n\nRun the deploy steps.\n\n--dry-run')
    expect(occurrences(text, '--dry-run')).toBe(1)
  })

  test('trailing whitespace of the body is trimmed so the delimiter is one blank line', () => {
    const text = expanded('Body line\n\n\n\t  \n', 'tail')
    expect(text).toBe('Body line\n\ntail')
    expect(text).not.toContain('\n\n\n')
  })
})

describe('expansion cap', () => {
  test('a result over the cap is refused with a reason', () => {
    const reason = refused('x'.repeat(10), 'yyyy', 15)
    expect(reason).toContain('16 bytes')
    expect(reason).toContain('15-byte expansion cap')
  })

  test('a result exactly at the cap is accepted', () => {
    expect(expanded('x'.repeat(10), 'yyyy', 16)).toBe(`${'x'.repeat(10)}\n\nyyyy`)
  })

  test('the cap counts UTF-8 bytes, not characters', () => {
    const body = '\u00e9'.repeat(5) // 5 characters, 10 bytes
    const text = `${body}\n\nok` // 9 characters, 14 bytes
    expect(text).toHaveLength(9)
    expect(Buffer.byteLength(text, 'utf8')).toBe(14)
    // A character-counting bound would accept this; a byte bound must not.
    expect(refused(body, 'ok', 9)).toContain('14 bytes')
    expect(expanded(body, 'ok', 14)).toBe(text)
  })

  test('the cap bounds the substituted result, not the template', () => {
    expect(expanded('$ARGUMENTS', 'x'.repeat(4), 4)).toBe('x'.repeat(4))
    expect(refused('$ARGUMENTS', 'x'.repeat(5), 4)).toContain('5 bytes')
  })
})

function resolved(over: Partial<ResolvedCommand> = {}): ResolvedCommand {
  return {
    name: 'deploy',
    path: '/repo/.dsh/commands/deploy.md',
    description: 'Deploy the app.',
    hint: '[arguments]',
    body: '# Deploy\n\nRun the deploy steps.\n',
    digest: 'digest',
    ...over,
  }
}

function definition(definitionId: string | undefined): CommandDefinition {
  return {
    ...(definitionId === undefined ? {} : { definitionId: CommandDefinitionId(definitionId) }),
    name: 'deploy',
    description: 'A command somebody else owns.',
    handler: () => ({ kind: 'success' }),
  }
}

interface FakeRuntime {
  readonly registered: CommandDefinition[]
  readonly diagnostics: readonly Diagnostic[]
  readonly count: number
}

function install(
  hit: CommandDefinition | undefined,
  options: { readonly failRegister?: boolean } = {},
): FakeRuntime {
  const registered: CommandDefinition[] = []
  const commands = {
    find: (_agent: Agent, _name: string): CommandDefinition | undefined => hit,
    register: (candidate: CommandDefinition): void => {
      if (options.failRegister === true) throw new Error('command "deploy" is already registered in this scope')
      registered.push(candidate)
    },
  }
  const outcome = installCommands({
    agent: {} as unknown as Agent,
    runtimeCtx: { commands } as unknown as Context,
    commands: [resolved()],
    maxExpandedBytes: CAP,
    log: LOG,
  })
  return { registered, diagnostics: outcome.diagnostics, count: outcome.registered }
}

describe('definitions', () => {
  test('the definition carries the plugin-owned id, the name and the hint', () => {
    const built = toCommandDefinition(resolved({ hint: '[target]' }), CAP, LOG)
    expect(String(built.definitionId)).toBe(commandDefinitionId('deploy'))
    expect(String(built.definitionId).startsWith(DEFINITION_ID_PREFIX)).toBe(true)
    expect(built.name).toBe('deploy')
    expect(built.description).toBe('Deploy the app.')
    expect(built.input?.hint).toBe('[target]')
  })
})

describe('registration collisions', () => {
  test('a free name is registered', () => {
    const fake = install(undefined)
    expect(fake.count).toBe(1)
    expect(fake.diagnostics).toEqual([])
    expect(fake.registered.map(entry => entry.name)).toEqual(['deploy'])
  })

  test('our own inherited registration is skipped silently', () => {
    const fake = install(definition(commandDefinitionId('deploy')))
    expect(fake.count).toBe(0)
    expect(fake.diagnostics).toEqual([])
    expect(fake.registered).toEqual([])
  })

  test('an untagged first-party command wins and is reported', () => {
    const fake = install(definition(undefined))
    expect(fake.count).toBe(0)
    expect(fake.registered).toEqual([])
    expect(fake.diagnostics[0]?.severity).toBe('error')
    expect(fake.diagnostics[0]?.capability).toBe('commands')
    expect(fake.diagnostics[0]?.field).toBe('name')
    expect(fake.diagnostics[0]?.reason).toContain('is already provided by a first-party command')
    expect(fake.diagnostics[0]?.reason).toContain('not registered')
  })

  test('a foreign tagged command is named in the diagnostic', () => {
    const fake = install(definition('@deepseek-ai/compact'))
    expect(fake.count).toBe(0)
    expect(fake.diagnostics[0]?.reason).toContain('"@deepseek-ai/compact"')
  })

  test('a throwing registry is reported rather than propagated', () => {
    const fake = install(undefined, { failRegister: true })
    expect(fake.count).toBe(0)
    expect(fake.diagnostics[0]?.capability).toBe('commands')
    expect(fake.diagnostics[0]?.reason).toContain('registration failed')
  })
})
