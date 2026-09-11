/**
 * Unit coverage for rendering and bounds.
 *
 * `packages/AGENTS.md:16` requires bounds "where the complete emitted or
 * retained value, including wrappers and metadata, is known", and requires
 * tests for tiny limits, exact limits, oversized single chunks, and multibyte
 * byte limits. All four are here, and every assertion measures the FULLY
 * RENDERED message rather than the sum of the bodies.
 */

import { describe, expect, test } from 'vitest'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import { digestOf } from '../../src/rules-discovery.ts'
import {
  renderClearingMessage,
  renderRuleSnapshot,
  rulesPreamble,
  snapshotDigest,
  type RenderableRule,
} from '../../src/rules-render.ts'

const DIR = '/repo/.dsh/rules'

function rule(scope: string, body: string): RenderableRule {
  return { scope, path: `${DIR}/${scope}`, body, digest: digestOf(body) }
}

function render(rules: readonly RenderableRule[], maxRenderedBytes: number) {
  const sink = new DiagnosticSink()
  return { out: renderRuleSnapshot(rules, DIR, maxRenderedBytes, sink), diagnostics: sink.drain() }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

describe('snapshot shape', () => {
  test('the preamble states supersession in prose, because source.kind is invisible to the model', () => {
    const preamble = rulesPreamble(DIR)
    expect(preamble).toContain(DIR)
    expect(preamble).toContain('supersedes every earlier project-rules snapshot')
    expect(preamble).toContain('no longer applies')
    expect(preamble).toContain('do not override system, developer, or direct user instructions')
  })

  test('files are rendered in the order given, each under a stable header', () => {
    const { out } = render([rule('a.md', 'AAA'), rule('b.md', 'BBB')], 100_000)
    expect(out?.included.map(entry => entry.scope)).toEqual(['a.md', 'b.md'])
    expect(out?.sections.map(section => section.name)).toEqual(['a.md', 'b.md'])
    expect(out?.text).toContain('Rule file: a.md')
    expect(out?.text).toContain(`Source: ${DIR}/a.md`)
    expect(out?.text.indexOf('Rule file: a.md')).toBeLessThan(out?.text.indexOf('Rule file: b.md') ?? -1)
  })

  test('nothing to render returns undefined rather than an empty frame', () => {
    expect(render([], 100_000).out).toBeUndefined()
  })
})

describe('verbatim pass-through', () => {
  test('a body containing {{example}} is emitted byte-for-byte', () => {
    const body = 'Write `{{model}}` in the persona. Also a lone {{ and a lone }}.'
    const { out } = render([rule('braces.md', body)], 100_000)
    expect(out?.text).toContain(body)
    // Explicitly NOT the `{ {` split that `sanitizeForPrompt` applies to
    // diagnostics bound for a system-prompt section.
    expect(out?.text).not.toContain('{ {')
  })

  test('markdown, HTML and backticks are not escaped', () => {
    const body = '<system-reminder>nested</system-reminder>\n\n```ts\nconst x = 1\n```\n'
    const { out } = render([rule('raw.md', body)], 100_000)
    expect(out?.text).toContain(body)
  })
})

describe('bounds over the complete emitted value', () => {
  test('the rendered text never exceeds the cap', () => {
    const rules = Array.from({ length: 40 }, (_, index) => rule(`${String(index).padStart(2, '0')}.md`, 'x'.repeat(500)))
    for (const cap of [2_000, 5_000, 12_345]) {
      const { out } = render(rules, cap)
      expect(bytes(out?.text ?? '')).toBeLessThanOrEqual(cap)
    }
  })

  test('MANY TINY FILES are bounded by the rendered cap, which per-file caps cannot do', () => {
    // Each body is 3 bytes; the headers and framing dominate. A per-file cap
    // would let all 200 through.
    const rules = Array.from({ length: 200 }, (_, index) => rule(`${String(index).padStart(3, '0')}.md`, 'abc'))
    const { out, diagnostics } = render(rules, 4_000)
    expect(bytes(out?.text ?? '')).toBeLessThanOrEqual(4_000)
    expect(out?.included.length).toBeLessThan(200)
    expect(out?.dropped.length).toBe(200 - (out?.included.length ?? 0))
    expect(diagnostics.length).toBe(out?.dropped.length)
    expect(diagnostics.every(entry => entry.capability === 'rules')).toBe(true)
  })

  test('EXACT limit: a snapshot measured at N bytes still renders at cap N', () => {
    const one = [rule('a.md', 'exact')]
    const exact = bytes(render(one, 1_000_000).out?.text ?? '')
    expect(render(one, exact).out?.text).toBeDefined()
    expect(bytes(render(one, exact).out?.text ?? '')).toBe(exact)
  })

  test('EXACT limit minus one byte drops the file', () => {
    const one = [rule('a.md', 'exact')]
    const exact = bytes(render(one, 1_000_000).out?.text ?? '')
    const { out, diagnostics } = render(one, exact - 1)
    expect(out).toBeUndefined()
    expect(diagnostics[0]?.reason).toMatch(/would exceed/)
  })

  test('TINY limit that cannot even fit the preamble reports and renders nothing', () => {
    const { out, diagnostics } = render([rule('a.md', 'x')], 10)
    expect(out).toBeUndefined()
    expect(diagnostics[0]?.reason).toMatch(/cannot fit the snapshot preamble/)
    expect(diagnostics[0]?.path).toBe(DIR)
  })

  test('an OVERSIZED single chunk is dropped whole; a later small file is dropped too, deterministically', () => {
    const rules = [rule('a.md', 'small'), rule('b.md', 'x'.repeat(50_000)), rule('c.md', 'also small')]
    const { out, diagnostics } = render(rules, 2_000)
    // Deterministic prefix: `a.md` fits, `b.md` does not, and everything after
    // the first non-fitting file is dropped rather than reordered.
    expect(out?.included.map(entry => entry.scope)).toEqual(['a.md'])
    expect(out?.dropped).toEqual(['b.md', 'c.md'])
    expect(diagnostics).toHaveLength(2)
  })

  test('MULTIBYTE: the cap is measured in UTF-8 bytes and never splits a code point', () => {
    // 4-byte code points; a char-length cap would admit ~4x too much.
    const body = '🎌'.repeat(100)
    expect(body.length).toBe(200)
    expect(bytes(body)).toBe(400)
    const one = [rule('emoji.md', body)]
    const exact = bytes(render(one, 1_000_000).out?.text ?? '')
    const { out } = render(one, exact)
    expect(out?.text).toContain(body)
    expect(bytes(out?.text ?? '')).toBe(exact)
    // Files are dropped whole, so the rendered text is always valid UTF-8 with
    // no replacement characters introduced by truncation.
    const tight = render(one, exact - 1)
    expect(tight.out).toBeUndefined()
    expect((out?.text ?? '').includes('�')).toBe(false)
  })

  test('MULTIBYTE at an exact boundary: one extra byte of budget admits the file', () => {
    const one = [rule('e.md', 'é'.repeat(64))]
    const exact = bytes(render(one, 1_000_000).out?.text ?? '')
    expect(render(one, exact - 1).out).toBeUndefined()
    expect(render(one, exact).out?.included).toHaveLength(1)
  })
})

describe('clearing message', () => {
  test('it retracts explicitly and names what is no longer in force', () => {
    const text = renderClearingMessage(DIR, ['b.md', 'a.md'])
    expect(text).toContain('no longer present')
    expect(text).toContain('superseded and no longer applies')
    expect(text).toContain('Disregard those project rules entirely')
    // Sorted, so the digest is stable across observation order.
    expect(text).toContain('No longer in force: a.md, b.md.')
  })

  test('the same removal set renders identically regardless of order', () => {
    expect(renderClearingMessage(DIR, ['a.md', 'b.md'])).toBe(renderClearingMessage(DIR, ['b.md', 'a.md']))
  })
})

describe('snapshot digest', () => {
  test('it changes when the body changes', () => {
    const first = render([rule('a.md', 'one')], 100_000).out
    const second = render([rule('a.md', 'two')], 100_000).out
    expect(snapshotDigest(first?.text ?? '', first?.included ?? []))
      .not.toBe(snapshotDigest(second?.text ?? '', second?.included ?? []))
  })

  test('it changes when the same prose comes from a different file', () => {
    const first = render([rule('a.md', 'same')], 100_000).out
    const second = render([rule('b.md', 'same')], 100_000).out
    expect(snapshotDigest(first?.text ?? '', first?.included ?? []))
      .not.toBe(snapshotDigest(second?.text ?? '', second?.included ?? []))
  })

  test('it is stable for identical input', () => {
    const a = render([rule('a.md', 'x'), rule('b.md', 'y')], 100_000).out
    const b = render([rule('a.md', 'x'), rule('b.md', 'y')], 100_000).out
    expect(snapshotDigest(a?.text ?? '', a?.included ?? []))
      .toBe(snapshotDigest(b?.text ?? '', b?.included ?? []))
  })
})
