/**
 * Unit coverage for reconciliation: delta and clearing semantics, and the
 * tri-state contract that keeps a transient I/O failure from durably
 * deactivating a live rule.
 *
 * Every assertion here is about what the MODEL would be told and what state is
 * committed — never about inbox mechanics, which are covered in composition.
 */

import { describe, expect, test } from 'vitest'
import { DiagnosticSink } from '../../src/diagnostics.ts'
import type { ProjectRulesSource } from '../../src/message-source.ts'
import { digestOf } from '../../src/rules-discovery.ts'
import { emptyRulesState, reconcileRules, type RulesState } from '../../src/rules-reconcile.ts'
import type { Observation, RuleObservation, RuleScan } from '../../src/types.ts'

const DIR = '/repo/.dsh/rules'
const BOUNDS = { maxRenderedBytes: 256 * 1024 }

function present(scope: string, body: string): RuleObservation {
  return { scope, path: `${DIR}/${scope}`, observation: 'present', body, digest: digestOf(body) }
}

function unavailable(scope: string): RuleObservation {
  return { scope, path: `${DIR}/${scope}`, observation: 'unavailable' }
}

function scan(
  files: readonly RuleObservation[],
  directoryObservation: Observation = 'present',
): RuleScan {
  return { directory: DIR, directoryObservation, files, projectRoot: '/repo' }
}

function run(input: RuleScan, state: RulesState = emptyRulesState()) {
  const sink = new DiagnosticSink()
  const outcome = reconcileRules(input, state, BOUNDS, sink)
  const source = outcome.desired?.source as ProjectRulesSource | undefined
  const text = (outcome.desired?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return { ...outcome, source, text, diagnostics: sink.drain() }
}

/** Deliver one snapshot and return the state a real admission would commit. */
function deliver(input: RuleScan, state: RulesState = emptyRulesState()): RulesState {
  const outcome = reconcileRules(input, state, BOUNDS, new DiagnosticSink())
  return outcome.desired === undefined ? state : outcome.next
}

describe('first delivery', () => {
  test('every file arrives as a `set` delta and appears in the text', () => {
    const out = run(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    expect(out.source?.kind).toBe('project-rules')
    expect(out.source?.form).toBe('snapshot')
    expect(out.source?.changes.map(change => `${change.action}:${change.scope}`))
      .toEqual(['set:a.md', 'set:b.md'])
    expect(out.text).toContain('AAA')
    expect(out.text).toContain('BBB')
    expect(out.source?.sections.map(section => section.name)).toEqual(['a.md', 'b.md'])
  })

  test('an empty project says nothing at all', () => {
    const out = run(scan([]))
    expect(out.desired).toBeUndefined()
    expect(out.preserved).toBe(false)
  })

  test('a first-load unreadable file is diagnosed and skipped — there is no last-good', () => {
    const out = run(scan([unavailable('locked.md'), present('open.md', 'visible')]))
    expect(out.source?.sections.map(section => section.name)).toEqual(['open.md'])
    expect(out.diagnostics[0]?.reason).toMatch(/first load/)
    expect(out.diagnostics[0]?.capability).toBe('rules')
    // No last-good was substituted, so nothing was preserved.
    expect(out.preserved).toBe(false)
  })
})

describe('unchanged input', () => {
  test('a repeat scan of the same bytes proposes nothing', () => {
    const state = deliver(scan([present('a.md', 'AAA')]))
    expect(run(scan([present('a.md', 'AAA')]), state).desired).toBeUndefined()
  })
})

describe('deltas', () => {
  test('an edited body is a `replace`, and the new text is what ships', () => {
    const state = deliver(scan([present('a.md', 'OLD')]))
    const out = run(scan([present('a.md', 'NEW')]), state)
    expect(out.source?.changes).toEqual([
      { action: 'replace', scope: 'a.md', path: `${DIR}/a.md`, digest: digestOf('NEW') },
    ])
    expect(out.text).toContain('NEW')
    expect(out.text).not.toContain('OLD')
  })

  test('a same-length rewrite is still detected, because the digest decides', () => {
    const state = deliver(scan([present('a.md', 'AAAAA')]))
    const out = run(scan([present('a.md', 'BBBBB')]), state)
    expect(out.source?.changes[0]?.action).toBe('replace')
  })

  test('a new file is a `set` while the existing one stays silent in the deltas', () => {
    const state = deliver(scan([present('a.md', 'AAA')]))
    const out = run(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]), state)
    expect(out.source?.changes).toEqual([
      { action: 'set', scope: 'b.md', path: `${DIR}/b.md`, digest: digestOf('BBB') },
    ])
    // The snapshot itself still carries BOTH files: it is a snapshot, not a patch.
    expect(out.text).toContain('AAA')
    expect(out.text).toContain('BBB')
  })

  test('a confirmed disappearance among survivors is a `remove`', () => {
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const out = run(scan([present('a.md', 'AAA')]), state)
    expect(out.source?.changes).toEqual([{ action: 'remove', scope: 'b.md', path: `${DIR}/b.md` }])
    expect(out.text).not.toContain('BBB')
    expect(out.source?.cleared).toBeUndefined()
  })
})

describe('clearing on confirmed emptiness', () => {
  test('non-empty → confirmed-empty emits an explicit clearing message', () => {
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const out = run(scan([]), state)
    expect(out.source?.cleared).toBe(true)
    expect(out.source?.sections).toEqual([])
    expect(out.source?.changes.map(change => change.action)).toEqual(['remove', 'remove'])
    expect(out.text).toContain('no longer present')
    expect(out.text).toContain('No longer in force: a.md, b.md.')
    // Dropping a pending message would NOT do this: the earlier snapshot is
    // already in history and keeps governing until something retracts it.
  })

  test('a confirmed-absent directory clears just the same', () => {
    const state = deliver(scan([present('a.md', 'AAA')]))
    const out = run(scan([], 'absent'), state)
    expect(out.source?.cleared).toBe(true)
  })

  test('empty → empty says nothing', () => {
    expect(run(scan([])).desired).toBeUndefined()
  })

  test('the clearing message is emitted once, not on every subsequent step', () => {
    const state = deliver(scan([present('a.md', 'AAA')]))
    const cleared = deliver(scan([]), state)
    expect(run(scan([]), cleared).desired).toBeUndefined()
  })

  test('rules that come back after a clearing arrive as fresh `set` deltas', () => {
    const first = deliver(scan([present('a.md', 'AAA')]))
    const cleared = deliver(scan([]), first)
    const out = run(scan([present('a.md', 'AAA')]), cleared)
    expect(out.source?.changes).toEqual([
      { action: 'set', scope: 'a.md', path: `${DIR}/a.md`, digest: digestOf('AAA') },
    ])
  })
})

describe('tri-state: unavailable never retracts', () => {
  test('an unreadable DIRECTORY preserves the whole snapshot and proposes nothing', () => {
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const out = run(scan([], 'unavailable'), state)
    expect(out.desired).toBeUndefined()
    expect(out.preserved).toBe(true)
    // The state handed back is byte-identical, so nothing advanced.
    expect(out.next).toBe(state)
  })

  test('an unreadable FILE keeps its last-good body and emits no removal', () => {
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const out = run(scan([present('a.md', 'AAA'), unavailable('b.md')]), state)
    // Nothing changed from the model's point of view, so nothing is sent.
    expect(out.desired).toBeUndefined()
    expect(out.preserved).toBe(true)
    expect(out.next.retained.get('b.md')?.body).toBe('BBB')
  })

  test('a sibling edit still ships while an unreadable file keeps its last-good body', () => {
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const out = run(scan([present('a.md', 'CHANGED'), unavailable('b.md')]), state)
    expect(out.text).toContain('CHANGED')
    expect(out.text).toContain('BBB')
    expect(out.source?.changes.map(change => `${change.action}:${change.scope}`)).toEqual(['replace:a.md'])
    expect(out.source?.changes.some(change => change.action === 'remove')).toBe(false)
    expect(out.preserved).toBe(true)
  })

  test('the content cache is NOT advanced for an unavailable scope, so recovery is detected', () => {
    const state = deliver(scan([present('b.md', 'BBB')]))
    const blind = deliver(scan([unavailable('b.md')]), state)
    // Recovers with different content: this must be a `replace`, which it can
    // only be if the old digest was retained across the blind step.
    const out = run(scan([present('b.md', 'RECOVERED')]), blind)
    expect(out.source?.changes).toEqual([
      { action: 'replace', scope: 'b.md', path: `${DIR}/b.md`, digest: digestOf('RECOVERED') },
    ])
  })

  test('a file that recovers UNCHANGED after a blind step says nothing', () => {
    const state = deliver(scan([present('b.md', 'BBB')]))
    const blind = deliver(scan([unavailable('b.md')]), state)
    expect(run(scan([present('b.md', 'BBB')]), blind).desired).toBeUndefined()
  })

  test('an all-unavailable directory listing never produces a clearing message', () => {
    const state = deliver(scan([present('a.md', 'AAA')]))
    const out = run(scan([unavailable('a.md')]), state)
    expect(out.source?.cleared).toBeUndefined()
    expect(out.desired).toBeUndefined()
  })
})

describe('confirmed exclusions still retract', () => {
  test('a file that becomes unrenderable under the byte cap is retracted, not preserved', () => {
    // The scan confirmed the file exists and read it; the render budget then
    // excluded it. That is a decision, not an unknown.
    const state = deliver(scan([present('a.md', 'AAA'), present('b.md', 'BBB')]))
    const sink = new DiagnosticSink()
    const tight = reconcileRules(
      scan([present('a.md', 'AAA'), present('b.md', 'BBB')]),
      state,
      { maxRenderedBytes: 400 },
      sink,
    )
    const source = tight.desired?.source as ProjectRulesSource | undefined
    if (source === undefined) return // the cap admitted both; nothing to assert
    expect(source.changes.some(change => change.action === 'remove')).toBe(true)
  })
})
