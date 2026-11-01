# Design v0.4: an inspection-only `/kanban`, shipped coordination guidance

Status: ready to implement. Covers T-0026, T-0027, T-0028. Vocabulary is
`GLOSSARY.md`; the rules are ADR 0002, 0004, 0005, 0006, 0008 and 0009.

Everything below is literal output. Replace `<angle>` placeholders only.
Do not re-wrap a block: every line is already inside the 76-column budget.

## 0. Conventions

**`design-v0.2.md` #0 and `design-v0.3.md` #0 apply unchanged**: `W = 76`
counted in characters, ASCII only apart from the five markers `◆ ◇ ─ · ⚠`,
three-dot truncation, `@handle` display, ages from the board clock
(`Clock.now()`), no re-wrapping of a block.

`#N` and `#N.M` are sections of this document. Only these two rules are new:

1. **A shipped resource is content, not rendering.** Files under `skills/**`
   and `prompts/**` are shipped verbatim and are not held to `W`. The budget
   governs `/kanban` output, not the prose an agent loads when a task matches.
   A skill description, a table, or a long line in `references/` may exceed 76
   characters; never re-wrap one to fit a block that is not output.
2. **The command surface is stated, then checked.** A removed subcommand is
   not merely absent from `USAGE`: typing it prints a pointer (#1.3). "Drop"
   means the dispatch is gone and the refusal is explicit, not that the string
   falls through to the task-id reader.

## 1. `/kanban` becomes inspection-only (T-0026)

### 1.1 What stays, and what goes

`/kanban` keeps every inspection path:

| Invocation | Still does |
|---|---|
| `/kanban` | Render the board |
| `/kanban <task-id>` | Render one task in full |
| `/kanban status <id>` | Filter by status |
| `/kanban mine <handle>` | Filter by assignee |
| `/kanban validate [--stale 24h]` | Report workflow drift and claim problems |
| `/kanban --all` | Expand terminal columns |
| `/kanban --json` | Print the board as JSON |
| `/kanban init` | Create `.pi/kanban/workflow.yaml` |
| `/kanban help` | Print the card |

Two subcommands are removed:

- `/kanban release <id> [--yes] [--as <handle>]`
- `/kanban repair-ids [--dry-run | --yes] [--as <handle>]`

`init` is the one surviving writer, and it is a bootstrap that creates a
workflow file before a board exists. The invariant after 0.4.0 is narrower and
exact: **nothing in `/kanban` changes a task's status, assignee, history, or
comments.** The help card's "This command only reads" is true of every path
that operates on a task; `init` creates the board the others read.

### 1.2 Why

v0.2.0 added `/kanban release` as "the one mutating subcommand"; v0.3.0 added
`repair-ids` as a second. A command that looks like a read but can write is a
footgun in a transcript, and both operations already live in the tools with
`expectedRev`, a structured error, and a change notification. Release is sugar:
`kanban_assign {assignee: null, force: true}` is the same write. Removing the
subcommands leaves one mutation surface (the five tools), one place where the
claim rule is enforced, and no `--yes`/`--as` flags to document. It is a
breaking change for anyone who used the two subcommands; the migration is one
tool call (#1.4).

### 1.3 The removal message

Both guards run before the board is resolved, so the pointer is printed even
with no board. Neither writes anything.

`/kanban release T-0003` prints
`release is not a /kanban subcommand; use kanban_assign {assignee: null, force: true}.`
and `/kanban repair-ids` prints
`repair-ids is not a /kanban subcommand; rename the task file and raise counter.json by hand.`

Without the guard, `release` falls through to the task-id reader and prints
`Invalid task id "release".` — true but useless, because the user asked for a
removed feature, not a malformed id. The guard is the difference between a
dead feature and an explained one.

### 1.4 What replaces `release`

The canonical tool call, named in T-0026 and in the help card:
`kanban_assign { task: "T-0003", assignee: null, agent: "coder-2", force: true }`.

`force: true` is required to clear a claim held by another handle. Releasing
your own assignment works without it:

```text
kanban_assign { task: "T-0003", assignee: null, agent: "coder-1" }
```

Both write an `unassign` history entry and bump `rev`, exactly as
`/kanban release` did. What is lost is the `--as` operator sugar and the
`--yes` confirmation; the tool does not need the confirmation because the call
is already explicit, carries `expectedRev`, and is reversible by moving the
task back into an active status.

### 1.5 `validate` keeps reporting what `repair-ids` fixed

`/kanban validate` is inspection and stays. It still reports:

- `id_mismatch` — a task file whose frontmatter `id` disagrees with its
  filename.
- `counter_low` — a `counter.json` that is not greater than the highest
  existing id.

`repair-ids` was the only writer for those two codes. After 0.4.0 the fix is a
hand edit: rename the file to the id its frontmatter declares (never the
reverse — an issued id is never discarded, ADR 0005), and raise `counter.json`
by hand. This is a deliberate non-goal (#4), not a lost check: the warning is
still visible, and the repair stays a deliberate human act.

### 1.6 The help card

`USAGE` is 14 lines. It already omits `release` and `repair-ids` and already
states the read-only rule; 0.4.0 must not add either back. The target block:

```text
Usage  /kanban [task-id] [--all] [--json]
       /kanban status <id> | mine <handle> | validate [--stale 24h]
       /kanban init | help

  Moving a task into an active (◆) status claims it for your handle; only
  that handle can move it, or clear the claim, without force: true.
  A terminal status releases the claim; a claim never expires on its own.
  Handles are self-asserted names like coder-1; the board does not check
  them. Assigning a task to another handle needs force: true as well.
  This command only reads: to change the board, call the kanban_* tools
  (kanban_assign with assignee: null and force: true clears a claim).
  Start with kanban_list: it shows rev, status, and claim age.
  Completions use this session's board and list task ids and handles;
  with no board they complete only the subcommands.
```

The `SUBCOMMANDS` completion array stays `init`, `validate`, `--all`,
`--json`, `status`, `mine`. No completion offers `release`, `repair-ids`,
`--yes`, or `--as`, and the completion handler does not special-case them.

### 1.7 Tool hints that name the removed command

Two user-facing strings in `src/store.ts` still name `/kanban release`, and
both must point at the tool after 0.4.0:

- the `wrong_owner` hint on a refused move or assignment prints
  `Release it with kanban_assign { task: "T-0003", assignee: null, force: true }, or pass force: true to take over.`

- the `stale_claim` validate warning prints
  `Release it with kanban_assign { task: "T-0003", assignee: null, force: true }.`

Both replacements name the task and the tool; do not keep a `/kanban` form.
This is not cosmetic: a refusal that tells an agent to run a command that no
longer exists is worse than no hint. The `releaseTask` doc comment is internal
and may stay while the function does.

### 1.8 README, `docs/workflow.md`, CHANGELOG

These are prose edits owned by T-0026, not by this design's resource files:

- `README.md` — the command block loses the two removed lines; the sentence
  "Everything renders read-only except `release` and `repair-ids`" becomes a
  read-only statement. The release recipe becomes the `kanban_assign` call.
- `docs/workflow.md` — the "Repairing task ids after a merge" section and the
  `/kanban release <id> --yes` sentence are replaced by the tool form. The
  `active`/`terminal` and `reason` rules are unchanged.
- `CHANGELOG.md` — a `## 0.4.0` section above `## 0.3.0`, under Changed:
  `/kanban` is inspection-only; Added: the skill and `/standup`.

## 2. The kanban skill (T-0027)

### 2.1 Files and layout

```text
skills/kanban/
├── SKILL.md
└── references/
    ├── coordination.md
    └── workflow-authoring.md
```

`SKILL.md` is a routing stub plus the procedural rules an agent needs before
its first write. It is loaded only when a task involves coordinating on the
board, so it must be skimmable and must not restate `README.md`. The two
references carry the depth and are loaded on demand:

- `references/coordination.md` — claim lifecycle, handoff patterns, reading a
  takeover's `why`, stale-owner recovery, and the `rev`/`expectedRev` workflow
  with a concrete example.
- `references/workflow-authoring.md` — authoring
  `.pi/kanban/workflow.yaml`: statuses, `active` vs `terminal`, declared
  transitions, and the rules the loader enforces.

All references inside `SKILL.md` are relative to the skill directory
(`references/coordination.md`, not an absolute path), because Pi tells the
model where the skill lives.

### 2.2 Frontmatter

```yaml
---
name: kanban
description: Coordinate multiple Pi agents on one project's .pi/kanban board using the five kanban tools. Load when an agent is about to coordinate work rather than just do a single edit, such as creating a task, claiming or moving it through the workflow, handing off or taking over another agent's task, commenting, or reporting who owns what. Also load for status summaries and standups (what a handle holds, what is reviewable, what a takeover's reason was). Use before writing to a task another agent may own, when you need an exclusive claim, or when a kanban_list result you already read may be stale.
---
```

`name` is `kanban`: lowercase, no hyphens, well under 64 characters. The
description states **what** (coordinate agents on `.pi/kanban` with the five
tools) and **when** (before a coordinating write, for standups, for a possibly
stale read), and stays under the 1024-character limit. It is a routing
description, not a slogan: "Helps with kanban" would not tell the model when to
load it.

### 2.3 What `SKILL.md` must cover

Every statement below is already shipped behaviour; the skill introduces no
rule. It is a checklist for review, not new requirements:

1. **When to create.** Only when work spans agents or outlives the turn; not
   for a one-shot edit.
2. **Read first.** `kanban_list { briefing: true }` on a first look; an empty
   board's list *is* the briefing.
3. **Claims are exclusive.** Moving into an active `◆` status claims for the
   caller's handle; another handle needs `force`.
4. **`expectedRev`.** Pass the `rev` from the last read; a stale rev fails
   with `stale` instead of overwriting.
5. **Takeovers.** `force: true` plus a one-line `reason` (1-200 chars),
   recorded as `force-assign` and printed as a `why` line.
6. **Terminal and release.** A terminal status clears the assignee; no claim
   expires on its own.
7. **Handles are self-asserted** and unverified; assigning to another handle
   needs `force`.
8. **References.** Pointers to the two bundled files with relative paths.

It must not contain a new tool, a schema copy, a code change, or an absolute
path. The task-file format belongs to `docs/task-file.md`.

### 2.4 Packaging

The package has an explicit `pi` manifest, so the new roots are declared
rather than left to discovery:

```json
"files": [
  "src/**/*.ts",
  "!src/test/**",
  "docs/**",
  "skills/**",
  "prompts/**",
  "assets/**",
  "GLOSSARY.md",
  "README.md",
  "LICENSE"
],
"pi": {
  "extensions": ["./src/index.ts"],
  "skills": ["./skills"],
  "prompts": ["./prompts/*.md"]
}
```

`skills` names the root; the skill directory `skills/kanban/` is discovered
recursively from it. `prompts` selects the direct `.md` children, so
`prompts/standup.md` becomes `/standup`. Both roots must be in `files` or the
published tarball will not contain them, and `pi.skills`/`pi.prompts` must be
present or an installation will not load them.

## 3. The `/standup` prompt (T-0027)

### 3.1 Frontmatter and command

```yaml
---
description: Produce a short board standup for one handle or the whole project
argument-hint: "[handle]"
---
```

The filename `prompts/standup.md` becomes `/standup`. The handle is optional,
so `argument-hint` uses square brackets; `description` is the completion line.
The body reads the optional handle as `${1}`; an empty expansion means the
whole board.

### 3.2 What the body does

It is a nudge to the tools, not a reimplementation of them:

1. Start with `kanban_list {}` (or `briefing: true` on a first look) to learn
   the workflow and the claim ages.
2. **Claimed / in progress.** `kanban_list { assignee: "${1}" }` for a handle
   (only when `${1}` is non-empty), or group the full list by assignee. Keep
   the claim age shown in the row.
3. **Reviewable.** Read the workflow block and pick the review/testing
   status(es); list each, calling out tasks not held by the handle.
4. **Done recently.** List terminal rows; favour the highest ids and read
   `kanban_list { task: "T-00NN" }` for `updated` when recency matters.
5. **Stale claims.** Flag any claim older than 24 h from the row's age.
   `/kanban validate --stale 24h` is named as an inspection cross-check a
   human can run, not something the agent invokes.
6. **Output.** Short: a heading per section, one bullet per task with id,
   status, owner, and age. No board restatement, no tidying moves; if a
   takeover or release happened while gathering, say which task and why.

The prompt must not move tasks, and must not replace `kanban_list` with a
hand-counted summary.

## 4. Non-goals

- **`repair-ids` stays unexposed.** No tool, flag, or subcommand replaces it.
  A merge-damaged board is fixed by hand. A rename pass as an agent tool would
  let one agent rewrite another's task identity, and the operation is rare
  enough that a human edit is the right speed.
- **No new tool.** The five tools are the mutation surface. A
  `kanban_release` tool would duplicate `kanban_assign {assignee: null,
  force: true}` and split the claim rule across two entry points.
- **No `--yes` or `--as` on `/kanban`.** Those flags existed to make the two
  mutating subcommands safe; with the subcommands gone, `/kanban` accepts
  `--all`, `--json`, and `--stale` only.
- **No change to claim enforcement, `reason`, `rev`, or the task format.**
  0.4.0 is a surface release plus two resources.
- **No automatic stale-claim release.** The warning stays advisory (ADR 0008,
  `docs/workflow.md`).
- **No skill-side executable.** The skill is instructions; it calls the same
  five tools. No script, no `allowed-tools` pre-approval.
- **No mutating prompt.** `/standup` reads and reports; it does not move a
  task to make the report tidy.

## 5. Implementation map

| Surface | Change | Must not change |
|---|---|---|
| `src/command.ts` | Remove the `release` and `repair-ids` dispatch and their imports (`renderRelease`, `repairRefusal`, `releaseTask`, `repairIds`). Add the two guards (#1.3) before board resolution. | Every inspection path in #1.1; `USAGE`'s 14 lines; `SUBCOMMANDS` (#1.6). |
| `src/store.ts` | Retarget the `wrong_owner` hint and the `stale_claim` warning to `kanban_assign {assignee: null, force: true}` (#1.7). `releaseTask`/`repairIds` may be deleted only if nothing references them; this release does not make that a gate. | Claim enforcement, `reason`, `rev`, task format. |
| `package.json` | `files` + `skills/**`, `prompts/**`; `pi.skills`, `pi.prompts` (#2.4). Version `0.4.0` at release. | The one runtime dependency; extension entry. |
| `skills/kanban/SKILL.md` | New (#2.2, #2.3). | — |
| `skills/kanban/references/coordination.md` | New: claim lifecycle, handoffs, takeover `why`, stale recovery, `rev` example. | No new rules. |
| `skills/kanban/references/workflow-authoring.md` | New: statuses, `active`/`terminal`, transitions, loader rules. | No new rules. |
| `prompts/standup.md` | New (#3). | No mutating instruction. |
| `README.md` | Command block and read-only sentence (#1.8). | Tool table, claim rules. |
| `docs/workflow.md` | Remove `release`/`repair-ids` sections; keep `active`/`terminal`/`reason` (#1.5, #1.8). | Workflow rules. |
| `CHANGELOG.md` | `## 0.4.0` section. | Existing entries. |

## 6. Acceptance checks

### T-0026 — inspection-only `/kanban`

- [ ] `rg -n "release|repair-ids" src/command.ts` finds no dispatch and no
      `renderRelease`, `repairRefusal`, `releaseTask`, or `repairIds` import;
      the only matches are the two guard strings and any comment explaining
      the removal.
- [ ] `SUBCOMMANDS` contains none of `release`, `repair-ids`, `--yes`, `--as`.
- [ ] `/kanban release T-0003` prints the pointer in #1.3 and writes nothing.
- [ ] `/kanban repair-ids` prints the pointer in #1.3 and writes nothing.
- [ ] `/kanban help` is 14 lines and mentions neither removed subcommand.
- [ ] `rg -n "/kanban release|/kanban repair-ids" src --glob '!src/test/**'`
      finds no user-facing string; the hint and `stale_claim` text name
      `kanban_assign` instead (#1.7).
- [ ] `README.md`, `docs/workflow.md`, and `CHANGELOG.md` agree with #1.8.

### T-0027 — skill and prompt

- [ ] `test -f skills/kanban/SKILL.md`
- [ ] `test -f skills/kanban/references/coordination.md`
- [ ] `test -f skills/kanban/references/workflow-authoring.md`
- [ ] `test -f prompts/standup.md`
- [ ] `rg -n "^name: kanban$" skills/kanban/SKILL.md` matches; the name is
      lowercase, 6 characters, with no leading, trailing, or double hyphen,
      and the description is 1-1024 characters.
- [ ] `rg -n '^argument-hint: "\[handle\]"$' prompts/standup.md` matches.
- [ ] `rg -n "/Users/|~/projects" skills prompts` finds nothing; every
      reference is relative.
- [ ] `package.json` `files` and `pi` include the two roots (#2.4).
- [ ] A fresh pi session discovers the `kanban` skill and the `/standup`
      command (T-0028).

### T-0028 — tests and gate

- [ ] Tests that drive `/kanban release` and `/kanban repair-ids` are pruned;
      they test a removed surface.
- [ ] Discovery tests cover `skills/kanban/SKILL.md` and
      `prompts/standup.md`.
- [ ] `pnpm typecheck` and `pnpm test` are green.
- [ ] `package.json` version is `0.4.0` and `CHANGELOG.md` has the matching
      section (release task only).

## Conflicts resolved

1. **Does `/kanban release` fall through to the task-id reader or print a
   pointer?** Pointer, before board resolution (#1.3). The fallthrough would
   print `Invalid task id "release".`, which names the wrong problem.
2. **Are `releaseTask`/`repairIds` deleted from `store.ts`?** Not in this
   release. T-0026 permits deletion only when nothing references them; the
   dispatch is what changes. Leaving them keeps the release at the command
   surface and avoids deleting tested logic in the same change that stops
   calling it.
3. **`force` on a self-release.** The canonical form named by T-0026 is
   `kanban_assign {assignee: null, force: true}`; it records a plain
   `unassign` when the caller is the current assignee and a forced one when
   the claim belongs to somebody else. The design documents the canonical
   form and notes the no-force self-release (#1.4).
4. **Does `/standup` run `/kanban validate`?** No. The agent reads claim age
   from `kanban_list` rows; `/kanban validate --stale` is named as a
   human-run cross-check, because an agent cannot invoke a slash command
   (#3.2).
5. **Does `init` violate "inspection-only"?** It creates the board before any
   task exists; it does not change a task. The 0.4.0 invariant is narrower
   and exact (#1.1).
6. **Skill description as one line or a folded block?** One line. It is under
   1024 characters and avoids a frontmatter shape a strict reader might not
   fold. `design-v0.3.md` #0's `W = 76` does not apply (#0.1).
