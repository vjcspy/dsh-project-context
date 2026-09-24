/**
 * Shared vocabulary for project-scoped markdown agent definitions.
 *
 * Three shapes are kept deliberately distinct:
 * - {@link AgentFileFields} — the validated *raw* frontmatter of one file.
 * - {@link ResolvedAgent} — the internal resolved schema, with the generated
 *   `toolName` and every default materialized.
 * - the first-party `dsh-tool-subagent` config, produced in `config-mapping.ts`.
 *
 * @module dsh-project-context/types
 */

import type { Volatile } from '@deepseek-ai/cordis'
import type { McpServerEntry } from './mcp/types.ts'

/** The `ctx.subagents` transport an agent file delegates through. */
export type Transport = 'spawn' | 'fork'

/** Background execution policy forwarded to `dsh-tool-subagent`. */
export type BackgroundMode = 'one-shot' | 'continuable'

/** Which discovery layer a definition came from. */
export type Layer = 'project' | 'global'

/** One-based file position used by rejection diagnostics. */
export interface SourceLocation {
  readonly line: number
  readonly column: number
}

/** LLM route requested by an agent file (maps onto `agentOptions`). */
export interface LlmRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Tool restriction requested by an agent file (maps onto `toolFilter`). */
export interface ToolRestrictionFields {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/**
 * One agent file after frontmatter validation. Every key is type-checked and
 * every default materialized; nothing here is derived from the harness runtime.
 */
export interface AgentFileFields {
  readonly name: string
  readonly description: string
  readonly transport: Transport
  readonly llm?: LlmRoute
  readonly tools?: ToolRestrictionFields
  readonly maxDepth: number | 'provider-managed'
  readonly background: BackgroundMode
  /** The markdown body, mapped onto the child `persona` prefix section. */
  readonly persona: string
}

/** One discovered file plus its provenance, before name resolution. */
export interface DiscoveredAgentFile {
  readonly path: string
  readonly layer: Layer
  readonly fields: AgentFileFields
}

/**
 * The resolved internal schema: a discovered file whose model-facing tool name
 * has been generated and checked. Immutable — a child Agent reuses its
 * parent's resolved roster by reference.
 */
export interface ResolvedAgent {
  readonly name: string
  readonly slug: string
  readonly toolName: string
  readonly description: string
  readonly transport: Transport
  readonly persona: string
  readonly llm?: LlmRoute
  readonly toolFilter?: ToolRestrictionFields
  readonly maxDepth: number | 'provider-managed'
  readonly background: BackgroundMode
  readonly path: string
  readonly layer: Layer
}

/**
 * How one diagnostic changes what the operator can use.
 *
 * `error` means a definition was skipped or the roster was truncated, so the
 * agent the file declares is NOT available and the operator has to act.
 * `notice` reports an ordinary precedence outcome — the project file won the
 * name collision, exactly as designed — which must not be presented as a
 * problem to fix.
 */
export type DiagnosticSeverity = 'error' | 'notice'

/**
 * Which of this plugin's capabilities a diagnostic belongs to.
 *
 * The report renderers are shared, but the capabilities fail for unrelated
 * reasons and produce unrelated operator actions, so a report that called a
 * skipped rule file an "agent definition" would be actively misleading. The tag
 * selects the noun; it is not presentation.
 *
 * The MCP settings namespace is deliberately NOT a member: it reports through
 * its own settings surface and never publishes into this banner.
 */
export type Capability = 'agents' | 'rules' | 'commands'

/** One skipped file or cap violation, aggregated into a single host-log report. */
export interface Diagnostic {
  /** Whether the operator has to act on this. */
  readonly severity: DiagnosticSeverity
  /** Which capability produced this. Defaults to `agents` where omitted. */
  readonly capability?: Capability
  /** Absolute path of the offending file, or the directory for a cap violation. */
  readonly path: string
  /** Human-readable cause. */
  readonly reason: string
  /** Frontmatter key or `body`, when the cause is field-local. */
  readonly field?: string
  /** One-based position inside the file, when known. */
  readonly location?: SourceLocation
}

/** Hard caps applied to every discovery pass. */
export interface ResourceBounds {
  /** Maximum number of resolved agents mounted into one Agent scope. */
  readonly maxAgents: number
  /** Maximum size of one `*.md` agent definition, in bytes. */
  readonly maxFileBytes: number
  /** Maximum total size of all read definitions in one discovery pass, in bytes. */
  readonly maxTotalBytes: number
  /** Maximum number of rule files loaded from one `.dsh/rules` directory. */
  readonly maxRules: number
  /** Maximum size of one `*.md` rule file, in bytes. */
  readonly maxRuleFileBytes: number
  /**
   * Maximum UTF-8 size of the COMPLETE rendered rules message, including the
   * preamble, every per-file header and the closing frame — not of the bodies
   * alone. `packages/AGENTS.md:16` requires the bound to cover the emitted
   * value with its wrappers and metadata.
   */
  readonly maxRenderedBytes: number
  /** Maximum number of command files registered into one Agent scope. */
  readonly maxCommands: number
  /** Maximum size of one `*.md` command file, in bytes. */
  readonly maxCommandFileBytes: number
  /**
   * Maximum UTF-8 size of the COMPLETE expanded command body handed to
   * `followup()` — after `$ARGUMENTS` substitution or argument appending, not
   * of the source file. The source cap ({@link maxCommandFileBytes}) is a
   * separate, independent limit.
   */
  readonly maxExpandedBytes: number
}

/**
 * Tri-state observation, mirroring the host's own contract at
 * `packages/context/agent-instructions/src/files.ts:73-77`.
 *
 * The distinction is load-bearing and must never be collapsed: `absent` is a
 * CONFIRMED non-existence and is the only state that may retract a rule, while
 * `unavailable` means the state could not be determined (permission error, I/O
 * failure, a race with atomic replacement) and must preserve last-good content.
 * Because supersession is durable, treating `unavailable` as `absent` would
 * permanently deactivate a safety rule that was never actually deleted.
 */
export type Observation = 'present' | 'absent' | 'unavailable'

/**
 * Advisory filesystem identity for one rule file.
 *
 * Recorded for diagnostics and for the record only. It is NEVER consulted to
 * decide that nothing changed: `(path, size, mtime)` compares equal across a
 * same-length rewrite whose mtime was restored, and a false negative there
 * silently keeps a superseded instruction in force.
 */
export interface MetadataStamp {
  readonly dev: number
  readonly ino: number
  readonly size: number
  /** High-resolution modification time, in nanoseconds. */
  readonly mtimeNs: bigint
  /** High-resolution inode-change time, in nanoseconds. */
  readonly ctimeNs: bigint
}

/** One rule file as observed by a single scan. */
export interface RuleObservation {
  /** Stable identity: the filename inside `.dsh/rules`. */
  readonly scope: string
  /** Absolute path. */
  readonly path: string
  /** Whether this scan could determine the file's state. */
  readonly observation: Observation
  /** The verbatim body. Present only when `observation` is `present`. */
  readonly body?: string
  /** SHA-256 of {@link body}. Present only when `observation` is `present`. */
  readonly digest?: string
  /** Advisory identity; never used to skip a read. */
  readonly stamp?: MetadataStamp
}

/** The result of one bounded, synchronous rules scan. */
export interface RuleScan {
  /** The absolute `.dsh/rules` path, or the path it would have had. */
  readonly directory: string | undefined
  /** Whether the directory listing itself could be determined. */
  readonly directoryObservation: Observation
  /**
   * Every `*.md` entry the listing produced, sorted by filename, after the
   * `maxRules` cap. Entries whose own state could not be determined appear
   * here with `observation: 'unavailable'`.
   */
  readonly files: readonly RuleObservation[]
  /** The resolved project root, or undefined when no `.git` ancestor exists. */
  readonly projectRoot: string | undefined
}

/**
 * One command file after frontmatter validation.
 *
 * The name is derived from the FILENAME, never from frontmatter: DSH command
 * names are what the operator types after `/`, and a file whose declared name
 * disagreed with its path would make the `/` menu and the filesystem disagree.
 */
export interface CommandFile {
  /** Command name, taken from the filename with `.md` stripped. */
  readonly name: string
  /** Validated `description`; one line, rendered in the `/` menu. */
  readonly description: string
  /** The `argument-hint` value, or the generic default when absent. */
  readonly hint: string
  /** The verbatim markdown body, used as the prompt template. */
  readonly body: string
}

/** One command file as observed by a single scan. */
export interface CommandObservation {
  /** Stable identity: the filename inside `.dsh/commands`. */
  readonly scope: string
  /** Absolute path. */
  readonly path: string
  /** Whether this scan could determine the file's state. */
  readonly observation: Observation
  /** The verbatim body. Present only when `observation` is `present`. */
  readonly body?: string
  /** SHA-256 of {@link body}. Present only when `observation` is `present`. */
  readonly digest?: string
  /** Advisory identity; never used to skip a read. */
  readonly stamp?: MetadataStamp
}

/** The result of one bounded, synchronous commands scan. */
export interface CommandScan {
  /** The absolute `.dsh/commands` path, or the path it would have had. */
  readonly directory: string | undefined
  /** Whether the directory listing itself could be determined. */
  readonly directoryObservation: Observation
  /**
   * Every `*.md` entry the listing produced, sorted by filename, after the
   * `maxCommands` cap. Entries whose own state could not be determined appear
   * here with `observation: 'unavailable'`.
   */
  readonly files: readonly CommandObservation[]
  /** The resolved project root, or undefined when no `.git` ancestor exists. */
  readonly projectRoot: string | undefined
}

/** One command resolved for registration, with its provenance and digest. */
export interface ResolvedCommand {
  /** Command name, taken from the filename with `.md` stripped. */
  readonly name: string
  /** Absolute path of the declaring file, used by every diagnostic. */
  readonly path: string
  /** Validated `description`; one line, rendered in the `/` menu. */
  readonly description: string
  /** The `argument-hint` value, or the generic default when absent. */
  readonly hint: string
  /** The verbatim markdown body, used as the prompt template. */
  readonly body: string
  /** SHA-256 of {@link body}, as observed by the scan that produced it. */
  readonly digest: string
}

/** Command-capability slice of {@link ResourceBounds}. */
export type CommandBounds = Pick<
  ResourceBounds,
  'maxCommands' | 'maxCommandFileBytes' | 'maxExpandedBytes'
>

/** Plugin entry configuration. */
export interface Config {
  /** Override {@link ResourceBounds.maxAgents}; default 16. */
  readonly maxAgents?: number
  /** Override {@link ResourceBounds.maxFileBytes}; default 65536. */
  readonly maxFileBytes?: number
  /** Override {@link ResourceBounds.maxTotalBytes}; default 262144. */
  readonly maxTotalBytes?: number
  /**
   * Absolute directory holding global agent definitions. Defaults to
   * `$DSH_HOME/agents`, falling back to `~/.dsh/agents`.
   */
  readonly globalAgentsDir?: string
  /**
   * Absolute directory used when an Agent's session header carries no `cwd`.
   * Defaults to `process.cwd()`.
   */
  readonly fallbackCwd?: string
  /** Turn the project-rules capability off entirely; default `true` (on). */
  readonly rules?: boolean
  /** Override {@link ResourceBounds.maxRules}; default 32. */
  readonly maxRules?: number
  /** Override {@link ResourceBounds.maxRuleFileBytes}; default 65536. */
  readonly maxRuleFileBytes?: number
  /** Override {@link ResourceBounds.maxRenderedBytes}; default 262144. */
  readonly maxRenderedBytes?: number
  /**
   * Directory holding project rules, relative to the project root.
   * Defaults to `.dsh/rules`. Exposed for tests; there is deliberately no
   * global layer.
   */
  readonly rulesSubdir?: string
  /** Turn the project-commands capability off entirely; default `true` (on). */
  readonly commands?: boolean
  /** Override {@link ResourceBounds.maxCommands}; default 32. */
  readonly maxCommands?: number
  /** Override {@link ResourceBounds.maxCommandFileBytes}; default 65536. */
  readonly maxCommandFileBytes?: number
  /** Override {@link ResourceBounds.maxExpandedBytes}; default 262144. */
  readonly maxExpandedBytes?: number
  /**
   * Directory holding project command files, relative to the project root.
   * Defaults to `.dsh/commands`. Exposed for tests; there is deliberately no
   * global layer.
   */
  readonly commandsSubdir?: string
  /**
   * Managed MCP servers, as the Loader resolves them. `servers` is a VOLATILE
   * reference: the settings form edits `mcp.servers` and the Loader commits the
   * new list into this reference without remounting the plugin. Defaults to an
   * empty list; the operator's servers live in the profile patch, and every
   * `env`/`headers` value is a credential reference rather than a secret.
   */
  readonly mcp?: { readonly servers: Volatile<readonly McpServerEntry[]> }
}

/** Immutable roster resolved for one top-level Agent lineage. */
export interface Roster {
  readonly agents: readonly ResolvedAgent[]
  /**
   * The commands resolved for the same lineage. A child Agent reuses its
   * parent's whole roster, so it re-registers the PARENT's resolved command set
   * under its own scope rather than rescanning its own cwd — matching the
   * agents capability.
   */
  readonly commands: readonly ResolvedCommand[]
  readonly diagnostics: readonly Diagnostic[]
  /** The project root the scan resolved, or undefined when none was found. */
  readonly projectRoot: string | undefined
  /** The cwd the scan started from. */
  readonly cwd: string
}
