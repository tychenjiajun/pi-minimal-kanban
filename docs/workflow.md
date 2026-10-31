# Workflow file

A board declares its lifecycle in `.pi/kanban/workflow.yaml` (or `.yml`, or
`workflow.json`). Exactly one of those files may exist. A project with a
broken or missing workflow is an error for every mutation, but `/kanban` still
lists tasks so the problem is visible.

## Minimal workflow

```yaml
statuses: [new, done]
```

Pure shorthand treats every status as a plain column and makes **the last
status terminal**. Transitions are the adjacent pairs, in both directions:
`new ↔ done`.

## Explicit workflow

```yaml
name: feature work            # optional, shown in diagnostics
initial: new                  # optional, defaults to the first status

statuses:
  - id: new                   # required, [A-Za-z0-9][A-Za-z0-9_-]*
    label: New                # optional, defaults to the id
  - id: planning
    active: true              # entering this status claims the task
  - id: working
    active: true
  - id: reviewing
    active: true
  - id: done
    label: Done
    terminal: true            # entering this status releases the claim

transitions:                  # optional; omit for the linear shorthand
  new: [planning, working]
  planning: [new, working]
  working: [planning, reviewing]
  reviewing: [working, done]
  done: [working]
```

### Rules

- Status ids are unique and match `[A-Za-z0-9][A-Za-z0-9_-]*`.
- At least one status is `terminal: true`.
- The initial status cannot be terminal.
- A status cannot be both `active` and `terminal`.
- Every transition target must be a declared status.
- A status cannot transition to itself.
- Every non-terminal status needs at least one outgoing transition.
- When `transitions` is omitted, adjacent statuses get two-way moves and the
  last status becomes terminal (shorthand only).

An invalid workflow reports every problem it can find in one pass, which is what
`/kanban validate` prints.

## JSON

The same document in `workflow.json`:

```json
{
  "initial": "new",
  "statuses": [
    { "id": "new" },
    { "id": "working", "active": true },
    { "id": "done", "terminal": true }
  ],
  "transitions": {
    "new": ["working"],
    "working": ["new", "done"],
    "done": ["working"]
  }
}
```

## `active` and `terminal`

`active` marks the statuses in which somebody is doing the work. Moving into one
claims the task for the caller, and moving out of one while somebody else holds
the claim requires `force`. While a claim lasts, its age is shown next to the
assignee, and `/kanban validate` warns once it is older than the stale threshold
(24 h by default). A claim never expires on its own; release it with
`/kanban release <id> --yes` or `kanban_assign {assignee: null, force: true}`.

`terminal` marks finished work. Entering it clears the assignee, and a terminal
task cannot be assigned until it is moved back.

A workflow without `active` statuses is valid — every task stays unassigned and
coordination happens through explicit `kanban_assign` calls.

## Assignment needs `force` when it is not yours

`kanban_assign` requires `force: true` whenever the target assignee is not the
caller's own handle: assigning an unassigned task to a third handle, handing
your own task to somebody else, and taking or clearing another handle's
assignment all need it. The write is then recorded as `force-assign` +
`forced: true`, distinguishable from a self-claim's plain `assign`; without
`force` it fails with `wrong_owner` and writes nothing. Moving a task into an
`active` status still claims it for the caller with no flag, because the new
assignee is the caller. ADR: `docs/adr/0009-third-party-assignment-is-forced.md`.

## Repairing task ids after a merge

Boards are committed, so a `counter.json` merge conflict is resolved by hand
(ADR 0005). Two things can come out of that, and without a repair path nothing
but a hand edit fixes them: a task file whose frontmatter `id` no longer matches
its filename (`/kanban validate` reports `id_mismatch`), and a counter that is
not greater than the highest existing id (`counter_low`).

`/kanban repair-ids` fixes exactly those two codes and nothing else.

- **The filename is the identity.** A file whose frontmatter declares
  `id: T-0009` is renamed to `T-0009.md`; the reverse repair is refused, because
  ADR 0005 makes an issued id permanent and overwriting it would discard an id
  that can never be reissued.
- **The counter only goes up.** It is raised to `highest + 1` when it is at or
  below the highest id, and otherwise left byte-identical.
- **The plan is re-computed under the board lock.** `--yes` does not apply the
  plan it printed; it takes the lock, re-plans, and applies that.
- **Two rename passes.** Sources move to `.repair.<token>.md` first, then to
  their targets, so a swap (`T-0002 -> T-0005` with `T-0005 -> T-0002`) and a
  chain both apply without colliding. A crash between the passes leaves no task
  with a wrong id, only a file no tool reads — and the next run lists it as
  `interrupted repair: restore or delete by hand`.
- **Prose is never rewritten.** A `T-0007` in a description or a comment stays
  as written. Neither are `rev`, `updated`, or the history: a rename is not
  task activity.
- **Ambiguity is refused.** `--dry-run --yes` together, two files declaring one
  id, and a target that already exists all print a refusal and write nothing. A
  file with no string `id` is skipped and listed, and the rest still applies.

Nothing here fixes `drifted`, `terminal_assigned`, `stale_claim`,
`unannotated_forced`, or an unreadable task file.

## Takeovers and their reasons

`kanban_assign` and `kanban_move` accept `reason` together with `force: true`.
It is recorded on the one forced history entry, must be a single line of 1-200
characters, and says why the claim changed hands. A `reason` without `force` is
an `invalid_argument` error: an annotation on a write that took nothing over
would be a false record. A takeover recorded without one stays valid, and
`/kanban validate` reports it once per task as a `unannotated_forced` warning.
