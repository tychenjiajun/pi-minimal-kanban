/**
 * T-0009: the reviewer findings on T-0003/T-0004/T-0006/T-0007 that are
 * behavior or format only — the briefing vs unreadable files, `limit: 500`,
 * claim wording outside an active status, and the §2 row everywhere.
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { USAGE, handleKanbanCommand } from "../command.ts";
import { assignTask, createTask, moveTask, readBoard, validateBoard } from "../store.ts";
import { renderTaskRows } from "../render.ts";
import { ListParams } from "../schemas.ts";
import { KanbanError } from "../errors.ts";
import { LINEAR_WORKFLOW, makeBoard, taskFile } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";
import type { Task } from "../types.ts";

// ─── harness ────────────────────────────────────────────────────────────────

interface RegisteredTool {
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (tool: { name: string } & RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: () => () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  kanbanExtension(pi);
  return tools;
}

interface ToolResult {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function list(
  tools: Map<string, RegisteredTool>,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  return (await tools
    .get("kanban_list")!
    .execute("call", params, undefined, undefined, {
      cwd,
      ui: { notify: () => undefined },
    } as unknown as ExtensionCommandContext)) as ToolResult;
}

function ctxFor(cwd: string): { ctx: ExtensionCommandContext; messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    ctx: { cwd, ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionCommandContext,
  };
}

/** Write `count` task files directly; faster than `count` locked creates. */
function seed(board: BoardLocation, count: number, status = "new"): void {
  for (let i = 1; i <= count; i += 1) {
    const id = `T-${String(i).padStart(4, "0")}`;
    taskFile(
      board,
      id,
      `---\nid: ${id}\ntitle: Task number ${i}\nstatus: ${status}\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );
  }
}

/** The engine's minimum `Task` shape for a row-layout unit test. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-0001",
    title: "A task",
    description: "",
    status: "working",
    created: "2026-10-01T00:00:00.000Z",
    updated: "2026-10-01T00:00:00.000Z",
    rev: 1,
    history: [],
    comments: [],
    path: "",
    drifted: false,
    active: true,
    claimAgeMs: 0,
    ...overrides,
  };
}

// ─── briefing and unreadable files ──────────────────────────────────────────

describe("the briefing never hides unreadable files", () => {
  it("does not answer an unreadable board with the empty-board briefing", async () => {
    const board = makeBoard();
    writeFileSync(join(board.tasksDir, "T-0001.md"), "junk\n", "utf8");
    const tools = loadTools();

    const result = await list(tools, { project: board.root }, board.root);
    const text = result.content[0].text;

    // An unreadable file is not an empty board: the agent is told what is wrong.
    expect(text).not.toContain("Start here");
    expect(text).toContain("could not be read");
    expect(text).toContain("T-0001.md");
    expect(text).toContain("No matching tasks.");
    expect(result.structuredContent?.briefing).toBeUndefined();
    expect(result.structuredContent?.total).toBe(0);
  });

  it("prints the warning lines and the real total for an explicit briefing", async () => {
    const board = makeBoard();
    seed(board, 2);
    writeFileSync(join(board.tasksDir, "T-0003.md"), "junk\n", "utf8");
    const tools = loadTools();

    const result = await list(tools, { briefing: true, project: board.root }, board.root);
    const text = result.content[0].text;

    expect(text).toContain("could not be read");
    expect(text).toContain("T-0003.md");
    expect(text).toContain("Start here");
    // The mirror is the text, warnings included.
    expect(result.structuredContent?.briefing).toBe(text);
    // Two readable tasks: not an empty board.
    expect(result.structuredContent?.total).toBe(2);
  });

  it("reports the real total for briefing: true on a 137-task board", async () => {
    const board = makeBoard();
    seed(board, 137);
    const tools = loadTools();

    const result = await list(tools, { briefing: true, project: board.root }, board.root);
    expect(result.structuredContent?.total).toBe(137);
    expect(result.content[0].text).toContain("Start here");
  });
});

// ─── limit ──────────────────────────────────────────────────────────────────

describe("limit is 500 everywhere", () => {
  it("accepts 500 in the schema instead of rejecting it before the clamp", () => {
    expect(Value.Check(ListParams, { limit: 500 })).toBe(true);
    expect(Value.Check(ListParams, { limit: 501 })).toBe(false);
    expect(ListParams.properties.limit.description).toContain("max 500");
  });

  it("prints 500 rows and pages the remainder", async () => {
    const board = makeBoard();
    seed(board, 520);
    const tools = loadTools();

    const result = await list(tools, { limit: 500, project: board.root }, board.root);
    expect(result.structuredContent).toMatchObject({ total: 520, limit: 500, returned: 500, hasMore: true });
    expect(result.content[0].text).toContain("... 20 more tasks (of 520). Next: offset 500");
  });
});

// ─── claim wording ──────────────────────────────────────────────────────────

describe("claim wording names the age everywhere", () => {
  it("names the age of a claim held outside an active status", async () => {
    const board = makeBoard();
    const start = { now: () => new Date("2026-10-01T00:00:00.000Z") };
    const task1 = await createTask(board, { title: "Assigned but not claimed", agent: "coder-1" }, start);
    await assignTask(board, { task: task1.id, assignee: "coder-1", agent: "coder-1" }, start);

    // Three days later a different handle tries to take it into `working`.
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    const error = await moveTask(board, { task: task1.id, to: "working", agent: "coder-2" }, later).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(KanbanError);
    expect((error as KanbanError).details.code).toBe("wrong_owner");
    expect((error as KanbanError).message).toContain('claimed by "coder-1" for 3d');
  });

  it("warns about a stale assignment in a non-active status, naming the blocker", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      [
        "---",
        "id: T-0001",
        "title: Assigned in new",
        "status: new",
        "assignee: coder-1",
        "created: 2026-10-01T00:00:00.000Z",
        "updated: 2026-10-01T00:00:00.000Z",
        "rev: 2",
        "history:",
        "  - at: 2026-10-01T00:00:00.000Z",
        "    action: assign",
        "    by: coder-1",
        "    assignee: coder-1",
        "---",
      ].join("\n") + "\n",
    );
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    const report = validateBoard(board, {}, later);

    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.severity).toBe("warning");
    // An assignment is not a claim, and the warning says why it still matters.
    expect(stale?.message).toContain('Assigned to "coder-1" for 3d (threshold 24h)');
    expect(stale?.message).toContain("blocks moving the task into an active status");
    expect(stale?.message).toContain("Release it with kanban_assign {assignee: null, force: true}.");
    expect(stale?.message).not.toContain("/kanban release");
    expect(report.ok).toBe(true);
  });

  it("keeps the claim sentence for an active claim", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      [
        "---",
        "id: T-0001",
        "title: Claimed while working",
        "status: working",
        "assignee: coder-1",
        "created: 2026-10-01T00:00:00.000Z",
        "updated: 2026-10-01T00:00:00.000Z",
        "rev: 2",
        "history:",
        "  - at: 2026-10-01T00:00:00.000Z",
        "    action: assign",
        "    by: coder-1",
        "    assignee: coder-1",
        "---",
      ].join("\n") + "\n",
    );
    const later = { now: () => new Date("2026-10-04T00:00:00.000Z") };
    const stale = validateBoard(board, {}, later).problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.message).toContain('Claimed by "coder-1" for 3d (threshold 24h). Release it');
  });

  it("treats a release attempt as an unknown task id and writes nothing", async () => {
    const board = makeBoard();
    // A status the workflow no longer declares, and no assignee.
    taskFile(
      board,
      "T-0001",
      "---\nid: T-0001\ntitle: Legacy\ntags: []\nstatus: legacy\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\nrev: 1\nhistory: []\n---\n",
    );
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("release T-0001", ctx);

    // The subcommand no longer exists, so `release` is parsed as a task id.
    expect(messages[0]).toBe('Invalid task id "release".\n\nUse the form T-0001.');
    expect(messages[0]).not.toContain("⚠");
  });
});

// ─── the §2 row everywhere ──────────────────────────────────────────────────

describe("the §2 row is used by every list", () => {
  async function claimedBoard(): Promise<BoardLocation> {
    const board = makeBoard();
    const start = { now: () => new Date("2026-10-01T00:00:00.000Z") };
    const created = await createTask(board, { title: "Ship the thing", agent: "coder-1" }, start);
    await moveTask(board, { task: created.id, to: "working", agent: "coder-1" }, start);
    return board;
  }

  it("prints rev and the claim age in /kanban mine", async () => {
    const board = await claimedBoard();
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("mine coder-1", ctx);
    // The real clock formats the fixture's age; the row shape is the assertion.
    expect(messages[0]).toMatch(/T-0001 {2}working {2}Ship the thing +@coder-1 \d+[smhdw] {2}rev 2/);
  });

  it("prints rev and the claim age in /kanban status, without a status cell", async () => {
    const board = await claimedBoard();
    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("status working", ctx);
    expect(messages[0]).toMatch(/T-0001 {2}Ship the thing +@coder-1 \d+[smhdw] {2}rev 2/);
    expect(messages[0]).not.toContain("working  Ship");
  });

  it("keeps the drift marker inside the status cell with the same row shape", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      "---\nid: T-0001\ntitle: Orphan\nstatus: legacy\ncreated: 2026-10-01T00:00:00.000Z\nupdated: 2026-10-01T00:00:00.000Z\nrev: 3\nhistory: []\n---\n",
    );
    const { ctx, messages } = ctxFor(board.root);
    return handleKanbanCommand("mine nobody", ctx).then(() => {
      // `/kanban` columns carry the drifted row; `kanban_list` shows the cell.
      const snapshot = readBoard(board);
      expect(snapshot.tasks[0].drifted).toBe(true);
      const rows = renderTaskRows(snapshot.tasks, { indent: 4, showStatus: true });
      expect(rows[0]).toMatch(/^ {4}T-0001 {2}legacy ⚠ {2}Orphan +rev 3$/);
      expect(messages[0]).toContain("Assigned to nobody");
    });
  });
});

// ─── truncation ─────────────────────────────────────────────────────────────

describe("truncation keeps the row honest", () => {
  it("strips the trailing space before the dots", () => {
    // width 39 - (6 id + 2 + 2 + 0 meta + 2 + 5 rev) = 22 columns of title, so
    // the cut lands on the space before `loading`.
    const rows = renderTaskRows([task({ title: "Add retry to the u loading" })], { width: 39, showStatus: false });
    expect(rows[0]).toContain("Add retry to the u...");
    expect(rows[0]).not.toContain("u ...");
    expect(rows[0]).toHaveLength(39);
  });

  it("does not truncate a 14-character handle, and does truncate a 16-character one", () => {
    const short = renderTaskRows([task({ assignee: "abcdefghijklmn" })], { showStatus: false });
    expect(short[0]).toContain("@abcdefghijklmn");
    expect(short[0]).not.toContain("...");

    const long = renderTaskRows([task({ assignee: "abcdefghijklmnop" })], { showStatus: false });
    expect(long[0]).toContain("@abcdefghijklm...");
  });
});

// ─── briefing status cap ────────────────────────────────────────────────────

function workflowWith(ids: string[]): string {
  const statuses = ids.map((id) => `  - id: ${id}\n    active: true`).join("\n");
  const transitions = ids.map((id, index) => `  ${id}: [${ids[(index + 1) % ids.length]}]`).join("\n");
  return `name: wide\ninitial: ${ids[0]}\nstatuses:\n${statuses}\n  - id: done\n    terminal: true\ntransitions:\n${transitions}\n`;
}

describe("the briefing cap counts the statuses it hides", () => {
  it("prints eight active statuses plus (+4 more)", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
    const board = makeBoard(workflowWith(ids));
    const text = (await list(loadTools(), { briefing: true, project: board.root }, board.root)).content[0].text;

    expect(text).toContain("◆ s7");
    expect(text).not.toContain("◆ s8");
    expect(text).toContain("(+4 more)");
  });

  it("keeps as many long statuses as fit and adds up the rest", async () => {
    const ids = [
      "backlog-refinement",
      "backlog-review",
      "design-review",
      "implementation",
      "code-review",
      "integration",
      "release",
      "hardening",
      "cleanup",
      "followup",
      "audit",
      "retro",
    ];
    const board = makeBoard(workflowWith(ids));
    const text = (await list(loadTools(), { briefing: true, project: board.root }, board.root)).content[0].text;

    const line = text.split("\n").find((candidate) => candidate.startsWith("  active  "))!;
    expect(line.length).toBeLessThanOrEqual(76);
    // Two shown plus ten hidden is the twelve it was given.
    expect(line).toContain("(+10 more)");
    expect(line).toContain("◆ backlog-refinement");
    expect(line).not.toContain("◆ design-review");
  });
});

// ─── T-0015: the 14-line help card ───────────────────────────────────────────

describe("/kanban help is the finished 14-line card", () => {
  it("is exactly 14 lines, and every line is at most 76 characters", () => {
    const lines = USAGE.split("\n");
    expect(lines).toHaveLength(14);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(76);
  });

  it("states each of the six rules as one literal line", () => {
    // One substring per rule, from design v0.3 §4's table. A later edit that
    // silently drops a rule fails here rather than in a snapshot.
    expect(USAGE).toContain("active (◆) status claims it for your handle");
    expect(USAGE).toContain("terminal status releases the claim");
    expect(USAGE).toContain("self-asserted");
    expect(USAGE).toContain("Assigning a task to another handle needs force: true");
    expect(USAGE).toContain("Completions use this session's board");
    expect(USAGE).toContain("subcommands");
  });

  it("keeps the kanban_list pointer", () => {
    expect(USAGE).toContain("Start with kanban_list");
  });

  it("names neither removed subcommand: release and repair-ids live in the tools", () => {
    // 0.4.0 made `/kanban` inspection-only. Both mutating subcommands are gone
    // from the parser, the completions, and the help card. Only the removal
    // line ` A terminal status releases the claim` may still contain the word.
    expect(USAGE).not.toContain("repair-ids");
    const invocations = USAGE.split("\n").filter((line) => line.includes("/kanban release") || line.includes("/kanban repair-ids"));
    expect(invocations).toEqual([]);
    expect(USAGE).toContain("This command only reads");
  });

  it("prints the block unchanged for `help` and `--help`", async () => {
    const board = makeBoard();
    for (const args of ["help", "--help"]) {
      const { ctx, messages } = ctxFor(board.root);
      await handleKanbanCommand(args, ctx);
      expect(messages).toEqual([USAGE]);
    }
  });
});
