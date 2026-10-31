# One Markdown file per task, with YAML frontmatter

Each task is a Markdown file named after its task ID: structured fields (status, assignee, timestamps, history) live in YAML frontmatter and the description is the document body.

Tasks are read and written by agents and reviewed by humans in the same medium, so the file must be pleasant to read and diffable. One file per task keeps a write limited to the task being changed and limits a merge conflict to the task both sides touched.

## Considered Options

- **One JSON file per task**: machine-clean, but unreadable in a diff and hostile to hand editing.
- **A single `board.json`**: every edit rewrites the whole board, so unrelated tasks conflict on merge.

## Consequences

The extension owns frontmatter round-tripping: unknown keys must be preserved, not dropped, on rewrite. Hand edits can violate board invariants, so status and assignment changes are documented as tool-only operations.
