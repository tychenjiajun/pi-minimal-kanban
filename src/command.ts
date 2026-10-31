// ---------------------------------------------------------------------------
// `/kanban` — the extension's only UI.
//
//   /kanban                 the board
//   /kanban T-0007          one task in full
//   /kanban --all           expand terminal columns
//   /kanban --json          machine-readable board
//   /kanban init            create .pi/kanban/workflow.yaml
//   /kanban validate        report workflow drift and claim problems
//   /kanban status <id>     only tasks in one status
//   /kanban mine <handle>   only tasks assigned to a handle
//   /kanban release <id>    release a claim (the one mutating subcommand)
//
// Rendering is plain text sent to the transcript: scrollable, copyable, and it
// works in headless and RPC modes. `release` is the one exception; everything
// else only renders.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KanbanError } from "./errors.ts";
import { FILES, displayPath, resolveBoard, type BoardLocation } from "./paths.ts";
import {
  DEFAULT_STALE_CLAIM_MS,
  claimAgeMs,
  initBoard,
  parseStaleDuration,
  readBoard,
  readTask,
  detail,
  releaseTask,
  validateBoard,
} from "./store.ts";
import { formatAge, formatThreshold, renderBoard, renderTask, renderTaskRows } from "./render.ts";
import { workflowToJson } from "./workflow.ts";
import type { Task, ValidationProblem } from "./types.ts";

const USAGE = [
  "Usage  /kanban [task-id] [--all] [--json]",
  "       /kanban status <id> | mine <handle> | validate [--stale 24h]",
  "       /kanban release <task-id> [--yes] [--as <handle>]",
  "       /kanban init | help",
  "",
  "  Moving a task into an active (◆) status claims it for your handle; only",
  "  that handle can move or release it without force: true.",
  "  A terminal status releases the claim; a claim never expires on its own.",
  "  Handles are self-asserted names like coder-1; the board does not check",
  "  them. Start with kanban_list: it shows rev, status, and claim age.",
].join("\n");

interface ParsedArgs {
  flags: Set<string>;
  /** Flags that take a value, e.g. `--stale 24h` or `--as human`. */
  values: Map<string, string>;
  positional: string[];
}

const VALUED_FLAGS = new Set(["stale", "as"]);

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

    if (command === "release") {
      if (!argument) {
        say("Usage: /kanban release <task-id> [--yes] [--as <handle>]");
        return;
      }
      say(await renderRelease(location, argument, flags, values));
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

// ─── release ───────────────────────────────────────────────────────────────

function claimAgeForDisplay(task: Task): string | undefined {
  return task.active && task.assignee ? formatAge(task.claimAgeMs ?? 0) : undefined;
}

async function renderRelease(
  location: BoardLocation,
  id: string,
  flags: Set<string>,
  values: Map<string, string>,
): Promise<string> {
  const task = readTask(location, id);
  const known = task.status;
  const claimed = Boolean(task.assignee);
  const age = claimAgeForDisplay(task);

  // No claim: there is nothing to release. This is a refusal, not a prompt, so
  // it prints the real status: the drift marker belongs to the release result.
  if (!claimed) {
    return [`${task.id} has no claim to release.`, "", `  status  ${known}`, `  owner   -`].join("\n");
  }

  const operator = resolveOperator(values.get("as"));

  if (!flags.has("yes")) {
    // A confirmation, never a write. Applies to claims and plain assignments.
    const verb = task.active ? "claim" : "assignment";
    const lines = [`Release the ${verb} on ${task.id}?`, ""];
    lines.push(`  owner   @${task.assignee}`);
    if (task.active) {
      lines.push(`  claimed ${age ?? "0s"}`);
    } else {
      lines.push(`  since   ${task.updated}`);
    }
    lines.push(`  status  ${known}`, `  rev     ${task.rev}`);
    lines.push("", `This records an unassign by "${operator}" in the task history.`);
    lines.push(`Re-run with --yes to confirm:  /kanban release ${task.id} --yes`);
    return lines.join("\n");
  }

  const released = await releaseTask(location, { task: id, agent: operator });
  const nowStatus = released.drifted ? `${released.status} ⚠` : released.status;
  const wasAge = age ? `  ${age}` : "";
  return [
    `Released ${released.id}.`,
    "",
    `  was  @${task.assignee}${wasAge}  ${known}`,
    `  now  unassigned  ${nowStatus}  rev ${released.rev}`,
  ].join("\n");
}

/** `--as`, else `PI_KANBAN_HANDLE`, else `human`. */
function resolveOperator(explicit: string | undefined): string {
  const handle = explicit ?? process.env.PI_KANBAN_HANDLE ?? "human";
  const trimmed = handle.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new KanbanError(
      "invalid_handle",
      `Invalid operator handle "${handle}": use 1-64 characters from A-Z, a-z, 0-9, dot, underscore, or hyphen, starting with a letter or digit.`,
      "Pass --as <handle> or set PI_KANBAN_HANDLE.",
    );
  }
  return trimmed;
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

/** Argument completions: subcommands, then task ids. */
export function completeKanbanCommand(prefix: string): Array<{ label: string; description: string }> {
  const subcommands = [
    { label: "init", description: "Create .pi/kanban/workflow.yaml" },
    { label: "validate", description: "Check the workflow and task claims" },
    { label: "release", description: "Release a task's claim (writes)" },
    { label: "--all", description: "Expand terminal columns" },
    { label: "--json", description: "Print the board as JSON" },
    { label: "status", description: "Filter by status id" },
    { label: "mine", description: "Filter by assignee handle" },
  ];
  const needle = prefix.trim().toLowerCase();
  if (!needle) return subcommands;
  if (needle.startsWith("--")) return subcommands.filter((item) => item.label.startsWith(needle));
  return subcommands.filter((item) => item.label.startsWith(needle));
}

/** Used by tests and debugging: one line naming the board's root and dir. */
export function boardSummaryLine(location: BoardLocation): string {
  return `${location.root} (${location.dir})`;
}
