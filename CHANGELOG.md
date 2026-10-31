# Changelog

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
