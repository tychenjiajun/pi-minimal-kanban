# Task IDs are sequential and never reused

A task is identified as `T-0001`, `T-0002`, … — allocated as one past the highest ID ever issued for that board, under the board lock.

The board is quoted in chat, in commit messages, and in cross-agent instructions, so an ID has to be short and sayable. A random or time-sortable ID would eliminate cross-branch collisions, but it would also make every reference ugly. Sequential IDs are worth the rare manual renumber when two branches create tasks independently.

## Consequences

IDs are never reused, even after a task file is deleted. Allocation must consult a counter that survives task deletion, not just the highest existing filename.

`/kanban repair-ids` repairs the two ways a merge can break that rule: it renames a task file to the id its frontmatter declares (never the reverse, which would discard an issued id), and it raises a `counter.json` that is not above the highest existing id — never lowers one. It takes the board lock and re-plans under it, so a printed plan is never applied blind.
