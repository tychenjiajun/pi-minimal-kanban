import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { KanbanError } from "./errors.ts";

/** Directory name inside the project root. */
export const BOARD_DIR_NAME = ".pi/kanban";

/** File names inside a board directory. */
export const FILES = {
  workflowYaml: "workflow.yaml",
  workflowYml: "workflow.yml",
  workflowJson: "workflow.json",
  config: "config.yaml",
  counter: "counter.json",
  lock: ".lock",
  tasks: "tasks",
} as const;

export const WORKFLOW_FILE_CANDIDATES = [FILES.workflowYaml, FILES.workflowYml, FILES.workflowJson] as const;

export interface BoardLocation {
  /** Absolute project root (the directory that owns `.pi/kanban`). */
  root: string;
  /** Absolute board directory. */
  dir: string;
  /** Absolute tasks directory. */
  tasksDir: string;
  /** How the root was found, for diagnostics and `/kanban` output. */
  source: "explicit" | "project-root" | "env";
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` looking for the nearest directory that contains either
 * `.git` or `.pi/kanban`. Returns undefined at the filesystem root.
 */
export function findProjectRoot(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (exists(join(current, ".git")) || isDirectory(join(current, BOARD_DIR_NAME))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface ResolveBoardOptions {
  /** Explicit path from a tool argument; may point at a project root or a board dir. */
  project?: string;
  /** Current working directory. */
  cwd: string;
  /** Environment lookup, injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the board for a call.
 *
 * Precedence:
 * 1. `project`, interpreted as a project root, or a board dir (contains a
 *    workflow file), or `.../.pi/kanban`.
 * 2. `PI_KANBAN_DIR` (a board directory).
 * 3. The nearest ancestor of `cwd` containing `.git` or `.pi/kanban`.
 * 4. `cwd` itself, so `/kanban init` can create a board in a fresh directory.
 */
export function resolveBoard(options: ResolveBoardOptions): BoardLocation {
  const env = options.env ?? process.env;

  if (options.project) {
    const raw = isAbsolute(options.project) ? options.project : resolve(options.cwd, options.project);
    if (!exists(raw)) {
      throw new KanbanError("io", `Project path does not exist: ${raw}`, "Pass a path to a project root or a board directory.");
    }
    return fromCandidate(raw, "explicit");
  }

  const fromEnv = env.PI_KANBAN_DIR;
  if (fromEnv && fromEnv.trim()) {
    const dir = isAbsolute(fromEnv) ? fromEnv : resolve(options.cwd, fromEnv);
    return fromCandidate(dir, "env", true);
  }

  const found = findProjectRoot(options.cwd);
  if (found) {
    return {
      root: found,
      dir: join(found, BOARD_DIR_NAME),
      tasksDir: join(found, BOARD_DIR_NAME, FILES.tasks),
      source: "project-root",
    };
  }

  return {
    root: resolve(options.cwd),
    dir: join(resolve(options.cwd), BOARD_DIR_NAME),
    tasksDir: join(resolve(options.cwd), BOARD_DIR_NAME, FILES.tasks),
    source: "project-root",
  };
}

/** Root that owns a board directory: strip `/.pi/kanban`, else the parent. */
function rootOfBoardDir(dir: string): string {
  const stripped = dir.replace(/[/\\]\.pi[/\\]kanban[/\\]?$/, "");
  return stripped === dir ? dirname(dir) : stripped;
}

function board(dir: string, source: BoardLocation["source"]): BoardLocation {
  const resolved = resolve(dir);
  return { root: rootOfBoardDir(resolved), dir: resolved, tasksDir: join(resolved, FILES.tasks), source };
}

function fromCandidate(candidate: string, source: BoardLocation["source"], isEnvDir = false): BoardLocation {
  const resolved = resolve(candidate);

  // PI_KANBAN_DIR always names the board directory itself.
  if (isEnvDir) return board(resolved, source);

  // An explicit argument may name a board dir (it has a workflow) or end in
  // `.pi/kanban`; anything else is treated as a project root.
  const looksLikeBoard =
    /[/\\]\.pi[/\\]kanban[/\\]?$/.test(resolved) ||
    (isDirectory(resolved) && WORKFLOW_FILE_CANDIDATES.some((name) => exists(join(resolved, name))));
  if (looksLikeBoard) return board(resolved, source);

  const nested = join(resolved, BOARD_DIR_NAME);
  return { root: resolved, dir: nested, tasksDir: join(nested, FILES.tasks), source };
}

/** The `cwd`-relative display form used in `/kanban` output. */
export function displayPath(path: string, cwd: string): string {
  const rel = path.startsWith(cwd) ? path.slice(cwd.length) : path;
  return rel.replace(/^[/\\]/, "") || ".";
}
