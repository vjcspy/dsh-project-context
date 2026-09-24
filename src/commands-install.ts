/**
 * Turning resolved command files into Agent-scoped DSH commands.
 *
 * Three properties are load-bearing here and each is deliberate:
 *
 * - **Arguments are never dropped silently.** Zero of Aweave's thirteen
 *   `agent/commands/common/*.md` files carry a `$ARGUMENTS` placeholder, and
 *   those files ARE invoked with arguments. A substitute-only expansion would
 *   therefore discard the operator's text on the entire real corpus while still
 *   delivering a plausible prompt — the worst possible failure mode, because
 *   the model receives an operative parameter missing with no error. Expansion
 *   is therefore two-branch: substitute when the token exists, otherwise append
 *   the raw input as a trailing block.
 * - **Registration is Agent-scoped.** `ctx.commands.register` at the plugin
 *   level is global and cannot express per-project visibility, so every
 *   registration happens inside an `agent.ctx.inject(['commands'], …)` fiber.
 * - **Collisions are classified by provenance, not by existence.**
 *   `find(agent, name)` resolves the EFFECTIVE view (global plus that Agent's
 *   whole scope chain), so a child Agent sees the registrations this plugin
 *   already made for its parent. Existence alone cannot tell "a first-party
 *   command" from "our own inherited registration"; the returned definition's
 *   `definitionId` can, and it needs no side-table and no per-root refcounting.
 *
 * @module dsh-project-context/commands-install
 */

// Type-only: `@deepseek-ai/dsh-commands` is not in the host's module-fallback
// tree, so a value import here would fail the plugin's own import. The brand
// constructor is a runtime no-op, so the identity is applied by cast instead.
import type { CommandDefinition, CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseCommandFile } from './command-frontmatter.ts'
import type { CommandScan, Diagnostic, ResolvedCommand } from './types.ts'

/** The in-place argument placeholder, matching Claude Code's token. */
export const ARGUMENTS_TOKEN = '$ARGUMENTS'

/**
 * Prefix of every `definitionId` this plugin mints.
 *
 * First-party producers prefix their own ids with `@deepseek-ai/` (verified in
 * `plan-mode`, `command-compact`, `command-goal`, `command-feedback`,
 * `session-log-export` and `permission-presets`), and `normalizeDefinition`
 * preserves `definitionId` verbatim, so this prefix is a sufficient and
 * self-maintaining provenance test.
 */
export const DEFINITION_ID_PREFIX = 'dsh-project-context/'

/** The `definitionId` one project command registers under. */
export function commandDefinitionId(name: string): string {
  return `${DEFINITION_ID_PREFIX}${name}`
}

/** The outcome of expanding one command body. */
export type ExpandResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Expand one command body into the single user-message text.
 *
 * The token branch substitutes EVERY occurrence. The append branch is entered
 * when the body has no token AND the operator typed something; the raw input is
 * appended after one blank line, which is the delimiter, and no marker text is
 * injected — the operator's own words must reach the model verbatim and
 * unadorned. Trailing whitespace on the body is trimmed so the delimiter is
 * exactly one blank line.
 *
 * `rawInput` is normalized with `trim()` first: DSH's own `parseCommand`
 * returns everything after the command NAME, so it carries the separator
 * whitespace (`/brainstorm  x` yields `" x"`). Without the trim the delivered
 * text would gain a stray leading space the operator never typed, and
 * `$ARGUMENTS` would double the space that precedes it in the template.
 * Leading/trailing whitespace around a command argument is not semantic.
 *
 * `maxExpandedBytes` bounds the COMPLETE emitted value, not the source file.
 *
 * @param body - the verbatim markdown body of the command file.
 * @param rawInput - everything the operator typed after the command name.
 * @param maxExpandedBytes - cap on the UTF-8 byte length of the result.
 * @returns the expanded text, or the reason it cannot be delivered.
 */
export function expandCommandBody(
  body: string,
  rawInput: string,
  maxExpandedBytes: number,
): ExpandResult {
  const input = rawInput.trim()
  let text: string
  if (body.includes(ARGUMENTS_TOKEN)) {
    text = body.replaceAll(ARGUMENTS_TOKEN, input)
  } else if (input !== '') {
    text = `${body.replace(/\s+$/u, '')}\n\n${input}`
  } else {
    text = body
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxExpandedBytes) {
    return {
      ok: false,
      reason: `the expanded body is ${String(bytes)} bytes, above the ${String(maxExpandedBytes)}-byte expansion cap`,
    }
  }
  return { ok: true, text }
}

/**
 * Validate every present observation in one scan into a resolved command.
 *
 * A file whose frontmatter is rejected is reported and skipped; one bad file
 * never blocks the rest of the directory.
 * @param scan - the bounded tri-state scan.
 * @param sink - diagnostics accumulator for rejected files.
 * @returns the resolved commands, in the scan's filename order.
 */
export function resolveCommands(
  scan: CommandScan,
  sink: { add(diagnostic: Diagnostic): void },
): ResolvedCommand[] {
  const resolved: ResolvedCommand[] = []
  const claimed = new Map<string, string>()
  for (const file of scan.files) {
    if (file.observation !== 'present') continue
    const { body, digest } = file
    if (body === undefined || digest === undefined) continue
    const parsed = parseCommandFile(file.path, body)
    if (!parsed.ok) {
      sink.add(parsed.diagnostic)
      continue
    }
    const existing = claimed.get(parsed.fields.name)
    if (existing !== undefined) {
      // Filenames are unique and the name is the filename, so two files cannot
      // resolve to one name. This guard is defensive, not a policy.
      sink.add({
        severity: 'error',
        capability: 'commands',
        path: file.path,
        field: 'name',
        reason: `duplicate command name "/${parsed.fields.name}" (also declared by ${existing})`,
      })
      continue
    }
    claimed.set(parsed.fields.name, file.path)
    resolved.push({ ...parsed.fields, path: file.path, digest })
  }
  return resolved
}

/** How one `find()` hit relates to this plugin. */
type Collision = 'free' | 'ours' | 'foreign'

function classify(existing: CommandDefinition | undefined): Collision {
  if (existing === undefined) return 'free'
  const id = existing.definitionId
  // An untagged definition is somebody else's: this plugin always mints one.
  return id !== undefined && String(id).startsWith(DEFINITION_ID_PREFIX) ? 'ours' : 'foreign'
}

/** Build the DSH definition for one resolved command. */
export function toCommandDefinition(
  resolved: ResolvedCommand,
  maxExpandedBytes: number,
  log: { warn(message: string): void },
): CommandDefinition {
  return {
    definitionId: commandDefinitionId(resolved.name) as CommandDefinitionId,
    name: resolved.name,
    description: resolved.description,
    // `rawInput` reaches the handler whether or not a hint is declared, so the
    // hint is presentation only — it is what gives the `/` menu its argument
    // affordance, and every corpus file relies on the generic default.
    input: { hint: resolved.hint },
    handler: (invocation) => {
      const expanded = expandCommandBody(resolved.body, invocation.rawInput, maxExpandedBytes)
      if (!expanded.ok) {
        // The operator already sees this text in the command plane, so no
        // banner is published for it; the host log carries the file identity.
        log.warn(`dsh-project-context: ${resolved.path} — ${expanded.reason}`)
        return { kind: 'error', text: `/${resolved.name}: ${expanded.reason}` }
      }
      try {
        // Mid-turn semantics: `followup()` queues an ordinary follow-up turn
        // that "becomes the sole ordinary message of its own turn", so a
        // command invoked while the driver is running is QUEUED as its own
        // turn — it is never spliced into the running step. `steer()` is the
        // sibling primitive and is deliberately not used here; plan mode uses
        // it because a mode switch must apply from the next step.
        invocation.agent.followup(createUserMessage({
          content: [{ type: 'text', text: expanded.text }],
          source: { kind: 'user' },
        }))
      } catch (error: unknown) {
        const reason = `the command message could not be delivered (${String(error)})`
        log.warn(`dsh-project-context: ${resolved.path} — ${reason}`)
        return { kind: 'error', text: `/${resolved.name}: ${reason}` }
      }
      return { kind: 'success' }
    },
  }
}

/** Everything one Agent-scoped command installation needs. */
export interface InstallCommandsOptions {
  /** The Agent whose scope owns the registrations. */
  readonly agent: Agent
  /** The injected runtime context, carrying the `commands` service. */
  readonly runtimeCtx: Context
  /** The commands resolved for this Agent lineage. */
  readonly commands: readonly ResolvedCommand[]
  /** Cap applied to every expanded body at invocation time. */
  readonly maxExpandedBytes: number
  /** Host-log sink. */
  readonly log: { warn(message: string): void }
}

/** The result of one Agent-scoped installation pass. */
export interface InstallCommandsOutcome {
  /** Registration-time diagnostics; empty when every command registered. */
  readonly diagnostics: readonly Diagnostic[]
  /** How many commands this pass actually registered. */
  readonly registered: number
}

/**
 * Register every resolved command into one Agent's scope.
 *
 * Must be called from inside an `agent.ctx.inject(['commands'], …)` fiber whose
 * disposer is owned by the plugin's per-Agent install transaction.
 * @param options - the Agent, its runtime context and its resolved commands.
 * @returns the registration-time diagnostics and the registered count; never throws.
 */
export function installCommands(options: InstallCommandsOptions): InstallCommandsOutcome {
  const diagnostics: Diagnostic[] = []
  let registered = 0
  for (const resolved of options.commands) {
    let existing: CommandDefinition | undefined
    try {
      existing = options.runtimeCtx.commands.find(options.agent, resolved.name)
    } catch (error: unknown) {
      diagnostics.push({
        severity: 'error',
        capability: 'commands',
        path: resolved.path,
        field: 'name',
        reason: `the command registry could not be inspected (${String(error)}); "/${resolved.name}" is not registered`,
      })
      continue
    }

    const collision = classify(existing)
    if (collision === 'ours') {
      // A parent Agent already registered this exact command and the child's
      // scope can see it. Not a problem, and not worth a diagnostic.
      continue
    }
    if (collision === 'foreign') {
      // A first-party command (`compact`, `goal`, `plan`, `feedback`, …) must
      // stay authoritative: a same-layer scoped registration would shadow it.
      const id = existing?.definitionId
      diagnostics.push({
        severity: 'error',
        capability: 'commands',
        path: resolved.path,
        field: 'name',
        reason: `command name "/${resolved.name}" is already provided by ${id === undefined ? 'a first-party command' : `"${String(id)}"`}; not registered`,
      })
      continue
    }

    try {
      // Second line of defence for a same-layer duplicate, which throws on its
      // own rather than returning a hit from `find`.
      options.runtimeCtx.commands.register(
        toCommandDefinition(resolved, options.maxExpandedBytes, options.log),
      )
      registered += 1
    } catch (error: unknown) {
      diagnostics.push({
        severity: 'error',
        capability: 'commands',
        path: resolved.path,
        field: 'name',
        reason: `registration failed (${String(error)}); "/${resolved.name}" is not available`,
      })
    }
  }
  return { diagnostics, registered }
}
