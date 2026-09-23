import { describe, expect, test } from 'vitest'
import {
  CAPABILITY_LABELS,
  DiagnosticSink,
  MAX_SURFACED_DIAGNOSTICS,
  MCP_HEALTH_DOM_ID,
  MCP_HEALTH_POLL_MS,
  MCP_HEALTH_ROUTE,
  capabilityOf,
  errorsOf,
  forCapability,
  noticeDomId,
  renderLine,
  renderMcpHealthScript,
  renderReport,
  renderSurfacedDiagnostics,
  renderWebNotice,
  replaceCapability,
  sanitizeForPrompt,
} from '../../src/diagnostics.ts'
import type { Capability, Diagnostic } from '../../src/types.ts'

const CAPABILITIES: readonly Capability[] = ['agents', 'rules', 'commands']

function diagnostic(over: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: 'error', path: '/repo/.dsh/agents/broken.md', reason: 'invalid YAML frontmatter', ...over }
}

describe('severity', () => {
  test('a notice is not something the operator has to act on', () => {
    const entries = [
      diagnostic({ severity: 'notice', reason: 'shadowed by the project definition' }),
      diagnostic({ reason: 'unknown frontmatter key "bogus"' }),
    ]
    expect(errorsOf(entries).map(entry => entry.reason)).toEqual(['unknown frontmatter key "bogus"'])
  })

  test('the sink preserves insertion order and drains a copy', () => {
    const sink = new DiagnosticSink()
    sink.add(diagnostic({ reason: 'first' }))
    sink.add(diagnostic({ reason: 'second' }))
    expect(sink.isEmpty).toBe(false)
    const drained = sink.drain()
    expect(drained.map(entry => entry.reason)).toEqual(['first', 'second'])
    expect(sink.drain()).toEqual(drained)
  })
})

describe('host-log report', () => {
  test('nothing recorded means nothing reported', () => {
    expect(renderReport([], 0, '/repo')).toBeUndefined()
  })

  test('errors are counted as skipped and notices are counted separately', () => {
    const report = renderReport([
      diagnostic({ reason: 'unknown key' }),
      diagnostic({ severity: 'notice', reason: 'shadowed' }),
    ], 1, '/repo')
    expect(report).toContain('1 agent definition skipped for cwd "/repo" (1 mounted); 1 notice')
    expect(report).toContain('error: /repo/.dsh/agents/broken.md: unknown key')
    expect(report).toContain('notice: /repo/.dsh/agents/broken.md: shadowed')
  })

  test('the location and field are rendered when known', () => {
    const line = renderLine(diagnostic({ field: 'maxDepth', location: { line: 7, column: 3 } }))
    expect(line).toBe('error: /repo/.dsh/agents/broken.md:7:3 [maxDepth]: invalid YAML frontmatter')
  })
})

describe('prompt safety', () => {
  test('a balanced reference is broken apart rather than removed', () => {
    expect(sanitizeForPrompt('Renders {{name}} templates.')).toBe('Renders { {name} } templates.')
    expect(sanitizeForPrompt('Renders {{name}} templates.')).not.toContain('{{')
  })

  test('runs of braces cannot reassemble a pair', () => {
    for (const text of ['{{{', '}}}', '{{{{', 'a}}}}b', '{{x}}{{y}}']) {
      expect(sanitizeForPrompt(text)).not.toContain('{{')
      expect(sanitizeForPrompt(text)).not.toContain('}}')
    }
  })

  test('text with no braces is untouched', () => {
    expect(sanitizeForPrompt('plain reason')).toBe('plain reason')
  })
})

describe('surfaced block', () => {
  test('a roster with no errors surfaces nothing', () => {
    expect(renderSurfacedDiagnostics([diagnostic({ severity: 'notice' })])).toEqual([])
  })

  test('a reason quoting `{{ … }}` is surfaced without a balanced reference', () => {
    const lines = renderSurfacedDiagnostics([
      diagnostic({ reason: 'contains a balanced `{{ \u2026 }}` reference, which assembly rejects' }),
    ])
    expect(lines).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('{{')
    expect(lines.join('\n')).not.toContain('}}')
    expect(lines[0]).toContain('balanced')
  })

  test('the block is capped and says how many rows it dropped', () => {
    const entries = Array.from(
      { length: MAX_SURFACED_DIAGNOSTICS + 3 },
      (_unused, index) => diagnostic({ reason: `reason ${String(index)}` }),
    )
    const lines = renderSurfacedDiagnostics(entries)
    expect(lines).toHaveLength(MAX_SURFACED_DIAGNOSTICS + 1)
    expect(lines.at(-1)).toContain('and 3 more skipped definition(s)')
  })

  test('a very long reason is truncated', () => {
    const lines = renderSurfacedDiagnostics([diagnostic({ reason: 'x'.repeat(500) })])
    expect(lines[0]?.length).toBeLessThan(500)
  })
})

describe('web notice', () => {
  test('no errors means no banner', () => {
    expect(renderWebNotice([{ cwd: '/repo', diagnostics: [diagnostic({ severity: 'notice' })] }])).toBeUndefined()
  })

  test('the banner names the cwd and the offending file', () => {
    const script = renderWebNotice([{ cwd: '/repo', diagnostics: [diagnostic()] }])
    expect(script).toBeDefined()
    expect(script).toContain('/repo')
    expect(script).toContain('broken.md')
  })

  test('the payload cannot close the script element or inject markup', () => {
    const script = renderWebNotice([{
      cwd: '/repo',
      diagnostics: [diagnostic({ path: '/repo/.dsh/agents/</script><img src=x onerror=alert(1)>.md' })],
    }])
    expect(script).toBeDefined()
    expect(script).not.toContain('</script')
    expect(script).not.toContain('<img')
    expect(script).toContain('\\u003c')
  })
})

describe('per-capability slices', () => {
  // One cwd's diagnostics carry all three capabilities at once, and each pass
  // retracts only its own slice. The hand-written version of this replaced the
  // whole list with `capability === 'rules'`, which erased the commands slice on
  // every Agent creation.
  const agentsEntry = diagnostic({ reason: 'missing a leading `---`' })
  const rulesEntry = diagnostic({ capability: 'rules', path: '/repo/.dsh/rules/a.md', reason: 'body is empty' })
  const commandsEntry = diagnostic({ capability: 'commands', path: '/repo/.dsh/commands/deploy.md', reason: 'body is empty' })

  test('an untagged diagnostic belongs to agents', () => {
    expect(capabilityOf(agentsEntry)).toBe('agents')
    expect(capabilityOf(rulesEntry)).toBe('rules')
    expect(capabilityOf(commandsEntry)).toBe('commands')
  })

  test('an agents re-scan retracts only the agents slice', () => {
    const fresh = diagnostic({ capability: 'agents', reason: 're-scanned agents entry' })
    const merged = replaceCapability([agentsEntry, rulesEntry, commandsEntry], 'agents', [fresh])
    expect(merged).toContain(rulesEntry)
    expect(merged).toContain(commandsEntry)
    expect(merged).not.toContain(agentsEntry)
    expect(forCapability(merged, 'agents')).toEqual([fresh])
    expect(forCapability(merged, 'rules')).toEqual([rulesEntry])
    expect(forCapability(merged, 'commands')).toEqual([commandsEntry])
  })

  test('a commands re-scan retracts only the commands slice', () => {
    const merged = replaceCapability([agentsEntry, rulesEntry, commandsEntry], 'commands', [])
    expect(merged).toContain(agentsEntry)
    expect(merged).toContain(rulesEntry)
    expect(merged).not.toContain(commandsEntry)
    expect(forCapability(merged, 'commands')).toEqual([])
  })

  test('every capability has a distinct, non-empty label set', () => {
    const labels = CAPABILITIES.map(capability => CAPABILITY_LABELS[capability])
    for (const label of labels) {
      expect(label.unit.length).toBeGreaterThan(0)
      expect(label.plural.length).toBeGreaterThan(0)
      expect(label.retainedVerb.length).toBeGreaterThan(0)
      expect(label.unit).not.toContain('{{')
    }
    expect(new Set(labels.map(label => label.unit)).size).toBe(CAPABILITIES.length)
    expect(new Set(labels.map(label => label.retainedVerb)).size).toBe(CAPABILITIES.length)
  })

  test('every capability paints a distinct banner', () => {
    const ids = CAPABILITIES.map(capability => noticeDomId(capability))
    expect(new Set(ids).size).toBe(CAPABILITIES.length)
    expect(ids.every(id => id.length > 0)).toBe(true)
  })

  test('the report uses the commands noun rather than the agents noun', () => {
    const report = renderReport([commandsEntry], 2, '/repo', 'commands')
    expect(report).toContain('1 command file skipped for cwd "/repo" (2 registered)')
    expect(report).not.toContain('agent definition')
    expect(renderReport([rulesEntry], 1, '/repo', 'rules')).toContain('1 rule file skipped')
  })
})

describe('MCP health banner script', () => {
  test('it carries the route, the DOM id and the poll interval', () => {
    const script = renderMcpHealthScript()
    expect(script).toContain(MCP_HEALTH_ROUTE)
    expect(script).toContain(MCP_HEALTH_DOM_ID)
    expect(script).toContain(String(MCP_HEALTH_POLL_MS))
    expect(script).toContain('"role", "alert"')
    expect(script).toContain('Dismiss')
  })

  test('it is idempotent across index renders through a window sentinel, not getElementById', () => {
    // An element-based guard cannot dedupe this script: the element legitimately
    // does not exist while every server is healthy, so a re-render would stack a
    // second timer on every page load.
    const script = renderMcpHealthScript()
    expect(script).toContain('window[key]')
    expect(script).not.toContain('getElementById(id)) return')
    expect(script).toContain('setInterval')
  })

  test('every DOM write goes through textContent, never innerHTML', () => {
    const script = renderMcpHealthScript()
    expect(script).not.toContain('innerHTML')
    expect(script).toContain('textContent')
  })

  test('the whole body is contained, so a DOM or CSP failure cannot break the page', () => {
    const script = renderMcpHealthScript()
    expect(script.startsWith(';(() => {')).toBe(true)
    expect(script.endsWith('})();')).toBe(true)
    expect(script).toContain('} catch {}')
    expect(script).toContain('.catch(() => {})')
  })

  test('the embedded payload cannot close the script element', () => {
    const script = renderMcpHealthScript()
    expect(script).not.toContain('</script')
    expect(script).not.toContain('<')
  })

  test('a Dismiss is remembered until the set of down servers changes', () => {
    const script = renderMcpHealthScript()
    expect(script).toContain('dismissed = current')
    // The key is the sorted server names, so a NEW outage re-shows the banner.
    expect(script).toContain('.sort()')
  })
})
