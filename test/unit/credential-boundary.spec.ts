/**
 * Credential boundary on the SHIPPED plugin schema.
 *
 * rc.1 persists a plugin's configuration form into the profile Cordis patch,
 * which is a TRACKED file in this deployment. A secret value must therefore
 * never be a form field. The managed MCP servers store CREDENTIAL REFERENCES —
 * the operator keeps the value in DSH's credential store, and the mount path
 * resolves it just before spawning — so the shipped schema declares no
 * `role('secret')` node at all.
 *
 * @module dsh-project-context/tests/credential-boundary
 */

import { describe, expect, test } from 'vitest'
import { Config } from '../../src/schema.ts'
import { McpManagerConfig } from '../../src/mcp/schema.ts'

/** The serialized schema tree, which carries every declared role. */
function schemaJson(schema: { toJSON(): unknown }): string {
  return JSON.stringify(schema.toJSON())
}

describe('shipped schema credential boundary', () => {
  test('the plugin entry schema declares no secret-role field', () => {
    const json = schemaJson(Config)
    expect(json).not.toContain('"role":"secret"')
  })

  test('env and header values are declared as credential references', () => {
    // Both positions — a stdio server's `env` and a streamable-http server's
    // `headers` — name a credential instead of carrying a value.
    const json = schemaJson(McpManagerConfig)
    expect(json).toContain('"role":"credential-ref"')
    expect(json).not.toContain('"role":"secret"')
  })
})
