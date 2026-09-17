/**
 * Registration of the plugin-owned MCP server settings namespace.
 *
 * `installSection` layers the plugin entry's own config under the user
 * document and keeps working when no settings provider is mounted, so the
 * plugin loads with or without a settings service. The registration OWNER is
 * the caller's context, not the injected child: `installSection` re-judges
 * derived state when the provider detaches, and only the owner's unload is
 * meant to suppress that fallback.
 *
 * @module dsh-project-context/mcp/namespace
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges `ctx.settings` onto Context, and
// marks this module as a runtime consumer of the settings package, which the
// manifest invariant requires to be declared as an optional peer.
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import {
  McpManagerConfig,
  validateManagerConfig,
  type McpManagerConfigResolved,
} from './schema.ts'
import { MCP_NAMESPACE, MCP_NAMESPACE_BASE, type McpManagerConfig as McpManagerConfigShape } from './types.ts'

export { MCP_NAMESPACE, MCP_NAMESPACE_BASE }

/** What the plugin entry hands the namespace installation. */
export interface McpNamespaceHooks {
  /**
   * Become the authoritative source of the current document: the resolved
   * settings scope while a provider is attached, the entry config otherwise.
   * @param source - thunk returning the authoritative document.
   */
  setSource(source: () => McpManagerConfigShape): void
  /**
   * Re-judge everything derived from the document. Called at attach, at
   * detach, and after every committed change.
   */
  onChange(): void
}

/**
 * Install the namespace on a host that provides `settings`, and do nothing on
 * a host that does not.
 *
 * The injected child fiber waits for the service, so a profile without a
 * settings provider never sees this plugin fail to load; when the provider
 * goes away the child stops and {@link McpNamespaceHooks.setSource} falls back
 * to the entry config.
 *
 * @param ctx - the plugin entry's context, which owns the registration.
 * @param entry - the composition-layer document, used as the base layer.
 * @param hooks - source sink and change notification.
 */
export function installMcpNamespace(
  ctx: Context,
  entry: McpManagerConfigResolved,
  hooks: McpNamespaceHooks,
): void {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as SettingsProvider | undefined
    if (settings === undefined) return
    settings.installSection(ctx, MCP_NAMESPACE, McpManagerConfig, entry, {
      // Cross-field and per-transport requirements: the MCP client refuses a
      // stdio branch without a command only at mount time, and a URL is not
      // validated by the schema beyond its length.
      validate: validateManagerConfig,
      setSource: hooks.setSource,
      onChange: hooks.onChange,
    })
  })
}
