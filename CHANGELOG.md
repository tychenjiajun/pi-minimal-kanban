# Changelog

## 0.3.0 — legible takeovers

2026-11-01. A takeover now leaves a readable trace, assigning a task to a handle
that is not yours is a deliberate act, and the `/kanban` surface finishes what
0.2.0 promised. No new runtime dependency: the release adds to the one `yaml`
dependency the package already had.

### Added

- **`reason` on a forced assignment.** `kanban_assign` and `kanban_move` accept an
  optional `reason` (one line, 1-200 characters) whenever `force: true` is set.
  It is written on the single `force-assign` entry the call appends and printed
  as a `why` line beneath it in `/kanban <task-id>`, so a reader can tell "the
  owner crashed" from "the owner was preempted". `/kanban validate` reports a
  takeover without one as an `unannotated_forced` **warning**: the board stays
  valid, the entry is still readable, and nothing is rewritten. A `reason`
  without `force` is an `invalid_argument` error, so an annotation can never
  record a write that took nothing over.
- **Tab completion.** `/kanban` completes the subcommands, the task ids on this
  session's board (with status and title), and the handles the board has seen.
  The caps are stated rather than silent: at most 20 task ids and 10 handles,
  scanned from the first 500 task files. With no board it completes only the
  subcommands.
- **`/kanban help`.** A 14-line card instead of a manual: moving into an active
  `◆` status claims the task for your handle, a terminal status releases the
  claim and no claim ever expires on its own, handles are self-asserted names
  the board does not verify, assigning a task to another handle needs
  `force: true`, completions look in this session's board, and the pointer to
  `kanban_list`.
- **`/kanban repair-ids [--dry-run | --yes]`.** Renames a task file to the id its
  frontmatter declares and raises a low `counter.json`; it never rewrites the
  reverse, and a `T-0007` mentioned inside a description or a comment stays as
  written. It is a mutating subcommand, and it writes nothing unless you ask:
  `--dry-run` prints the plan, `--yes` re-plans under the board lock and applies
  it, and both flags together are refused.

### Changed

- **Assigning a task to another handle now requires `force: true`** (ADR 0009).
  This is a behaviour change for agents that assign on someone else's behalf:
  they now pass `force: true` (and may add a `reason`). Assigning to yourself,
  releasing your own claim, and taking over with an explicit `force` behave as
  before. The rule is stated in the tool description, the prompt guidelines, the
  help card, `README.md`, and `docs/workflow.md`.
- **A takeover into a terminal status records it.** `moveTask` writes
  `force-assign`, then `move`, then `unassign` when the target status is terminal
  and the claim is released.

### Compatibility

- **Third-party assignment requires `force: true`** — a breaking change for agents
  that assigned on someone else's behalf. One-line migration: add
  `force: true` (with a `reason` if the takeover deserves one) to those calls;
  everything else keeps working unchanged.
- **Boards written before 0.3.0 are still valid.** Their `force-assign` entries
  have no `reason`, so `/kanban validate` reports them once per task as
  `unannotated_forced` warnings: visible, not fatal, and no history is rewritten
  and no `rev` is bumped. New takeovers can carry a reason from now on.
- **`repair-ids` is a new mutating subcommand.** It is the second of the two
  writing `/kanban` subcommands, and it refuses to write unless you pass
  `--dry-run` (plan only) or `--yes` (apply under the board lock). A missing
  flag prints the plan and writes nothing, like `/kanban release` without
  `--yes`.

### Design notes

- `docs/adr/0009-third-party-assignment-is-forced.md` records the forced-
  assignment decision; `docs/product/design-v0.3.md` is the spec for the release
  and `docs/product/v0.3-scope.md` the scope, including what was deliberately
  deferred: enforcing the claim in non-active statuses (#2), the `/kanban` scale
  story (#6), and the unused `KanbanError.toJSON()` (#8).
- `docs/product/backlog.md` checkboxes now match the shipped tree: `[x]` means
  shipped, and the deferred sub-bullets (#2, #4's workflow-only print, #6, #8's
  `toJSON()`) are still open.

## 0.2.0 — trustworthy coordination

The board was already file-backed with declared workflows and exclusive claims.
0.2.0 makes the board something a new agent can understand from the tools alone,
and something a departed agent cannot quietly block.

### Added

- **Agent briefing.** `kanban_list {briefing: true}`, and any `kanban_list` on an
  empty board, returns the claim rules, the workflow's active statuses, and the
  first calls to make. The same text is returned as `structuredContent.briefing`.
- **Bounded listings.** `kanban_list` accepts `limit` (default 50, max 500) and
  `offset`, and prints an exact continuation line when rows are omitted.
  `summary: true` returns per-status counts instead of rows. New
  `structuredContent` fields: `total`, `offset`, `limit`, `returned`, `hasMore`.
- **Claim age.** Every view that shows an assignee shows how long the claim has
  lasted (`@coder-1 3d`, `/kanban` columns, `/kanban mine`, `/kanban <id>`).
- **`/kanban release <id>`.** The one mutating `/kanban` subcommand. Releases a
  claim held by an agent that is gone; without `--yes` it prints a confirmation
  and writes nothing. Sugar for `kanban_assign {assignee: null, force: true}`,
  recorded as a forced unassign. No leases, no automatic expiry.
- **`/kanban validate --stale <duration>`.** A claim older than the threshold
  (default 24 h, also `PI_KANBAN_STALE_MS`) is reported as a `stale_claim`
  warning; the board stays valid. Stale assignments outside active statuses are
  reported with distinct wording, because they block moving into an active one.
- **`/kanban help`.** Claim, terminal-status, and handle rules, in ten lines.

### Fixed

- **One malformed task file no longer blanks the board.** Readable tasks still
  list, the warning names the file, `/kanban validate` reports `unreadable_task`,
  and `structuredContent.fileErrors` carries the detail. Reading that specific
  task by id still fails clearly.
- **The board lock can no longer be held twice.** Entry is all-or-nothing (a
  complete `.lock.entry.<token>/` is renamed onto `.lock`), recovery renames to a
  tombstone before verifying the owner token, and orphan tombstones are reaped
  instead of blocking every write forever. `release()` only deletes a lock it
  still owns. Concurrency tests spawn real processes, including a
  stale-threshold contention run.
- **`kanban_list` rows print `rev`**, so the documented `expectedRev` workflow
  works from the tool's own text output.
- **`stale` errors name the observed rev, expected rev, and current status**;
  every tool failure carries the board `dir` and `root`.
- **`kanban_move` reads the task inside the lock**, so the reported `from` status
  and the event are not from a separate unlocked read.
- **`/kanban validate` catches id/filename mismatches and a `counter.json` that
  would reuse an id.**
- **`already_in_status`, `assertHandle`, `/kanban mine|status`, drifted rows, and
  title/handle truncation** match the documented wording and the 76-column row
  format.

### Compatibility

- Tool parameter and output changes are additive. `kanban_list` still returns
  every previously documented field.
- `limit` above 500 is rejected by the schema; the default stays 50.
- `active_unassigned` is no longer reported by `/kanban validate`; an active
  task with no assignee is a normal, recoverable state.

### Design notes

- `docs/product/audit.md`, `docs/product/backlog.md`,
  `docs/product/design-v0.2.md`, and `docs/product/v0.2-scope.md` record the
  product work behind this release, including the items deliberately deferred
  (claim enforcement outside active statuses, forced-move reasons, `/kanban`
  paging beyond scrollback).
