import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { handleKanbanCommand } from "../command.ts";
import { makeBoard, LINEAR_WORKFLOW } from "./helpers.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

function loadExtension() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { description?: string; handler: unknown }>();
  const events: Array<{ channel: string; data: unknown }> = [];

  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: { description?: string; handler: unknown }) =>
      commands.set(name, options),
    events: {
      emit: (channel: string, data: unknown) => events.push({ channel, data }),
      on: () => () => undefined,
    },
    on: () => () => undefined,
  } as unknown as ExtensionAPI;

  kanbanExtension(pi);
  return { tools, commands, events };
}

function ctxFor(cwd: string) {
  return {
    cwd,
    ui: {
      notify: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

describe("extension registration", () => {
  it("registers exactly five tools and one command", () => {
    const { tools, commands } = loadExtension();
    expect([...tools.keys()].sort()).toEqual([
      "kanban_assign",
      "kanban_comment",
      "kanban_create",
      "kanban_list",
      "kanban_move",
    ]);
    expect([...commands.keys()]).toEqual(["kanban"]);
  });

  it("every tool declares an output schema", () => {
    const { tools } = loadExtension();
    for (const tool of tools.values()) {
      expect((tool as unknown as { outputSchema?: unknown }).outputSchema).toBeDefined();
    }
  });
});

describe("tools end to end", () => {
  it("runs create -> move -> comment -> list and emits events", async () => {
    const board = makeBoard();
    const { tools, events } = loadExtension();
    const ctx = ctxFor(board.root);
    const run = async (name: string, params: unknown) =>
      (await tools.get(name)!.execute("call", params, undefined, undefined, ctx)) as ToolResult;

    const created = await run("kanban_create", { title: "End to end", agent: "coder-1", project: board.root });
    expect(created.isError).toBeFalsy();
    const taskId = (created.structuredContent?.task as { id: string }).id;

    const moved = await run("kanban_move", { task: taskId, to: "working", agent: "coder-1", project: board.root });
    expect(moved.isError).toBeFalsy();
    expect((moved.structuredContent?.task as { assignee: string }).assignee).toBe("coder-1");

    const commented = await run("kanban_comment", { task: taskId, body: "Progress.", agent: "coder-1", project: board.root });
    expect(commented.isError).toBeFalsy();

    const list = await run("kanban_list", { project: board.root });
    expect(list.isError).toBeFalsy();
    expect((list.structuredContent?.tasks as unknown[]).length).toBe(1);
    expect((list.structuredContent?.workflow as { initial: string }).initial).toBe("new");
    // The text form must carry the same facts, so an agent with only this tool
    // can still plan a legal move.
    expect(list.content[0].text).toContain("initial=new");
    expect(list.content[0].text).toContain("working (active) -> new, done");

    expect(events.map((event) => event.channel)).toEqual([
      "kanban:task_changed",
      "kanban:task_changed",
      "kanban:task_changed",
    ]);
  });

  it("returns a structured failure for a contested claim", async () => {
    const board = makeBoard();
    const { tools } = loadExtension();
    const ctx = ctxFor(board.root);
    const run = async (name: string, params: unknown) =>
      (await tools.get(name)!.execute("call", params, undefined, undefined, ctx)) as ToolResult;

    const created = await run("kanban_create", { title: "Contested", agent: "alpha", project: board.root });
    const taskId = (created.structuredContent?.task as { id: string }).id;
    await run("kanban_move", { task: taskId, to: "working", agent: "alpha", project: board.root });

    const denied = await run("kanban_move", { task: taskId, to: "done", agent: "beta", project: board.root });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent?.code).toBe("wrong_owner");
    expect(denied.content[0].text).toContain("force");
  });

  it("reports a missing workflow with an init hint", async () => {
    const board = makeBoard(null);
    const { tools } = loadExtension();
    const result = (await tools
      .get("kanban_create")!
      .execute("call", { title: "No board", agent: "a", project: board.root }, undefined, undefined, ctxFor(board.root))) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("no_workflow");
    expect(String(result.structuredContent?.hint)).toContain("/kanban init");
  });

  it("explains a missing workflow even when there are no tasks", async () => {
    const board = makeBoard(null);
    const { tools } = loadExtension();
    const result = (await tools
      .get("kanban_list")!
      .execute("call", { project: board.root }, undefined, undefined, ctxFor(board.root))) as ToolResult;

    expect(result.isError).toBeFalsy();
    // An empty board returns the briefing (design v0.2 section 1); the
    // degenerate workflow line points at `/kanban validate`.
    expect(result.content[0].text).toContain("Workflow  unavailable");
    expect(result.content[0].text).toContain("/kanban validate");
    expect(result.content[0].text).toContain("Start here");
  });

  it("lists a single task in full detail", async () => {
    const board = makeBoard();
    const { tools } = loadExtension();
    const ctx = ctxFor(board.root);
    const created = (await tools
      .get("kanban_create")!
      .execute("call", { title: "Detail", description: "Body.", agent: "a", project: board.root }, undefined, undefined, ctx)) as ToolResult;
    const taskId = (created.structuredContent?.task as { id: string }).id;

    const listed = (await tools
      .get("kanban_list")!
      .execute("call", { task: taskId, project: board.root }, undefined, undefined, ctx)) as ToolResult;
    const tasks = listed.structuredContent?.tasks as Array<{ description: string }>;
    expect(tasks[0].description).toBe("Body.");
  });

  it("filters by status and assignee", async () => {
    const board = makeBoard();
    const { tools } = loadExtension();
    const ctx = ctxFor(board.root);
    const run = async (name: string, params: unknown) =>
      (await tools.get(name)!.execute("call", params, undefined, undefined, ctx)) as ToolResult;

    const a = await run("kanban_create", { title: "A", agent: "alpha", project: board.root });
    const b = await run("kanban_create", { title: "B", agent: "beta", project: board.root });
    const aId = (a.structuredContent?.task as { id: string }).id;
    const bId = (b.structuredContent?.task as { id: string }).id;
    await run("kanban_assign", { task: aId, assignee: "alpha", agent: "alpha", project: board.root });
    await run("kanban_move", { task: bId, to: "working", agent: "beta", project: board.root });

    const byStatus = await run("kanban_list", { status: "working", project: board.root });
    expect((byStatus.structuredContent?.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([bId]);

    const byAssignee = await run("kanban_list", { assignee: "alpha", project: board.root });
    expect((byAssignee.structuredContent?.tasks as Array<{ id: string }>).map((task) => task.id)).toEqual([aId]);
  });
});

describe("/kanban command", () => {
  it("initialises a board from an empty directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-cmd-"));
    const messages: string[] = [];
    const ctx = {
      cwd: root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("init", ctx);
    expect(messages[0]).toContain("Board initialized");
    expect(readFileSync(join(root, ".pi/kanban/workflow.yaml"), "utf8")).toContain("statuses:");
  });

  it("renders the board, a single task, and JSON", async () => {
    const board = makeBoard(LINEAR_WORKFLOW);
    await import("../store.ts").then(({ createTask, moveTask }) =>
      createTask(board, { title: "Rendered task", agent: "coder-1" }).then((task) =>
        moveTask(board, { task: task.id, to: "working", agent: "coder-1" }),
      ),
    );

    const messages: string[] = [];
    const ctx = {
      cwd: board.root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("", ctx);
    expect(messages[0]).toContain("Rendered task");
    expect(messages[0]).toContain("@coder-1");

    messages.length = 0;
    await handleKanbanCommand("T-0001", ctx);
    expect(messages[0]).toContain("status");
    expect(messages[0]).toContain("working");

    messages.length = 0;
    await handleKanbanCommand("--json", ctx);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.workflow.initial).toBe("new");
  });

  it("reports validation problems", async () => {
    const board = makeBoard(null);
    const messages: string[] = [];
    const ctx = {
      cwd: board.root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("validate", ctx);
    expect(messages[0]).toContain("No workflow file");
  });

  it("explains a missing board without crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-empty-"));
    const messages: string[] = [];
    const ctx = {
      cwd: root,
      ui: { notify: (message: string) => messages.push(message) },
    } as unknown as ExtensionCommandContext;

    await handleKanbanCommand("", ctx);
    expect(messages[0]).toContain("/kanban init");
  });
});
