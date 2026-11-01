// ---------------------------------------------------------------------------
// `/kanban` — the extension's only UI, and it only reads.
//
//   /kanban                 the board
//   /kanban T-0007          one task in full
//   /kanban --all           expand terminal columns
//   /kanban --json          machine-readable board
//   /kanban init            create .pi/kanban/workflow.yaml
//   /kanban validate        report workflow drift and claim problems
//   /kanban status <id>     only tasks in one status
//   /kanban mine <handle>   only tasks assigned to a handle
//
// Rendering is plain text sent to the transcript: scrollable, copyable, and it
// works in headless and RPC modes. Every subcommand renders; board writes
// belong to the five tools (kanban_create, kanban_move, kanban_comment,
// kanban_assign, kanban_list), so `/kanban` can never mutate board state.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KanbanError } from "./errors.ts";
import { FILES, displayPath, resolveBoard, type BoardLocation } from "./paths.ts";
import {
  DEFAULT_STALE_CLAIM_MS,
  initBoard,
  parseStaleDuration,
  readBoard,
  readTask,
  detail,
  validateBoard,
} from "./store.ts";
import { formatThreshold, renderBoard, renderTask, renderTaskRows, truncate } from "./render.ts";
import { workflowToJson } from "./workflow.ts";
import type { Task, ValidationProblem } from "./types.ts";

export const USAGE = [
  "Usage  /kanban [task-id] [--all] [--json]",
  "       /kanban status <id> | mine <handle> | validate [--stale 24h]",
  "       /kanban init | help",
  "",
  "  Moving a task into an active (◆) status claims it for your handle; only",
  "  that handle can move it, or clear the claim, without force: true.",
  "  A terminal status releases the claim; a claim never expires on its own.",
  "  Handles are self-asserted names like coder-1; the board does not check",
  "  them. Assigning a task to another handle needs force: true as well.",
  "  This command only reads: to change the board, call the kanban_* tools",
  "  (kanban_assign with assignee: null and force: true clears a claim).",
  "  Start with kanban_list: it shows rev, status, and claim age.",
  "  Completions use this session's board and list task ids and handles;",
  "  with no board they complete only the subcommands.",
].join("\n");

interface ParsedArgs {
  flags: Set<string>;
  /** Flags that take a value, e.g. `--stale 24h`. */
  values: Map<string, string>;
  positional: string[];
}

const VALUED_FLAGS = new Set(["stale"]);

function parseArgs(input: string): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (VALUED_FLAGS.has(name)) {
      const next = tokens[i + 1];
      // A value is required; a following flag means it was omitted.
      if (next && !next.startsWith("--")) {
        values.set(name, next);
        i += 1;
      } else {
        values.set(name, "");
      }
      continue;
    }
    flags.add(name);
  }
  return { flags, values, positional };
}

/** `/kanban` handler. Exported so tests can drive it without a TUI. */
export async function handleKanbanCommand(input: string, ctx: ExtensionCommandContext): Promise<void> {
  const say = (message: string) => {
    ctx.ui.notify(message, "info");
  };

  const { flags, values, positional } = parseArgs(input);
  if (flags.has("help") || positional[0] === "help") {
    say(USAGE);
    return;
  }

  const location = resolveBoard({ cwd: ctx.cwd });
  const [command, argument] = positional;

  try {
    if (command === "init") {
      const result = await initBoard(location);
      say(
        result.created
          ? `Board initialized.\n  ${result.workflowPath}\n\nEdit the workflow to declare your own statuses, then create a task with kanban_create.`
          : `Board already has a workflow:\n  ${result.workflowPath}`,
      );
      return;
    }

    if (command === "validate") {
      const staleAfterMs = resolveStaleAfter(values.get("stale"), process.env);
      const report = validateBoard(location, { staleAfterMs });
      say(renderValidationReport(report, ctx.cwd));
      return;
    }

    if (!existsSync(join(location.dir, FILES.tasks)) && !existsSync(location.dir)) {
      say(`No board here.\n  ${location.dir}\n\nRun /kanban init to create one.`);
      return;
    }

    const board = readBoard(location);

    if (flags.has("json")) {
      const payload = {
        root: board.root,
        dir: displayPath(board.dir, ctx.cwd),
        workflow: board.workflow ? workflowToJson(board.workflow) : null,
        workflowErrors: board.workflowErrors,
        fileErrors: board.fileErrors,
        tasks: board.tasks.map((task) => (detail(task) as ReturnType<typeof detail>)),
      };
      say(JSON.stringify(payload, null, 2));
      return;
    }

    if (command === "status") {
      if (!argument) {
        say("Usage: /kanban status <status-id>");
        return;
      }
      const tasks = board.tasks.filter((task) => task.status === argument);
      say(renderTaskList(tasks, `Status: ${argument}`, { showStatus: false }));
      return;
    }

    if (command === "mine") {
      if (!argument) {
        say("Usage: /kanban mine <handle>");
        return;
      }
      const tasks = board.tasks.filter((task) => task.assignee === argument);
      say(renderTaskList(tasks, `Assigned to ${argument}`, { showStatus: true }));
      return;
    }

    if (command) {
      const task = readTask(location, command);
      say(renderTask(task, board.workflow));
      return;
    }

    say(renderBoard(board, { all: flags.has("all") }));
  } catch (error) {
    if (error instanceof KanbanError) {
      const hint =
        error.details.code === "invalid_argument" || !error.details.hint ? "" : `\n\n${error.details.hint}`;
      say(`${error.message}${hint}`);
      return;
    }
    say(`Kanban failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── validate ──────────────────────────────────────────────────────────────

/** `--stale` wins over `PI_KANBAN_STALE_MS`; both default to 24h. */
function resolveStaleAfter(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  if (flag !== undefined) {
    if (flag === "") {
      throw new KanbanError(
        "invalid_task",
        `Invalid --stale ""; use 30m, 12h, 7d, or 0.`,
        "Pass a duration such as --stale 24h, or 0 to disable the check.",
      );
    }
    return parseStaleDuration(flag);
  }
  const raw = env.PI_KANBAN_STALE_MS ?? env.PI_KANBAN_STALE_CLAIM_MS;
  if (raw !== undefined && raw.trim() !== "") return parseStaleDuration(raw);
  return DEFAULT_STALE_CLAIM_MS;
}

/** Wrap a validate line at 76 columns with a 12-space continuation indent. */
function wrapValidate(prefix: string, message: string): string[] {
  const width = 76;
  const contIndent = 12;
  const words = message.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = prefix.trimEnd();
  for (const word of words) {
    if (`${line} ${word}`.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = `${" ".repeat(contIndent)}${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * `/kanban validate` output. Warnings (`stale_claim`) never flip `ok`; when the
 * only finding is a warning the header says `Board is valid (N warnings).`
 */
export function renderValidationReport(
  report: ReturnType<typeof validateBoard>,
  cwd: string,
): string {
  const warnings = report.problems.filter((problem) => problem.severity === "warning");
  const problems = report.problems.filter((problem) => problem.severity === "problem");
  const hardFailure = !report.ok;

  const header = hardFailure
    ? "Board has problems."
    : warnings.length > 0
      ? `Board is valid (${warnings.length} warning${warnings.length === 1 ? "" : "s"}).`
      : "Board is valid.";
  const lines = [header, `  ${displayPath(report.dir, cwd)}`];

  if (report.workflowErrors.length > 0) {
    lines.push("", "Workflow:");
    for (const error of report.workflowErrors) lines.push(`  ⚠ ${error}`);
  }

  const renderProblem = (problem: ValidationProblem): string[] => {
    const who = problem.task ?? "-";
    const first = `  ⚠ ${who}  ${problem.code}: `;
    const out = wrapValidate(first, problem.message);
    if (problem.path) out.push(`${" ".repeat(12)}${displayPath(problem.path, cwd)}`);
    return out;
  };

  // Order: hard problems first (drifted, terminal_assigned, unreadable, counter),
  // then warnings, so a stale claim reads as advisory rather than fatal.
  if (problems.length > 0) {
    lines.push("", "Tasks:");
    for (const problem of problems) lines.push(...renderProblem(problem));
  }
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(...renderProblem(warning));
  }

  return lines.join("\n");
}

// ─── lists ─────────────────────────────────────────────────────────────────
/**
 * `/kanban status` shows one status, so its rows carry no status cell: the
 * heading already says it. `/kanban mine` shows every status, so it prints the
 * status cell. Both use the §2 row layout, so `rev` and the claim age are
 * present and the ` ⚠` marker lands inside the status column.
 */
function renderTaskList(tasks: Task[], heading: string, options: { showStatus: boolean }): string {
  const lines = [heading, ""];
  if (tasks.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  lines.push(...renderTaskRows(tasks, { indent: 2, showStatus: options.showStatus }));
  return lines.join("\n");
}

// ─── completions ───────────────────────────────────────────────────────────

const MAX_COMPLETION_TASKS = 20;
const MAX_COMPLETION_HANDLES = 10;
/** A task's description is `<status> ⚠ · <title>`, title cut to fit this. */
const COMPLETION_DESCRIPTION_WIDTH = 64;

const SUBCOMMANDS = [
  { label: "init", description: "Create .pi/kanban/workflow.yaml" },
  { label: "validate", description: "Check the workflow and task claims" },
  { label: "--all", description: "Expand terminal columns" },
  { label: "--json", description: "Print the board as JSON" },
  { label: "status", description: "Filter by status id" },
  { label: "mine", description: "Filter by assignee handle" },
];

type CompletionItem = { label: string; description: string };

function completionTaskItem(task: Task): CompletionItem {
  const status = task.drifted ? `${task.status} ⚠` : task.status;
  const description = truncate(`${status} · ${task.title}`, COMPLETION_DESCRIPTION_WIDTH);
  return { label: task.id, description };
}

/**
 * Handles seen as a current assignee or anywhere in history, case-insensitively
 * deduplicated (first occurrence wins, scanning tasks by id and, per task,
 * `assignee`, then each entry's `by`, then its `assignee`), alphabetical. The
 * description counts the tasks the handle currently holds.
 */
function completionHandleItems(tasks: Task[]): CompletionItem[] {
  const counts = new Map<string, { label: string; count: number }>();
  const remember = (handle: string | undefined) => {
    if (!handle) return;
    const key = handle.toLowerCase();
    if (!counts.has(key)) counts.set(key, { label: handle, count: 0 });
  };

  for (const task of tasks) {
    remember(task.assignee);
    for (const entry of task.history) {
      remember(entry.by);
      remember(entry.assignee);
    }
  }
  for (const task of tasks) {
    if (!task.assignee) continue;
    const entry = counts.get(task.assignee.toLowerCase());
    if (entry) entry.count += 1;
  }

  return [...counts.values()]
    .sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0))
    .map(({ label, count }) => ({ label, description: `${count} task${count === 1 ? "" : "s"}` }));
}

/**
 * Argument completions for `/kanban`: subcommands, then task ids, then handles.
 *
 * `board` is the location `src/index.ts` cached for this session, because
 * `getArgumentCompletions` receives no `cwd` and no context. Passing it keeps
 * this function pure and testable; the caller owns the cache.
 *
 * A completion never throws, never writes, never takes the board lock, and
 * never returns an empty list: with no board (or an unreadable one) it falls
 * back to the subcommands. Task files that fail to parse are dropped silently.
 */
export function completeKanbanCommand(prefix: string, board?: BoardLocation): CompletionItem[] {
  const needle = prefix.trim().toLowerCase();
  // A leading `@` is how an agent types a handle, but the handler stores and
  // compares bare handles, so the search drops it and looks at handles only.
  const handleOnly = needle.startsWith("@");
  const search = handleOnly ? needle.slice(1) : needle;
  const matches = (item: CompletionItem) => item.label.toLowerCase().startsWith(search);

  const subcommands = handleOnly ? [] : SUBCOMMANDS.filter(matches);
  // At most 500 task files are consulted; a larger board completes on the
  // first 500 by id, which is a stated bound rather than an error.
  const scanned = readTasksForCompletions(board).slice(0, 500);
  const taskItems = handleOnly ? [] : scanned.map(completionTaskItem).filter(matches).slice(0, MAX_COMPLETION_TASKS);
  const handleItems = completionHandleItems(scanned).filter(matches).slice(0, MAX_COMPLETION_HANDLES);

  const items = [...subcommands, ...taskItems, ...handleItems];
  return items.length > 0 ? items : SUBCOMMANDS;
}

/** The readable tasks on the board, or none: one try/catch, no lock, no throw. */
function readTasksForCompletions(board: BoardLocation | undefined): Task[] {
  if (!board) return [];
  try {
    return readBoard(board).tasks;
  } catch {
    return [];
  }
}

/** Used by tests and debugging: one line naming the board's root and dir. */
export function boardSummaryLine(location: BoardLocation): string {
  return `${location.root} (${location.dir})`;
}
