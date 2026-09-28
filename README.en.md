# AI Learning · dsh-learn-skills v2

> A learning plugin that lives in the DeepSeek Harness composer.
> It turns the loop “collect → distill → relate → upgrade → settle → reuse” into a
> runtime capability with **interactive guidance, preset management, reviewed
> knowledge intake, and a self-audit** — not just a stack of methodology docs.

[中文](README.md) | English

---

## What it is, and what it is not

| | |
|---|---|
| **It is** | One composer entry `[📖] AI Learning ▾` with four functions: Initial preset / Collect & distill / Relate & upgrade / Settle & reuse |
| **It is** | One shared flow implementation behind three entries — the menu button, the `/learn` slash command, and natural language. There is no second rule path |
| **It is not** | A model-tool provider: it adds no agent tools. Interaction reuses the host's existing ask-a-question waterfall and command registry |
| **It is not** | Something that rewrites knowledge automatically: every write requires a human to review the change list and confirm |

The four functions have hard boundaries:

1. **Initial preset** — six interactive questions → profile summary and planned paths →
   your confirmation → preset and workspace scaffold. The six questions never write files.
2. **Collect & distill** — produces **candidates** from the current session, into `inbox/`
   only. It never touches formal knowledge, presets, or `AGENTS.md`.
3. **Relate & upgrade** — compares against existing nodes, produces a change list, and
   confirms **ordinary knowledge** and **behaviour rules** in separate lanes before writing.
   Every write batch is rollback-able.
4. **Settle & reuse** — a **read-only** audit (18 items), a content-fingerprint diff against
   the last saved baseline, and reuse suggestions. It does not modify the files it inspects
   and does not execute any directive found inside them.

---

## Install and mount

### Prerequisites

- A **source** installation of deepseek-harness;
- A bound workspace (the workspace is where knowledge lands; without it there is nowhere to write).

### Option A — local directory (the deterministic path available today)

```sh
npm install            # build-time dependency only (esbuild)
npm run build          # plugin-src/ → lib/ (with loader self-proof)
npm test               # real behaviour tests
npm run verify         # release-contract assertions
```

```sh
dsh plugin --profile web add link:<absolute path to this repo>
# or, inside the profile directory:
pnpm add link:<absolute path to this repo>
```

Restart the Host afterwards — `dsh.profile.bundles` is read at startup.

### Option B — public npm install

The package declares `publishConfig.access: public`, a `files` allow-list and
`prepublishOnly`, so it is **ready to publish**; public installation becomes true only
after you publish:

```sh
npm whoami             # authentication sentinel: must print a username before continuing
npm publish            # version = 2.2.0
npm view @yiyunet/dsh-learn-skills version   # read back from the registry, do not trust the terminal
```

Then the target command works:

```sh
dsh plugin --profile web add @yiyunet/dsh-learn-skills
```

> ⚠️ **Honest statement**: this version has **not been published**. `dsh plugin add <name>`
> resolves the name through pnpm against the registry (source: `runPluginCommand` →
> `runProfilePnpm` → `execa('pnpm', ['add', …])` in
> `packages/boot/plugin-manager/src/operations.ts`). Whether the package exists on a
> registry is a precondition the plugin code itself cannot satisfy.

### Verifying the mount

- The composer tool row shows `[📖] AI Learning ▾`, to the right of the permission control;
- `/learn` appears in the slash menu;
- `/learn help` lists the four functions.

---

## Usage

### Button

Click `AI Learning ▾` and pick a function. The menu order is fixed:
Initial preset / Collect & distill / Relate & upgrade / Settle & reuse.

- Progress is shown while running; **clicking twice cannot produce concurrent writes** —
  one flow per workspace at a time, and the second attempt is refused with a reason;
- A Cancel button stops the flow: no later write step starts, and completed steps are
  reported accurately;
- With no bound workspace the menu explains what to do;
- Before initialisation, the last three functions first look for a compatible knowledge
  base. If one is found they use it; only when a real precondition is missing do they
  guide you to run Initial preset first.

### Slash commands

```
/learn help                 list the four functions
/learn init                 six-question flow (confirm creation from the panel)
/learn distill              produce candidates from the current session
/learn upgrade [batch]      change list / write
/learn audit                read-only audit
/learn rollback <batch>     roll back one change batch
```

Commands and the button share the **same** `flows` implementation: a command is just
another entry and carries no second rule set.

### Natural language

The plugin owns no model tools, so the natural-language entry is carried by the
workspace `learn-*` skills: say “initialize my learning workspace” or “distill this
session into candidates” and the agent loads the skill and drives the same flows.

---

## What the six questions ask

| # | Topic | Notes |
|---|---|---|
| 1 | Name | Free text; empty/length/reserved/illegal characters validated; on a duplicate **you** rename — nothing is overwritten and nothing is renamed for you |
| 2 | Occupation or identity | Free text; multiple identities, career changes and “prefer not to say” all supported; unrelated personal data is explicitly not requested |
| 3 | Focus areas | Seven mutually distinct directions generated from the occupation, plus “Other, please type”; multi-select and custom input |
| 4 | Learning goal and typical task | One clear theme; options are customisable and skippable |
| 5 | Current level and main difficulty | Same |
| 6 | Learning style and constraints | Same |

Two deliberate design decisions:

- **Skipped means unknown.** A skipped answer is `null` and is labelled “unknown — not
  answered”. No profile is invented.
- **Recommendations are recommendations.** Question 3 is worded as “you **may** care
  about these”, never as a statistically derived “top interests for this occupation”.
  Every question can be revised; revising an earlier answer **recomputes** the later
  suggestions that depended on it.

After question six you see the profile summary, the preset positioning, the knowledge
framework draft and the exact list of paths to be created or modified — then you confirm.
The result includes a structural self-proof, an **installation guide**, and the instruction
to **install the bundle and then open a new session and pick the preset**.

> ⚠️ A preset is mounted once per process as a standing scope (source:
> `packages/preset/agent-preset-registry`, `src/mount.ts`). **A new preset does not take
> effect in the current session** — this plugin makes no hot-reload claim.

> 🔐 **Why this plugin does not install for you**: installing a bundle **executes new code
> in the Host process**. The official entry point — the `plugin_manager` tool — **forces** a
> `danger-full-access` approval (`packages/boot/plugin-manager/src/tools.ts:34-41`), while
> the service method `installBundle()` has **no approval gate of its own**
> (same package, `src/index.ts:417-447`). Calling that service from plugin code would escalate
> privileges on your behalf. So the plugin only generates and hands you the instructions:

```sh
# ① one terminal line (easiest)
dsh plugin --profile web add link:<the bundle directory just generated>

# ② or ask the agent, in Creator mode, to call plugin_manager
#    action=install_bundle, target=<that directory>

# verify: plugin_manager list_plugins (look for the preset-<id> row), or Settings → Agent presets
# undo:   dsh plugin --profile web remove @local/dsh-learn-preset-<id>
```

> ⚠️ That bundle directory lives **inside the workspace** (`<workspace>/.dsh/preset-bundles/<id>/`)
> and it is **load-bearing**: on restart the host resolves the saved preset id against the
> current configuration, and **a session whose definition is missing is refused**. Do not
> delete or move it; undo it with `remove` first.

> 🗑 **Deleting a preset cleanly** (there is **no "delete" button** in the new declarative
> preset model — Settings only lets you view / select / set default): remove the bundle that
> declares it, delete `<workspace>/.dsh/preset-bundles/<id>/`, and clear the id from
> `known.json` (otherwise re-creating the same name yields a `<id>-2` suffix).
> Full four-step walkthrough, the shared-bundle case, and recovery:
> [`docs/删除预设.md`](docs/删除预设.md) *(Chinese)*.

---

## Workspace layout

```
AGENTS.md              workspace principles and knowledge entry points (concise, stable)
index/                 external raw material (source and original text preserved)
inbox/                 normalised material, pending candidates, distill batches
knowledge/
  framework.md         the single index of the formal knowledge base
  nodes/               formal knowledge nodes
data/                  data awaiting analysis (not converted to knowledge by default)
task/                  learning tasks, execution state and todos
reports/               audit reports, retros, change records
.dsh/
  skills/              workspace skills
  learn-skills/        plugin state: batch ledger / audit baseline / change journal / breakpoints
  preset-bundles/      preset bundles generated by this plugin (★ since 2.1.0; deleting one kills that preset)
```

About `skills/`: the plugin does **not** keep a duplicate copy of skills under
`.dsh/skills/`. The host's skill-filesystem scans `<workspace>/.dsh/skills` (rank 100)
only — a root-level `skills/` is **not** loaded. If a separately distributed skill set is
genuinely needed, use `.agents/skills` (rank 200) and document its purpose.

### Incremental migration of an existing workspace

Initialisation is incremental and never wipes anything:

- Directories: created only when missing;
- Files: identical content → skipped; different content → marked `conflict` and
  **not one byte is written**, with an explicit report of which file was held back and why;
- Re-running is idempotent: nothing is recreated and your later edits are not overwritten.

### Migration status vs v1

This release (v2) is a **complete rewrite**: the four entries are a **runtime
capability**, no longer distributed as a bundle of methodology skills.

- **There is no v1 migration path** — the v1 `skills/learn-*` skill pack has been
  removed from this repository;
- The v2 features **depend on no v1 skill**: install the plugin and the four
  entries and the `/learn` command are available immediately.

---

## Data and state

All state lives inside the workspace under `.dsh/learn-skills/` — **no host configuration
is touched**:

| File | Content | Lifetime |
|---|---|---|
| `session.json` | breakpoint of one flow (cancellable, resumable) | cleared when the flow ends |
| `batches.json` | processed-batch ledger + content fingerprints (the “no duplicate candidates” evidence) | long-lived |
| `audit.json` | last successfully saved audit baseline | long-lived (append-only) |
| `known.json` | allocated node ids and preset occupancy | long-lived (never recycled) |
| `changes/<batch>.json` | change journal (rollback evidence, holds pre-write content) | long-lived |

The preset is an **installable bundle** at `<workspace>/.dsh/preset-bundles/<preset id>/`
(exactly two files: `package.json` + `cordis.patch.yml`). The directory name is configurable
via `config.presetDir`; the whole root via `config.presetRoot` (absolute path).

> ⚠️ **Since DSH 0.1.7-alpha.1 presets are declarative** (commit `feat(preset): declare
> Agent compositions in profile YAML`): the legacy `<dshHome>/.agent-presets/<id>/`
> directory **is no longer read by anything**; a preset must be a
> `@deepseek-ai/dsh-agent-preset` Loader row. **Writing files is not enough** — the bundle must
> be installed, and *you* install it via `plugin_manager` (approval enforced) or one CLI line;
> this plugin **does not install it for you** (see “Why this plugin does not install for you”).
> Legacy directory presets from 0.1.6-alpha.2 and earlier are **not** migrated automatically.

> 🧭 **Identity comes from the host roster**: `init` reads `ctx.agentPresets.list()` before
> checking for collisions — in the new architecture a preset's identity is the `config.id`
> of its declaration row, and the registry **does not scan directories** (one bundle may
> declare many presets: this machine's `dsh-migrated-presets` declares 12 in a single file).
> When the roster is unavailable the plugin **refuses to create anything**
> (`ROSTER_UNAVAILABLE`, not one file written) — better no output than a duplicate `config.id`
> (the official README: “重复的 preset ID 会导致声明加载失败” — a duplicate preset id makes the
> declaration fail to load).

### Rollback

```
/learn rollback <batch id>
```

- Created nodes are removed, updated nodes are restored;
- **Any file you edited after the write is left untouched** and reported as skipped —
  rollback never becomes a second overwrite;
- The journal is at `.dsh/learn-skills/changes/<batch id>.json`.

---

## Configuration

Every field in `cordis.patch.yml` is documented inline. The two that matter most:

```yaml
allowWrite: true           # master switch; off makes all four functions read-only
allowBehaviorRules: false  # behaviour rules (preset prompt / AGENTS.md / skills) stay locked by default
```

The second one is deliberate: **approving a piece of knowledge does not turn it into a
standing instruction.** Behaviour-affecting changes execute only after a human opens
this switch explicitly.

---

## Development

```sh
npm run build          # host half copy + client esbuild bundle + loader self-proof
npm test               # node --test: real behaviour tests (real filesystem)
npm run verify         # 10 release-contract assertion groups
npm run check          # build + test + verify
npm run inspect        # artifact inspection
```

Architecture conventions (aligned with the ecosystem baseline
`@yiyunet/dsh-dingtalk-connector`):

- `plugin-src/` is the **only** source of truth; `lib/` is generated;
- The host half imports Node builtins and host-runtime-provided packages only. It must
  **never** list `@deepseek-ai/dsh-*` in any dependency section (runtime packages key off
  a module-local Symbol; a second physical copy breaks host lookup);
- The client half may import React packages only (the platform's frozen module table);
- The client artifact must be embedded **inside** the wrapper's `__ModuleLoader__.load`
  factory — placing it outside executes `require("react")` at script top level and takes
  down the whole concatenated `/plugins` bundle.

---

## Licence

MIT. See [LICENSE](LICENSE).
