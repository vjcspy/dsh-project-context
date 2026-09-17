/**
 * Inline presentation for the MCP servers settings card.
 *
 * The card renders plain HTML with inline styles on purpose: the client bundle
 * purity rule forbids importing another plugin's components, a CSS Modules
 * sheet would need a stylesheet pipeline this package's own toolchain does not
 * ship, and `ui-primitives` is a module-table row this plugin does not request.
 * Only shared `--dsw-*` tokens are referenced, so the card follows the active
 * theme instead of hard-coding a palette.
 */

import type { CSSProperties } from 'react'

const MUTED = 'var(--dsw-alias-label-secondary, #6b7280)'
const BORDER = '1px solid var(--dsw-alias-border-l2, #d8dce3)'

/** Styles for the card and its controls. */
export const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    color: 'var(--dsw-alias-label-primary, #111827)',
  } satisfies CSSProperties,
  intro: { margin: 0, color: MUTED, lineHeight: 1.5 } satisfies CSSProperties,
  notice: {
    margin: 0,
    padding: '10px 12px',
    borderRadius: '8px',
    border: BORDER,
    background: 'var(--dsw-alias-bg-layer-2, #f6f7f9)',
    lineHeight: 1.5,
  } satisfies CSSProperties,
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  } satisfies CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: BORDER,
  } satisfies CSSProperties,
  identity: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } satisfies CSSProperties,
  name: { fontWeight: 600, wordBreak: 'break-all' } satisfies CSSProperties,
  meta: { color: MUTED, fontSize: '12px', wordBreak: 'break-word' } satisfies CSSProperties,
  actions: { display: 'flex', gap: '6px', flexShrink: 0, flexWrap: 'wrap' } satisfies CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    borderRadius: '8px',
    border: BORDER,
  } satisfies CSSProperties,
  field: { display: 'flex', flexDirection: 'column', gap: '4px' } satisfies CSSProperties,
  label: { fontSize: '12px', color: MUTED } satisfies CSSProperties,
  input: {
    padding: '6px 8px',
    borderRadius: '6px',
    border: BORDER,
    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    color: 'inherit',
    font: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  } satisfies CSSProperties,
  textarea: {
    padding: '6px 8px',
    borderRadius: '6px',
    border: BORDER,
    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    color: 'inherit',
    font: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '64px',
  } satisfies CSSProperties,
  button: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: BORDER,
    background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  } satisfies CSSProperties,
  primary: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: BORDER,
    background: 'var(--dsw-alias-button-primary-fill, #111827)',
    color: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
    font: 'inherit',
    cursor: 'pointer',
  } satisfies CSSProperties,
  error: { margin: 0, color: 'var(--dsw-alias-label-secondary, #6b7280)' } satisfies CSSProperties,
  rowGroup: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties,
  check: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px' } satisfies CSSProperties,
} as const
