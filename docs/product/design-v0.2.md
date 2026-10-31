# Design v0.2: the agent-facing surface

Status: ready to implement. Covers backlog items 1, 3, 4, and 7 and task
T-0002. Vocabulary is `GLOSSARY.md`; the rules are ADR 0002, 0004, 0007,
and 0008.

Everything below is literal output. Replace `<angle>` placeholders only.
Do not re-wrap a block: every line is already inside the 76-column budget.

## 0. Conventions

- Render width `W = 76` columns, counted in characters. `renderBoard` and
  `renderTask` already default to this; the new blocks use the same number.
- All new text is ASCII. The only non-ASCII characters allowed are the
  existing markers `◆` (U+25C6), `◇` (U+25C7), `─` (U+2500), `·` (U+00B7),
  and `⚠` (U+26A0). Truncation uses three ASCII dots, never a single
  ellipsis character.
- A **claim** exists only while the task sits in an `active` status
  (ADR 0008). An assignee in any other status is an assignment, not a claim,
  and is shown without an age.
- All handles are displayed as `@` + handle. Handles are self-asserted and
  never verified.
- Ages use the board clock (`Clock.now()`), so tests can inject time.

### 0.1 Claim age (`age`)

`claimStart` is the `at` timestamp of the last `history` entry whose action
is `assign` or `force-assign` and whose `assignee` equals the current
assignee. If no such entry exists, use `updated`. `age = now - claimStart`,
floored at zero, then formatted:

| Seconds elapsed | Format | Examples |
|---|---|---|
| `< 60` | `{s}s` | `0s`, `45s` |
| `< 3600` | `{m}m` | `5m`, `59m` |
| `< 86400` | `{h}h` | `1h`, `23h` |
| `< 1209600` (14 d) | `{d}d` | `1d`, `13d` |
| `>= 1209600` | `{w}w` | `2w`, `52w` |

`{n}` is `Math.floor`, never zero-padded. An age is at most 4 characters
(`520w`); if a future timestamp yields a negative age, print `0s`.

The age is shown only when the task is in an `active` status. This is the
invariant from ADR 0008, not a display choice: no claim outside an active
status means no claim age to report. When backlog item 2 widens exclusivity
to every non-terminal status, the same formatter applies there unchanged.

## 1. Board briefing

### Trigger

`kanban_list` returns the briefing instead of a task list in exactly two
cases:

1. The caller passes `briefing: true` (new optional boolean parameter,
   default `false`). It wins over every other parameter.
2. The board has zero tasks **and** no status/assignee filter is set.

The briefing is plain text in the tool's `text` content, and the same string
is returned as `structuredContent.briefing`. It never prints a fenced block.

### Template (18 lines, hard maximum 20)

```
Board  <dir>
Workflow  <name>  ·  initial: <initial>
  active  <active statuses>
  other   <other statuses>

Claims
  Moving a task into an active status claims it for your handle; only the
  holder can move or release it. force: true is a deliberate takeover,
  recorded as a forced assignment. A terminal status releases the claim.
  There are no leases: a claim never expires until someone releases it.

  Handles are self-asserted, like coder-1. The board does not verify them.

Start here
  kanban_list, then kanban_list {task:"T-0001"} for one task in full.
  kanban_create {title, agent} adds a task in the initial status.
  kanban_move {task, to, agent} moves along a declared transition.
  Every write takes an agent handle; pass expectedRev from kanban_list.
```

### Substitutions

- `<dir>`: `displayPath(board.dir, ctx.cwd)`. If longer than 69 characters,
  keep the last 66 and prefix `...`.
- `<name>`: `workflow.name`, or `(unnamed)` when absent.
- `<initial>`: `workflow.initial`, verbatim.
- `<active statuses>`: each `active` status as `◆ ` + status **id**, joined
  by two spaces, in workflow order. If the line would exceed 74 characters,
  keep the first eight and append `  (+N more)`; the full list is always
  available in the `kanban_list` Workflow block.
- `<other statuses>`: every non-active status as `◇ ` + id, joined by two
  spaces, in workflow order, with ` (terminal)` appended to terminal ids.
  Same eight-item cap as above.

### Degenerate cases

Missing or invalid workflow: replace lines 2-4 with one line and keep the
rest of the briefing unchanged:

```
Workflow  unavailable  (⚠ run /kanban validate)
```

Workflow with no `active` status (valid per `docs/workflow.md`): line 3 is
exactly:

```
  active  (none - exclusivity rests on kanban_assign)
```

Empty board: the briefing is the whole response; do not append
`No matching tasks.` or the Workflow block.

## 2. Task row format

One row shape is used by `kanban_list` and by the columns of `/kanban`.
`kanban_list` rows start at column 1, as they do today.

### Layout equations

```
row = indent + id + "  " + [status + "  "] + title + "  "
      + meta + "  " + rev
```

- `indent`: 0 in `kanban_list`, 4 spaces inside a `/kanban` column.
- `id`: left-aligned, `idWidth = max(6, longest displayed id length)`.
- `status` (list only): left-aligned, `statusWidth = min(16, max(6, longest
  displayed status cell))`. The cell is the status id, plus ` ⚠` when the
  task is drifted (ADR 0007). A status id longer than `statusWidth` is
  truncated to `statusWidth - 3` + `...`.
- `title`: left-aligned in `titleWidth`, truncated to `titleWidth - 3`
  (trailing spaces removed) + `...` when longer.
- `meta`: the assignee cell. Empty when unassigned. Content is
  `@handle age` in an active status, and `@handle` otherwise. A handle cell
  longer than 16 characters is truncated to `@` + the first 13 characters
  + `...`.
- `rev`: right-aligned, `revWidth = max(5, longest "rev N" length)`, capped
  at 6 (a rev above 99999 prints its full `rev N` and lets the row grow).
- `titleWidth` is the remainder:

```
titleWidth = W - (indent + 2 + idWidth + 2
                  + (statusWidth + 2 if a status cell is printed)
                  + 2 + metaWidth + 2 + revWidth)
```

`metaWidth = max(0, longest meta length)`, so the trailing `rev` column is
aligned across all rows in one result set. With the caps above `titleWidth`
is always at least 15; if a computation yields less, clamp `statusWidth` to
10, then drop the age, then clamp `metaWidth` to 16.

Trailing spaces are stripped from every row.

### Example: `kanban_list` rows

Widths: `idWidth=6`, `statusWidth=9`, `metaWidth=12`, `revWidth=6`,
`titleWidth=35`.

```
T-0001  working    Add retry to the upload client       @coder-1 3d    rev 4
T-0002  planning   Fix duplicate ids after a merge                     rev 2
T-0003  reviewing  Make an abandoned claim visible...   @reviewer 5h  rev 11
```

Row 2 is unassigned: the meta column is spaces and `rev` stays right-aligned.
Row 3 shows truncation; `...` replaces the tail inside `titleWidth`.

### Example: `/kanban` column rows

No status cell (the column heading carries it); indent 4. Widths:
`idWidth=6`, `metaWidth=12`, `revWidth=6`, `titleWidth=42`.

```
    T-0001  Add retry to the upload client                @coder-1 3d  rev 4
    T-0005  Rework the board briefing                                  rev 7
```

The claim age is what makes an abandoned claim visible on `/kanban`. A
non-active column (`◇ new`) therefore prints `@coder-1` with no age.

### Drifted and long-status rows

A drifted task keeps its raw status id and gains ` ⚠` after it; the marker
sits inside `statusWidth`, so the title column does not shift:

```
T-0003  working ⚠  Fix duplicate ids after a merge      @coder-1 3d    rev 9
```

## 3. Truncation and paging

### `kanban_list` parameters

| Param | Type | Default | Meaning |
|---|---|---|---|
| `limit` | integer 1-500 | `50` | Maximum rows printed. |
| `offset` | integer >= 0 | `0` | Rows to skip after filtering and sorting. |
| `summary` | boolean | `false` | Print counts instead of rows. |
| `includeTerminal` | boolean | `true` | Existing filter, applied before paging. |
| `briefing` | boolean | `false` | Section 1. |

Filtering happens first; `total` is the number of matching tasks. Rows keep
today's order: workflow status order, then task id ascending. `offset >=
total` is not an error.

### Omitted rows

The result prints at most `limit` rows. A header line precedes the rows
when `offset > 0`; a footer line follows the last row when
`offset + returned < total`. A middle page prints both, which is intended:
the header gives position, the footer gives the continuation.

Header (only when `offset > 0`):

```
  showing 51-100 of 137 (offset 50, limit 50)
```

Footer (only when `offset + returned < total`):

```
  ... 37 more tasks (of 137). Next: offset 100, or narrow the filters.
```

The footer is a single line; `N` is `total - offset - returned` and the
`Next:` offset is `offset + returned`.

Offset past the end:

```
  No tasks at offset 137; 137 match. Reset with offset 0.
```

Zero matches after filtering keeps today's sentence plus one hint line:

```
No matching tasks.
  Try another status, assignee, or includeTerminal: false.
```

Zero tasks on the whole board is the briefing (Section 1), not this block.

### `summary: true`

Counts only, no task rows, no paging. Filters still apply. Line 1 names the
board, then the totals line from `summaryLine` (`{total} tasks · {open} open
· {done} done`, plus ` · {claimed} claimed` only when claimed > 0), then one
line per declared status in workflow order:

```
Board  /Users/me/app/.pi/kanban

  137 tasks · 92 open · 45 done · 61 claimed

  ◆ planning     12  11 claimed
  ◆ working      40  38 claimed
  ◆ reviewing     9  9 claimed
  ◇ new          31  0 claimed
  ◇ done         45  terminal
```

- Label column: `  ` + marker + space + label, left-aligned to the longest
  label + 2.
- Count: right-aligned in 4 columns.
- Note: `{claimed} claimed` for every column that is not terminal;
  `terminal` for terminal columns.
- Drifted tasks, if any, add one final line, with the same marker and
  label alignment:
  `  ⚠ drifted       2  not in workflow`.

### `structuredContent`

`kanban_list` adds `total`, `offset`, `limit`, `returned`, and `hasMore`
(`offset + returned < total`). These are the post-filter numbers, so an
agent can page without counting text lines.

## 4. Stale claim surface

### `/kanban` and `kanban_list`

Claim age appears wherever an assignee appears, using the row format in
Section 2: in `/kanban` columns, in `kanban_list` rows, and in `/kanban
mine <handle>`. `/kanban <task-id>` gains one line under `assignee`:

```
  assignee  coder-1  (claimed 3d)
```

and, when unassigned, keeps the existing `assignee  -`. `-` is the ASCII
stand-in for an empty value; do not use an em dash.

### `/kanban validate`

`validateBoard` gains a `staleAfterMs` option, default `86_400_000` (24 h).
Override with `--stale <duration>` on the command and with
`PI_KANBAN_STALE_MS` in the environment; the flag wins.

Duration grammar: `<n>` followed by `m`, `h`, `d`, or `w` (`30m`, `12h`,
`7d`); bare integers are milliseconds; `0` disables the check. Invalid
input is a hard error: `Invalid --stale "x"; use 30m, 12h, 7d, or 0.`

`stale_claim` is a **warning**, not a failure: it does not flip
`report.ok`, and the header says so. Problems gain `severity: "problem" |
"warning"`. Order: `drifted`, `terminal_assigned`, `stale_claim`. The
`active_unassigned` problem is deleted (backlog item 1): an active task
with no assignee is a normal state after a release.

```
Board is valid (1 warning).
  /Users/me/app/.pi/kanban

Tasks:
  ⚠ T-0003  stale_claim: Claimed by "coder-1" for 3d (threshold 24h).
            Release it with /kanban release T-0003 --yes.
```

The message is one sentence, then the release sentence. Wrap at 76 with a
12-space continuation indent. When `stale_claim` is the only finding, print
`Board is valid (1 warning).` (or `(N warnings)` for N > 1) and the `⚠`
lines but no `Board has problems.`; `report.ok` stays `true`.

### `wrong_owner`

Every `wrong_owner` message states the claim age; every hint names the
release call and the `force` alternative. Exact text:

```
Error [wrong_owner]: Task T-0003 is claimed by "coder-1" for 3d.
"coder-2" cannot move it into "reviewing"; that would take the claim.
Release it with /kanban release T-0003 --yes, or pass force: true to
take over. An agent can call kanban_assign with assignee:null, force:true.
```

Rules: the message is a single sentence ending in a period and never
contains the caller's target status (it would exceed the width); the hint
is a single paragraph of complete sentences, wrapped as shown, and always
contains the literal `/kanban release <task-id> --yes`. Use the same hint
for the `already_assigned` refusal, with the owning sentence substituted.

## 5. `/kanban release <task-id>`

### Semantics

`/kanban release` is sugar for
`kanban_assign {task, assignee: null, force: true}`: it clears the single
assignee and records a forced unassignment in `history` (ADR 0004, 0008).
It never changes the status and never sets an assignee. It works on an
assigned task in any non-terminal status; a terminal task has no assignee,
so it falls through to the "no claim" refusal.

This is the only mutating `/kanban` subcommand. `README.md` and the
`command.ts` header must change from "the command never edits the board" to
"`release` is the one exception; everything else only renders."

Arguments: `--yes` confirms; `--as <handle>` names the operator recorded as
`by` (default `PI_KANBAN_HANDLE`, else `human`, validated by
`assertHandle`). Without `--yes` nothing is written, in TUI and headless
alike; do not call `ctx.ui.confirm`.

### Confirmation prompt (no `--yes`)

```
Release the claim on T-0003?

  owner   @coder-1
  claimed 3d
  status  reviewing
  rev     11

This records an unassign by "human" in the task history.
Re-run with --yes to confirm:  /kanban release T-0003 --yes
```

For a non-active status the first line is `Release the assignment on
T-0003?` and the `claimed 3d` line becomes `since <updated>`.

### Success

```
Released T-0003.

  was  @coder-1  3d  reviewing
  now  unassigned     reviewing  rev 12
```

The `now` line's `rev` is the post-write rev. The history entry is
`{ action: "unassign", by: "<operator>", assignee: "coder-1",
forced: true }`, using the existing optional `forced?: boolean` on
`HistoryEntry`.

### Refusal and confirmation variants

Not claimed (no assignee):

```
T-0003 has no claim to release.

  status  new
  owner   -
```

Assignment without a claim (non-active status, someone assigned): the
request is valid, so this is the confirmation text, not a refusal.

```
T-0003 has an assignment but no claim.

  status  new
  owner   @coder-1
Run /kanban release T-0003 --yes to clear it.
```

Unknown task keeps the existing `no_such_task` text. A task whose status is
not in the workflow still releases, and the `now` line prints the raw status
with ` ⚠`.

## 6. `/kanban help`

Ten lines, printed by `/kanban help` and `/kanban --help`. It replaces the
current `USAGE` constant.

```
Usage  /kanban [task-id] [--all] [--json]
       /kanban status <id> | mine <handle> | validate [--stale 24h]
       /kanban release <task-id> [--yes] [--as <handle>]
       /kanban init | help

  Moving a task into an active (◆) status claims it for your handle; only
  that handle can move or release it without force: true.
  A terminal status releases the claim; a claim never expires on its own.
  Handles are self-asserted names like coder-1; the board does not check
  them. Start with kanban_list: it shows rev, status, and claim age.
```

The claim rule (lines 6-7), the terminal rule (line 8), and the handle
convention (lines 9-10) are mandatory; do not add lines beyond 12.

## 7. Implementation map

| Location | Change |
|---|---|
| `src/render.ts` | `formatAge`, row layout for list and columns, drifted cell, `...` truncation, summary block, omitted-row footer. |
| `src/index.ts` | `briefing` on `kanban_list`, paging params, briefing text, `summary` branch, `wrong_owner` hint is emitted from `fail()` unchanged. |
| `src/command.ts` | `/kanban release`, `/kanban help`, `/kanban validate --stale`, task view `assignee` age line. |
| `src/store.ts` | `validateBoard({ staleAfterMs })`, `stale_claim` warning, drop `active_unassigned`, release helper reusing `assignTask({ assignee: null, force: true })`. |
| `src/schemas.ts` | `limit`, `offset`, `summary`, `briefing`. |
| `src/types.ts` | `forced?: boolean` on unassign history entries; `severity` on validation problems. |
| `README.md`, `docs/adr/0004` | Document the release path and the read-only exception. |

Do not add leases, heartbeats, expiry, or a second source of truth for
claims. Do not change the `◆ ◇ ─ · ⚠` marker set or the 76-column default.

## 8. Acceptance checks

- The briefing names the initial status, every active status id, the `force`
  rule, the terminal release rule, and the self-asserted handle rule, in
  at most 20 lines.
- Every fenced block above has lines of at most 76 characters.
- A 137-task board produces the same `limit`/`offset` numbers in text and
  `structuredContent`.
- `validate` with a claim older than the threshold prints one `stale_claim`
  warning and still reports `ok: true`.
- `/kanban release T-1` without `--yes` writes nothing and prints the
  confirmation block; with `--yes` it clears the assignee and bumps `rev`.
