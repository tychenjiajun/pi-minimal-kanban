/**
 * T-0007: the cheap correctness pack — rev visibility, the one error envelope,
 * locked moves, handle guidance, and the two `validate` checks that catch
 * hand-edited board files.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension, { failureEnvelope } from "../index.ts";
import { handleKanbanCommand } from "../command.ts";
import { KanbanError } from "../errors.ts";
import { assertHandle, createTask, moveTask, validateBoard } from "../store.ts";
import { makeBoard, taskFile } from "./helpers.ts";

interface RegisteredTool {
  name: string;
  promptGuidelines?: string[];
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadExtension() {
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

function ctxFor(cwd: string) {
  return { cwd, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function run(tools: Map<string, RegisteredTool>, name: string, params: unknown, cwd: string) {
  return (await tools.get(name)!.execute("call", params, undefined, undefined, ctxFor(cwd))) as ToolResult;
}

describe("rev is visible where agents need it", () => {
  it("prints a rev column on every kanban_list row", async () => {
    const board = makeBoard();
    const tools = loadExtension();
    await run(tools, "kanban_create", { title: "Rev me", agent: "coder-1", project: board.root }, board.root);

    const listed = await run(tools, "kanban_list", { project: board.root }, board.root);
    expect(listed.content[0].text).toMatch(/T-0001\s+new\s+Rev me\s+rev 1/);
    expect((listed.structuredContent?.tasks as Array<{ rev: number }>)[0].rev).toBe(1);
  });

  it("tells the writing tools when to pass expectedRev", () => {
    const tools = loadExtension();
    for (const name of ["kanban_move", "kanban_assign", "kanban_comment"]) {
      const guidelines = tools.get(name)!.promptGuidelines?.join(" ") ?? "";
      expect(guidelines).toContain("expectedRev");
      expect(guidelines).toMatch(/since|when|last/);
    }
  });
});

describe("the error envelope", () => {
  it("carries the observed rev, the expected rev, and the current status on stale", async () => {
    const board = makeBoard();
    const tools = loadExtension();
    const created = await run(tools, "kanban_create", { title: "Stale", agent: "a", project: board.root }, board.root);
    const id = (created.structuredContent?.task as { id: string }).id;
    await run(tools, "kanban_move", { task: id, to: "working", agent: "a", project: board.root }, board.root);

    const stale = await run(
      tools,
      "kanban_move",
      { task: id, to: "done", agent: "a", expectedRev: 1, project: board.root },
      board.root,
    );

    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ code: "stale", rev: 2, expectedRev: 1, status: "working" });
    expect(stale.content[0].text).toContain("rev 2");
    expect(stale.content[0].text).toContain("rev 1");
    expect(stale.content[0].text).toContain("working");
  });

  it("names the board on every tool failure", async () => {
    const board = makeBoard();
    const tools = loadExtension();
    const attempts: Array<[string, unknown]> = [
      ["kanban_list", { task: "T-0099", project: board.root }],
      ["kanban_move", { task: "T-0099", to: "working", agent: "a", project: board.root }],
      ["kanban_assign", { task: "T-0099", assignee: "a", agent: "a", project: board.root }],
      ["kanban_comment", { task: "T-0099", body: "hi", agent: "a", project: board.root }],
      ["kanban_create", { title: "", agent: "a", project: board.root }],
    ];

    for (const [name, params] of attempts) {
      const result = await run(tools, name, params, board.root);
      expect(result.isError, `${name} should fail`).toBe(true);
      expect(result.structuredContent?.root, name).toBe(board.root);
      expect(result.structuredContent?.dir, name).toBe(board.dir);
      expect(typeof result.structuredContent?.hint, name).toBe("string");
    }
  });

  it("maps a non-KanbanError exception to a typed code with a hint", () => {
    const board = makeBoard();
    const cwd = board.root;

    const errno = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    expect(failureEnvelope(errno, {}, cwd)).toMatchObject({ ok: false, code: "io", root: board.root, dir: board.dir });

    const locked = failureEnvelope(new Error("Board is locked by another process (waited 15000ms)."), {}, cwd);
    expect(locked.code).toBe("locked");
    expect(locked.hint).toBeTruthy();

    const strange = failureEnvelope(new TypeError("boom"), {}, cwd);
    expect(strange.code).toBe("internal");
    expect(strange.hint).toBeTruthy();
  });

  it("keeps KanbanError details and drops the old toJSON path", () => {
    const board = makeBoard();
    const error = new KanbanError("stale", "Task T-0001 is at rev 3.", "Re-read.", { rev: 3, expectedRev: 2 });
    const envelope = failureEnvelope(error, {}, board.root);

    expect(envelope).toMatchObject({
      ok: false,
      error: "Task T-0001 is at rev 3.",
      code: "stale",
      hint: "Re-read.",
      rev: 3,
      expectedRev: 2,
      root: board.root,
      dir: board.dir,
    });
    expect((error as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
  });
});

describe("already_in_status", () => {
  it("reports the assignee and whether the caller holds the claim", async () => {
    const board = makeBoard();
    const tools = loadExtension();
    const created = await run(tools, "kanban_create", { title: "Same", agent: "alpha", project: board.root }, board.root);
    const id = (created.structuredContent?.task as { id: string }).id;
    await run(tools, "kanban_move", { task: id, to: "working", agent: "alpha", project: board.root }, board.root);

    const own = await run(tools, "kanban_move", { task: id, to: "working", agent: "alpha", project: board.root }, board.root);
    expect(own.structuredContent).toMatchObject({
      code: "already_in_status",
      assignee: "alpha",
      claimedByCaller: true,
    });

    const other = await run(tools, "kanban_move", { task: id, to: "working", agent: "beta", project: board.root }, board.root);
    expect(other.structuredContent).toMatchObject({
      code: "already_in_status",
      assignee: "alpha",
      claimedByCaller: false,
    });
    expect(other.content[0].text).toContain("alpha");
  });
});

describe("assertHandle", () => {
  it("states the first-character rule its regex enforces", () => {
    expect(() => assertHandle(".hidden")).toThrow(/starting with a letter or digit/);
    expect(() => assertHandle("-x")).toThrow(/starting with a letter or digit/);
    expect(() => assertHandle("a".repeat(65))).toThrow(/1-64 characters/);
    expect(assertHandle(" coder-1 ")).toBe("coder-1");
  });
});

describe("moveTask reports its origin from inside the lock", () => {
  it("returns from on the result and the tool prints it", async () => {
    const board = makeBoard();
    const tools = loadExtension();
    const created = await run(tools, "kanban_create", { title: "Origin", agent: "a", project: board.root }, board.root);
    const id = (created.structuredContent?.task as { id: string }).id;

    const moved = await moveTask(board, { task: id, to: "working", agent: "a" });
    expect(moved.from).toBe("new");

    const again = await run(tools, "kanban_move", { task: id, to: "done", agent: "a", project: board.root }, board.root);
    expect(again.structuredContent?.from).toBe("working");
    expect(again.content[0].text.startsWith("working")).toBe(true);
  });
});

describe("validate ids", () => {
  it("reports a frontmatter id that disagrees with the filename", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0009\ntitle: Renamed\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );

    const report = validateBoard(board);
    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.code)).toContain("id_mismatch");
    const problem = report.problems.find((candidate) => candidate.code === "id_mismatch")!;
    expect(problem.task).toBe("T-0001");
    expect(problem.message).toContain("T-0009");
    expect(problem.message).toContain("T-0001");
  });

  it("reports a counter that is not greater than the highest existing id", () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0002",
      `---\nid: T-0002\ntitle: Second\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );
    writeFileSync(join(board.dir, "counter.json"), `${JSON.stringify({ next: 2 }, null, 2)}\n`, "utf8");

    const report = validateBoard(board);
    expect(report.problems.map((problem) => problem.code)).toContain("counter_low");
    expect(report.problems.find((problem) => problem.code === "counter_low")!.message).toContain("T-0002");
  });

  it("accepts a healthy counter", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "Fine", agent: "a" });
    expect(task.id).toBe("T-0001");
    expect(validateBoard(board).problems.map((problem) => problem.code)).not.toContain("counter_low");
  });

  it("prints both findings from /kanban validate", async () => {
    const board = makeBoard();
    taskFile(
      board,
      "T-0001",
      `---\nid: T-0009\ntitle: Renamed\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );

    const messages: string[] = [];
    const ctx = {
      cwd: board.root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("id_mismatch");
    expect(messages[0]).toContain("T-0009");
  });

  it("keeps a valid board valid", () => {
    const board = makeBoard();
    expect(validateBoard(board).ok).toBe(true);
  });
});
