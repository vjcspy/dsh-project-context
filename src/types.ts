/**
 * Shared vocabulary for project-scoped markdown agent definitions.
 *
 * Three shapes are kept deliberately distinct:
 * - {@link AgentFileFields} — the validated *raw* frontmatter of one file.
 * - {@link ResolvedAgent} — the internal resolved schema, with the generated
 *   `toolName` and every default materialized.
 * - the first-party `dsh-tool-subagent` config, produced in `config-mapping.ts`.
 *
 * @module dsh-project-agents/types
 */

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

/** One skipped file or cap violation, aggregated into a single host-log report. */
export interface Diagnostic {
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
}

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
}

/** Immutable roster resolved for one top-level Agent lineage. */
export interface Roster {
  readonly agents: readonly ResolvedAgent[]
  readonly diagnostics: readonly Diagnostic[]
  /** The project root the scan resolved, or undefined when none was found. */
  readonly projectRoot: string | undefined
  /** The cwd the scan started from. */
  readonly cwd: string
}
