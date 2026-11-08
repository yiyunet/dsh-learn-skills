# AI Learning · dsh-learn-skills

**A learning plugin that lives in the DeepSeek Harness input area.** It turns "collect → distill → relate → upgrade → persist → reuse" into a **runtime capability with guided interaction, preset management, reviewed writes and a self-audit** — not just a stack of methodology documents.

MIT · independent community plugin · **not affiliated with, sponsored by, or endorsed by DeepSeek or DeepSeek Harness**
[Data and state](#data-and-state) · [Uninstall](#uninstall)

[中文](README.md) | English

---

## What this is, and what it is not

| | |
|---|---|
| **Is** | One entry in the input area — `[📖] AI学习 ▾` — with four functions: initial preset / collect & distill / relate & upgrade / persist & reuse |
| **Is** | The **same flow implementation** behind the slash command `/learn` and natural language (there is no second rule set) |
| **Is not** | A model-tool provider: it adds no tools to the agent, reusing the host's existing ask-a-question and command registry |
| **Is not** | Something that rewrites your knowledge automatically: every write requires a human to review a change list and confirm |

## The four entries and their boundaries

| # | Entry | What it does | Writes to | Command |
|---|---|---|---|---|
| 1 | **Initial preset** | Seven rounds of Q&A establish a profile → show a summary and the planned paths → **you confirm** → generate the preset and workspace skeleton | Workspace files and directories (**incremental, never overwrites**) | `/learn init` |
| 2 | **Collect & distill** | Produce **candidates** from the current session — this step **never** touches formal knowledge, presets or `AGENTS.md` | `inbox/` only | `/learn distill` |
| 3 | **Relate & upgrade** | Compare against existing nodes → produce a change list → confirm **ordinary knowledge** and **behavior rules** separately, then write (batch is rollback-able) | `knowledge/` (behavior rules require explicit opt-in) | `/learn upgrade` |
| 4 | **Persist & reuse** | **Read-only** audit (18 checks) ＋ change comparison against the last baseline ＋ reuse suggestions. It **modifies nothing it checks** and executes no instruction found in files | **writes nothing** | `/learn audit` |

> **Relation to the older workflow**: the older flow ran the whole pipeline in one click; now the writes in the middle are **tightened to "produce candidates → human verdict → write"**. That is the substantive difference — see [`docs/迁移与兼容.md`](docs/迁移与兼容.md).

## What it guarantees, and what it does not

| | Content |
|---|---|
| **Guarantees** | Writes happen only after human confirmation; every write is rollback-able per batch, and **files you edited after the write are never touched**; initialization is incremental and conflicting files are **not written at all**; when the host preset roster cannot be read it **refuses to create** (nothing on disk, no duplicate `config.id`); the plugin **never writes host configuration** — all state lives inside the workspace |
| **Does not guarantee** | It does not install the preset bundle for you (reason below); a new preset does not take effect in the current session (presets mount once per process under standing scope); it never rewrites your knowledge assets |
| **Why "installing the preset" is left to you** | Installing a bundle **executes new code inside the Host process**. The official `plugin_manager` entry therefore **forces** a `danger-full-access` approval, while the service method `installBundle()` **has no approval gate of its own** — calling it directly from a plugin would **exercise authority on your behalf**. So the plugin only generates and instructs; the click stays yours |

## Requirements

- A **source** installation of deepseek-harness (`engines.dsh >= 0.2.1-alpha.1`);
- **Node ≥ 22.19**;
- A bound workspace (the workspace is where knowledge lands; without it nothing can be written).

## Install

### Option A · From npm (recommended)

```sh
dsh plugin --profile web add dsh-learn-skills
```

Then **restart the host** (the profile's `dsh.profile.bundles` is read at startup).

> ✅ **Consumers do not build anything**: the published package ships `lib/`, so installing from a registry is a one-step operation. The build commands below matter only to people changing the source.

### Option B · Local directory install (for source changes / debugging)

`lib/` **is not in the repository**, so a clone must be built:

```sh
npm install            # installs esbuild (build-time dependency) only
npm run static         # static consistency check (imports/symbols/syntax/allowlists)
npm run build          # plugin-src/ → lib/
npm test               # real behavior tests
npm run verify         # release contract assertions (11 groups)
```

```sh
dsh plugin --profile web add link:<absolute path to this repository>
```

> 📌 `npm install` **builds once automatically** (a `prepare` hook). The `npm run build` line above is therefore an idempotent re-run, not a required step — it stays so that "build" is **explicitly visible** in the flow.

### Check that it loaded

- The input-area tool row shows `[📖] AI学习 ▾` (to the right of the "workspace changes" control);
- `/learn` appears in the slash menu;
- `/learn help` lists the four entries.

**To remove it**: see [Uninstall](#uninstall).

## Quick start: generate and enable a preset from scratch

Installing is not the same as working. The endpoint of the four steps below is **a preset that is in the roster and selectable in a new session**.

1. **What you provide** — a name, plus one three-part line: `occupation ｜ what you face (people or subject) ｜ what you want to achieve`.
2. **What you do** — click `[📖] AI学习 ▾` → **Initial preset** → complete the seven questions (each can be revisited) → review the summary and planned paths → **click Confirm create** → **install the generated bundle yourself** as instructed.
3. **Where the result appears** — the workspace is filled in incrementally; the preset itself lands in `<workspace>/.dsh/preset-bundles/<preset id>/` (exactly two files: `package.json` + `cordis.patch.yml`); the UI shows a structural self-check and install guidance.
4. **How to know it is right** — after installing the bundle, **start a new session** and the preset appears in the preset selector; the input area shows `[📖] AI学习 ▾`. **Not seeing a new preset in an existing session is expected** (presets mount once under standing scope; no hot reload).

## Day-to-day use

**Main line, end to end.** Finish a stretch of work → collect & distill (produce candidates) → relate & upgrade (review the change list; confirm ordinary knowledge and behavior rules separately) → persist & reuse (read-only audit; compare against the last baseline).

**Shortest path from the second time on.** With a knowledge base in place, the last three entries first detect the existing base: if found they use it directly, and only if not do they guide you to the initial preset.

**Three triggers, one implementation**: ① the input-area button `[📖] AI学习 ▾`; ② the slash command `/learn`; ③ natural language (routed into the same flow by workspace skills). **There is no second rule set.**

**Two guarantees while running**: **repeated clicks never cause concurrent writes** (one flow per workspace at a time; a second attempt is explicitly rejected); **cancelling stops any further write steps**, and completed steps are reported truthfully.

### Slash commands

```
/learn help                 list the four entries
/learn init                 seven-question flow (creation is confirmed in the UI)
/learn distill              produce candidates from the current session
/learn upgrade [batch]      change list / write
/learn audit                read-only audit
/learn rollback <batch>     roll back one change batch
/learn rollback <batch> --dry-run   list files that would be deleted/restored, change nothing
```

Steps that need confirmation (creating a preset, writing changes) accept `--confirm` on the command side, but **the default path is confirming in the UI** — people should see the change list first.

### Natural language

The plugin owns no model tools, so the natural-language entry is provided by the workspace skills `learn-*`: say "help me set up my learning system" or "turn this session into candidates", and the agent reads the skill and calls the same flow.

### What the seven questions ask

The first two are fixed; **from question 3 onward the model generates them live each round** (carrying everything collected so far, the remaining rounds and the topics already asked). When no model is available it falls back to a hardcoded bank round by round, and the flow never stops.

| # | Topic | Key points |
|---|---|---|
| 1 | Name | Free input; empty/length/reserved-name/illegal-character checks; **a duplicate asks you to rename** — it neither overwrites nor renames for you |
| 2 | Identity · facing · expectation | **One three-part line**: `occupation ｜ what you face ｜ what you want`; a single part is treated as occupation only and the rest stays unknown; it **does not ask** for employer or real name |
| 3 | Focus areas | The model asks from your three parameters; on fallback it matches through "scenario pool → occupation pool → generic pool" and offers **7 directions** + "other, please specify"; multi-select and free text supported |
| 4 | Learning goals and typical tasks | Model-driven question; on fallback, candidates around a fixed theme plus free text |
| 5 | Current level and real difficulties | Same |
| 6 | Learning style and output preference | Same |
| 7 | The one thing you want solved first | Model-driven; on fallback offers "as fast as possible / build foundations / steady cadence" — this one decides what comes first |

Three deliberate design choices: **blank means unknown** (skipped items are `null` and labelled "unknown — not filled", never invented); **a suggestion is a suggestion** (wording is "you **may** care about", never presented as a statistical finding; every question can be revisited, and changing an earlier answer re-derives later ones); **the model chooses the questions, the plugin fixes the slots** (which profile field an answer lands in is fixed by the plugin, so model-reported dimensions cannot bypass the "blank means unknown" normalization and silently lose data).

After the seventh question it shows: profile summary / preset positioning / knowledge framework draft / the list of paths to create or modify — and only then can you click **Confirm create**. Afterwards it prints a structural self-check and **install guidance**:

```sh
# ① One terminal line (simplest)
dsh plugin --profile web add link:<the bundle directory just generated>

# ② Or ask an agent in a "creation mode" session to call plugin_manager (it raises an approval card)
#    action=install_bundle, target=<that directory>

# Verify: plugin_manager's list_plugins (look for a preset-<id> row) or GUI Settings → Agent presets
```

> ⚠️ A preset mounts once per process under standing scope. **A new preset does not take effect in the current session** — this plugin claims no hot reload.
> ⚠️ The bundle directory lives **inside the workspace** and is **live**: on restart the host resolves the preset id against the current configuration, and **sessions whose definition is missing are refused restoration**. Do not delete or move it.

> 🗑 **To delete a preset (the complete four steps)**: see [`docs/删除预设.md`](docs/删除预设.md). Remember three things first: ① there is **no "delete preset" button** (the settings page only views/selects/defaults); what you can remove is **the bundle it lives in**; ② **after uninstalling you must also delete** `<workspace>/.dsh/preset-bundles/<id>/` and **clear its entry in `known.json`** (otherwise a same-name rebuild gets a `-2` suffix); ③ with several presets in one package you **must not uninstall the whole package**.

> 🧭 **Identity comes from the host roster**: `init` reads `ctx.agentPresets.list()` before checking for duplicates — in the new architecture **preset identity is the `config.id` in the declaration row**, and the registry **does not scan directories** (one bundle can declare many presets). If the roster cannot be read it **refuses to create** (`ROSTER_UNAVAILABLE`, not a single file written) — better no output than a `config.id` duplicated with an existing preset (official wording: "duplicate preset IDs cause declaration loading to fail").

## Workspace structure

```
AGENTS.md              workspace principles and knowledge entry (concise, stable)
index/                 external raw material (keeps sources and originals)
inbox/                 normalized material, pending candidates, distill batches
knowledge/
  framework.md         the single master index of the formal knowledge system
  nodes/               formal knowledge nodes
data/                  data awaiting analysis (not turned into knowledge or memory by default)
task/                  learning tasks, execution state and to-dos
reports/               audit reports, retrospectives and change records
.dsh/
  skills/              workspace skills
  learn-skills/        plugin state: batch ledger / audit baseline / change log / breakpoints
  preset-bundles/      presets generated by this plugin (★deleting one invalidates that preset)
```

About `skills/`: by default it **does not duplicate skills into `.dsh/skills/`**. The host's skill-filesystem scans only `<workspace>/.dsh/skills`; a root-level `skills/` **is not loaded**. If you genuinely need separately distributable skills, use `.agents/skills` and document their purpose.

### Incremental migration of an existing workspace

Initialization is **incremental** and never clears anything: a directory is created only if absent; a file with identical content is skipped; **a file with different content is marked `conflict` and not a single byte is written**, and the result names which file was blocked and why. Re-running is idempotent.

## Data and state

All state lives in `<workspace>/.dsh/learn-skills/`; **host configuration is never written**:

| File | Content | Lifetime |
|---|---|---|
| `session.json` | Breakpoint of a single flow (cancellable, resumable) | Cleared when the flow ends |
| `batches.json` | Processed batch ledger + content fingerprints (the "do not recreate candidates" criterion) | Long-lived |
| `audit.json` | Last successfully saved audit baseline | Long-lived (append-only) |
| `known.json` | Allocated node ids and preset occupancy | Long-lived (never reclaimed) |
| `changes/<batch>.json` | Change log (rollback evidence; contains pre-write content) | Long-lived |

The preset itself lives in `<workspace>/.dsh/preset-bundles/<preset id>/`. The directory name can be changed with `config.presetDir`, and the whole root overridden with `config.presetRoot` (absolute path).

### Rollback

```
/learn rollback <batch>              perform the rollback
/learn rollback <batch> --dry-run    show the plan only, change nothing
```

- Newly created nodes are deleted; updated ones are restored;
- **Files you edited after the write are never touched** and are reported as skipped — a rollback never becomes a second overwrite;
- Results carry the **absolute path of every file**;
- If an absolute path in the log no longer matches the current workspace (the workspace moved, or the log was edited), it is recorded as `tampered` and flagged — the rollback still proceeds using relative paths and never gets stuck.

## Configuration

Every field in `cordis.patch.yml` carries a Chinese comment. Two defaults matter most:

```yaml
allowWrite: true           # master switch; when off all four entries become read-only (init only previews)
allowBehaviorRules: false  # behavior rules (preset prompts / AGENTS.md / skills) are not permitted by default
```

The second is deliberate: **knowledge being accepted does not make it a standing instruction**. Changes that affect agent behavior require a human to explicitly open this switch before the relate & upgrade confirmation will execute them.

### Semantic enhancement (dual track with divergence flags)

**Off by default**:

```yaml
allowModelSemantics: false  # when on, distillation sends session text to a model for semantic judgment
semanticBatchSize: 8        # items judged per call (higher is cheaper, slower)
semanticBudgetMs: 60000     # total budget; when exhausted the rest uses the baseline track
```

**Why off by default**: turning it on **sends session text to a model**. Sessions may contain customer information, platform account hints or internal pricing — that is data egress and a compliance red line, hence disabled.

**What it does**: adds a semantic track to collect & distill — the model judges each candidate's **type** and its relation to **existing nodes** (`new`/`supplement`/`correction`/`conflict`/`duplicate`/`supersede`/`unverified`), plus `why` (which words led to it).

**Why it does not overwrite the baseline**: model output **is not reproducible** — two distillations of the same content can disagree. Overwriting the baseline would produce "same knowledge classified differently on entry → version bumps for no reason → index churn", destroying provenance and traceability on the spot. Hence **two tracks side by side**:

| Track | Produced by | Reproducible | Fields |
|---|---|---|---|
| Baseline | keyword regex + lexical overlap | ✅ | `type` / `relations` (`confidence: 'heuristic'`) |
| Semantic | model | ❌ | `typeSemantic` / `relationsSemantic` (`confidence: 'model'`) + `why` |

When the tracks agree no extra fields appear; **when they diverge both are shown side by side with `typeDivergence` / `relationsDivergence`**, and the review panel labels model suggestions explicitly as "model" — **the final verdict is still yours**.

**Fallback discipline**: no model / timeout / invalid JSON / over budget ⇒ **silently fall back to the baseline track** and candidates are still produced. Two honest notes: when semantic enhancement is **partially applied** (budget hit or a batch failed), both the UI and the batch file mark it "not finished"; the `semantic` summary in the batch file records how many calls and how many divergences for later review. Model output is **strictly validated, never patched** — fabricated candidate ids and illegal type/relation values are discarded.

## Troubleshooting

**`[📖] AI学习 ▾` missing after install**

| Check | Note |
|---|---|
| **Did you restart the host** | ★ The most common cause. `dsh.profile.bundles` is read **at startup** |
| Right profile? | Must be `--profile web` (the client half registers only in the web profile) |
| Is the package there? | `dsh plugin --profile web list`, or inspect the profile's bundles list |

**Menu opens but clicking gives `HTTP 404`** (e.g. `transport failure for /api/dsh-learn-skills: HTTP 404`)
Root cause: the HTTP RPC endpoint was not registered. The `connection` service belongs to the web runtime layer and may not be ready when `apply()` runs, so the registration window is missed. This plugin **does not put `connection` into the static `inject`** (that would leave the plugin entirely inactive in deployments without a web runtime); it registers **after the service becomes ready**, and a `npm run verify` assertion pins this down. If you do see this 404, share the `learn-skills` lines from the host log under `~/.dsh/`.

**Clicking "Initial preset" immediately reports it cannot read the host preset roster** — **deliberate**: without the roster it cannot guarantee a unique `config.id`, so it writes nothing. The other three entries are unaffected.

**"Not installed yet" after Confirm create** — **also deliberate** (see the reason above). Run the suggested `dsh plugin --profile web add link:<that directory>`.

**Collect & distill produces nothing or very few candidates**

| Cause | Criterion |
|---|---|
| Session content judged **noise** | Small talk and empty content are excluded (false negatives preferred) |
| Message **already processed** | Marked `alreadyProcessed`, not recreated |
| Session history **incomplete** | The report marks "partial range"; `historyComplete: false` means a replace compaction happened |
| Truncated by limits | Reflected truthfully in `stats`, never silently dropped |

**Wondering whether the model is actually working** — there is exactly one criterion: the host log line
`第 N 题未由模型生成，已回退到通用候选：<reason>`. Seeing it means that round ran on the fallback. **Do not judge by "the question looks specific enough"** — the hardcoded fallback bank also contains specific options.

**Selecting a preset fails with `unknown prompt variable "{{cwd}}"`** — this preset was generated by an **older generator**, not a broken host. The new architecture registers only the `provider` / `model` prompt variables; an unregistered variable throws during interpolation, and the working directory is now injected as runtime context by the working-directory service. Two fixes: **rebuild** (delete that preset directory and run Initial preset again) or **edit by hand** (remove the whole `suffix: Your working directory is {{cwd}}.` line; replace `工作目录 {{cwd}}，` with `工作目录见运行时上下文，`). The audit flags such files and line numbers itself (warning `PRESET_PROMPT_VARIABLE`).

**`npm run check` reports missing files or a failed assertion** — read which of the 11 groups failed (each maps to a real failure mode). The most common is **`lib/` out of sync with `plugin-src/`**: `npm run build && npm run verify`.

## Uninstall

**Step 1: remove the plugin**

```sh
dsh plugin --profile web remove dsh-learn-skills
```

Or via GUI: **Settings → Plugins**, find it and remove. **Restart the host afterwards.** Uninstalling only stops loading; **it deletes none of your data**.

**Step 2 (optional): clean up the plugin's state**

| Path | Content | Consequence of deleting |
|---|---|---|
| `<workspace>/.dsh/learn-skills/` | Batch ledger / audit baseline / change log / breakpoints / `known.json` | You lose the last baseline and rollback evidence; **knowledge nodes themselves are unaffected** |
| `<workspace>/.dsh/preset-bundles/<preset id>/` | The **preset itself** generated by this plugin | ⚠️ **Invalidates that preset** (on restart the definition cannot be resolved and sessions of that preset are refused restoration) |

> 🗑 To delete a preset use the **four steps** — confirm the row, uninstall the package, delete the directory, clear the `known.json` entry — never delete the directory directly. **With several presets in one package you must not uninstall the whole package.** See [`docs/删除预设.md`](docs/删除预设.md).

**Step 3: your knowledge base is not deleted**
`AGENTS.md` / `index/` / `inbox/` / `knowledge/` / `data/` / `task/` / `reports/` are **your assets** and the plugin never deletes them.

> Want to roll back writes rather than uninstall? Use `/learn rollback <batch>` — it restores **only what this plugin wrote**, and **files you edited after the write are never touched**.

## Compatibility: required, verified, still unconfirmed

- **Required** — Node ≥ 22.19; DSH `>= 0.2.1-alpha.1` (from that version only the `provider` / `model` prompt variables are registered, and the working directory comes from runtime context); the client half registers only in the `web` profile.
- **Verified** — the four entries and the `/learn` commands work on that DSH version; the 11 contract assertion groups in `npm run check` pass; incremental initialization, batch rollback and audit baselines have been measured.
- **Still unconfirmed** — a wider DSH version matrix has not been systematically verified; the stability of the semantic track is untested (whether two judgments of the same content converge has not been measured).

## Development

```sh
npm run static         # non-executing static check (imports/symbols/syntax/allowlists)
npm run build          # build (host half copy + client esbuild bundle + loader self-proof)
npm test               # node --test: real behavior tests against the filesystem
npm run verify         # 11 release contract assertion groups
npm run check          # ★ all four in one go: static → build → test → verify
npm run inspect        # artifact inspection
```

Architecture conventions (aligned with the ecosystem reference `dsh-dingtalk-connector`):

- `plugin-src/` is the **only source of truth**; `lib/` is an artifact and will be overwritten by the next build;
- The host half uses only Node built-ins and packages provided by the host runtime and **must not** add `@deepseek-ai/dsh-*` to any dependency section (runtime packages key on module-local Symbols; a second physical copy breaks host lookup);
- The client half may **only require react-family** modules (the platform's frozen module table); no third-party dependency is allowed;
- The client artifact must have the wrapper embed the bundle **inside** the `__ModuleLoader__.load` factory — placing it outside executes `require("react")` at script top level and takes down the entire concatenated `/plugins` bundle.

## Feedback

Open an [issue](https://github.com/yiyunet/dsh-learn-skills/issues/new/choose) for problems or feature requests. Include the **DSH version** and the **plugin version** (see the package manifest or `CHANGELOG.md`; this document does not duplicate it).

The plugin writes startup diagnostics to `~/.dsh/learn-skills-boot.log`; the last few lines usually locate the problem. **Remove secrets and private information before pasting.**

## License

**MIT**, see [LICENSE](LICENSE). Author: yiyunet. Not affiliated with, sponsored by, or endorsed by DeepSeek or DeepSeek Harness.
