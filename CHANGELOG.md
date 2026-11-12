# Changelog

## 0.5.3 — built and tested against pi 1.5.2

2026-11-12. Dependency release: no tool, workflow, or on-disk change.

### Changed

- **Dev dependency** `@earendil-works/pi-coding-agent` 1.5.0 → 1.5.2;
  `pnpm typecheck` and all 277 vitest cases pass against it.
- **`typebox`** dev dependency 1.4.5 → 1.4.6, and `yaml` 2.9.0 → 2.9.1.

## 0.5.2 — typebox v1, newer toolchain

2026-11-06. Dependency release: no tool, workflow, or on-disk change.

### Changed

- **Schemas are built with `typebox` v1.** pi 1.5.0 validates tool arguments as
  JSON Schema and aliases legacy `@sinclair/typebox` imports to its own bundled
  `typebox` v1, so the 0.34 dev dependency described a different library than
  the one that runs. `src/schemas.ts` and the surface-pack test now import
  `typebox` (peer `typebox`, dev `^1.4.5`), and the emitted schemas are byte
  for byte the ones 0.34 produced.
- **Dev dependencies:** `vitest` 5.1.0, `@types/node` 26.6.6.

### Fixed

- **`src/test/resources.test.ts` no longer pins a literal version.** It now
  asserts `package.json` and the newest `CHANGELOG.md` heading agree, so a
  release bump cannot fail the suite (0.5.1 shipped with that test red).

## 0.5.1 — built and tested against pi 1.5.0

2026-11-06. Compatibility release: no tool, workflow, or on-disk change.

### Compatibility

- **pi 1.5.0 validates tool arguments as JSON Schema.** The kanban tools use
  plain `@sinclair/typebox` schemas with no refinements, codecs, or `BigInt`,
  so validation, coercion, and error messages keep working unchanged.
- **Dev dependency** `@earendil-works/pi-coding-agent` 1.4.0 → 1.5.0;
  `pnpm typecheck` and all 277 vitest cases pass against it.

## 0.5.0 — set up, review, stand up

2026-11-03. Two more atomic prompt templates ship beside the extension, so a
project can be set up correctly and reviewed through the board, not just
coordinated. No runtime change, no tool change, no on-disk format change.

### Added

- **`skills/kanban-setup/SKILL.md`** — the maintainer role, shipped as a skill
  because it carries workflow-authoring context. It authors
  `.pi/kanban/workflow.yaml` for the real project with ordinary file tools, walks
  the loader's rules, checks its own file by calling `kanban_list`, and commits
  `workflow.yaml`, `counter.json`, and `tasks/` as reviewed project state. It
  loads when a project needs its first board, or when kanban calls fail because
  the workflow is missing or invalid.
- **`prompts/review.md` (`/review`)** — the reviewer role, shipped as a prompt
  template. Finds the review-like statuses from the board briefing, reads each
  owned task and its actual change, comments the verdict, and moves the task to
  the terminal or back to working. It respects `wrong_owner` rather than forcing
  another agent's claim to clear the list.

### Changed

- **Prompt bodies are written for the agent, not as human commands.** `/review`
  and `/setup`-era text no longer tell the agent to "run `/kanban init`" or
  "run `/kanban validate`": those are human UI commands an agent cannot invoke.
  Board setup now writes the files with ordinary file tools and self-checks by
  calling `kanban_list`; the pre-existing `/standup` and `skills/kanban` wording
  that pointed at `/kanban validate` was corrected the same way.
- **`README.md` documents two skills and two prompts as roles** — coordination,
  setup, review, and standup — and separates model-loaded skills from
  human-invoked prompt templates so the distinction is explicit.
- **`src/test/resources.test.ts`** pins `kanban-setup` and `review` frontmatter,
  the roles they run, the authoring reference they point at, and (as a guard)
  that neither body instructs the agent to run `/kanban init` or
  `/kanban validate`.

### Compatibility

- **Nothing to migrate.** `skills/**` and `prompts/**` were already declared in
  `pi.skills`, `pi.prompts`, and `files`, so the new skill and prompt are
  discovered and shipped with no `package.json` wiring beyond the version bump.

## 0.4.1 — 简体中文 README

2026-11-01. A documentation release: the package gains a Simplified Chinese
README beside the English one, so the working agreement is readable to the
Chinese-speaking agents and humans who install it. No code, no metadata, no
board change.

### Added

- **`docs/README.zh-CN.md`** — a full translation of `README.md`: the pitch,
  install commands, tools table, `/kanban` surface, claim and forced-assignment
  rules, workflow YAML, files layout, skills and prompts, design notes, and the
  FAQ. Every tool name, error code, env var, and example is kept verbatim, so a
  Chinese reader and an English reader debug the same board.

### Changed

- **`README.md` links to it.** A language switcher (`English | 简体中文`) sits
  under the title, matching the sibling pi packages.

### Compatibility

- **Nothing to migrate.** `files` already ships `docs/**`, so the new README
  travels in the tarball from the next publish; the extension, the tool surface,
  and the on-disk board format are untouched.

## 0.4.0 — `/kanban` reads, the tools write

2026-11-01. The command surface loses its last two mutating subcommands, so
`/kanban` can never change the board; the package grows a skill and a standup
prompt. No new runtime dependency.

### Changed

- **`/kanban` is inspection-only.** `release` and `repair-ids` are gone from the
  command, its usage card, its tab completion, and the docs. Every remaining
  subcommand — the board, `<id>`, `status`, `mine`, `validate`, `init`, `help`,
  `--json`, `--all`, `--stale` — only reads. The five tools stay the whole
  mutation surface, so a session can render the board in a review, a demo, or a
  read-only context without any path that writes.
- **The help card says where writes live.** `/kanban help` still fits 14 lines: it
  now states that the command only reads and that the `kanban_*` tools change the
  board, including the exact call that clears a claim.
- **`docs/workflow.md` makes id repair a hand edit.** `id_mismatch` and
  `counter_low` are still reported by `/kanban validate`; the rules for fixing
  them (filename is the identity, the counter only goes up, prose is never
  rewritten) are stated for the hand edit that replaces `repair-ids`.

### Added

- **A kanban skill.** `skills/kanban/SKILL.md` plus `skills/kanban/references/`
  ships the working agreement: how to read the board, claim a task, hand it over
  with a `reason`, and recover a drifted board. Installed with the package and
  discovered from the conventional `skills/` directory.
- **A `/standup` prompt template.** `prompts/standup.md` reads the board and
  reports what each handle holds, what has gone stale, and what is waiting.
- **Both ship.** `files` in `package.json` now includes `skills/**` and
  `prompts/**`, and `pi.skills` / `pi.prompts` point at the conventional paths.

### Compatibility

- **`/kanban release <id> [--yes]` no longer exists** — a breaking change for
  anyone who used the command as a shortcut. One-line migration: call
  `kanban_assign {task: "<id>", assignee: null, force: true}` instead. It does
  what `release` did (clears the claim, records the unassignment, bumps `rev`),
  takes the board lock, and is available to agents and humans alike.
- **`/kanban repair-ids` is no longer exposed.** The `id_mismatch` and
  `counter_low` codes are still reported, but repair is a hand edit under the
  rules in `docs/workflow.md`. No board is rewritten by upgrading: a task whose
  frontmatter id disagrees with its filename stays exactly as it is until someone
  renames it.
- **Boards are unchanged.** No schema, history entry, or `rev` semantics move in
  0.4.0; the tool surface and the on-disk format are the 0.3.0 ones.

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
