# dsh-project-context

Project-scoped context for dsh: **subagents** and **rules**, both declared in
markdown, both per project, both requiring **no change to the harness**.

- Drop `analyst.md` into `<repo>/.dsh/agents/`, and an `agent_analyst`
  delegation tool becomes callable in that repo — with its own model, reasoning
  effort, persona and tool restrictions — and only in that repo.
- Drop any `*.md` into `<repo>/.dsh/rules/`, and its contents reach every Agent
  working in that repo, verbatim, from the first request.

This plugin **registers no tool of its own**. For agents it mounts first-party
`@deepseek-ai/dsh-tool-subagent` instances into each Agent's context scope, so
host upgrades come free and there is no dispatch code to maintain.

***

# Part 1 — Subagents

## Discovery

| Layer | Directory | Precedence |
| --- | --- | --- |
| Project | `<projectRoot>/.dsh/agents/*.md` | wins |
| Global | `$DSH_HOME/agents/*.md` (else `~/.dsh/agents`) | loses |

`projectRoot` is the nearest ancestor of the Agent's `cwd` holding `.git`,
matching the convention used by skills and agent-instructions. Scanning is
non-recursive, synchronous and capped.

The roster is resolved when a **top-level** Agent is created. A newly dropped
file takes effect for the next top-level Agent in the same process — no restart
— but not for Agents that already exist. A child Agent reuses its parent's
resolved roster, so a delegation chain stays internally consistent.

## Frontmatter schema

```markdown
---
name: analyst                 # required
description: Reads code and returns a synthesis.   # required
transport: spawn              # spawn | fork          (default: spawn)
background: one-shot          # one-shot | continuable (default: one-shot)
maxDepth: 3                   # non-negative integer | provider-managed (default: 3)
llm:
  provider: deepseek
  model: deepseek-chat
  reasoningEffort: high
tools:
  allow: [read, grep]
  deny: [write]
---

The markdown body becomes the child's persona.
```

| Key | Type | Default | Rejection rules |
| --- | --- | --- | --- |
| `name` | string | — | Required. Matches `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`, at most 48 chars. Decides identity for project-over-global shadowing; the filename does not. |
| `description` | string | — | Required, non-empty, single line, at most 200 chars, no balanced `{{ … }}`. Becomes one agent-catalog row. |
| `transport` | `spawn` \| `fork` | `spawn` | Names the `ctx.subagents` transport, **not** an LLM provider. Any other value is rejected. |
| `background` | `one-shot` \| `continuable` | `one-shot` | `continuable` requires a transport with `prepareContinuable`. |
| `maxDepth` | non-negative safe integer \| `provider-managed` | `3` | Always emitted explicitly — a direct `apply()` omission would be capless. A numeric cap requires the transport's `depthLimit` capability. |
| `llm.provider` | string | — | Required together with `llm.model`. Requires the transport's `agentOptions` capability. |
| `llm.model` | string | — | Required together with `llm.provider`. |
| `llm.reasoningEffort` | string | — | Non-empty when present. |
| `tools.allow` | string[] | — | Non-empty array of non-empty names. |
| `tools.deny` | string[] | — | Non-empty array of non-empty names. |
| body | markdown | — | Required, non-empty, no balanced `{{ … }}`. Becomes the `persona` **prefix** section — harness identity and tool sections still render beneath it. |

**Unknown keys are rejected**, at the top level and inside `llm` / `tools`. An
explicit YAML `null` is a value, not an omission, and is rejected rather than
silently defaulted.

### The `{{ … }}` rule

System-prompt interpolation throws on any `{{` that has a later `}}` unless it
is a registered variable, and it is applied to every assembled section. Both the
body and the `description` are therefore rejected outright when they contain
one; there is no demonstrated round-trip-safe escape. A lone `{{` with no later
`}}` is literal prose and is accepted.

### Tool naming

Every generated tool is namespaced `agent_<slug>`, where the slug is the name
with `-` replaced by `_`. The namespace is mandatory: scoped tools silently
shadow globals, so an unnamespaced `read.md` would hijack a core tool for the
whole project. A generated name is additionally compared against the tool names
already visible in that Agent's scope, both before mounting and again at the
moment of registration; a conflict skips that file with a diagnostic.

## Entry configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `maxAgents` | `16` | Maximum agents mounted into one Agent scope. |
| `maxFileBytes` | `65536` | Maximum size of one definition. |
| `maxTotalBytes` | `262144` | Maximum total bytes read in one discovery pass. |
| `globalAgentsDir` | `$DSH_HOME/agents` | Global layer directory. |
| `fallbackCwd` | `process.cwd()` | Used when the Agent's session header carries no `cwd`. |

Each override must be a positive safe integer; a bad value fails the plugin load
rather than failing per Agent.

### Why 16

Measured against the real first model request the AgentLoop issues (see
`test/composition/schema-size.spec.ts`), with ~110-character descriptions:

| Agents | Generated tool schemas | Catalog section | Total added |
| --- | --- | --- | --- |
| 1 | 1,108 B | 344 B | 1,452 B |
| 10 | 11,071 B | 1,298 B | 12,369 B |
| 16 | 17,719 B | 1,946 B | 19,665 B |

Roughly **1.1 KB per agent** in tool schema, plus ~106 B per catalog row. At the
200-character description cap the catalog roughly doubles, putting the 16-agent
worst case near 21 KB of every request.

## Diagnostics

Invalid files are skipped and aggregated into one report per discovery — never
thrown. A synchronous `agent/created` listener that throws vetoes Agent
publication, so one typo must not be able to break Agent creation.

The host logger alone cannot carry that report to the operator: cordis delivers
`ctx.logger` records to registered exporters only, and the shipped `web` profile
mounts none, so a warning lands in an in-memory ring buffer and is dropped on
exit. One discovery pass therefore produces three channels:

| Channel | Who sees it | Where it comes from |
| --- | --- | --- |
| Host log | anyone with a log exporter | `renderReport` — complete, with `error:` / `notice:` labels |
| Agent catalog section | the model, on every surface | `renderSurfacedDiagnostics` — bounded block in `project-agents:catalog` |
| Web GUI banner | the operator, unasked | `renderWebNotice` — a `webserver/index-inject` body script |

The catalog block is emitted even when **nothing** mounted, because that is
exactly the case a log-only report lost: the model can then answer "why is the
agent I declared missing?" instead of guessing. The banner is host-only (no
client bundle) and dismissible.

Rules that keep these channels safe:

- **Only `error` diagnostics are surfaced.** A `notice` records an ordinary
  precedence outcome — the project file shadowing a global one — which is not
  something to fix.
- **Surfaced text is brace-sanitized.** A rejection reason quotes the offending
  construct, so the diagnostic for a file containing `{{name}}` itself contains
  `{{ … }}`. Interpolation throws on any balanced reference in an assembled
  section, so surfacing the raw reason would kill prompt assembly — the exact
  failure the frontmatter guard prevents. `sanitizeForPrompt` splits every
  adjacent brace pair.
- **Both channels are bounded**: at most 5 rows, each reason truncated to 200
  characters, with a trailing count of what was dropped.
- **The banner payload cannot inject markup.** It is JSON-encoded with `<`
  escaped, and the DOM is built with `textContent`.

***

# Part 2 — Rules

Every `*.md` in `<projectRoot>/.dsh/rules/` is loaded verbatim, sorted by
filename, and delivered to each Agent as **one durable user message**. There is
no frontmatter contract, no recursion and no global layer — flat files, bodies
untouched.

## Why a user message and not a system-prompt section

Because rule prose has to survive verbatim. `interpolate()` runs over
system-prompt sections and contexts but **never** over inbox messages, and in a
section a `{{` with any later `}}` that is not a registered variable throws and
kills prompt assembly for that Agent. A rule file that documents `{{model}}` is
a perfectly ordinary thing to write; making it either crash the Agent or get
silently rewritten to `{ {model} }` would be a defect in an instruction channel.
On this path there is no hazard, so nothing is sanitized and nothing is
rejected.

## Why the pre-step waterfall and not the inbox

`AgentLoop.preStep()` **claims** — removes — the entire `next-step` batch
*before* dispatching the `agent/pre-step` waterfall. By the time any listener
runs, `inbox.replace` returns `false` (the message is no longer pending) and
`inbox.prepend` queues for a *later* step. So a rules change delivered through
the inbox would reach the request *after* the one the user is waiting on.

This plugin folds its message straight into `decision.messages`, the same way
`@deepseek-ai/dsh-agent-instructions` does. **Editing a rule file changes the
very next model request, not the one after.**

## Supersession

Session history is append-only, and every user message is serialized to the
provider in order regardless of its `source.kind`. Removing a *pending* message
therefore does nothing about a rule the model has already read. Supersession is
carried three ways:

| Mechanism | Audience | What it does |
| --- | --- | --- |
| Snapshot preamble | the model | States in prose that this snapshot replaces every earlier one, and that any rule not repeated no longer applies |
| `changes` deltas | consumers | `set` / `replace` / `remove` per file on `source.changes` |
| Clearing message | the model | On a **confirmed** non-empty → empty, an explicit retraction naming what is no longer in force |

The distinct `source.kind: 'project-rules'` is **not** the supersession
mechanism — it is a non-interference property. `agent-instructions` removes
every pending message whose kind is `agent-instructions`, so sharing that kind
would let the two plugins delete each other's input. The kind says nothing to
the model; the preamble does.

## Change detection

Contents are **digested on every reconciliation**. A `(path, size, mtime)`
metadata stamp is recorded, but it is advisory only and never justifies a
"nothing changed" decision on its own: a same-length rewrite with the mtime
restored compares equal on that tuple, and a false negative in an instruction
channel silently keeps a superseded rule in force. Measured cost of always
digesting the real 4-file / 25 497-byte corpus: **0.21 ms** — noise beside a
model request.

## Tri-state observation

Every observation is `present`, `absent` or `unavailable`, mirroring the host's
own contract, and the two negative states are handled differently:

| Observation | Meaning | Effect |
| --- | --- | --- |
| `present` | read successfully | content ships |
| `absent` | `ENOENT` / `ENOTDIR` — confirmed non-existence | `remove` delta; a clearing message when nothing is left |
| `unavailable` | anything else — `EACCES`, `EIO`, a race with atomic replacement | last-good content preserved; **no** removal, **no** clearing, cache not advanced so the next step retries |

Collapsing the two would let a transient permission error permanently
deactivate a safety rule that was never deleted. On the very *first* load there
is no last-good value, so an unreadable file is diagnosed and skipped.

## Bounds

The byte cap is enforced on the **fully rendered message** — preamble, per-file
headers and framing included — not on the sum of the bodies, because many tiny
files would otherwise blow the prompt budget while every per-file check passed.
Overflow drops whole files from a deterministic prefix of the sorted order and
records a diagnostic; a body is never truncated, which also means a multibyte
code point can never be split.

## Rules entry configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `rules` | `true` | Set `false` to disable the rules capability entirely. |
| `maxRules` | `32` | Maximum rule files loaded from one directory. |
| `maxRuleFileBytes` | `65536` | Maximum size of one rule file; a larger one is skipped with a diagnostic. |
| `maxRenderedBytes` | `262144` | Maximum UTF-8 size of the complete rendered message. |
| `rulesSubdir` | `.dsh/rules` | Rules directory, relative to the project root. |

## Rules edge cases

| Case | Behaviour |
| --- | --- |
| No `.dsh/rules`, or no `.git` ancestor | nothing injected, no diagnostic |
| Empty directory | nothing injected; a previously non-empty set is cleared explicitly |
| Non-`.md` file, subdirectory, file empty after trim | ignored silently |
| File over `maxRuleFileBytes` | skipped with a diagnostic; the rest still load |
| More files than `maxRules` | first N by filename win; each drop diagnosed |
| Body containing `{{example}}` | loaded unchanged; prompt assembly still succeeds |
| Session header with no `cwd` | falls back to `fallbackCwd`, else `process.cwd()` |

***

# Development

```sh
pnpm install          # links the harness packages from ../deepseek-harness
pnpm run check        # type-check
pnpm test             # unit + real-composition suites
pnpm run build        # emit lib/
```

Install into a profile:

```sh
pnpm dsh plugin --profile web add file:/abs/path/to/dsh-project-context
```

> **`file:` installs are hardlinks — verify, do not assume.** pnpm materializes
> the package into `<profile>/node_modules` by hardlinking each file from the
> `files` list, so the installed path and this repo can share one inode. Whether
> a rebuild reaches an installed profile therefore depends on how the emitter
> writes: `tsc` overwrites in place and the change propagates with no `add`,
> while anything that unlinks and recreates a file (a clean `rm -rf lib`, a
> bundler) breaks the link and leaves the profile silently stale. Neither
> outcome announces itself. After changing `lib/`, check before trusting it:
>
> ```sh
> diff -rq lib "$DSH_HOME/profiles/web/node_modules/dsh-project-context/lib"
> ```
>
> Re-run the `add` (or `pnpm install` in the profile) when it reports a
> difference. The package's own harness imports resolve through
> `$DSH_HOME/profiles/node_modules`, which the launcher links to the source
> checkout.
