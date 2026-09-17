# dsh-project-context

Project-scoped context for dsh: **subagents**, **rules** and **commands**, all
declared in markdown, all per project, all requiring **no change to the
harness**.

- Drop `analyst.md` into `<repo>/.dsh/agents/`, and an `agent_analyst`
  delegation tool becomes callable in that repo — with its own model, reasoning
  effort, persona and tool restrictions — and only in that repo.
- Drop any `*.md` into `<repo>/.dsh/rules/`, and its contents reach every Agent
  working in that repo, verbatim, from the first request.
- Drop `brainstorm.md` into `<repo>/.dsh/commands/`, and `/brainstorm` becomes
  an Agent-scoped DSH slash command in that repo — the filename is the command
  name, the body is its prompt.

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
| `mcp` | `{ servers: [] }` | Composition base of the MCP settings namespace — see Part 4. Keep it empty; servers belong in the user layer. |

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

# Part 3 — Commands

Every `*.md` in `<projectRoot>/.dsh/commands/` becomes one Agent-scoped DSH
slash command. **The filename is the command name** (`.md` stripped) and must
match `^[a-z][a-z0-9_-]*$`; the markdown body is the prompt, and must be
non-empty. Like rules, there is no global layer — flat files in the project.

```markdown
---
description: Brainstorm a change with the operator
---

Ask which chain they selected. Then propose three approaches.
```

| Key | Type | Default | Rejection rules |
| --- | --- | --- | --- |
| `description` | string | — | Required, non-empty, single line, at most 256 chars, no balanced `{{ … }}`. Becomes the `/` menu row. |
| `argument-hint` | string | `[arguments]` | Non-empty, single line, at most 64 chars. Becomes DSH's `input.hint`. |
| body | markdown | — | Required, non-empty. Becomes the prompt, delivered as a user message. |

**Any other key is rejected** with an `error` diagnostic — the same
unknown-key stance as the agents schema, so a typo is reported rather than
silently dropped. All thirteen files in this platform's
`agent/commands/common/` corpus omit `argument-hint`, which is why
`[arguments]` is the default: without it the `/` menu would offer no argument
affordance on any distributed command. The hint is presentation only and never
gates delivery — the typed text reaches the handler either way.

## Argument expansion is two-branch

| Body contains `$ARGUMENTS` | Operator typed | Delivered text |
| --- | --- | --- |
| yes | anything | Every occurrence substituted in place with the input |
| no | something | Body, then **exactly one blank line**, then the input |
| no | nothing | Body, unchanged |

**The append branch is the one that matters.** It is the branch a real command
takes: **0 of the 13 corpus files contain `$ARGUMENTS`**, so a substitute-only
design would silently discard the operator's argument on every single
distributed command. The operator's words are appended verbatim with no marker
text injected, and trailing whitespace on the body is trimmed first so the
delimiter is exactly one blank line.

The input is normalised with `trim()` before either branch, because DSH's own
`parseCommand` returns everything after the command *name* including the
separating whitespace — `/brainstorm x` yields `" x"`. Without the trim the
delivered text would gain a stray leading space the operator never typed, and
`$ARGUMENTS` would double the space preceding it in the template.

Invoking the example above as `/brainstorm Cách 3 — mở rộng plugin` therefore
delivers:

```markdown
Ask which chain they selected. Then propose three approaches.

Cách 3 — mở rộng plugin
```

## Delivery

The expanded text is submitted as **one user message** through
`invocation.agent.followup(…)`. `followup()` queues an ordinary follow-up turn
that becomes the sole ordinary message of its **own** turn, so a command invoked
while the driver is running is queued — never spliced into the running step.
(Plan mode deliberately uses `steer()` instead, which is a different
requirement.)

## Registration is Agent-scoped

Commands are registered per Agent through
`agent.ctx.inject(['commands'], …)`, never globally: `ctx.commands.register` at
the plugin layer cannot express per-project visibility, so a global
registration would leak one project's commands into every project.

A project command whose name already belongs to a first-party command
(`compact`, `goal`, `plan`, `feedback`, …) is **rejected with an `error`
diagnostic and not registered**, so first-party commands stay authoritative —
a same-layer scoped registration would otherwise shadow one. The check reads
provenance off the registered `definitionId`: the `dsh-project-context/<name>`
prefix marks our own, which suppresses a harmless duplicate when a child Agent
re-registers a command its parent already provided.

**There is no execution surface.** No shell `` !`cmd` `` fragments, no `@` file
references, no `${CLAUDE_*}` interpolation. A command body is delivered verbatim
as a user message — it is prompt text, not a script.

## Resolution and inheritance

There is **no filesystem watcher.** Commands resolve once per top-level Agent at
`agent/created`, so a file added mid-session appears to the **next** top-level
Agent, not the current one.

A **child Agent inherits the parent's resolved command set** — the parent's
whole roster is reused rather than rescanned against the child's own `cwd`, the
same behaviour as the agents capability. The surprise worth stating plainly: a
subagent whose `cwd` sits in a *different* repository still sees the **parent's**
commands, not that repository's.

## Commands entry configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `commands` | `true` | Set `false` to disable the commands capability entirely. |
| `maxCommands` | `32` | Maximum command files registered from one directory. |
| `maxCommandFileBytes` | `65536` | Maximum size of one command file; a larger one is skipped with a diagnostic. |
| `maxExpandedBytes` | `262144` | Maximum UTF-8 size of the **complete expanded text** handed to `followup()` — not the source file. |
| `commandsSubdir` | `.dsh/commands` | Commands directory, relative to the project root. |

A body that expands past `maxExpandedBytes` is **not** truncated and not
delivered: the command reports an `error` instead, because half a prompt is
worse than a visible refusal.

## Diagnostics

Command rejections join the same per-capability Web banner as rules and agents.
Each capability has its own DOM id
(`dsh-project-context-commands-notice`) and its own report noun, so a rejected
command file is reported as a `command file` — a rejected file means a slash
command the operator cannot type, which is a different failure from a rule that
did not load.

## Distribution in this platform

Commands are distributed into Aweave by a `dsh` provider in
`workspaces/devtools/common/config/defaults/workspace.yaml`, under
`buildCommands.providers`, with `targetDir: ".dsh/commands"`. Its allow-list is
**tool-verified** rather than "the whole cursor set" — 10 of the 13
`agent/commands/common/*.md` files:

`brainstorm`, `create-overview`, `create-plan`, `debate-opponent`,
`debate-proposer`, `doctor-devtools`, `lead`, `orchestrate`, `relay-commit`,
`review-plan`.

Three files are deliberately excluded, each for a named reason:

| File | Why it is excluded |
| --- | --- |
| `implementation` | References `subagent_type`, the `Task tool` and `ReadLints`, none of which exist in DSH — DSH exposes subagents as separately-named tools such as `agent_scout`. |
| `create-confluence-page` | References `mcp_confluence_confluence_*`; no Confluence MCP server is mounted, and DSH's tool naming form is `mcp__<server>__<tool>`. |
| `create-skill` | Cursor-only surface: it writes to `~/.cursor/skills/` / `.cursor/skills/`, verifies through Cursor Settings, and uses Cursor's `/migrate-to-skills`. |

Run it with `pnpm aw workspace build-commands` (cwd `workspaces/devtools`). It
creates **absolute symlinks**, never overwrites a non-symlink, and prunes
managed symlinks no longer in config — so the allow-list can be widened or
narrowed just by editing the config and re-running.

Discovery follows symlinks (`readdirSync` + `statSync`, deliberately not
`lstatSync`), which is exactly what makes that distribution model work; this was
probed empirically rather than assumed.

`.dsh/commands` is already git-ignored by `.gitignore:29` (`.dsh/*`), so no
`.gitignore` change was needed. **That is a convention, not tool-enforced**:
`build-commands` validates only that `targetDir` resolves inside the project
root.

***

# Part 4 — MCP servers

The plugin owns this deployment's MCP servers. **Settings → MCP servers**
lists them, adds, edits, enables, disables and removes them, and every change
takes effect in the running host — no restart and no patch-file edit.

## Where the servers live

| Layer | File | Role |
| --- | --- | --- |
| Composition base | `cordis.patch.yml` (`config.mcp.servers`) | Ships `[]`. Credential-free by design, because this file is version-controlled. |
| User layer | `$DSH_HOME/settings.yaml`, namespace `dsh-project-context-mcp` | The operator's servers. Home-level and mode `0600`, so one document covers every profile. |

The plugin registers that namespace through `ctx.settings.installSection()`, so
it loads normally on a host with no settings provider (the composition base is
then authoritative) and the Settings card is the only supported editor.

## The entry shape

The namespace schema is a **flat object with an enum `transport`**, never a
discriminated union, and that is load-bearing: the settings redaction walker
returns a union node verbatim, so a schema mirroring the MCP client's own
`stdio | streamable-http` union would put a plaintext API key on the settings
wire with an empty `secrets[]`. Per-transport requirements live in the
`validate` hook instead, which refuses the write before anything persists.

```yaml
dsh-project-context-mcp:
  servers:
    - id: doccontext            # stable, card-allocated
      serverName: mcp-doccontext
      enabled: true
      transport: streamable-http
      url: https://mcp.context7.com/mcp
      headers:
        CONTEXT7_API_KEY: '…'   # write-only on every wire surface
    - id: github                # a stdio server keeps its token in env instead
      serverName: mcp-github
      enabled: true
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: '…'       # write-only on every wire surface
```

`command`, `args`, `env` and `cwd` apply to `stdio`; `url` and `headers` apply
to `streamable-http`. Both `env` and `headers` are **secret positions**: their
values are stripped from every describe response and listed in `secrets[]` by
path, so the card sees the names and never the values. A hand edit of
`settings.yaml` bypasses `validate`, so the loader re-checks the schema and the
collection bounds when it resolves the document.

## Lifecycle

A change is reconciled against the live mounts: an added or enabled server is
mounted, a removed or disabled one is disposed, and a server whose connection
fields changed is remounted. Each server is mounted through
`ctx.plugin(McpClient, config)` **in its own Cordis scope**, so the MCP client's
per-scope `serverName` reservation holds and one server's teardown cannot touch
another's tools.

`serverName` is the identity that matters: public tool names are
`mcp__<serverName>__<rawName>`, hash-suffixed when the joined name is too long
or needs character rewriting. Two servers therefore cannot share a namespace
inside one scope, and a name another plugin already owns is detected by
prefix-matching the **tool registry** — never by parsing patch files, which see
neither bundle patches nor runtime mounts.

## Known limitations

- **A mounted server is not a working one.** `failOnStartupError` is always
  `false` here, so the MCP client logs a failed connect and resolves; the card
  reports `mounted, registered no tool` when the namespace stays empty, which is
  what a failed connect, a name collision rolling the generation back, and a
  server that genuinely exposes no tool all look like.
- **No reachability display.** `mcp-client` exposes no connection state, so the
  card cannot show latency, a reconnect loop, or a server that died after
  connecting.
- **Env and header values are write-only.** Both are secret positions, so the
  wire never carries their values: the card shows the stored env and header
  NAMES, and an edit that leaves one of those boxes empty keeps the stored
  values. To change a value, retype the line.
- **The MCP API key lives in `$DSH_HOME/settings.yaml` (mode 0600).** Do not
  keep a dated backup of a retired `cordis.patch.yml`: it is a second plaintext
  copy.
- **The namespace is home-level**, so it applies to every profile that loads
  this plugin — a profile without the plugin sees no MCP servers at all.
- **Removing a server disposes its scope**, which disconnects it; a server that
  does not exit on transport close may linger as an orphan process.

***

# Development

```sh
pnpm install          # links the harness packages from ../deepseek-harness
pnpm run check        # type-check both faces (host + browser)
pnpm test             # unit, client-artifact and real-composition suites
pnpm run build        # emit lib/ (host via tsc, browser bundle via tsdown)
```

The browser half ships as a lazy-CJS factory artifact (`lib/client.js`) that
calls `window.__ModuleLoader__.load({ id, factory })`; the client module system
serves it because `package.json` declares `dsh.client` and a `./client` export.
`test/client/bundle.spec.ts` asserts that handoff and the plugin face the
factory returns, so a build that silently changes either fails the suite.

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
