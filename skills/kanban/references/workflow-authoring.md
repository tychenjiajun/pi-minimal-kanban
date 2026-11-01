# Authoring a workflow

A board declares its lifecycle in `.pi/kanban/workflow.yaml` (or `.yml`, or
`workflow.json`). Exactly one of those files may exist. A missing or invalid
workflow is an error for every mutation, but `/kanban` still lists tasks so the
problem is visible. `/kanban init` writes a starter file; edit it to fit the
project.

## Minimal workflow

```yaml
statuses: [new, done]
```

Pure shorthand treats every status as a plain column and makes **the last status
terminal**. Transitions are the adjacent pairs in both directions: `new ↔ done`.
Do not ship this for real work — it has no active status, so nothing is ever
claimed.

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

The same document as JSON in `workflow.json`:

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

- `active: true` marks a status where work is happening. Moving into it **claims**
  the task for the caller, and another handle cannot move or release the task
  while it sits there without `force`. Think of it as "someone is holding this".
- `terminal: true` marks finished work. Entering it clears the assignee, and a
  terminal task cannot be assigned until it is moved back.
- A status cannot be both `active` and `terminal`.
- A workflow with no active statuses is valid. Every task stays unassigned and
  coordination happens through explicit `kanban_assign` calls — useful for a
  read-only or human-owned board, but not for multi-agent claims.

Common shape: `new` and a queue status are non-active; the working statuses are
active; `done` is terminal. A `reviewing` status is usually `active` so the
reviewer holds the claim while reviewing. If review is a shared queue, leave it
non-active and let each reviewer claim it by moving it into their own active
status.

## Declared transitions

`transitions` maps each status id to the list of statuses reachable from it. A
move that is not declared fails. Declare both directions you want; the loader
does not add a reverse automatically when `transitions` is present.

If `transitions` is omitted, the **shorthand** applies: every adjacent pair gets
a two-way move and the last status becomes terminal. This is fine for a small
linear board and wrong for anything with a review loop — declare transitions
explicitly once the shape is not a straight line.

## Rules the loader enforces

An invalid workflow reports every problem it can find in one pass, which is what
`/kanban validate` prints. The rules:

- Status ids are unique and match `[A-Za-z0-9][A-Za-z0-9_-]*`.
- At least one status is `terminal: true`.
- The initial status cannot be terminal.
- A status cannot be both `active` and `terminal`.
- Every transition target must be a declared status.
- A status cannot transition to itself.
- Every non-terminal status needs at least one outgoing transition.
- When `transitions` is omitted, adjacent statuses get two-way moves and the last
  status becomes terminal (shorthand only).

## Evolving a workflow

Editing a workflow can leave existing tasks in a status the new file no longer
declares. Such a **drifted task** still lists, and `/kanban validate` reports it.
Because a drifted status has no declared edges, `kanban_move` skips the
transition check for it: any declared status is a legal target (the claim rule
still applies). That is the recovery path. Prefer adding a status and a
transition over renaming one, and move tasks out of a status before removing it.

`/kanban validate` is inspection only. It reports workflow errors, drifted tasks,
stale claims, an `id` that disagrees with its filename, and a counter that would
reuse an id; it does not rewrite the board.

The board's workflow is project state and belongs in version control alongside
`tasks/` and `counter.json`. A change to the workflow is a change every agent
will see.
