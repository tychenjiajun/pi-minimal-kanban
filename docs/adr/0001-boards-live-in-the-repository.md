# Boards live in the repository they describe

A board is stored at `<project-root>/.pi/kanban/`, where the project root is the nearest ancestor containing `.git`, or an existing `.pi/kanban/`, or the directory named by `PI_KANBAN_DIR`. Board files are committed to git.

The board exists so that several agents — humans watching them — agree on the same work. That requires the board to travel with the code, to be reviewable in a diff, and to survive a fresh clone. The accepted cost is that each git worktree carries its own copy of the board, so agents working in separate worktrees do not share claims.

## Considered Options

- **Per-directory boards** (`<cwd>/.pi/kanban/`): a nested checkout silently forks the board.
- **An explicit project path on every call**: pushes a routing concern onto every agent and every prompt.
