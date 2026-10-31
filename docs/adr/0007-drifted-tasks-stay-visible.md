# Drifted tasks stay visible and are recoverable

If the workflow stops declaring a status that an existing task uses, that task is shown as drifted rather than making the board unreadable. Reads still list it, with its raw status; `kanban_move` may move it out to any declared status, but no task may be moved *into* an undeclared status.

Boards and workflows are hand-editable, so a workflow edit must never be able to brick the board. The strict alternative — fail every read and write until a human repairs the data — turns a typo in `workflow.yaml` into a full stop, and gives no in-product way to see what broke.

## Consequences

`/kanban` and `kanban_list` must label drifted tasks distinctly. `/kanban validate` reports them. A missing or syntactically invalid workflow is still a hard error for operations that need transitions.

## Unreadable task files

The same rule applies to a task file that cannot be parsed: it is excluded from
the board and reported, rather than blanking every other task. `readBoard`
returns the readable tasks plus `fileErrors: [{ path, message }]`; `kanban_list`
prints a warning block and repeats the list in `structuredContent.fileErrors`;
`/kanban` lists the readable columns and names the bad files:
`/kanban validate` reports each one as `unreadable_task` (an `id` disagreement
keeps its `id_mismatch` code). Reading that one task by id
(`kanban_list {task: "T-0002"}`) still fails with the parse error, because the
caller asked for a file that cannot be read.
