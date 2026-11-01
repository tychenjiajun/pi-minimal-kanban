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
`kanban_assign {task: "T-0003", assignee: null, force: true}`.

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
(ADR 0005). Two things can come out of that: a task file whose frontmatter `id`
no longer matches its filename (`/kanban validate` reports `id_mismatch`), and a
counter that is not greater than the highest existing id (`counter_low`).

`/kanban` reports both and writes neither: the command is read-only, and
`/kanban repair-ids` is no longer exposed. The fix is a hand edit that follows
the same rules the command used:

- **The filename is the identity.** Rename the file to the id its frontmatter
  declares (`id: T-0009` -> `T-0009.md`). Never edit the id to match the
  filename: ADR 0005 makes an issued id permanent, so the reverse repair would
  discard an id that can never be reissued.
- **The counter only goes up.** Raise `counter.json` to `highest + 1` when it is
  at or below the highest id, and otherwise leave it byte-identical.
- **Prose is never rewritten.** A `T-0007` mentioned in a description or a
  comment stays as written, and so do `rev`, `updated`, and the history: a
  rename is not task activity.
- **Do it while nobody is writing.** A hand edit does not take the board lock, so
  make it when no agent holds a claim, and run `/kanban validate` afterwards.

Nothing here fixes `drifted`, `terminal_assigned`, `stale_claim`,
`unannotated_forced`, or an unreadable task file: those are reported by
`/kanban validate` and resolved by the call that owns them, not by an id rename.

## Takeovers and their reasons

`kanban_assign` and `kanban_move` accept `reason` together with `force: true`.
It is recorded on the one forced history entry, must be a single line of 1-200
characters, and says why the claim changed hands. A `reason` without `force` is
an `invalid_argument` error: an annotation on a write that took nothing over
would be a false record. A takeover recorded without one stays valid, and
`/kanban validate` reports it once per task as a `unannotated_forced` warning.
