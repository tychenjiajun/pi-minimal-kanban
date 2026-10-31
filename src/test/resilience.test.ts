/**
 * T-0005: one malformed task file must not blank the board. The readable tasks
 * are still listed, the broken file is reported with its path and error, and a
 * direct read by id still fails clearly.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { handleKanbanCommand } from "../command.ts";
import { readBoard, readTask, readTasks, validateBoard } from "../store.ts";
import { renderBoard } from "../render.ts";
import { makeBoard, taskFile } from "./helpers.ts";
import type { BoardLocation } from "../paths.ts";

interface RegisteredTool {
  name: string;
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

async function call(tools: Map<string, RegisteredTool>, name: string, params: Record<string, unknown>, cwd: string) {
  return (await tools.get(name)!.execute("call", params, undefined, undefined, {
    cwd,
    ui: { notify: () => undefined },
  } as unknown as ExtensionCommandContext)) as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

function captureContext(cwd: string): { ctx: ExtensionCommandContext; messages: string[] } {
  const messages: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (message: string) => messages.push(message) },
  } as unknown as ExtensionCommandContext;
  return { ctx, messages };
}

/** A board with T-0001 valid and T-0002 missing its frontmatter. */
function mixedBoard(): BoardLocation {
  const board = makeBoard();
  taskFile(
    board,
    "T-0001",
    `---\nid: T-0001\ntitle: Readable task\nstatus: new\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
  );
  taskFile(board, "T-0002", "no frontmatter here, just prose\n");
  return board;
}

describe("unreadable task files", () => {
  it("excludes the broken file and reports it, keeping the readable tasks", () => {
    const board = mixedBoard();
    const { tasks, fileErrors } = readTasks(board);
    expect(tasks.map((task) => task.id)).toEqual(["T-0001"]);
    expect(fileErrors).toHaveLength(1);
    expect(fileErrors[0].path.endsWith("T-0002.md")).toBe(true);
    expect(fileErrors[0].message).toMatch(/frontmatter/);

    const snapshot = readBoard(board);
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["T-0001"]);
    expect(snapshot.fileErrors).toHaveLength(1);
  });

  it("still lists readable tasks in kanban_list and carries fileErrors", async () => {
    const board = mixedBoard();
    const tools = loadTools();
    const result = await call(tools, "kanban_list", { project: board.root }, board.root);

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("T-0001");
    expect(text).toContain("could not be read");
    expect(text).toContain("T-0002.md");

    const structured = result.structuredContent as {
      ok: boolean;
      tasks: Array<{ id: string }>;
      fileErrors: Array<{ path: string; message: string }>;
    };
    expect(structured.ok).toBe(true);
    expect(structured.tasks.map((task) => task.id)).toEqual(["T-0001"]);
    expect(structured.fileErrors).toHaveLength(1);
    expect(structured.fileErrors[0].path.endsWith("T-0002.md")).toBe(true);
  });

  it("renders the readable board and lists unreadable files", () => {
    const board = mixedBoard();
    const text = renderBoard(readBoard(board));
    expect(text).toContain("Readable task");
    expect(text).toContain("Unreadable task files");
    expect(text).toContain("T-0002.md");
  });

  it("shows the readable board in /kanban with a warning block", async () => {
    const board = mixedBoard();
    const { ctx, messages } = captureContext(board.root);
    await handleKanbanCommand("", ctx);
    expect(messages[0]).toContain("Readable task");
    expect(messages[0]).toContain("could not be read");
    expect(messages[0]).toContain("T-0002.md");
  });

  it("reports an unreadable file in /kanban validate as unreadable_task", async () => {
    const board = mixedBoard();
    const report = validateBoard(board);
    const problem = report.problems.find((entry) => entry.task === "T-0002");
    expect(problem?.code).toBe("unreadable_task");
    expect(problem?.severity).toBe("problem");
    expect(problem?.path?.endsWith("T-0002.md")).toBe(true);
    expect(report.ok).toBe(false);

    const { ctx, messages } = captureContext(board.root);
    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("unreadable_task");
    expect(messages[0]).toContain("T-0002");
    expect(messages[0]).toContain("Board has problems.");
  });

  it("fails clearly when the broken file is read directly by id", async () => {
    const board = mixedBoard();
    expect(() => readTask(board, "T-0002")).toThrow(/frontmatter/);

    const tools = loadTools();
    const result = await call(tools, "kanban_list", { task: "T-0002", project: board.root }, board.root);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { ok: boolean; code: string; error: string };
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe("invalid_task");
    expect(structured.error).toMatch(/T-0002/);
    expect(result.content[0].text).toContain("Error [invalid_task]");
  });
});
