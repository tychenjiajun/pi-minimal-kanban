import { Document, parse as parseYaml, parseDocument } from "yaml";
import { KanbanError } from "./errors.ts";

/** Sentinels delimit comments in the task body. See ADR 0006. */
const SENTINEL = /^<!--\s*kanban:comment\s+at=(\S+)\s+by=(\S+)\s*-->\s*$/;

export interface CommentBlock {
  at: string;
  by: string;
  body: string;
}

export interface ParsedTaskFile {
  /** Every frontmatter key, including ones this version does not know. */
  frontmatter: Record<string, unknown>;
  description: string;
  comments: CommentBlock[];
  /** Raw frontmatter text, kept so untouched files round-trip byte for byte. */
  rawFrontmatter?: string;
}

export interface TaskFileInput {
  frontmatter: Record<string, unknown>;
  description: string;
  comments: CommentBlock[];
}

/**
 * Split a task file into YAML frontmatter and body. Throws when the file is
 * not a kanban task (so a hand-written file fails with a readable message).
 */
export function parseTaskFile(text: string, path: string): ParsedTaskFile {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new KanbanError("invalid_task", `${path} does not start with YAML frontmatter.`, "Restore the `---` block at the top of the task file.");
  }

  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    throw new KanbanError("invalid_task", `${path} has frontmatter with no closing "---".`, "Close the frontmatter block.");
  }

  const rawFrontmatter = normalized.slice(4, end + 1);
  const body = normalized.slice(end + 4).replace(/^\n/, "");

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(rawFrontmatter);
  } catch (error) {
    throw new KanbanError(
      "invalid_task",
      `${path} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the frontmatter syntax.",
    );
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new KanbanError("invalid_task", `${path} frontmatter must be a YAML object.`, "Use `key: value` pairs.");
  }

  const { description, comments } = splitComments(body);
  return { frontmatter: frontmatter as Record<string, unknown>, description, comments, rawFrontmatter };
}

/** Split a body into the description and comment blocks. */
export function splitComments(body: string): { description: string; comments: CommentBlock[] } {
  const lines = body.split("\n");
  const firstSentinel = lines.findIndex((line) => SENTINEL.test(line.trim()));
  const descriptionEnd = firstSentinel === -1 ? lines.length : firstSentinel;
  return {
    description: trimBlock(lines.slice(0, descriptionEnd).join("\n")),
    comments: collectComments(lines, firstSentinel === -1 ? lines.length : firstSentinel),
  };
}

function collectComments(lines: string[], start = 0): CommentBlock[] {
  const comments: CommentBlock[] = [];
  let i = start;
  while (i < lines.length) {
    const match = SENTINEL.exec(lines[i].trim());
    if (!match) {
      i += 1;
      continue;
    }
    const [, at, by] = match;
    const collected: string[] = [];
    i += 1;
    while (i < lines.length && !SENTINEL.test(lines[i].trim())) {
      collected.push(lines[i]);
      i += 1;
    }
    comments.push({ at, by, body: trimBlock(collected.join("\n")) });
  }
  return comments;
}

function trimBlock(text: string): string {
  return text.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** Serialize a task file. Unknown frontmatter keys are preserved verbatim. */
export function serializeTaskFile(input: TaskFileInput, existingRaw?: string): string {
  const frontmatter = serializeFrontmatter(input.frontmatter, existingRaw);
  const parts = [`---\n${frontmatter}\n---`, ""];
  const description = trimBlock(input.description);
  if (description) parts.push(description, "");

  for (const comment of input.comments) {
    parts.push(`<!-- kanban:comment at=${comment.at} by=${comment.by} -->`);
    parts.push(comment.body);
    parts.push("");
  }

  return parts.join("\n").replace(/\n+$/, "\n");
}

/**
 * Rewrite known keys through a YAML Document so comments, quoting, and unknown
 * keys survive. Falls back to plain stringification when the raw text is gone.
 */
function serializeFrontmatter(frontmatter: Record<string, unknown>, existingRaw?: string): string {
  const known = ["id", "title", "status", "assignee", "created", "updated", "rev", "history"];
  if (existingRaw) {
    try {
      const doc = parseDocument(existingRaw);
      for (const [key, value] of Object.entries(frontmatter)) {
        doc.set(key, value);
      }
      // Only remove keys this extension owns; hand-added keys stay put.
      for (const key of known) {
        if (!(key in frontmatter)) doc.delete(key);
      }
      return doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
    } catch {
      /* fall through to plain serialization */
    }
  }
  const doc = new Document(frontmatter);
  return doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
}

/** The canonical file name for a task ID. */
export function taskFileName(id: string): string {
  return `${id}.md`;
}

/** Validate a task ID's shape (not its existence). */
export function isTaskId(value: string): boolean {
  return /^T-\d{4,}$/.test(value);
}
