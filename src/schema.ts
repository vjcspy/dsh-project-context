/**
 * Plugin entry configuration schema.
 *
 * The plugin declares a schema for ONE reason: rc.1's settings provider
 * projects a plugin's VOLATILE Config fields into its configuration form, so
 * `mcp.servers` must be volatile for the Settings page to edit the managed MCP
 * servers. Every other field stays ordinary and undeclared here — schemastery
 * preserves unknown profile fields as plain values, which is what the rest of
 * `Config` (bounds, `rules`, `commands`, directories) already is.
 *
 * @module dsh-project-context/schema
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Config as PlainConfig } from './types.ts'
import type { McpServerEntry } from './mcp/types.ts'
import { mcpServersSchema } from './mcp/schema.ts'

/**
 * Live plugin entry configuration.
 *
 * Identical to {@link PlainConfig} except that `mcp.servers` is a volatile
 * reference the Loader keeps live across a settings write.
 */
export interface Config extends Omit<PlainConfig, 'mcp'> {
  /** Managed MCP servers, resolved live by the settings form. */
  readonly mcp?: { readonly servers: Volatile<readonly McpServerEntry[]> }
}

/**
 * The plugin entry schema.
 *
 * `mcp.servers` is volatile: a settings write commits the new list into the
 * running reference and emits `loader/volatile-update` instead of remounting
 * the plugin. The `mcp` object carries a default so the reference exists even
 * for a composition that omits the `mcp` block entirely.
 */
export const Config = z.object({
  mcp: z.object({
    servers: mcpServersSchema.volatile(),
  }).default({}),
})
