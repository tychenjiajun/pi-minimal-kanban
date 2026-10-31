# Design v0.3: legible takeovers, finished command surface

Status: ready to implement. Covers `docs/product/v0.3-scope.md`,
T-0012, T-0013, T-0014, T-0015, T-0016. Vocabulary is `GLOSSARY.md`; the
rules are ADR 0002, 0004, 0005, 0006, 0008 and the new ADR 0009.

Everything below is literal output. Replace `<angle>` placeholders only.
Do not re-wrap a block: every line is already inside the 76-column budget.

## 0. Conventions

**`design-v0.2.md` #0 applies unchanged**: `W = 76` counted in characters,
ASCII only, the five markers `◆ ◇ ─ · ⚠`, three-dot truncation, `@handle`
display, ages from the board clock (`Clock.now()`), no re-wrapping of a
block.

`#N` and `#N.M` are sections of this document. `Backlog #N` and
`T-001N #M` are items and checks elsewhere. No section sign appears in this
file, because `#0` allows only five non-ASCII characters.

Only these four rules are new or narrowed:

1. **Fenced blocks are renderings; inline code is a value.** A block is the
   76-column presentation of output, already wrapped. A one-line exact
   string quoted inline (an `error`, a `code`, a label) is the literal
   value and may exceed 76 characters; never break it to fit a block.
2. **Tool error text is not wrapped by the tool.** `fail()` emits
   `Error [<code>]: <error>` and then `\n<hint>` as three logical lines.
   Blocks in #1 and #2 that show an error are its 76-column presentation,
   exactly as design v0.2 #4 does.
3. **A completion item is an argument, not a handle display.** `@handle`
   display still holds everywhere in rendered output; completion `label`
   and `value` are the bare token the handler accepts (`coder-1`, not
   `@coder-1`), because `/kanban mine` compares against the stored handle.
4. **`reason` is free text**, so it is the only user-supplied string that
   reaches a history line. Its two prints (#1.4, #1.6) have their own
   truncation rules; they never wrap.

## 1. The `reason` field (T-0012)

Backlog #9. A forced assignment records `forced: true` and nothing else, so a
reader cannot tell a crash from a preemption.

### 1.1 Where it lives

One new optional key, `reason`, on a **frontmatter `history` entry**. It is
not a top-level key, it is not a body field, and it is never on a `create`
entry. Placement is last within the entry:

```yaml
history:
  - at: 2026-10-30T10:05:00.000Z
    action: force-assign
    by: coder-2
    assignee: coder-2
    forced: true
    reason: owner idle 2d
```

`HistoryEntry` gains `reason?: string`. `parseHistory` must append `reason`
**after** every other key and only when it is a non-empty string, so a file
that has no `reason` still round-trips byte for byte (the existing
`{ lineWidth: 0 }` document path keeps a 200-character reason on one line).

### 1.2 Accepted by which calls, and on which entry

`kanban_assign` and `kanban_move` both accept `reason` (release criterion:
`rg -n "reason" src/schemas.ts src/types.ts` finds it on `AssignParams`,
`MoveParams`, and `HistoryEntry`). `kanban_assign` and `kanban_move` are the
only writers; `/kanban release` has no reason flag and never passes one.

`reason` is written on **exactly one entry per call**: the first entry the
call appends with `forced: true`; if the call appends no forced entry, the
first entry it appends.

| Call | Entries appended | Carries `reason` |
|---|---|---|
| `kanban_assign {force:true}`, takes another handle's task | `force-assign` | `force-assign` |
| `kanban_assign {force:true}`, task unassigned, `assignee` another handle | `force-assign` | `force-assign` |
| `kanban_assign {force:true}`, `assignee` = caller | `assign` | `assign` |
| `kanban_move {force:true}`, takes another handle's task | `force-assign`, `move`, `assign` | `force-assign` |
| `kanban_move {force:true}`, nothing to take over | `move`, `assign`/`unassign` | `move` |
| `kanban_move {reason, no force}` | none | `invalid_argument` |

A forced `unassign` entry is only written by `/kanban release`, which cannot
carry a reason. `unannotated_forced` therefore inspects `force-assign` entries
only (#1.6), and a released claim is never flagged.

### 1.3 Validation, and the error without `force`

`reason` **requires** `force: true`. Without it the call fails before the
board lock and writes nothing; code `invalid_argument` (`fail()` already
prints no hint line for that code):

`Error [invalid_argument]: reason requires force: true.`

Sanitization and limits, in this order, all `invalid_argument`:

| Check | Failure message |
|---|---|
| trim; empty | `reason must be 1-200 characters.` |
| contains `\n`, `\r`, or a control character `< 0x20` / `0x7F` | `reason must be a single line.` |
| longer than 200 characters (`MAX_REASON = 200`) | `reason is 201 characters; the limit is 200.` |

The overflow case is an error, never silent truncation: a silently shortened
reason is a false record. The *rendering* truncates (#1.4), the stored value
never does. Repeat the reason verbatim after trimming; do not collapse runs
of spaces.

The schema declares `reason` as `Type.Optional(Type.String({ minLength: 1 }))`
with **no `maxLength`**, so the four messages above are the only ones an agent
can get; a TypeBox `maxLength` would replace them with a harness error.

Validation order inside `assignTask`/`moveTask`: normalize `reason` first
(`invalid_argument`), then take the board lock, then the state checks
(`already_assigned`, `wrong_owner`). An argument error therefore wins over a
board-state error.

### 1.4 `renderTask`

The `force-assign` history line keeps its ` (forced)` suffix and does not
change. The reason prints on its own continuation line, so it can never shift
the `when`/`who`/`action` columns:

```
  History
    2026-10-30 10:05:00Z @coder-2  force-assign coder-2 (forced)
      why  owner idle 2d
    2026-10-30 10:12:00Z @coder-2  move working -> reviewing
```

- Line shape: 6 spaces + `why` + 2 spaces + reason, i.e. a 65-character
  budget. A longer reason is truncated to 62 characters + `...` (three dots,
  trailing spaces stripped first). Never wrap, never print a second line.
- Printed for **any** history entry that carries a reason, after that entry's
  own line. An entry without a reason prints nothing extra.
- No other surface prints a reason: rows, the briefing, `summary`, and
  `/kanban mine` are unchanged.

### 1.5 `structuredContent`

`kanban_list`, `kanban_assign`, `kanban_move`, and `kanban_comment` pass
`task.history` through `detail()` unchanged, so `reason` appears there as soon
as `HistoryEntry`'s schema has it. No new output field.

### 1.6 `validate` - `unannotated_forced`

New problem code `unannotated_forced`, **severity `warning`**. It is one
finding per task, not one per entry, so a board cannot flood the report:

- Trigger: the task has at least one `history` entry with
  `action: "force-assign"` and no non-empty `reason`.
- `ok` stays `true`; the header is `Board is valid (1 warning).`
- Order within a task: `drifted`, `terminal_assigned`, `stale_claim`,
  `unannotated_forced`. It renders in the `Warnings:` section, after
  `stale_claim`.
- `<date>` is the offending entry's `at` sliced to `YYYY-MM-DD`.

Message, singular:
`Forced assignment by "coder-1" on 2026-10-30 has no reason. Add one next time with kanban_assign {force: true, reason: "..."}.`

Message, plural (`<n>` entries):
`<n> forced assignments have no reason; the first is by "coder-1" on 2026-10-30. Add one next time with kanban_assign {force: true, reason: "..."}.`

```
Board is valid (1 warning).
  /Users/me/app/.pi/kanban

Warnings:
  ⚠ T-0005  unannotated_forced: Forced assignment by "coder-1" on
            2026-10-30 has no reason. Add one next time with
            kanban_assign {force: true, reason: "..."}.
```

### 1.7 Backward compatibility

- A task file written before 0.3.0 has `forced: true` and no `reason`. It
  keeps parsing, keeps every key, and re-serializes byte-identically when
  nothing else changes.
- Such an entry now reports `unannotated_forced`. That is the point of the
  release: existing takeovers stay valid, and become **visible**. It is a
  warning, so `validate` still exits `ok: true` and no historic board becomes
  invalid on upgrade.
- There is no migration, no rewrite, and no `rev` bump for old files.

## 2. Third-party assignment (T-0013)

Backlog #10, decided in `v0.3-scope.md` # "#10 decision, in full". ADR 0009 is
a blocking prerequisite.

### 2.1 The rule

`assignTask` requires `force: true` whenever **`wanted !== null` and
`wanted !== agent`** - regardless of whether the task currently has an
assignee, and regardless of whether the caller currently holds it. After this
change the rule is uniform in both directions: *any write to an assignee that
is not yours needs `force`.*

Unchanged, deliberately:

| Case | Needs `force` | Entry |
|---|---|---|
| assign an unassigned task to yourself | no | `assign` |
| clear your own assignment | no | `unassign` |
| clear another handle's assignment | yes | `unassign` + `forced: true` |
| take another handle's task | yes | `force-assign` + `forced: true` |
| assign to a third handle, task unassigned | **yes (new)** | `force-assign` + `forced: true` |
| assign to a third handle while you hold it | **yes (new)** | `force-assign` + `forced: true` |
| `assignee` already equals the target (no-op) | no | nothing written, `rev` unchanged |

The no-op table row is intentional: the existing early return
(`current === wanted`) stays **before** the new check, so a retried call is
still idempotent and still writes nothing. State it in the test name.

`kanban_move`'s **implicit claim-on-move is not affected**. Moving an
unassigned task into an active status claims it for the caller with a plain
`assign` entry and needs no `force`: the resulting assignee *is* the caller.
No new check belongs in `moveTask` for this rule.

### 2.2 The refusal

Code `wrong_owner` - reuse it, teach no new code (ADR 0009 records that
choice). Raised inside the board lock, after the task is read, so it cannot
race a concurrent assignment; nothing is written.

`error` (one string): `Task T-0002 is unassigned; "reviewer" cannot assign it to "coder-2" without force.`

`hint` (one string): `Pass force: true to make this assignment; history records it as a forced assignment by "reviewer".`

```
Error [wrong_owner]: Task T-0002 is unassigned; "reviewer" cannot assign
it to "coder-2" without force.
Pass force: true to make this assignment; history records it as a forced
assignment by "reviewer".
```

This is the **one** `wrong_owner` variant whose hint does not name
`/kanban release <id> --yes`: no handle holds the task, so there is nothing to
release. Design v0.2 #4's hint rule applies to refusals about an existing
holder.

`structuredContent` of the failure:

| Field | Value |
|---|---|
| `ok` | `false` |
| `code` | `"wrong_owner"` |
| `error` | the string above |
| `hint` | the string above |
| `task` | `"T-0002"` |
| `assignee` | `"coder-2"` - the handle the caller tried to write |
| `agent` | `"reviewer"` - the caller |
| `root`, `dir` | as every envelope |

### 2.3 The History entry written with `force`

Same entry the take-from-another-handle path already writes, so no new action
name is needed:

```yaml
  - at: 2026-10-30T10:05:00.000Z
    action: force-assign
    by: reviewer
    assignee: coder-2
    forced: true
    reason: handoff, reviewer is going offline
```

Before and after, one board, one intent (assign `T-0002` to `coder-2`):

```yaml
# 0.2.0 - succeeded silently
  - at: 2026-10-30T10:05:00.000Z
    action: assign
    by: pm-v03
    assignee: coder-2
```

```yaml
# 0.3.0 - needs force, and says so
  - at: 2026-10-30T10:05:00.000Z
    action: force-assign
    by: pm-v03
    assignee: coder-2
    forced: true
```

Historic third-party `assign` entries stay valid and readable: no migration,
no rewrite, no `rev` bump, and `validate` does not flag them.

### 2.4 Tool surface

`kanban_assign` parameter descriptions (`src/schemas.ts`):

- `assignee`: ``Handle to assign, or null to release. Exactly one handle may hold a task; assigning it to a handle other than your own needs `force: true`.``
- `force`: ``Take the task from, or release, another handle's claim, or assign it to a handle that is not yours. Recorded as a forced assignment.``

`kanban_assign` `promptGuidelines` - keep the existing three sentences and add
this one, exactly:

One string, shown wrapped at 76:

```
Assigning a task to any handle but your own needs `force: true`;
history then records a forced assignment.
```

`USAGE` gains exactly one sentence, inside the existing handle block
(T-0015 owns the final block; this is the line T-0013 adds and T-0015 keeps
verbatim):

```
  them. Assigning a task to another handle needs force: true as well.
  Start with kanban_list: it shows rev, status, and claim age.
```

### 2.5 ADR 0009 checklist

`docs/adr/0009-third-party-assignment-is-forced.md`, written **before** the
code, in the shape of ADR 0004 and ADR 0008:

- [ ] Title `Third-party assignment is forced`, plus the status line the other ADRs carry.
- [ ] The rule: `assignTask` requires `force: true` whenever the target assignee is not the caller's handle.
- [ ] The override: `force: true`, recorded as `force-assign` + `forced: true`, distinguishable from a self-claim.
- [ ] Why the v0.2 objection ("an assignment outside an active status is a hint, not a claim") is answered, not violated: the hint stays unenforced on move; only *who may write it* changed.
- [ ] The uniform sentence: any write to an assignee that is not yours, in either direction, needs `force`.
- [ ] Migration: no data rewrite; historic third-party `assign` entries stay valid and readable; no `rev` bump; `validate` does not flag them.
- [ ] Rejected alternatives: a config flag; a warning instead of an error; a new error code instead of reusing `wrong_owner`.
- [ ] Consequences naming `kanban_assign`'s description, its `promptGuidelines`, `USAGE`, `README.md`, `docs/workflow.md`, `GLOSSARY.md` "Forced assignment".
- [ ] A one-line pointer added under ADR 0004, and a `0009` reference in `README.md` (release criterion: `rg -n "0009" README.md docs/adr/*.md`).

## 3. Completions (T-0014)

Backlog #12a. The interface risk is here, so every item shape is pinned.

### 3.1 What is impossible, and the mechanism

`RegisteredCommand.getArgumentCompletions` is
`(argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>`
(`@earendil-works/pi-coding-agent`, `dist/core/extensions/types.d.ts`). It
receives no `cwd` and no `ExtensionCommandContext`, so completions cannot call
`resolveBoard({ cwd: ctx.cwd })`. `ExtensionAPI` has **no cwd-change event**
(`on()` offers `session_start`, `session_info_changed`,
`session_before_switch`, `session_before_fork`, `session_compact`,
`session_shutdown`, `session_before_tree`, `session_tree`, and turn/tool
events only); `ExtensionContext.cwd` is the only source of a working
directory.

The accepted mechanism, all of it inside the extension factory, so
`completeKanbanCommand` itself stays pure:

| Hook | Fires | Action |
|---|---|---|
| `pi.on("session_start", (e, ctx) => ...)` | startup, reload, new, resume, fork | `cached = resolveCached(ctx.cwd)` |
| `pi.on("session_before_switch", () => ...)` | before another session file loads | `cached = undefined` |
| `pi.on("session_shutdown", () => ...)` | session end | `cached = undefined` |
| command handler wrapper | every `/kanban` invocation | `cached = resolveCached(ctx.cwd)`, then call `handleKanbanCommand` |

```ts
function resolveCached(cwd: string): BoardLocation | undefined {
  try { return resolveBoard({ cwd }); } catch { return undefined; }
}
```

`pi.registerCommand` then does:

```ts
getArgumentCompletions: (prefix) =>
  completeKanbanCommand(prefix, cached).map((item) => ({
    value: item.label, label: item.label, description: item.description,
  })),
handler: async (args, ctx) => {
  cached = resolveCached(ctx.cwd);
  return handleKanbanCommand(args, ctx);
},
```

`completeKanbanCommand(prefix: string, board?: BoardLocation)` returns
synchronously - never a Promise, never `null`. No module-level mutable global:
tests pass `board` explicitly. The handler refresh is what makes a stale
location impossible within a session, since `ctx.cwd` cannot change without a
new session; `session_before_switch`/`session_shutdown` cover the rest.

### 3.2 The item shapes

Every item is `{ label, description }` (`index.ts` maps `value = label`).
`label` is the bare token the handler accepts, so `value` is already correct.

Task ID item:

| Field | Value |
|---|---|
| `label` | `T-0001` |
| `description` | `<status>` + (` ⚠` when drifted) + ` · ` + title, truncated to 64 with `...` |

Handle item:

| Field | Value |
|---|---|
| `label` | `coder-1` |
| `description` | `<n> task` / `<n> tasks`, `n` = tasks whose current `assignee` is that handle; a handle seen only in history prints `0 tasks` |

How the dropdown shows them (label, gap, description); `label` and
`description` are two separate strings and the padding is the editor's:

```
T-0001      planning · Fix duplicate ids after a merge
T-0003      working ⚠ · Make an abandoned claim visible
coder-1     2 tasks
triage-bot  0 tasks
```

Rationale for `label`: completing `/kanban T-0001  planning  Fix ...` would insert
four stray positional arguments. The status and title belong in
`description`, which the dropdown shows and the input does not receive.

### 3.3 Order, caps, dedup

1. Subcommands, in their existing order, with `repair-ids` inserted after
   `release`: `init`, `validate`, `release`, `repair-ids`, `--all`, `--json`,
   `status`, `mine` - 8 items.
2. Task IDs, ascending by number, at most **20**.
3. Handles, case-insensitive alphabetical, at most **10**.

Deduplication: task IDs are unique by filename. Handles are deduplicated
case-insensitively, first occurrence wins, scanned in this order per task
(id ascending): `assignee`, then each history entry's `by`, then its
`assignee`.

Caps apply after sorting. A truncated list adds no "more" item - a completion
dropdown has no footer.

### 3.4 Prefix rule

Prefix match, case-insensitive, on `label` - never a substring match. The
needle is `prefix.trim().toLowerCase()`.

| `prefix` | Behaviour |
|---|---|
| empty | all three groups, complete |
| `--` | subcommands whose label starts with `--` only (existing rule) |
| `T-0` | task IDs starting `t-0` -> `T-0001`, `T-0002`, ... |
| `building` | handles starting `building` -> `building-2`; subcommands are checked too |
| `@cod` | a leading `@` is stripped and the search is **handle-only** -> `coder-1` |
| `zz` | nothing matches -> the 8 subcommands (#3.5) |

Substring matching is rejected: every label is short, and `1` would match
half the board.

### 3.5 Degenerate cases - the invariant

A completion call **never throws, never writes, never takes the board lock**,
and **never returns an empty array**.

| Condition | Result |
|---|---|
| no cached location (before the first `session_start`) | 8 subcommands |
| cached location, no `.pi/kanban/tasks` directory | 8 subcommands |
| board readable, zero tasks | 8 subcommands |
| some task files unreadable | the readable tasks and handles; `fileErrors` are dropped silently, and no description mentions them |
| every task file unreadable | 8 subcommands |
| the filtered result is empty | the 8 subcommands, unfiltered |

Read with `readBoard(location)` (or `readTasksWith`) inside one `try/catch`;
never `readTask` per id. Cost is O(tasks) with no lock. A board with more than
500 task files completes on the first 500 by id - a stated bound, not an
error. No memoization: correctness must not depend on a cache.

## 4. `/kanban help` (T-0015)

Backlog #12b. The `USAGE` constant is replaced by this 14-line block: v0.2's
10 lines, plus 4 that T-0013, T-0015 and T-0016 each add. That is exactly
T-0015's 14-line cap. Export it (or a `helpText()` accessor) so a test can
assert without capturing `ctx.ui.notify`.

```
Usage  /kanban [task-id] [--all] [--json]
       /kanban status <id> | mine <handle> | validate [--stale 24h]
       /kanban release <task-id> [--yes] [--as <handle>]
       /kanban repair-ids [--dry-run | --yes] [--as <handle>]
       /kanban init | help

  Moving a task into an active (◆) status claims it for your handle; only
  that handle can move or release it without force: true.
  A terminal status releases the claim; a claim never expires on its own.
  Handles are self-asserted names like coder-1; the board does not check
  them. Assigning a task to another handle needs force: true as well.
  Start with kanban_list: it shows rev, status, and claim age.
  Completions use this session's board and list task ids and handles;
  with no board they complete only the subcommands.
```

Who owns which line of the 14, so parallel tasks do not collide:

| Lines | Owner | Note |
|---|---|---|
| 1-3, 5, 6-10, 12 | v0.2 | reused **verbatim**; do not rewrite |
| 4 | T-0016 | the `repair-ids` usage line |
| 11 | v0.2 + T-0013 | the v0.2 sentence `them.` gains T-0013's second sentence |
| 13-14 | T-0015 | the completion rule |

Each required rule is assertable as one literal substring, on one line:

| Rule | Assert this substring |
|---|---|
| Claim | `active (◆) status claims it for your handle` |
| Terminal status | `terminal status releases the claim` |
| Handle convention | `self-asserted` |
| Assignment (`force` for third parties) | `Assigning a task to another handle needs force: true` |
| Completion / no board | `Completions use this session's board` and `subcommands` |

`/kanban help` and `/kanban --help` print the block unchanged. No board
location, no `PI_KANBAN_DIR`, and no troubleshooting text: this is a help
card, not a manual (`README.md` covers the rest).

## 5. `/kanban repair-ids` (T-0016)

Backlog #13. The only destructive subcommand besides `release`; it must be
impossible to run by accident.

### 5.1 Parse and plan

```
/kanban repair-ids [--dry-run | --yes] [--as <handle>]
```

| Flag | Effect |
|---|---|
| none | compute and print the plan; write nothing |
| `--dry-run` | compute and print the plan; write nothing, and say so |
| `--yes` | take the board lock, re-plan, apply |
| `--as <handle>` | the operator named in the result; `PI_KANBAN_HANDLE`, else `human`; validated by the existing handle rules (`invalid_handle`) |

`--dry-run` together with `--yes` is ambiguous and writes nothing (#5.4).

**Filename is the identity source of truth.** The plan is enumerated from
`listTaskIds` - the filenames that exist - never from frontmatter and never
from `counter.json`. A file whose frontmatter `id` is a string that differs
from its filename id is *repaired to the declared id*: the frontmatter `id`
is the id the task was issued under, so it is made true by renaming the file,
and the frontmatter is then written back with `id: <declared id>` (idempotent
when it already matches). The reverse repair is refused: ADR 0005 makes an
issued id permanent, and overwriting `T-0009` with `T-0002` would discard an
id that can never be reissued.

```ts
export interface IdRepair {
  filenameId: string;   // T-0002
  declaredId: string;   // T-0009
  path: string;         // absolute path of T-0002.md
  target: string;       // absolute path of T-0009.md
}
export interface RepairPlan {
  dir: string;
  // filenameId ascending
  renames: IdRepair[];
  counter?: { from: number; to: number };
  skipped: Array<{ path: string; message: string }>;
}
// Read only: takes no lock.
export function planRepairIds(location: BoardLocation): RepairPlan;
// Re-plans under the board lock, then applies.
export async function repairIds(
  location: BoardLocation,
  agent: string,
): Promise<{ plan: RepairPlan; applied: boolean }>;
```

`repairIds` takes no plan argument: it re-plans **under the lock**, exactly as
`/kanban release --yes` re-reads the task under the lock. `--yes` confirms the
command, not a snapshot.

A file whose `id` is missing or not a string is `invalid_task`, not an
`id_mismatch`; the plan reports it in `skipped` and never invents an id. A
task whose id is already correct produces no line at all - it is not a
refusal, it is simply not in the plan. A `.repair.<token>.md` left by an
interrupted run is also `skipped`, with
`interrupted repair: restore or delete by hand`.

### 5.2 The plan block (no flag / `--dry-run`)

```
Repair task ids  .pi/kanban  (dry run: nothing written)

  rename  T-0002.md -> T-0009.md
          id: T-0009  Fix duplicate ids after a merge
  counter next 12 is already above T-0009; left unchanged

1 file would be renamed. Nothing was written. Re-run with --yes to apply.
Docs and comments that mention T-0002 are not rewritten.
```

Without `--dry-run`, the header is `(nothing written)` and the footer is the
confirmation form, matching `/kanban release`:

```
Repair task ids  .pi/kanban  (nothing written)

  rename  T-0002.md -> T-0009.md
          id: T-0009  Fix duplicate ids after a merge
  counter next 12 is already above T-0009; left unchanged

1 file would be renamed. Docs and comments that mention T-0002 are not
rewritten.
Re-run with --yes to confirm:  /kanban repair-ids --yes
```

Per rename: `  rename  <from> -> <to>` then, 10 spaces in,
`id: <declaredId>  <title>`. The `counter` line is
`  counter next 3 -> 10  (raised above the highest id T-0009)` when the
counter will be raised, and
`  counter next 12 is already above T-0009; left unchanged` when it is
already high enough. `<dir>` is `displayPath(plan.dir, cwd)`; if it exceeds
30 characters keep the last 27 and prefix `...`.

### 5.3 The apply block (`--yes`)

```
Repaired 1 task id.

  renamed  T-0002.md -> T-0009.md   id: T-0009
  counter  next 12, above the highest id T-0009  (unchanged)
  by       @human

Run /kanban validate to confirm the board is clean.
```

The `counter` line becomes
`  counter  next 3 -> 10  (raised above the highest id T-0009)`.
`Repaired 1 task id.` / `Repaired N task ids.`; a plan with only a counter
change prints `Repaired 1 task id.` too, with no `renamed` line. Skipped files
are appended when present:

```
1 file was skipped and needs a hand edit:
  T-0007.md  no string "id" in frontmatter
```

`--as reviewer` replaces `@human`. Nothing is written to the history of any
task: a rename is not task activity, so no `rev` bump, no `updated` change,
no entry.

### 5.4 Refusals

Nothing is written in either refusal below, and the exit is `ctx.ui.notify`
with the block (the `release` precedent: a refusal is text, not an
exception). A missing flag is **not** a refusal - it prints the plan of #5.2
and writes nothing, like `/kanban release` without `--yes`.

Both flags at once:

```
/kanban repair-ids takes one of two flags.

  --dry-run  print the plan and write nothing
  --yes      apply the plan, under the board lock

Both at once is ambiguous; nothing was written.
```

A rename target that already exists:

```
Cannot repair: T-0009.md already exists and T-0002.md declares id T-0009.

  T-0002.md  declares T-0009
  T-0009.md  already uses that name

Nothing written. Rename or delete one of them by hand, then re-run.
```

Two files declaring the same id:

```
Cannot repair: two files declare the same id.

  T-0002.md  declares T-0009
  T-0005.md  declares T-0009

Nothing written. Fix one of the two frontmatter ids by hand, then re-run.
```

A hand-edit-only file is not a refusal; it goes to `skipped` and the rest of
the plan proceeds. Nothing to repair at all:

```
Nothing to repair: every frontmatter id matches its filename.

  board    .pi/kanban
  counter  next 12, above the highest id T-0005

Nothing written.
```

### 5.5 Ordering, so swaps cannot collide

Two passes inside one lock, so `T-0002 -> T-0005` and `T-0005 -> T-0002` in one
run cannot collide, and neither can a chain:

```
pass 1  T-0002.md -> .repair.<token>.md    (all sources, id ascending)
pass 2  .repair.<token>.md -> T-0009.md    (all targets, id ascending)
```

`<token>` is one random hex string per run. `.repair.<token>.md` never matches
`listTaskIds`' `/^T-(\d{4,})\.md$/`, so a crash between the passes leaves no
task with a wrong id, only a file no tool reads (and #5.1's `skipped` line
surfaces it).

Lock discipline: the plan for printing takes **no** lock (it is a read, like
`validate`). `--yes` takes the board lock once for the whole run - re-plan,
both rename passes, and the counter write - so no `kanban_create` can allocate
an id mid-run.

### 5.6 `counter.json`

- Never lowered. If `next` is already greater than the highest id on the
  board, the file is not rewritten at all, so it stays byte-identical.
- Only raised, to `highest + 1`, when `next <= highest` - the same condition
  `validate` reports as `counter_low`, and the same value `reserveTaskId`
  would compute. Written as `JSON.stringify({ next }, null, 2) + "\n"` via
  `atomicWrite`, exactly as `reserveTaskId` does.
- Raised even when there is no rename: a board whose only defect is
  `counter_low` is repairable by `repair-ids --yes`, and that case must print
  `counter` and no `renamed` line.

### 5.7 What it does not do

- No prose rewriting: a `T-0007` inside a description or a comment stays as
  written, and the plan footer says so.
- No history or comment rewriting.
- No id invention: it never takes an id from `counter.json`.
- No `rev` bump, no `updated` rewrite, no history entry.
- It does not fix `unreadable_task`, `drifted`, `terminal_assigned`,
  `stale_claim`, or `unannotated_forced`.

`validate` codes it clears: **`id_mismatch`** (all of them) and
**`counter_low`** (by raising the counter). Nothing else.

## 6. Implementation map

| Source file | Change | Must not change |
|---|---|---|
| `src/types.ts` | `HistoryEntry.reason?: string`. | No new action names; `forced` stays optional-boolean. |
| `src/schemas.ts` | `reason` on `AssignParams`, `MoveParams`, `HistoryEntry`; `assignee`/`force` descriptions (#2.4). No `maxLength` on `reason`. | No new tool, no new output field, no schema-level `force` requirement. |
| `src/store.ts` | `normalizeReason`, the one-entry attachment rule (#1.2), the third-party `force` check in `assignTask` (#2.1), `unannotated_forced` in `validateBoard`, `reason` in `parseHistory` (last key), `planRepairIds`, `repairIds`. | The claim model (`claimBound`, `target.active || currentStatus?.active`), `reserveTaskId`, `releaseTask`'s forced unassign, `stale_claim`, `assertFresh`. |
| `src/render.ts` | the `why` line in `renderTask`; export the existing `truncate` helper. | `renderBoard`, row layout, `renderBriefing`, `renderSummary`, `formatAge`, the marker set, `DEFAULT_WIDTH`. |
| `src/command.ts` | the 14-line `USAGE` exported; `completeKanbanCommand(prefix, board?)`; the `repair-ids` branch, `renderRepairPlan`, `renderRepairResult`; `repair-ids` in the subcommand list and the header comment. | `release`, `validate`'s report renderer, `renderTaskList`, `parseArgs` (the `as` flag already exists), `resolveOperator`. |
| `src/index.ts` | session `cached` location + the four hooks/wrapper of #3.1; `getArgumentCompletions` passes `cached`; `kanban_assign`'s guideline; the `reason`/`force` guidance on `kanban_assign` and `kanban_move`. | Tool names, `fail()`/`failureEnvelope`, `kanban_list`'s paging and briefing paths, `notifyChange`. |

Docs: `README.md` (third-party rule, `repair-ids`, `unannotated_forced`,
completion sentence, `0009` reference), `docs/workflow.md` (assignment
paragraph, repair paragraph, `unannotated_forced` line), `docs/task-file.md`
(`reason` in the frontmatter table and the history bullet),
`docs/adr/0005` (one Consequences line pointing at `repair-ids`),
`docs/adr/0004` (one line pointing at 0009), `GLOSSARY.md` ("Forced
assignment" clause). `CHANGELOG.md` and `package.json` belong to T-0017.

## 7. Acceptance checks

Each line is an assertion a test can make literally. `B` is a scratch board
from `makeBoard()`; a test that depends on an age or a timestamp injects a
`fixedClock`.

### T-0012 - `reason`

1. `kanban_assign {task:"T-0001", assignee:"coder-2", agent:"coder-1", force:true, reason:"owner idle 2d"}` writes a `force-assign` entry whose **last** key is `reason: owner idle 2d`, and `rg -c "^    reason: owner idle 2d$"` on that file returns `1`.
2. The same call without `force` fails with code `invalid_argument` and text `reason requires force: true.`, and the task file is byte-identical.
3. A 201-character reason fails with `reason is 201 characters; the limit is 200.`
4. A reason containing `\n` fails with `reason must be a single line.`, and `"   "` fails with `reason must be 1-200 characters.`
5. `renderTask` output contains the two adjacent lines `    2026-10-30 10:05:00Z @coder-2  force-assign coder-2 (forced)` and `      why  owner idle 2d`, and every line is at most 76 characters.
6. A 200-character reason renders on one `why` line of exactly 76 characters ending in `...`.
7. `validateBoard(B)` on one unannotated `force-assign` returns exactly one problem with `code === "unannotated_forced"` and `severity === "warning"`, and `report.ok === true`.
8. `/kanban validate` on that board prints `Board is valid (1 warning).` and the three-line warning block of #1.6, every line at most 76 characters.
9. The same entry with a reason prints `Board is valid.` and no `unannotated_forced` line.
10. A file written before v0.3 (no `reason` key) parses, and a `/kanban release --yes` on it produces no `unannotated_forced` (forced `unassign` is not a takeover).
11. `rg -n "reason" src/schemas.ts src/types.ts` shows `AssignParams`, `MoveParams`, and `HistoryEntry`.

### T-0013 - third-party assignment

1. `kanban_assign {task:"T-0002", assignee:"coder-2", agent:"coder-1"}` on an unassigned task fails with code `wrong_owner`, error text `Task T-0002 is unassigned; "coder-1" cannot assign it to "coder-2" without force.`, and a hint containing `force: true`.
2. `structuredContent` of that failure has `task: "T-0002"`, `assignee: "coder-2"`, `agent: "coder-1"`.
3. The task file is byte-identical after the failure, and `.pi/kanban/.lock` does not exist.
4. The same call with `force: true` succeeds and the last history entry is `action: force-assign`, `by: "coder-1"`, `assignee: "coder-2"`, `forced: true`.
5. `kanban_assign {assignee:"coder-1", agent:"coder-1"}` on an unassigned task needs no `force` and appends `action: assign`.
6. `kanban_assign` whose `assignee` equals the current assignee writes nothing, and `rev` is unchanged.
7. Holding the task yourself and assigning it to another handle without `force` fails with `wrong_owner` (row 6 of #2.1's table).
8. `kanban_move {task:"T-0001", to:"working", agent:"coder-1"}` from an unassigned `new` succeeds without `force` and appends `action: assign`, `assignee: "coder-1"`.
9. A task file containing a historic third-party `action: assign` entry still validates `ok: true`.
10. `USAGE` contains `Assigning a task to another handle needs force: true`, and `kanban_assign.promptGuidelines` contains `history then records a forced assignment`.
11. `docs/adr/0009-third-party-assignment-is-forced.md` exists and `rg -n "0009" README.md docs/adr/*.md` matches.

### T-0014 - completions

1. `completeKanbanCommand("T-0", B)` returns an item with `label === "T-0001"` and `description === "planning · Fix duplicate ids after a merge"`.
2. `completeKanbanCommand("coder", B)` returns `label === "coder-1"` with `description === "2 tasks"` on a board where `@coder-1` holds two tasks.
3. `completeKanbanCommand("", undefined)` deep-equals the 8 labels `["init","validate","release","repair-ids","--all","--json","status","mine"]`.
4. `completeKanbanCommand("T-0", undefined)` also returns those 8 labels (never empty).
5. `completeKanbanCommand("@cod", B)` returns `["coder-1"]` and no `T-` label.
6. A board with 25 tasks yields 20 task items; a board with 15 handles yields 10.
7. `completeKanbanCommand("", B)` contains exactly one `coder-1` item when that handle is both the assignee and a history `by`.
8. A board with one malformed task file still returns the readable task, and no `description` contains `could not be read`.
9. A cached location whose `.pi/kanban/tasks` does not exist returns the 8 subcommands.
10. A completion call leaves `.pi/kanban/.lock` absent and no task file's `mtime` changed.
11. `completeKanbanCommand("T-0", B)` never throws for any of: missing workflow file, empty `tasks/`, unreadable `tasks/`.

### T-0015 - `/kanban help`

1. `USAGE.split("\n").length === 14` and every line is at most 76 characters.
2. `USAGE` contains each of `active (◆) status claims it for your handle`, `terminal status releases the claim`, `self-asserted`, `Assigning a task to another handle needs force: true`, `Completions use this session's board`, `subcommands`.
3. `USAGE` contains `Start with kanban_list`.
4. `handleKanbanCommand("help", ctx)` notifies the exact `USAGE` string, and so does `--help`.

### T-0016 - `repair-ids`

1. On `B` where `T-0002.md` declares `id: T-0009`, `/kanban repair-ids --dry-run` prints a line matching `  rename  T-0002.md -> T-0009.md` and `Nothing was written.`
2. After that dry run, every task file and `counter.json` is byte-identical, and `.pi/kanban/.lock` does not exist.
3. `--yes` on the same board: `T-0002.md` no longer exists, `T-0009.md` exists, its frontmatter reads `id: T-0009`, and `validateBoard(B).problems` contains no `id_mismatch`.
4. `repair-ids --yes` prints `Repaired 1 task id.`, `  renamed  T-0002.md -> T-0009.md   id: T-0009`, and `  by       @human`.
5. On `B` with `counter.json` `next: 3` and tasks up to `T-0009`, `--yes` prints `  counter  next 3 -> 10  (raised above the highest id T-0009)` and `counter.json` reads `10`; `validateBoard(B).problems` contains no `counter_low`.
6. On a clean `B` with `counter.json` `next: 12`, `--dry-run` prints `Nothing to repair: every frontmatter id matches its filename.` and writes nothing; the counter file is byte-identical.
7. On `B` where `T-0009.md` exists and `T-0002.md` declares `id: T-0009`, `--yes` prints `Cannot repair: T-0009.md already exists and T-0002.md declares id T-0009.` and no file is touched.
8. On `B` where `T-0002.md` and `T-0005.md` both declare `id: T-0009`, `--yes` prints `Cannot repair: two files declare the same id.`
9. On `B` where `T-0007.md` has no `id`, the plan lists `  T-0007.md  no string "id" in frontmatter` under `skipped`, and the readable renames still apply.
10. `repair-ids --dry-run --yes` prints `/kanban repair-ids takes one of two flags.` and writes nothing.
11. A swap (`T-0002.md` declares `T-0005`, `T-0005.md` declares `T-0002`) is applied by `--yes` with both files renamed and both `id`s correct.
12. `rg -n "repair-ids" README.md docs/workflow.md src/command.ts` matches.

### Release criteria coverage

| `v0.3-scope.md` bullet | Covered by |
|---|---|
| `rg -n "reason" src/schemas.ts src/types.ts` | T-0012 #11 |
| forced takeover with `reason` in the file and in `renderTask` | T-0012 #1, #5 |
| `unannotated_forced` present / absent | T-0012 #7, #9 |
| third-party assign fails `wrong_owner`, hint names `force: true` | T-0013 #1 |
| third-party assign with `force` writes `force-assign` | T-0013 #4 |
| task file unchanged after the refusal | T-0013 #3 |
| `completeKanbanCommand("T-0")` / `("")` with no board | T-0014 #1, #3 |
| help names all four rules | T-0015 #2 |
| `repair-ids --dry-run` prints the rename, writes nothing | T-0016 #1, #2 |
| `repair-ids --yes` renames, rewrites `id`, clears `id_mismatch` | T-0016 #3 |
| counter stays above the highest id, no `counter_low` | T-0016 #5 |
| `README`/`workflow.md` document the codes and `repair-ids` | T-0016 #12, T-0012 docs |
| ADR 0009 exists and is referenced | T-0013 #11 |
| build clean, test count, version, CHANGELOG, backlog markers | T-0017; not a design assertion |

## Conflicts resolved

`v0.3-scope.md` wins over this document, this document wins over the
`T-001x` work orders. Where the three disagreed:

1. **`reason` without `force`.** T-0012's note says a `reason` without `force`
   is *ignored*. Rejected: a silently discarded reason is exactly the false
   record section 1 exists to prevent. It is `invalid_argument` (#1.3).
2. **`reason` on `renderTask`.** T-0012's note says `(forced: <reason>)` inline
   on the history line. Rejected: free text up to 200 characters cannot be
   inlined into a 76-column line without moving the `when`/`who`/`action`
   columns. A `why` continuation line with a 65-character truncation budget
   (#1.4) replaces it.
3. **`reason` on a forced `unassign`.** T-0012's note flags any forced entry
   without a reason, including `unassign`. Rejected: only `/kanban release`
   writes a forced `unassign`, it cannot carry a reason, so every board that
   ever used `release` would carry a permanent warning no API could clear.
   `unannotated_forced` inspects `force-assign` only (#1.2).
4. **Which repair `repair-ids` performs.** T-0016's note says the file is
   repaired *to the filename* (frontmatter rewritten). The scope's release
   criteria require the inverse: `--dry-run` "prints the rename" and `--yes`
   "renames the file and rewrites its frontmatter `id`". Scope wins: the file
   is renamed to the declared id (#5.1). This also honours ADR 0005 - a
   declared id was issued and can never be reissued, so overwriting it would
   destroy an id; renaming to it preserves the id.
5. **`repair-ids` signature.** T-0016's note has
   `repairIds(location, plan, agent)`. Narrowed to
   `repairIds(location, agent)`: it re-plans under the lock, like
   `/kanban release --yes` re-reads under the lock, so a printed plan is never
   applied blind (#5.1).
6. **`wrong_owner` hints must name `/kanban release`.** design v0.2 #4 says
   every `wrong_owner` hint does. The third-party case has no holder to
   release, so its hint names `force: true` and the recorded entry instead
   (#2.2).
7. **`USAGE` line budget.** v0.2 #6 caps help at 12 lines (10 used); T-0015
   caps it at 14. The v0.3 block is exactly 14 lines, and every line is at
   most 76 characters.
8. **Subcommand count with no board.** T-0014 asserts "the current subcommand
   count"; that is 8 once `repair-ids` lands (T-0016 adds it) and 7 if T-0014
   lands first. The final assertion is the 8-label list of T-0014 #3.
9. **Scope's "#12 constraint" cites "session_start/`cwd` events".** There is
   no `cwd` event in `ExtensionAPI`; the refresh points are `session_start`,
   `session_before_switch`, `session_shutdown`, and every `/kanban`
   invocation (#3.1). This is the only reading that is implementable.
10. **`repair-ids` with no flag.** T-0016's note offers two readings (refuse
    with the usage error, or print the plan as `/kanban release` does). Chosen:
    no flag prints the plan and writes nothing, and only `--dry-run --yes`
    together is refused (#5.4). The scope's release criteria name
    `--dry-run` as the flag under test, not the bare invocation.
