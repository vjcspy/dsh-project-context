/**
 * Payload bounds for the MCP server namespace.
 *
 * A namespace document is reachable from two directions that skip
 * `installSection`'s `validate` hook: a hand edit of `$DSH_HOME/settings.yaml`
 * (the migration seed is exactly that) and any other process writing the
 * shared user settings file. The schema therefore carries its own per-field
 * limits, and {@link import('./schema.ts').resolveMcpServer} re-checks the
 * collection limits while building the mount config — the bound is applied
 * where the complete emitted value is known, so a payload that only becomes
 * oversized during resolution is refused there rather than handed to the MCP
 * client.
 *
 * @module dsh-project-context/mcp/bounds
 */

/** `serverName` length cap, mirroring the MCP client's own pattern. */
export const MAX_SERVER_NAME_LENGTH = 32

/** Managed server cap. One entry is one child process or one HTTP client. */
export const MAX_SERVERS = 32

/** Argument count cap per server. */
export const MAX_ARGS = 64

/** Single argument length cap, in characters. */
export const MAX_ARG_LENGTH = 4096

/** Environment entry count cap per server. */
export const MAX_ENV_ENTRIES = 64

/** Single environment value length cap, in characters. */
export const MAX_ENV_VALUE_LENGTH = 4096

/** Header entry count cap per server. */
export const MAX_HEADERS = 64

/** Single header value length cap, in characters. */
export const MAX_HEADER_VALUE_LENGTH = 4096

/** Endpoint URL length cap, in characters. */
export const MAX_URL_LENGTH = 2048

/** Command length cap, in characters. */
export const MAX_COMMAND_LENGTH = 4096

/** Working-directory length cap, in characters. */
export const MAX_CWD_LENGTH = 4096

/** {@link import('./types.ts').McpServerEntry.id} length cap. */
export const MAX_ID_LENGTH = 64

/** `serverName` pattern, identical to the MCP client's `SERVER_NAME_PATTERN`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Accepted endpoint protocols. An MCP endpoint is HTTP; anything else is a typo. */
export const ALLOWED_URL_PROTOCOLS: readonly string[] = ['http:', 'https:']
