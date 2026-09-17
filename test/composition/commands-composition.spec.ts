/**
 * Composition-level proof for the `commands` capability.
 *
 * The claims proven here are the ones unit tests structurally cannot reach:
 *
 * - a registered project command's EXPANDED body actually reaches a model
 *   request through the real agent loop (unit tests can prove `register` was
 *   called, but `ctx.commands.execute()` itself never touches the model);
 * - a command colliding with a first-party name is refused rather than allowed
 *   to shadow it;
 * - unloading the plugin retracts the command.
 *
 * The fixture body is deliberately PLACEHOLDER-FREE, because that is the entire
 * real corpus: 0 of Aweave's thirteen `agent/commands/common/*.md` files carry
 * `$ARGUMENTS`, and they are invoked with arguments. A composition spec built
 * only on a `$ARGUMENTS` fixture would pass while the shipped commands silently
 * dropped every argument.
 */

import { afterEach, expect, test } from 'vitest'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { boot, makeWorkspace, recordedRequests, type Booted, type Workspace } from './harness.ts'

let booted: Booted | undefined
let workspace: Workspace | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  workspace?.dispose()
  workspace = undefined
})

/** Every text block of every recorded request, joined per message. */
function requestedTexts(): string[] {
  const texts: string[] = []
  for (const request of recordedRequests) {
    for (const message of request.messages ?? []) {
      const text = (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (text.length > 0) texts.push(text)
    }
  }
  return texts
}

const COMMAND_BODY = 'Ask the operator which chain they selected. Do not edit any files.\n'
const COMMAND_FILE = `---\ndescription: Brainstorm a change with the operator\n---\n\n${COMMAND_BODY}`

test('a placeholder-free project command delivers its body AND the argument to the model', async () => {
  workspace = makeWorkspace('commands-compose')
  workspace.writeCommand('brainstorm', COMMAND_FILE)
  booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
  const agent = await booted.createAgent('commands-arg', workspace.root)

  const definition = booted.ctx.commands.find(agent, 'brainstorm')
  expect(definition?.definitionId).toBe('dsh-project-context/brainstorm')
  expect(definition?.description).toBe('Brainstorm a change with the operator')
  // The generic default hint: the real corpus sets no `argument-hint` at all.
  expect(definition?.input?.hint).toBe('[arguments]')

  const execution = await booted.ctx.commands.execute(
    agent,
    '/brainstorm Cách 3 — mở rộng plugin của chúng ta',
    [],
    new AbortController().signal,
  )
  expect(execution?.result.kind).toBe('success')
  await agent.whenIdle()

  const carrying = requestedTexts().find(text => text.includes('Do not edit any files.'))
  expect(carrying).toBeDefined()
  // The body arrives verbatim...
  expect(carrying).toContain(COMMAND_BODY.trimEnd())
  // ...and the operator's argument is NOT dropped, separated by exactly one
  // blank line, with no injected marker text.
  expect(carrying?.endsWith('Cách 3 — mở rộng plugin của chúng ta')).toBe(true)
  expect(carrying).toContain(`${COMMAND_BODY.trimEnd()}\n\nCách 3 — mở rộng plugin của chúng ta`)
})

test('a $ARGUMENTS body substitutes in place instead of appending', async () => {
  workspace = makeWorkspace('commands-substitute')
  workspace.writeCommand('plan', '---\ndescription: Plan $ARGUMENTS work\n---\n\nPlan the following: $ARGUMENTS\n')
  booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
  const agent = await booted.createAgent('commands-sub', workspace.root)

  await booted.ctx.commands.execute(agent, '/plan the migration', [], new AbortController().signal)
  await agent.whenIdle()

  const carrying = requestedTexts().find(text => text.includes('Plan the following:'))
  // The token was replaced in place by the trimmed argument. `description` is
  // menu metadata and is deliberately NOT part of the delivered prompt.
  expect(carrying).toContain('Plan the following: the migration')
  // Substituted in place, NOT appended as well: exactly one occurrence.
  expect(carrying?.match(/the migration/gu)).toHaveLength(1)
})

test('a first-party command name is not shadowed by a project command', async () => {
  workspace = makeWorkspace('commands-collision')
  workspace.writeCommand('plan', '---\ndescription: Project plan command\n---\n\nPROJECT PLAN BODY\n')
  booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
  // Stand in for a shipped producer such as `plan-mode`, which registers its
  // own `definitionId` at the plugin level before any Agent exists.
  const disposer = booted.ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'),
    name: 'plan',
    description: 'Shipped plan mode',
    handler: () => ({ kind: 'success' as const }),
  })

  const agent = await booted.createAgent('commands-collision-agent', workspace.root)
  const definition = booted.ctx.commands.find(agent, 'plan')
  // The first-party definition still owns the name; the project file was
  // refused rather than allowed to shadow it.
  expect(definition?.definitionId).toBe('@deepseek-ai/dsh-plan-mode')
  expect(definition?.description).toBe('Shipped plan mode')
  disposer()
})

test('unloading the plugin retracts its commands', async () => {
  workspace = makeWorkspace('commands-unload')
  workspace.writeCommand('brainstorm', COMMAND_FILE)
  booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
  const agent = await booted.createAgent('commands-unload-agent', workspace.root)
  expect(booted.ctx.commands.find(agent, 'brainstorm')).toBeDefined()

  await booted.unloadPlugin()
  expect(booted.ctx.commands.find(agent, 'brainstorm')).toBeUndefined()
})

test('a cwd with no .dsh/commands registers nothing', async () => {
  workspace = makeWorkspace('commands-negative')
  booted = await boot({ globalAgentsDir: '/nonexistent-global-agents' })
  // `writeCommand` is deliberately not called: the directory exists but is empty.
  const agent = await booted.createAgent('commands-negative-agent', workspace.root)
  expect(booted.ctx.commands.find(agent, 'brainstorm')).toBeUndefined()
})

test('the capability can be switched off entirely', async () => {
  workspace = makeWorkspace('commands-disabled')
  workspace.writeCommand('brainstorm', COMMAND_FILE)
  booted = await boot({ commands: false, globalAgentsDir: '/nonexistent-global-agents' })
  const agent = await booted.createAgent('commands-disabled-agent', workspace.root)
  expect(booted.ctx.commands.find(agent, 'brainstorm')).toBeUndefined()
})
