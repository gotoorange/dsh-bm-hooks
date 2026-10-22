# dsh-bm-hooks

Basic Memory lifecycle hooks as a **native DeepSeek Harness plugin**, plus a
Settings page for the three preferences that are actually user choices.

Mount it like any other DSH plugin — no bridge, no experimental mods package,
no hook config file. It drives the `bm` CLI from the harness's own extension
points, so it does the two things an external-command hook bridge cannot:

- reads the live transcript via `session.deriveMessages()`, because a hook
  process only ever receives an empty `transcript_path`;
- writes the checkpoint at the **real** PreCompact moment — the
  `compaction/start` session event, appended before summarization begins, while
  the surface is still intact.

Inspired by Basic Memory's own `bm hook` semantics for Claude Code and Codex.
The lifecycle contract is the same; the implementation uses DSH's native
extension points instead of an external hook process.

---

## Event mapping

| Basic Memory hook | Claude Code / Codex | This plugin |
|---|---|---|
| `bm hook session-start` | `SessionStart` | `agent/created` warms the CLI; `agent/pre-step` delivers the brief as source-attributed context |
| `bm hook pre-compact` | `PreCompact` | `session/event` → `compaction/start` — **a true pre-compaction checkpoint** |
| `bm hook flush` | *(never scheduled)* | `agent/disposed`, throttled by `flushIntervalHours` |
| `bm hook status` | — | `/bm-status` |
| *(manual checkpoint)* | — | `/bm-checkpoint` |
| `bm hook stop` | retired `Stop` | not needed; it exists only to unblock stale pre-upgrade configs |

Why `agent/created` and `agent/pre-step` are split: `agent/created` is the only
place that runs *before* the first turn, and `agent/pre-step` is the only place
whose result can carry `messages`. The brief subprocess starts at creation, the
delivery happens on step 1, and the result is cached per session so a resumed
turn does not re-run it.

---

## Install

### From npm

```powershell
dsh plugin add dsh-bm-hooks
```

### From a local checkout

```powershell
dsh plugin add file:C:\path\to\dsh-bm-hooks
```

Use `file:`, not `link:`. pnpm treats them differently for peer resolution:

| Spec | `node_modules` entry | Peers resolve from | Works? |
|---|---|---|---|
| `link:<dir>` | symlink to the checkout | the **checkout's** real path | ❌ `Cannot find package '@deepseek-ai/schemastery'` |
| `file:<dir>` | copied package | the **profile's** `node_modules` | ✅ |

A `link:` install makes the plugin resolve its peers from the source directory,
where no harness package exists, so it fails to load. `file:` copies the package
into the profile and resolves peers there, which is what the Loader expects.
The plugin manager's own guidance points at `link:` for source checkouts; for
this package the observable result is a load failure, so use `file:`.

Selecting the bundle inserts this row into the profile:

```yaml
- insert:
    - id: bm-hooks
      name: 'dsh-bm-hooks'
```

### Prerequisite: `bm` on PATH

```powershell
uv tool install basic-memory
```

No version pin: the package tracks the latest release, and `bm update` /
auto-update keeps it current. The only hard requirement is that the installed
CLI **ships the `hook` command group**, which arrived in v0.23 — a stale
pre-0.23 `bm` on PATH cannot work, which is exactly what bm's own
`_supports_hook()` probe guards against.

`uv tool install` puts the shims in `%USERPROFILE%\.local\bin`, which is **not
on PATH by default**. Add it once:

```powershell
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (($userPath -split ';') -notcontains "$env:USERPROFILE\.local\bin") {
  [Environment]::SetEnvironmentVariable("PATH", "$userPath;$env:USERPROFILE\.local\bin", "User")
}
```

**A DSH restart is required after changing PATH** — the running process keeps the
environment it was launched with, so a newly added entry is invisible to it.

---

## Configuration

The whole config is optional. The plugin carries no path, version, project
name, or workspace path:

```yaml
- id: bm-hooks
  name: "dsh-bm-hooks"
  config:
    harness: codex
    project: project-memory
    recallTimeframe: 7d
    briefLimit: 5
    injectBrief: true
    checkpointOnCompact: true
    autoDetectProject: false
```

| Key | Default | Editable live | Meaning |
|---|---|---|---|
| `enabled` | `true` | | `false` unmounts every listener and command. |
| `bmArgv` | `['bm']` | | argv prefix for the CLI. A bare name, resolved through PATH. |
| `harness` | `codex` | | `--harness` value; `codex` matches DSH's snake_case payload shape. |
| `project` | `''` | ✅ | Basic Memory project for the brief and checkpoints. A user preference: set it in Settings or with `/bm-project`. |
| `recallTimeframe` | `7d` | ✅ | Recall window for the brief. |
| `briefLimit` | `5` | ✅ | Entries the brief shows per section. |
| `autoDetectProject` | `false` | ✅ | Match each session's project to its working directory. See below. |
| `captureFolder` | `codex` | | Folder inside the project. Required by bm's `--folder`; a relative name, not a path. |
| `noteType` | `session` | | Frontmatter `type`. |
| `titlePrefix` | `DSH session` | | Title prefix; bm's own values are `Session` / `Codex session`. |
| `projectDir` | `''` | | `--project-dir` for bm's settings lookup; empty uses the session cwd. |
| `injectBrief` | `true` | | Deliver the session brief. |
| `briefWaitMs` | `8000` | | How long a step waits for the brief before proceeding without it. `0` never waits. |
| `checkpointOnCompact` | `true` | | Write a checkpoint at `compaction/start`. |
| `flushIntervalHours` | `24` | | Minimum hours between inbox sweeps. `0` disables. |
| `flushRetentionDays` | `30` | | `--older-than-days` for the sweep. |
| `timeoutMs` | `120000` | | Per-CLI-call ceiling, enforced by aborting the managed process range. |

The ✅ rows are declared `.volatile()`, so they are live references: the plugin
reads them through `.get()` on every use, and a Settings write is picked up
without a restart.

### Which project a session uses

Resolution order, most specific first:

1. an explicit per-session switch — `/bm-project <name>` or the `bm_set_project` tool;
2. a project whose root contains the session's working directory (`autoDetectProject`);
3. the configured `project`;
4. Basic Memory's own `default_project`.

`autoDetectProject` is **off by default** because it adds one cached
`bm project list --json` call per session and lets a cwd match outrank the
configured project. Enable it when one profile spans several repositories.

Matching is by **longest prefix** and separator-aware, so `D:/work/deep` wins
over `D:/work`, and `/work/ab` is not treated as living under `/work/a`. `~` and
symlinked spellings are canonicalized before comparison. Measured against a
real two-project setup:

```
D:/project-memory              => project-memory
D:/project-memory/notes/deep   => project-memory     ← subdirectory inherits
~\\basic-memory                => main
C:/Windows                     => (no match)         → falls back
some/workspace/dir             => (no match)         → falls back to default_project
```

Step 4 is the fallback that keeps a plain workspace directory from losing its
brief entirely.

---

## Settings page

The client half adds a **Basic Memory** section to Settings with three controls
and one switch:

| Control | Binds | Behavior |
|---|---|---|
| Project | `project` | Dropdown from `bm project list --json`, plus a refresh button |
| Recall window | `recallTimeframe` | `1d` / `7d` / `30d` |
| Entries per section | `briefLimit` | Number, 1–20 |
| Match project to working directory | `autoDetectProject` | Toggle |

Writes go through `ctx.configForms`, the Host settings transport, as one atomic
mutation with the revision that was read — the same path any other settings page
takes. The page never edits `cordis.patch.yml` itself; doing so would bypass
Loader validation and the stale-write check.

The project *list* is not part of the settings document, so the Host half serves
it at `GET /bm-hooks/api/projects` (loopback-only, no-store). That route is
registered only when a `webServer` is composed; in a headless deployment the
plugin runs normally and the page simply has no catalogue to show.

`lib/client.js` is a **built artifact**, not ordinary ESM: it registers a lazy
factory on `window.__ModuleLoader__` and takes React from the platform module
table. There is no build step — the file in the package is the file the browser
runs. Editing it in place is the supported way to change the page.

---

## Commands

```
/bm-project              # list Basic Memory projects and show the current one
/bm-project <name>       # switch to another project (persists to the profile)
/bm-status               # bm hook status: inbox depth, last flush, settings, versions
/bm-checkpoint           # write a checkpoint for this session now
/bm-flush                # sweep the inbox now instead of waiting for the interval
```

`/bm-project <name>` verifies the name against `bm project list --json` first, so
a typo cannot point the brief and checkpoints at a project that does not exist.
It writes through `configEditor.edit()` — the same service a Settings write uses —
so the change persists to the profile patch and the Loader reconciles it live.
Without a composed config editor it says so and points at `cordis.patch.yml`
instead of pretending to save.

### `bm_set_project` (model-facing)

The plugin never parses conversation text to guess a project — that is fragile
and unpredictable. Instead it publishes one deterministic switch primitive:

```
bm_set_project({ project?: string })
```

The description tells the model to call it when the user names a project,
repository, or workspace. Omit the argument to list what is available. The
binding is **per session** and writes no configuration, so a model-side switch
never changes another session's behaviour.

---

## `bm hook flush` — nothing schedules it

Grepping the whole installed Basic Memory package: `basic_memory.hooks.archive`
is imported in **exactly one place** — `cli/commands/hook.py`, the
`bm hook flush` command itself. There is no daemon, no startup hook, no
MCP-side sweep, no cron. So on Claude Code and Codex the inbox only grows, and
`processed/` is never pruned.

This plugin therefore sweeps at `agent/disposed`, throttled by
`flushIntervalHours`.

Two properties make automating it safe, both from bm's own implementation:

- **It never writes to the graph.** `archive.flush` only moves valid envelopes
  into `processed/`, dedups by `idempotency_key`, and prunes by retention.
- **It fails safe on junk.** Invalid or future-`envelope_version` files stay
  pending for inspection instead of being deleted.

Set `flushIntervalHours: 0` and schedule `bm hook flush` externally if you
prefer; the result is identical.

---

## Failure behavior

Every CLI call is contained:

| Failure | Behavior |
|---|---|
| `bm` not resolvable | logged at `warn`; the step still enters with no context |
| CLI exits non-zero | logged at `warn` with the stderr tail; the session continues |
| spawn throws | returned as a failed run; logged, never thrown into the loop |
| brief unavailable | no context message added; the turn proceeds |
| no user turn to checkpoint | `/bm-checkpoint` reports it; nothing is written |
| project list unreadable | the brief falls back to the configured project |

This mirrors bm's own hook contract: active lifecycle verbs are fail-open, so a
capture or recall error must never disrupt the agent session.

---

## Notes on the implementation

- **The brief is not pinned to step 1.** `bm` is a Python process: measured at
  ~3.5 s warm and ~12.5 s cold on this machine. Blocking the first step on that
  would be wrong, so `agent/pre-step` races the brief against `briefWaitMs` and
  delivers it on whichever step first finds it ready. The subprocess is started
  once at `agent/created` and cached, so a slow first step never starts a second.
- **Timers are `unref()`ed.** The `timeoutMs` deadline aborts the managed
  process range, but the timer must never be the reason the host process stays
  alive.
- **Source labels are load-bearing.** Every injected message carries
  `source: { kind: 'bm-hooks', form: 'snapshot', sections: [...] }`. An
  unlabeled context message would render as a user prompt in derived history.
- **`session/event` is observe-only.** The emitter does not await listeners, so
  the checkpoint work is started and contained inside the handler.
- **Subagent sessions are skipped.** `session.header.origin === 'subagent'`
  means the session is a child; briefing or checkpointing it would duplicate
  the parent's work.
- **`bm tool write-note` has no `--metadata` flag**, but frontmatter inside the
  note's own content takes precedence over `--type`, so the frontmatter rides
  the content and the note keeps every metadata key.
- **Every external call is a command, never an MCP call.** The plugin spawns
  `bm` through `ctx.subprocess` for all its operations. It never routes through
  `mcp__basic-memory__*` tools: a lifecycle hook is a command boundary, so this
  keeps one execution path with one failure mode, no coupling to whether an MCP
  connector happens to be connected, and no second client of the same database.
- **No settings file is ever written.** Configuration lives in DSH alone. The
  brief is built from explicit `--project` queries, so neither
  `~/.codex/basic-memory.json` nor `~/.claude/settings.json` is created, read,
  or modified.
- **Only `@deepseek-ai/schemastery` is imported.** A profile plugin resolves its
  peers from the profile's own `node_modules`; packages like
  `@deepseek-ai/dsh-llm` or `@deepseek-ai/dsh-tools` live in the app archive
  and are not resolvable there. Importing one makes the plugin fail to load
  with `Cannot find package`. Both the tool definition and the context message
  are therefore built from the harness's documented shapes rather than from its
  constructors.

---

## Tests

```powershell
node test/native.mjs      # 36 offline checks: plugin shape, config, lifecycle, commands, tools
node test/client.mjs      # 3 checks: the client bundle registers and writes through settings
node test/projects.mjs    # 4 checks: normalization and matching against the real bm CLI
```

`native.mjs` loads the real `lib/index.js`, stubs only `@deepseek-ai/schemastery`,
and drives the plugin through a fake Cordis context. It also guards the three
constraints above: no harness-internal import, no MCP tool call, and no settings
file written.

---

## Known limitations

- **`link:` installs do not load.** See [Install](#install). Use `file:` for a
  local checkout, or install from npm.
- **A restart is needed to pick up code changes.** The plugin is loaded once at
  startup; `file:` installs copy the package, so re-run the install (or restart)
  after editing the checkout. Settings *values* need no restart, because the
  volatile fields are live references.
- **The Settings page cannot be verified without a browser.** The bundle's
  registration, services, and write path are covered by `test/client.mjs`; the
  rendered result is not. Treat "it appears in Settings" as a manual check.
- **Project auto-detection costs one CLI call per session** when enabled, and
  the result is cached for 60 seconds. A project added mid-session appears after
  that window or on the next session.
- **The brief is extractive and capped.** It shows at most `briefLimit` entries
  per section and does not summarize note bodies; the full graph stays in Basic
  Memory.
- **`bm` must be on the PATH the harness was launched with.** A PATH edit made
  while DSH is running is invisible until restart.
- **The project list route is loopback-only.** A deployment that serves the GUI
  on a non-loopback address will see the page load without a catalogue.

---

## License

MIT. See [LICENSE](LICENSE).
