import { describe, expect, test } from 'vitest'
import {
  DiagnosticSink,
  MAX_SURFACED_DIAGNOSTICS,
  errorsOf,
  renderLine,
  renderReport,
  renderSurfacedDiagnostics,
  renderWebNotice,
  sanitizeForPrompt,
} from '../../src/diagnostics.ts'
import type { Diagnostic } from '../../src/types.ts'

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
