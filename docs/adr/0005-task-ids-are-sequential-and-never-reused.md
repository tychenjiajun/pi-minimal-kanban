# Task IDs are sequential and never reused

A task is identified as `T-0001`, `T-0002`, … — allocated as one past the highest ID ever issued for that board, under the board lock.

The board is quoted in chat, in commit messages, and in cross-agent instructions, so an ID has to be short and sayable. A random or time-sortable ID would eliminate cross-branch collisions, but it would also make every reference ugly. Sequential IDs are worth the rare manual renumber when two branches create tasks independently.

## Consequences

IDs are never reused, even after a task file is deleted. Allocation must consult a counter that survives task deletion, not just the highest existing filename.
