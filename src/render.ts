import { basename } from "node:path";
import type { BoardSnapshot, FileError, StatusDef, Task, Workflow } from "./types.ts";
import { displayPath } from "./paths.ts";

/** Everything `/kanban` and the tools need to print a board. */
export interface RenderOptions {
  /** Include terminal columns expanded instead of collapsed. */
  all?: boolean;
  /** Prefix paths with the project root's basename, for multi-project output. */
  showRoot?: boolean;
  /** Width used for alignment; defaults to 76. */
  width?: number;
}

const DEFAULT_WIDTH = 76;
const MIN_TITLE_WIDTH = 15;
const MAX_STATUS_WIDTH = 16;
const MAX_META_WIDTH = 17;
const MAX_REV_WIDTH = 6;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // No dangling space before the dots: it reads as a gap, not as a cut.
  return `${text.slice(0, Math.max(0, limit - 3)).replace(/ +$/, "")}...`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/**
 * Format a claim age from `design-v0.2.md` §0.1: `45s`, `5m`, `1h`, `1d`,
 * `2w`. Floored at zero and never zero-padded.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * Format a stale-claim threshold. Kept in hours below a week so the default
 * reads `24h` rather than `1d` (design §4).
 */
export function formatThreshold(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Warnings for task files that could not be read. `mode` lets each surface
 * choose how much to print: the board and `/kanban validate` show the files,
 * while `kanban_list` keeps the short warning and its `fileErrors` field.
 */
export function renderFileErrors(
  errors: FileError[],
  options: { mode?: "both" | "summary" | "detail"; cwd: string; indent?: string } = { cwd: "" },
): string[] {
  if (errors.length === 0) return [];
  const mode = options.mode ?? "both";
  const indent = options.indent ?? "  ";
  const lines: string[] = [];
  if (mode !== "detail") {
    lines.push(
      `⚠ ${errors.length} task file${errors.length === 1 ? "" : "s"} could not be read; the board shows the rest.`,
    );
  }
  if (mode !== "summary") {
    for (const error of errors) {
      lines.push(`${indent}${displayPath(error.path, options.cwd)}  ${error.message}`);
    }
  }
  return lines;
}

/**
 * Render the board as plain text.
 *
 * Non-terminal columns come first, in workflow order; terminal columns collapse
 * to a count unless `all` is set. Drifted tasks (a status the workflow no longer
 * declares) are grouped under a warning heading so they are visible but cannot
 * be mistaken for a real column.
 */
export function renderBoard(board: BoardSnapshot, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const lines: string[] = [];
  const workflow = board.workflow;

  const rootLabel = options.showRoot ? `${basename(board.root)}  ` : "";
  lines.push(`${rootLabel}${board.dir}`);
  lines.push("");

  if (board.workflowErrors.length > 0) {
    lines.push("⚠ Workflow problem");
    for (const error of board.workflowErrors) lines.push(`  ${error}`);
    lines.push("");
  }

  // Unreadable task files must never hide the readable board.
  const fileWarning = renderFileErrors(board.fileErrors, { mode: "summary", cwd: board.dir });
  if (fileWarning.length > 0) {
    lines.push(...fileWarning);
    lines.push("");
  }

  if (!workflow) {
    const counts = countByStatus(board.tasks);
    lines.push(`${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"} (statuses unvalidated)`);
    for (const [status, tasks] of counts) {
      lines.push(`  ${status}: ${tasks.length}`);
    }
    appendFileErrorDetail(lines, board.fileErrors, board.dir);
    return lines.join("\n").replace(/\n+$/, "");
  }

  const byStatus = groupByStatus(board.tasks);
  const declared = new Set(workflow.statuses.map((status) => status.id));
  const openStatuses = workflow.statuses.filter((status) => !status.terminal);
  const terminalStatuses = workflow.statuses.filter((status) => status.terminal);
  const drilled = board.tasks.filter((task) => !declared.has(task.status));

  for (const status of openStatuses) {
    lines.push(...renderColumn(status, byStatus.get(status.id) ?? [], width));
  }

  for (const status of terminalStatuses) {
    const tasks = byStatus.get(status.id) ?? [];
    if (options.all) {
      lines.push(...renderColumn(status, tasks, width));
    } else {
      lines.push(`  ${status.label} ${"·".repeat(Math.max(2, width - status.label.length - 12))} ${tasks.length}`);
    }
  }

  if (drilled.length > 0) {
    lines.push("");
    lines.push(`  ⚠ Drifted tasks (status not in workflow: ${drilled.length})`);
    // Same row shape as everywhere else, and the raw status id stays visible
    // inside the status cell with the ` ⚠` drift marker (design §2).
    lines.push(...renderTaskRows(drilled, { width, indent: 4, showStatus: true }));
  }

  lines.push("");
  lines.push(`  ${summaryLine(board, workflow)}`);
  appendFileErrorDetail(lines, board.fileErrors, board.dir);
  return lines.join("\n").replace(/\n+$/, "");
}

/** Detail for unreadable task files, placed under the board so tasks stay on top. */
function appendFileErrorDetail(lines: string[], errors: FileError[], cwd: string): void {
  const detail = renderFileErrors(errors, { mode: "detail", cwd });
  if (detail.length === 0) return;
  lines.push("", "⚠ Unreadable task files", ...detail);
}

function summaryLine(board: BoardSnapshot, workflow: Workflow): string {
  const total = board.tasks.length;
  const claimed = board.tasks.filter((task) => task.assignee).length;
  const terminal = board.tasks.filter((task) => workflow.byId.get(task.status)?.terminal).length;
  const open = total - terminal;
  const parts = [`${total} task${total === 1 ? "" : "s"}`, `${open} open`, `${terminal} done`];
  if (claimed > 0) parts.push(`${claimed} claimed`);
  return parts.join(" · ");
}

function renderColumn(status: StatusDef, tasks: Task[], width: number): string[] {
  const lines: string[] = [];
  const marker = status.active ? "◆" : "◇";
  const heading = `${marker} ${status.label}`;
  const count = tasks.length === 0 ? "0" : String(tasks.length);
  const rule = "─".repeat(Math.max(2, width - heading.length - count.length - 4));
  lines.push(`  ${heading} ${rule} ${count}`);

  if (tasks.length === 0) {
    lines.push("    (empty)");
    lines.push("");
    return lines;
  }

  lines.push(...renderTaskRows(tasks, { width, indent: 4, showStatus: false }));
  lines.push("");
  return lines;
}

function groupByStatus(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const list = map.get(task.status) ?? [];
    list.push(task);
    map.set(task.status, list);
  }
  return map;
}

function countByStatus(tasks: Task[]): Map<string, Task[]> {
  return groupByStatus(tasks);
}

/**
 * Render one task: frontmatter-derived facts, description, history, comments.
 * Deliberately read-only; editing goes through the tools.
 */
export function renderTask(task: Task, workflow: Workflow | null, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const lines: string[] = [];

  const status = workflow?.byId.get(task.status);
  const statusLabel = status ? status.label : `${task.status} ⚠ not in workflow`;

  lines.push(`${task.id}  ${task.title}`);
  lines.push("");
  lines.push(`  status    ${statusLabel}`);
  lines.push(`  assignee  ${assigneeLine(task)}`);
  lines.push(`  created   ${task.created}`);
  lines.push(`  updated   ${task.updated}  (rev ${task.rev})`);
  lines.push(`  file      ${task.path}`);

  if (workflow) {
    const allowed = workflow.statuses
      .filter((candidate) => workflow.transitions.get(task.status)?.has(candidate.id))
      .map((candidate) => candidate.id);
    lines.push(`  next      ${allowed.length > 0 ? allowed.join(", ") : "-"}`);
  }

  if (task.description.trim()) {
    lines.push("");
    lines.push("  Description");
    for (const line of wrap(task.description.trim(), width - 4)) lines.push(`    ${line}`);
  }

  if (task.history.length > 0) {
    lines.push("");
    lines.push("  History");
    for (const entry of task.history) {
      const when = entry.at.replace("T", " ").replace(/\.\d+Z$/, "Z");
      const who = entry.by ? ` @${entry.by}` : "";
      const detail =
        entry.action === "move"
          ? ` ${entry.from} → ${entry.to}`
          : entry.action === "assign"
            ? ` ${entry.assignee ?? ""}`
            : entry.action === "force-assign"
              ? ` ${entry.assignee ?? ""} (forced)`
              : entry.action === "unassign"
                ? ` ${entry.assignee ?? ""}`
                : ` ${entry.to ?? ""}`;
      lines.push(`    ${when}${who}  ${entry.action}${detail}`.replace(/\s+$/, ""));
    }
  }

  if (task.comments.length > 0) {
    lines.push("");
    lines.push(`  Comments (${task.comments.length})`);
    for (const comment of task.comments) {
      lines.push(`    ── ${comment.at} @${comment.by}`);
      for (const line of wrap(comment.body.trim(), width - 6)) lines.push(`       ${line}`);
    }
  }

  return lines.join("\n").replace(/\n+$/, "");
}

/** `coder-1  (claimed 3d)` for a claim; the bare handle for an assignment; `-` when unassigned. */
function assigneeLine(task: Task): string {
  if (!task.assignee) return "-";
  if (!task.active) return task.assignee;
  return `${task.assignee}  (claimed ${formatAge(task.claimAgeMs ?? 0)})`;
}

/** Wrap text on spaces, preserving explicit line breaks. */
function wrap(text: string, width: number): string[] {
  const limit = Math.max(20, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= limit) {
      out.push(raw);
      continue;
    }
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if (`${line} ${word}`.length <= limit) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Append the block `kanban_list` returns so an agent with only that tool can
 * still plan a legal move. The block's size depends on the workflow, never on
 * the number of tasks on the board.
 */
export function renderWorkflowBlock(workflow: Workflow | null): string[] {
  if (!workflow) return [];
  const lines: string[] = [];
  lines.push(`Workflow: ${workflow.name ?? "(unnamed)"}  initial=${workflow.initial}`);
  for (const status of workflow.statuses) {
    const flags = [status.active ? "active" : "", status.terminal ? "terminal" : ""].filter(Boolean);
    const next = workflow.statuses
      .filter((candidate) => workflow.transitions.get(status.id)?.has(candidate.id))
      .map((candidate) => candidate.id);
    const suffix = next.length > 0 ? ` -> ${next.join(", ")}` : " (no outgoing)";
    lines.push(`  ${status.id}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}${suffix}`);
  }
  return lines;
}

/** Compact one-line task summary used by `kanban_list` and tests. */
export function renderTaskLine(task: Task): string {
  return renderTaskRows([task])[0];
}

export interface TaskRowOptions {
  /** Render width; defaults to 76. */
  width?: number;
  /** Left margin in spaces: 0 for `kanban_list`, 4 inside a `/kanban` column. */
  indent?: number;
  /** Print the status cell; `/kanban` columns carry the status in the heading. */
  showStatus?: boolean;
}

/**
 * The one task-row layout, shared by `kanban_list` and `/kanban` columns:
 *
 *   indent + id + "  " + [status + "  "] + title + "  " + meta + "  " + rev
 *
 * Column widths are computed across the whole result set so `rev` lines up.
 * Title and status truncation uses three ASCII dots, never an ellipsis
 * character. Trailing spaces are stripped from every row.
 */
export function renderTaskRows(tasks: Task[], options: TaskRowOptions = {}): string[] {
  if (tasks.length === 0) return [];
  const width = options.width ?? DEFAULT_WIDTH;
  const indent = options.indent ?? 0;
  const showStatus = options.showStatus !== false;

  const idWidth = Math.max(6, ...tasks.map((task) => task.id.length));
  const rawStatusCells = tasks.map((task) => (task.drifted ? `${task.status} ⚠` : task.status));
  let statusWidth = Math.min(MAX_STATUS_WIDTH, Math.max(6, ...rawStatusCells.map((cell) => cell.length)));
  let metaWidth = Math.max(0, ...tasks.map((task) => metaCell(task).length));
  const revValues = tasks.map((task) => `rev ${task.rev}`);
  const revLongest = Math.max(5, ...revValues.map((cell) => cell.length));
  const revWidth = Math.min(MAX_REV_WIDTH, revLongest);
  const layout = (): number =>
    width -
    indent -
    idWidth -
    2 -
    (showStatus ? statusWidth + 2 : 0) -
    2 -
    metaWidth -
    2 -
    revWidth;

  let titleWidth = layout();
  if (titleWidth < MIN_TITLE_WIDTH) {
    statusWidth = Math.min(statusWidth, 10);
    titleWidth = layout();
  }
  // Drop the claim age before clamping meta: the owner and its age matter more
  // than a wider title, and the spec's fallback order says age goes first.
  const showAge = titleWidth < MIN_TITLE_WIDTH;
  if (showAge) {
    metaWidth = Math.min(MAX_META_WIDTH, Math.max(0, ...tasks.map((task) => metaCell(task, false).length)));
    titleWidth = layout();
  }
  if (titleWidth < MIN_TITLE_WIDTH) {
    metaWidth = Math.min(metaWidth, MAX_META_WIDTH);
    titleWidth = layout();
  }
  titleWidth = Math.max(1, titleWidth);

  return tasks.map((task, index) => {
    const parts: string[] = [" ".repeat(indent), pad(task.id, idWidth), "  "];
    if (showStatus) {
      parts.push(pad(statusCell(task, statusWidth), statusWidth), "  ");
    }
    parts.push(pad(truncate(task.title.trim(), titleWidth), titleWidth), "  ");
    parts.push(pad(metaCell(task, !showAge), metaWidth), "  ");
    parts.push(padStart(revValues[index], revWidth));
    return parts.join("").replace(/\s+$/, "");
  });
}

/** The ` claimAge` suffix for a claimed task, or `""` when there is no claim. */
export function claimAgeLabel(task: Task): string {
  if (!task.assignee || !task.active) return "";
  return ` ${formatAge(task.claimAgeMs ?? 0)}`;
}

/**
 * Assignee cell: `@handle age` in an active status, `@handle` otherwise. Only a
 * cell longer than 16 characters is truncated, to `@` + 13 + `...`, so a
 * 14-character handle keeps its full name.
 */
function metaCell(task: Task, withAge = true): string {
  if (!task.assignee) return "";
  const cell = `@${task.assignee}`;
  const handle = cell.length > 16 ? `@${task.assignee.slice(0, 13)}...` : cell;
  const age = withAge ? claimAgeLabel(task) : "";
  return `${handle}${age}`;
}

/** Status cell: the raw id plus the drift marker, truncated inside its column. */
function statusCell(task: Task, statusWidth: number): string {
  const marker = task.drifted ? " ⚠" : "";
  const room = Math.max(1, statusWidth - marker.length);
  return `${truncate(task.status, room)}${marker}`;
}

// ─── The board briefing ──────────────────────────────────────────────────────

/** `<dir>` in the briefing: at most 69 characters, tail-kept. */
function briefDir(dir: string, cwd: string): string {
  const display = displayPath(dir, cwd);
  if (display.length <= 69) return display;
  return `...${display.slice(display.length - 66)}`;
}

const MAX_BRIEF_STATUSES = 8;

/** One status line: `  active  ◆ a  ◆ b`, at most eight items plus `(+N more)`. */
function statusLine(kind: "active" | "other", cells: string[]): string {
  if (cells.length === 0) {
    return kind === "active"
      ? "  active  (none - exclusivity rests on kanban_assign)"
      : "  other  (none)";
  }
  const head = `  ${kind}  `;
  const visible = cells.slice(0, MAX_BRIEF_STATUSES);
  // Keep as many statuses as fit and say how many are hidden, counting the ones
  // the eight-item cap already dropped.
  for (let shown = visible.length; shown >= 1; shown -= 1) {
    const suffix = cells.length > shown ? `  (+${cells.length - shown} more)` : "";
    const line = `${head}${visible.slice(0, shown).join("  ")}${suffix}`;
    if (line.length <= 74) return line;
  }
  return `${head}${visible[0]}`;
}

/**
 * The 18-line board briefing from `docs/product/design-v0.2.md`, section 1.
 * It is the whole response for `kanban_list {briefing: true}` and for any
 * unfiltered call on a board with no tasks.
 */
export function renderBriefing(board: BoardSnapshot, cwd: string = board.root): string {
  const workflow = board.workflow;
  const lines: string[] = [`Board  ${briefDir(board.dir, cwd)}`];

  if (workflow) {
    lines.push(`Workflow  ${workflow.name ?? "(unnamed)"}  ·  initial: ${workflow.initial}`);
    lines.push(
      statusLine(
        "active",
        workflow.statuses.filter((status) => status.active).map((status) => `◆ ${status.id}`),
      ),
    );
    lines.push(
      statusLine(
        "other",
        workflow.statuses
          .filter((status) => !status.active)
          .map((status) => `◇ ${status.id}${status.terminal ? " (terminal)" : ""}`),
      ),
    );
  } else {
    lines.push("Workflow  unavailable  (⚠ run /kanban validate)");
  }

  lines.push(
    "",
    "Claims",
    "  Moving a task into an active status claims it for your handle; only the",
    "  holder can move or release it. force: true is a deliberate takeover,",
    "  recorded as a forced assignment. A terminal status releases the claim.",
    "  There are no leases: a claim never expires until someone releases it.",
    "",
    "  Handles are self-asserted, like coder-1. The board does not verify them.",
    "",
    "Start here",
    '  kanban_list, then kanban_list {task:"T-0001"} for one task in full.',
    "  kanban_create {title, agent} adds a task in the initial status.",
    "  kanban_move {task, to, agent} moves along a declared transition.",
    "  Every write takes an agent handle; pass expectedRev from kanban_list.",
  );

  return lines.join("\n");
}

// ─── Paging and summary for kanban_list ──────────────────────────────────────

export interface Paging {
  total: number;
  offset: number;
  limit: number;
  returned: number;
}

/** `  showing 51-100 of 137 (offset 50, limit 50)`, printed only when offset > 0. */
export function renderPageHeader(paging: Paging): string | null {
  if (paging.offset <= 0) return null;
  const last = paging.offset + paging.returned;
  return `  showing ${paging.offset + 1}-${last} of ${paging.total} (offset ${paging.offset}, limit ${paging.limit})`;
}

/** `  ... 37 more tasks (of 137). Next: offset 100, or narrow the filters.` */
export function renderPageFooter(paging: Paging): string | null {
  const more = paging.total - paging.offset - paging.returned;
  if (more <= 0) return null;
  return `  ... ${more} more task${more === 1 ? "" : "s"} (of ${paging.total}). Next: offset ${paging.offset + paging.returned}, or narrow the filters.`;
}

/** `  No tasks at offset 137; 137 match. Reset with offset 0.` */
export function renderOffsetPastEnd(total: number, offset: number): string {
  return `  No tasks at offset ${offset}; ${total} match. Reset with offset 0.`;
}

export interface SummaryCounts {
  total: number;
  open: number;
  done: number;
  claimed: number;
  /** Rows per declared status, in workflow order. */
  statuses: Array<{ status: StatusDef; count: number; claimed: number }>;
  drifted: number;
}

/** Counts for `kanban_list {summary: true}`. Filters are applied by the caller. */
export function summarizeCounts(tasks: Task[], workflow: Workflow | null): SummaryCounts {
  const byStatus = groupByStatus(tasks);
  const terminalIds = new Set((workflow?.statuses ?? []).filter((status) => status.terminal).map((status) => status.id));
  const declared = new Set((workflow?.statuses ?? []).map((status) => status.id));
  const counted = workflow ? tasks.filter((task) => declared.has(task.status)) : tasks;
  return {
    total: tasks.length,
    open: tasks.filter((task) => !terminalIds.has(task.status)).length,
    done: tasks.filter((task) => terminalIds.has(task.status)).length,
    claimed: tasks.filter((task) => task.assignee).length,
    statuses: (workflow?.statuses ?? []).map((status) => {
      const rows = byStatus.get(status.id) ?? [];
      return { status, count: rows.length, claimed: rows.filter((task) => task.assignee).length };
    }),
    drifted: tasks.length - counted.length,
  };
}

/**
 * The `summary: true` block: one line naming the board, the totals line, one
 * line per declared status, and an optional drifted line. No task rows, so its
 * size follows the workflow, not the board.
 */
export function renderSummary(
  board: Pick<BoardSnapshot, "dir">,
  tasks: Task[],
  workflow: Workflow | null,
  cwd: string = board.dir,
): string {
  const counts = summarizeCounts(tasks, workflow);
  const lines: string[] = [`Board  ${displayPath(board.dir, cwd)}`, "", `  ${summaryTotals(counts)}`];

  const labels = counts.statuses.map(({ status }) => `${status.active ? "◆" : "◇"} ${status.label}`);
  if (counts.drifted > 0) labels.push("⚠ drifted");
  const labelWidth = Math.max(...labels.map((label) => label.length), 0) + 2;

  counts.statuses.forEach(({ status, count, claimed }, index) => {
    const note = status.terminal ? "terminal" : `${claimed} claimed`;
    lines.push(`  ${pad(labels[index], labelWidth)}${padStart(String(count), 4)}  ${note}`);
  });
  if (counts.drifted > 0) {
    lines.push(`  ${pad(labels[labels.length - 1], labelWidth)}${padStart(String(counts.drifted), 4)}  not in workflow`);
  }

  return lines.join("\n");
}

/** `{total} tasks · {open} open · {done} done`, plus ` · {claimed} claimed`. */
function summaryTotals(counts: SummaryCounts): string {
  const parts = [
    `${counts.total} task${counts.total === 1 ? "" : "s"}`,
    `${counts.open} open`,
    `${counts.done} done`,
  ];
  if (counts.claimed > 0) parts.push(`${counts.claimed} claimed`);
  return parts.join(" · ");
}
