/**
 * Round-2 independent acceptance suite for T-0008 (safe board-lock steal) and
 * T-0009 (surface pack).
 *
 * External only: drives the registered `kanban_*` tools, the store, the
 * `/kanban` command, the renderer, and two spawned processes. Boards are
 * throwaway `mkdtempSync` fixtures.
 *
 * Kept separate from `acceptance.test.ts` on purpose; the reviewer may be
 * reading the repo in parallel and only this file is added here.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { handleKanbanCommand } from "../command.ts";
import { assignTask, createTask, moveTask, readBoard, validateBoard } from "../store.ts";
import { renderTaskRows } from "../render.ts";
import { KanbanError } from "../errors.ts";
import { makeBoard, taskFile } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";
import type { Task } from "../types.ts";

// ─── Harness ────────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  parameters?: { properties?: Record<string, { maximum?: number; minimum?: number }> };
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: () => undefined,
    on: () => () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  kanbanExtension(pi);
  return tools;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  return (await tools.get(name)!.execute("call", params, undefined, undefined, {
    cwd,
    ui: { notify: () => undefined },
  } as unknown as ExtensionCommandContext)) as ToolResult;
}

function ctxFor(cwd: string): { ctx: ExtensionCommandContext; messages: string[] } {
  const messages: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (message: string) => messages.push(message) },
  } as unknown as ExtensionCommandContext;
  return { ctx, messages };
}

function runChild(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const path = join(mkdtempSync(join(tmpdir(), "kanban-child-")), "child.mjs");
  writeFileSync(path, script, "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function writeTaskFile(
  board: BoardLocation,
  id: string,
  status: string,
  options: { assignee?: string; claimAt?: string } = {},
): void {
  const at = options.claimAt ?? "2026-10-30T00:00:00.000Z";
  const lines = ["---", `id: ${id}`, `title: Task ${Number(id.slice(2))}`, `status: ${status}`];
  if (options.assignee) lines.push(`assignee: ${options.assignee}`);
  lines.push(`created: ${at}`, `updated: ${at}`, "rev: 3", "history:");
  lines.push(`  - at: ${at}`, "    action: create", "    by: tester", "    to: new");
  if (options.assignee) {
    lines.push(`  - at: ${at}`, "    action: move", `    by: ${options.assignee}`, "    from: new", `    to: ${status}`);
    lines.push(`  - at: ${at}`, "    action: assign", `    by: ${options.assignee}`, `    assignee: ${options.assignee}`);
  }
  lines.push("---", "");
  taskFile(board, id, lines.join("\n"));
}

/** Seed `count` sequential tasks; optionally make one of them a live claim. */
function seedBoard(
  board: BoardLocation,
  count: number,
  claimed?: { index: number; status: string; assignee: string; claimAt: string },
): void {
  for (let index = 1; index <= count; index += 1) {
    const id = `T-${String(index).padStart(4, "0")}`;
    const live = claimed?.index === index ? claimed : undefined;
    writeTaskFile(board, id, live ? live.status : "new", live ? { assignee: live.assignee, claimAt: live.claimAt } : {});
  }
  writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: count + 1 }, null, 2)}\n`, "utf8");
}

/** Rewrite every timestamp in a task file so its assignment looks `msAgo` old. */
function backdateAssignment(board: BoardLocation, id: string, msAgo: number): void {
  const at = new Date(Date.now() - msAgo).toISOString();
  const path = join(board.tasksDir, `${id}.md`);
  taskFile(board, id, readFileSync(path, "utf8").replace(ISO, at));
}

// ─── T-0009: limit 500 ──────────────────────────────────────────────────────

describe("T-0009: limit 500 on a 137-task board", () => {
  it("accepts limit 500 in the schema and returns all 137 rows in one call", async () => {
    const board = makeBoard();
    seedBoard(board, 137);
    const tools = loadTools();

    // The old schema rejected 500 before the clamp could see it.
    expect(tools.get("kanban_list")?.parameters?.properties?.limit?.maximum).toBe(500);
    expect(tools.get("kanban_list")?.parameters?.properties?.limit?.minimum).toBe(1);

    const result = await call(tools, "kanban_list", { project: board.root, limit: 500 }, board.root);
    const text = result.content[0].text;
    const rows = text.split("\n").filter((line) => /^T-\d{4}\s/.test(line));
    expect(rows).toHaveLength(137);
    expect(rows[0]).toContain("T-0001");
    expect(rows.at(-1)).toContain("T-0137");
    expect(text).not.toContain("more tasks (of 137)");

    const page = result.structuredContent as {
      total: number;
      limit: number;
      returned: number;
      hasMore: boolean;
    };
    expect(page).toMatchObject({ total: 137, limit: 500, returned: 137, hasMore: false });
  });
});

// ─── T-0009: briefing + unreadable files ────────────────────────────────────

describe("T-0009: briefing and unreadable task files", () => {
  it("names a malformed file instead of answering with the empty-board briefing", async () => {
    const board = makeBoard();
    taskFile(board, "T-0002", "garbage, not a kanban task file\n");
    const tools = loadTools();

    const result = await call(tools, "kanban_list", { project: board.root, briefing: true }, board.root);
    const text = result.content[0].text;
    expect(text).toContain("could not be read");
    expect(text).toContain("T-0002.md");
    // The briefing block is still present beside the warning.
    expect(text).toContain("Start here");
    const structured = result.structuredContent as { briefing?: string; total?: number; fileErrors?: unknown[] };
    expect(typeof structured.briefing).toBe("string");
    expect(structured.fileErrors).toHaveLength(1);
    // The "real count" is the filtered readable total. With zero readable tasks
    // that is legitimately 0; the "not 0" clause is covered by the 137-task
    // briefing below (T-0009 bullet: "briefing: true on a 137-task board must
    // not report total: 0").
    expect(structured.total).toBe(0);
  });

  it("keeps the real total for briefing: true on a populated board", async () => {
    const board = makeBoard();
    seedBoard(board, 137);
    const tools = loadTools();

    const result = await call(tools, "kanban_list", { project: board.root, briefing: true }, board.root);
    const structured = result.structuredContent as { briefing?: string; total?: number };
    expect(typeof structured.briefing).toBe("string");
    expect(structured.total).toBe(137);
    expect(result.content[0].text).toContain("Start here");
  });

  it("does not hide a malformed file in a normal listing either", async () => {
    const board = makeBoard();
    writeTaskFile(board, "T-0001", "new");
    taskFile(board, "T-0002", "garbage, not a kanban task file\n");
    writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: 3 }, null, 2)}\n`, "utf8");
    const tools = loadTools();

    const result = await call(tools, "kanban_list", { project: board.root }, board.root);
    const text = result.content[0].text;
    expect(text).toMatch(/^T-0001\s/m);
    expect(text).toContain("T-0002.md");
    const structured = result.structuredContent as { total?: number; fileErrors?: unknown[] };
    expect(structured.total).toBe(1);
    expect(structured.fileErrors).toHaveLength(1);
  });
});

// ─── T-0009: stale assignment outside an active status ──────────────────────

describe("T-0009: stale assignment in a non-active status", () => {
  it("uses assignment wording, and moving into an active status needs force", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Unclaimed hint", agent: "coder-1" });
    // `new` is not active: this is an assignment, not a claim.
    await assignTask(board, { task: task.id, assignee: "coder-1", agent: "coder-1" });
    backdateAssignment(board, task.id, 3 * 86_400_000);

    const report = validateBoard(board);
    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.severity).toBe("warning");
    expect(stale?.message).toContain('Assigned to "coder-1" for 3d');
    expect(stale?.message).toContain("blocks moving the task into an active status");
    expect(stale?.message).not.toContain("Claimed by");
    expect(report.ok).toBe(true);

    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("stale_claim");
    expect(messages[0]).toContain('Assigned to "coder-1"');
    expect(messages[0]).toContain("Board is valid (1 warning).");

    // The assignment blocks the move that would create a claim...
    const blocked = await moveTask(board, { task: task.id, to: "working", agent: "coder-2" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(blocked).toBeInstanceOf(KanbanError);
    expect((blocked as KanbanError).details.code).toBe("wrong_owner");
    expect((blocked as KanbanError).message).toContain("for 3d");

    // ...unless the caller deliberately takes over.
    const forced = await moveTask(board, { task: task.id, to: "working", agent: "coder-2", force: true });
    expect(forced.status).toBe("working");
    expect(forced.assignee).toBe("coder-2");
  });

  it("keeps the active-claim wording distinct from the assignment wording", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Real claim", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    backdateAssignment(board, task.id, 3 * 86_400_000);

    const report = validateBoard(board);
    const stale = report.problems.find((problem) => problem.code === "stale_claim");
    expect(stale?.message).toContain('Claimed by "coder-1" for 3d');
    expect(stale?.message).not.toContain("Assigned to");
  });
});

// ─── T-0009: release refusal and list rows ──────────────────────────────────

describe("T-0009: /kanban release refusal and row formats", () => {
  it("prints the raw status with no drift marker and writes nothing", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Nobody owns me", agent: "coder-1" });
    const path = join(board.tasksDir, `${task.id}.md`);
    const before = readFileSync(path, "utf8");

    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand(`release ${task.id} --yes`, ctx);
    const text = messages[0];
    expect(text).toContain("has no claim to release.");
    expect(text).toContain("status  new");
    expect(text).not.toContain("new ⚠");
    expect(text).not.toContain("⚠");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("prints rev and claim age in /kanban mine and /kanban status", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Claimed work", agent: "coder-1" });
    await moveTask(board, { task: task.id, to: "working", agent: "coder-1" });
    backdateAssignment(board, task.id, 3 * 86_400_000);

    const mine = ctxFor(board.root);
    await handleKanbanCommand("mine coder-1", mine.ctx);
    expect(mine.messages[0]).toMatch(/T-0001\s+working\s+Claimed work\s+@coder-1 3d\s+rev \d+/);

    const status = ctxFor(board.root);
    await handleKanbanCommand("status working", status.ctx);
    // `status` omits the status cell (the heading already says it) but keeps rev/age.
    expect(status.messages[0]).toMatch(/T-0001\s+Claimed work\s+@coder-1 3d\s+rev \d+/);
    expect(status.messages[0]).not.toMatch(/T-0001\s+working\s/);
  });

  it("keeps the raw status and the drift marker in a drifted /kanban row", async () => {
    const board = makeBoard();
    writeTaskFile(board, "T-0001", "ghosting");
    writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: 2 }, null, 2)}\n`, "utf8");

    const { ctx, messages } = ctxFor(board.root);
    await handleKanbanCommand("", ctx);
    expect(messages[0]).toContain("Drifted tasks");
    expect(messages[0]).toMatch(/T-0001\s+ghosting ⚠\s+/);
    expect(messages[0]).toContain("rev 3");
  });
});

// ─── T-0009: truncation ─────────────────────────────────────────────────────

describe("T-0009: 14-character handle and long-title truncation", () => {
  it("keeps a 14-character handle whole and cuts the title without a dangling space", () => {
    const base = {
      created: "",
      updated: "",
      description: "",
      history: [],
      comments: [],
      path: "",
      drifted: false,
    };
    const task: Task = {
      ...base,
      id: "T-0001",
      title: `${"word ".repeat(50)}tail`,
      status: "working",
      assignee: "abcdefghijklmn", // 14 characters
      rev: 42,
      active: true,
      claimAgeMs: 3 * 86_400_000,
    };

    const row = renderTaskRows([task])[0];
    expect(row.length).toBeLessThanOrEqual(76);
    expect(row).toContain("@abcdefghijklmn");
    expect(row).not.toContain("@abcdefghijklm...");
    expect(row).toContain("...");
    // No ` ...` gap: the cut swallows the space and appends three dots directly.
    expect(row).not.toContain(" ...");
  });
});

// ─── T-0008: safe steal under two real processes ────────────────────────────

const LOCK_SCRIPT = `
import { withBoardLock } from ${JSON.stringify(join(import.meta.dirname, "../fs.ts"))};
import { createTask } from ${JSON.stringify(join(import.meta.dirname, "../store.ts"))};
import { resolveBoard } from ${JSON.stringify(join(import.meta.dirname, "../paths.ts"))};
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const role = process.argv[3];
const iterations = Number(process.argv[4] ?? 3);
const board = resolveBoard({ cwd: root, env: {} });
const lock = join(board.dir, ".lock");
const journal = join(root, "journal.log");
const counter = join(root, "counter.txt");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => appendFileSync(journal, line + "\\n");
const readCounter = () => {
  try { return Number(readFileSync(counter, "utf8")) || 0; } catch { return 0; }
};

if (role === "holder") {
  await withBoardLock(
    lock,
    async () => {
      log("holding");
      // Sleep past the contenders' staleMs, then die inside the critical
      // section: release() never runs and the lock survives.
      await sleep(700);
      process.exit(0);
    },
    { staleMs: 150, acquireTimeoutMs: 10_000 },
  );
} else {
  for (let i = 0; i < iterations; i += 1) {
    await withBoardLock(
      lock,
      async () => {
        const value = readCounter();
        await sleep(40);
        writeFileSync(counter, String(value + 1));
      },
      { staleMs: 150, acquireTimeoutMs: 20_000 },
    );
  }
  for (let i = 0; i < 2; i += 1) {
    await createTask(board, { title: role + " task " + i, agent: role });
  }
  log("done " + role);
}
`;

describe("T-0008: a holder that sleeps past staleMs", () => {
  it("has no lost update, no duplicate id, and no leftover lock or tombstone", async () => {
    const board = makeBoard();
    const journal = join(board.root, "journal.log");
    const holder = runChild(LOCK_SCRIPT, [board.root, "holder", "0"]);

    // Wait until the holder is inside the critical section.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(journal) && readFileSync(journal, "utf8").includes("holding")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readFileSync(journal, "utf8")).toContain("holding");
    expect(existsSync(join(board.dir, ".lock"))).toBe(true);

    // Wait past the contenders' staleMs so the live-but-slow lock looks stale.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const [holderResult, alpha, beta] = await Promise.all([
      holder,
      runChild(LOCK_SCRIPT, [board.root, "alpha", "3"]),
      runChild(LOCK_SCRIPT, [board.root, "beta", "3"]),
    ]);
    for (const result of [holderResult, alpha, beta]) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }

    // Both contenders did three read-modify-writes; none was lost.
    expect(Number(readFileSync(join(board.root, "counter.txt"), "utf8"))).toBe(6);
    expect(readFileSync(journal, "utf8")).toContain("done alpha");
    expect(readFileSync(journal, "utf8")).toContain("done beta");

    // No task id or title was reused.
    const tasks = readBoard(board).tasks;
    expect(tasks).toHaveLength(4);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(4);
    expect(new Set(tasks.map((task) => task.title)).size).toBe(4);

    // Every release cleaned up: no lock directory, no `.steal.` tombstone.
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
    expect(readdirSync(board.dir).filter((name) => name.includes(".steal."))).toEqual([]);
  }, 60_000);
});
