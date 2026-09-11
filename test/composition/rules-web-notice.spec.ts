/**
 * The web GUI banner for RULES diagnostics.
 *
 * `renderWebNotice` was already unit-tested as a pure function, but nothing
 * asserted that a *rules* diagnostic actually reaches `webserver/index-inject`
 * and lands in the served index HTML. It did not: the handler in `index.ts`
 * called `renderWebNotice(groups)` with no capability argument, the parameter
 * defaults to `'agents'`, and the renderer filters the groups to that
 * capability — so every rules diagnostic was dropped on the floor. This file
 * is the regression guard for that fix.
 *
 * Two things make the rules banner different from the agents one and are
 * asserted separately:
 *
 * - Rules diagnostics are recorded during `agent/pre-step`, not at
 *   `agent/created`, so the banner is empty until a session has actually run
 *   in that cwd. Booting alone proves nothing.
 * - Each capability owns its own DOM id, so the two banners must both survive
 *   one render rather than one suppressing the other through the script's own
 *   `getElementById` guard.
 *
 * Boundary asserted here, stated exactly: the real `webserver/index-inject`
 * emit over the real plugin, passed to the host's own exported
 * `renderIndexInjections`. That is the same pair `WebServer.renderIndex`
 * composes (`packages/host/webserver/src/index.ts:347-361`), but the
 * `WebServer` service itself is NOT mounted and no socket is bound here — the
 * live profile check covers the served-over-HTTP half. The browser executing
 * the injected script and painting the DOM is NOT asserted anywhere: no DOM is
 * instantiated in this file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as ProjectContext from '../../src/index.ts'
import { noticeDomId, renderWebNotice } from '../../src/diagnostics.ts'
import type { Diagnostic } from '../../src/types.ts'
import type { Config } from '../../src/types.ts'

/** A minimal index document, shaped the way the real one is consumed. */
const INDEX_HTML = '<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>'

class ProbeAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let disposers: Array<() => Promise<unknown>> = []
const roots: string[] = []

afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  disposers = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Booted {
  readonly ctx: Context
  readonly root: string
  createAgent(id: string): Promise<Agent>
  prompt(agent: Agent, text: string): Promise<void>
  /** The served index HTML, through the host's own injection collection + renderer. */
  servedIndex(): string
  /** The raw injection table the host would collect right now. */
  injections(): IndexInjection[]
}

/**
 * Boot with a project whose rules directory holds the given files.
 * @param label - temp-directory hint.
 * @param files - filename → body, written into `.dsh/rules`.
 * @param config - plugin entry configuration.
 * @param agents - filename → body, written into `.dsh/agents`.
 */
async function boot(
  label: string,
  files: Record<string, string>,
  config: Config = {},
  agents: Record<string, string> = {},
): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), `dsh-webnotice-${label}-`))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.dsh', 'rules'), { recursive: true })
  mkdirSync(join(root, '.dsh', 'agents'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.dsh', 'rules', name), body, 'utf8')
  }
  for (const [name, body] of Object.entries(agents)) {
    writeFileSync(join(root, '.dsh', 'agents', name), body, 'utf8')
  }

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  ctx.llm.registerAdapter(['mock'], new ProbeAdapter())
  disposers.push((await ctx.plugin(ProjectContext, { globalAgentsDir: '/nonexistent', ...config })).dispose)
  disposers.push((await ctx.plugin(AgentLoop, { agents: [] })).dispose)

  // The host's own emit. Binding a socket is deliberately avoided — the
  // WebServer service would acquire a port for nothing, and the injection
  // table plus `renderIndexInjections` is exactly what `renderIndex` composes
  // (`packages/host/webserver/src/index.ts:347-361`).
  const injections = (): IndexInjection[] => {
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    return table
  }
  return {
    ctx,
    root,
    injections,
    servedIndex: () => renderIndexInjections(INDEX_HTML, injections()),
    createAgent: id => ctx.agentLoop.create(
      SessionId(id),
      { provider: 'mock', model: 'mock' },
      { cwd: root },
    ),
    async prompt(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

const RULES_DOM_ID = noticeDomId('rules')
const AGENTS_DOM_ID = noticeDomId('agents')

describe('the defect this file guards', () => {
  test('the OLD single-argument call shape drops every rules diagnostic', () => {
    // Pinning the bug rather than describing it. `renderWebNotice(groups)`
    // defaults `capability` to `'agents'` and filters the group to it, so a
    // rules-only group rendered nothing at all — which is exactly what
    // `index.ts` did before the per-capability loop was introduced.
    const rules: Diagnostic[] = [{
      severity: 'error',
      capability: 'rules',
      path: '/repo/.dsh/rules/big.md',
      reason: 'rule file is 5000 bytes, above the 1000-byte per-file cap; skipped',
    }]
    const groups = [{ cwd: '/repo', diagnostics: rules }]
    expect(renderWebNotice(groups)).toBeUndefined()
    expect(renderWebNotice(groups, 'agents')).toBeUndefined()
    // …and renders once the capability is passed, which is the fix.
    expect(renderWebNotice(groups, 'rules')).toContain(noticeDomId('rules'))
  })
})

describe('rules diagnostics reach the served index HTML', () => {
  test('nothing is injected before any session has run', async () => {
    // Rules diagnostics are produced in `agent/pre-step`, so a cold boot has
    // nothing to report even though the offending file is already on disk.
    const booted = await boot('cold', { 'big.md': 'x'.repeat(5_000) }, { maxRuleFileBytes: 1_000 })
    expect(booted.servedIndex()).not.toContain(RULES_DOM_ID)
  })

  test('an oversized rule file lands in the served HTML after one turn', async () => {
    const booted = await boot('oversized', {
      'big.md': 'x'.repeat(5_000),
      'ok.md': 'a fine rule',
    }, { maxRuleFileBytes: 1_000 })
    await booted.prompt(await booted.createAgent('web-notice-oversized'), 'hi')

    const html = booted.servedIndex()
    expect(html).toContain(RULES_DOM_ID)
    expect(html).toContain('big.md')
    expect(html).toContain('above the 1000-byte per-file cap')
    // The noun is the rules one, not "agent definition".
    expect(html).toContain('rule file(s) skipped')
    // The healthy file is not reported.
    expect(html).not.toContain('ok.md')
    // Injected as a body script row, the same shape the agents banner uses.
    const rows = booted.injections()
    const rulesRow = rows.find(row => row.kind === 'script' && row.text.includes(RULES_DOM_ID))
    expect(rulesRow).toBeDefined()
    expect(rulesRow?.placement).toBe('body')
  })

  test('the row is rendered inside the body element, as a real script tag', async () => {
    const booted = await boot('placement', { 'big.md': 'x'.repeat(5_000) }, { maxRuleFileBytes: 1_000 })
    await booted.prompt(await booted.createAgent('web-notice-placement'), 'hi')
    const html = booted.servedIndex()
    // `body` placement means "immediately after the opening body tag"
    // (`packages/host/webserver/src/injections.ts:11`), so the only ordering
    // guarantee is that it sits between <body> and </body>.
    const at = html.indexOf(RULES_DOM_ID)
    expect(at).toBeGreaterThan(html.indexOf('<body>'))
    expect(at).toBeLessThan(html.indexOf('</body>'))
    expect(html).toContain('<script>')
  })

  test('BOTH capabilities can report in one render, under distinct DOM ids', async () => {
    // One suppressing the other is a live risk: the injected script bails on
    // `document.getElementById(id)`, so a shared id would silently hide the
    // second banner.
    const booted = await boot(
      'both',
      { 'big.md': 'x'.repeat(5_000) },
      { maxRuleFileBytes: 1_000 },
      // An agent definition with an invalid transport is skipped with an error.
      { 'broken.md': '---\nname: broken\ndescription: Bad transport.\ntransport: nope\n---\nbody\n' },
    )
    await booted.prompt(await booted.createAgent('web-notice-both'), 'hi')

    const html = booted.servedIndex()
    expect(AGENTS_DOM_ID).not.toBe(RULES_DOM_ID)
    expect(html).toContain(AGENTS_DOM_ID)
    expect(html).toContain(RULES_DOM_ID)
    expect(html).toContain('agent definition(s) skipped')
    expect(html).toContain('rule file(s) skipped')
    expect(booted.injections().filter(row => row.kind === 'script').length).toBeGreaterThanOrEqual(2)
  })

  test('a clean pass reports nothing, so fixing the file takes the banner down', async () => {
    const booted = await boot('clean', { 'ok.md': 'a fine rule' })
    await booted.prompt(await booted.createAgent('web-notice-clean'), 'hi')
    expect(booted.servedIndex()).not.toContain(RULES_DOM_ID)
  })

  test('the payload cannot close the script element or inject markup', async () => {
    // A path-legal filename that still looks like markup. `/` cannot appear in
    // a filename, so the closing-tag half is exercised through the renderer's
    // own `<` escaping rather than through the name.
    const booted = await boot('escape', {
      '<img src=x onerror=alert(1)>.md': 'x'.repeat(5_000),
    }, { maxRuleFileBytes: 1_000 })
    await booted.prompt(await booted.createAgent('web-notice-escape'), 'hi')
    const html = booted.servedIndex()
    expect(html).toContain(RULES_DOM_ID)
    // The diagnostic path is JSON-encoded with `<` escaped, and the DOM is
    // built with textContent, so no live element can appear from the filename
    // and the script element cannot be closed early.
    expect(html).not.toContain('<img')
    expect(html).toContain('\\u003cimg')
    expect(html).toContain('\\u003c')
    // The host's own row contract: an inline script must never carry `</script`.
    const row = booted.injections().find(r => r.kind === 'script' && r.text.includes(RULES_DOM_ID))
    expect(row?.kind === 'script' ? row.text.includes('</script') : true).toBe(false)
  })
})
