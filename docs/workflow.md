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
