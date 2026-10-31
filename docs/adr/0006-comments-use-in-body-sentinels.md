# Comments are Markdown blocks delimited by sentinels

A comment lives in the task body, introduced by an invisible sentinel:

```md
<!-- kanban:comment at=2026-10-30T10:04:00Z by=reviewer -->
Please add a regression test.
```

The next sentinel or the end of the file ends the comment body.

A YAML `comments:` array would be mechanically simpler, but a chatty task would push its description below a wall of indented frontmatter. A sibling comments file would double the file count. Body sentinels keep the task readable top-to-bottom, keep the frontmatter small, and tolerate arbitrary Markdown (including headings) inside a comment without escaping rules.

## Consequences

The sentinel syntax is part of the durable file format, so it must be documented and covered by round-trip tests. A comment body must not contain a line that looks like a sentinel.
