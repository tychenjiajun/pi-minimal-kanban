# Workflows are declared, and a missing workflow is an error

Every project declares its own workflow in a YAML or JSON file. The extension never invents statuses, never guesses transitions, and never falls back to a built-in board.

The whole reason a project-specific workflow exists is that projects genuinely differ: some have two statuses, some have seven. A silent default would let agents move work through a lifecycle nobody agreed on, and would hide a missing workflow file until the board was already wrong. A missing workflow therefore fails loudly, and `/kanban init` writes a commented template instead.

## Consequences

`/kanban` must remain readable for a project whose workflow file is broken or absent, so that the failure is diagnosable from inside Pi.
