---
name: kanban-setup
description: Set up or repair the file-backed Kanban board for a project by authoring .pi/kanban/workflow.yaml. Use when a project needs its first board, when choosing statuses and transitions for how work actually flows, when bootstrap or repair a workflow, or when kanban calls fail because the workflow is missing or invalid.
---

# Set up a project board

The board is four paths under `.pi/kanban/`: `workflow.yaml` (or `.yml`/`.json`),
`counter.json`, `tasks/`, and the transient `.lock/`. You create the first three
with ordinary file tools; the kanban tools own the rest. There is no setup
command to invoke and you cannot run the human `/kanban` command — write the
files yourself.

## 1. Look before writing

Check for `.pi/kanban/workflow.yaml`, `.yml`, and `.json`; exactly one may exist.
If one does, this is an evolution, not a reset. Read it and the existing tasks
first: a status the new file drops orphans those tasks, and
`../kanban/references/workflow-authoring.md` explains the recovery path. If none
exists, create `.pi/kanban/workflow.yaml` and `.pi/kanban/tasks/`. Leave
`counter.json` absent; the first `kanban_create` writes it.

## 2. Shape the lifecycle to the project

Inspect the repo — language, test runner, and whether review or CI is a separate
step — and choose the fewest statuses that model how work flows here. Read
`../kanban/references/workflow-authoring.md` before writing; it is the rule set
the loader enforces. In particular:

- Ids match `[A-Za-z0-9][A-Za-z0-9_-]*`; at least one status is `terminal: true`;
  the initial status is not terminal; no status is both `active` and `terminal`.
- A status is `active: true` where work is held as a claim, and `terminal: true`
  at the finish line. Most real boards have `new` (non-active), one or more
  active working/review statuses, and a terminal `done`.
- Declare `transitions` for every edge you want; when you do, both directions
  must be written, and every target must be declared. Omit `transitions` only
  for a straight linear board.

Keep it minimal and let the team extend it. Prefer adding a status and a
transition over renaming one.

## 3. Check your own work

A missing terminal status, a dangling transition target, or a self-transition
makes every kanban call fail. Re-read the file and walk the rules above, then
call `kanban_list {}`: a clean board lists, and a broken workflow errors with the
reason. Fix what it names and repeat until it lists. Existing tasks in a dropped
status still list as drifted; move them out rather than renaming.

## 4. Commit the board

`.pi/kanban/workflow.yaml`, `counter.json`, and `tasks/` are project state. Stage
them so the workflow is a reviewed change every agent will see. Then say, in a
few lines, the statuses, which are `active`, which is `terminal`, and why they
fit this project. Do not create tasks; this is board setup, not work.
