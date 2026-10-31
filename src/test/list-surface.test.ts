/**
 * T-0003 and T-0004: the agent-facing `kanban_list` surface — the briefing for a
 * fresh session, and bounded output for a large board.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import kanbanExtension from "../index.ts";
import { makeBoard, taskFile } from "./helpers.ts";
import type { BoardLocation as BoardFixture } from "../paths.ts";

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
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  kanbanExtension(pi);
  return tools;
}

async function list(tools: Map<string, RegisteredTool>, params: Record<string, unknown>, cwd: string) {
  return (await tools
    .get("kanban_list")!
    .execute("call", params, undefined, undefined, { cwd, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext)) as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

/** Write `count` task files directly: faster than 60 locked creates. */
function seed(board: BoardFixture, count: number, statusOf: (index: number) => string = () => "new"): void {
  for (let i = 1; i <= count; i += 1) {
    const id = `T-${String(i).padStart(4, "0")}`;
    taskFile(
      board,
      id,
      `---\nid: ${id}\ntitle: Task number ${i}\nstatus: ${statusOf(i)}\ncreated: 2026-10-30T10:00:00.000Z\nupdated: 2026-10-30T10:00:00.000Z\nrev: 1\nhistory: []\n---\n`,
    );
  }
}

const ACTIVE_WORKFLOW = `name: delivery
initial: new
statuses:
  - id: new
  - id: planning
    active: true
  - id: working
    active: true
  - id: reviewing
    active: true
  - id: done
    terminal: true
transitions:
  new: [planning, working]
  planning: [new, working]
  working: [planning, reviewing]
  reviewing: [working, done]
  done: [working]
`;

describe("briefing", () => {
  it("prints the briefing for briefing: true and mirrors it in structuredContent", async () => {
    const board = makeBoard();
    seed(board, 1);
    const tools = loadExtension();

    const result = await list(tools, { briefing: true, project: board.root }, board.root);
    const text = result.content[0].text;

    expect(result.structuredContent?.briefing).toBe(text);
    expect(text).toContain("Board  .pi/kanban");
    expect(text).toContain("Workflow  linear  ·  initial: new");
    expect(text).toContain("◆ working");
    expect(text).toContain("◇ new");
    expect(text).toContain("◇ done (terminal)");
    expect(text).toContain("force: true");
    expect(text).toContain("terminal status releases the claim");
    expect(text).toContain("self-asserted");
    expect(text).toContain("kanban_create {title, agent}");
    expect(text).toContain("expectedRev");
    // The briefing replaces the task list.
    expect(text).not.toContain("Task number 1");
    expect(text).not.toContain("Workflow: linear");

    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThanOrEqual(10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("wins over task, limit, offset, and summary", async () => {
    const board = makeBoard();
    seed(board, 3);
    const tools = loadExtension();

    const result = await list(
      tools,
      { briefing: true, task: "T-0001", limit: 1, summary: true, project: board.root },
      board.root,
    );
    expect(result.content[0].text).toContain("Start here");
    expect(result.content[0].text).not.toContain("T-0001  new");
  });

  it("is the whole response for an empty board", async () => {
    const board = makeBoard();
    const tools = loadExtension();

    const result = await list(tools, { project: board.root }, board.root);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Start here");
    expect(result.content[0].text).not.toContain("No matching tasks.");
    expect(result.content[0].text).not.toContain("Workflow: linear");
    expect(typeof result.structuredContent?.briefing).toBe("string");
  });

  it("names the initial status, every active status, and force", async () => {
    const board = makeBoard(ACTIVE_WORKFLOW);
    const tools = loadExtension();
    const text = (await list(tools, { briefing: true, project: board.root }, board.root)).content[0].text;

    expect(text).toContain("initial: new");
    for (const status of ["planning", "working", "reviewing"]) {
      expect(text).toContain(`◆ ${status}`);
    }
    expect(text).toContain("force: true");
    expect(text).toContain("(terminal)");
  });

  it("states the degenerate workflow without dropping the rest", async () => {
    const board = makeBoard(null);
    const tools = loadExtension();
    const text = (await list(tools, { briefing: true, project: board.root }, board.root)).content[0].text;

    expect(text).toContain("Workflow  unavailable  (⚠ run /kanban validate)");
    expect(text).toContain("Claims");
    expect(text).toContain("Start here");
    expect(text.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("says so when no status is active", async () => {
    const board = makeBoard(
      "initial: new\nstatuses:\n  - id: new\n  - id: done\n    terminal: true\ntransitions:\n  new: [done]\n  done: [new]\n",
    );
    const tools = loadExtension();
    const text = (await list(tools, { briefing: true, project: board.root }, board.root)).content[0].text;
    expect(text).toContain("  active  (none - exclusivity rests on kanban_assign)");
    expect(text).toContain("  other  ◇ new  ◇ done (terminal)");
  });

  it("keeps the no-match sentence for a filtered empty result", async () => {
    const board = makeBoard();
    seed(board, 2);
    const tools = loadExtension();

    const result = await list(tools, { status: "done", project: board.root }, board.root);
    expect(result.content[0].text).toContain("No matching tasks.");
    expect(result.content[0].text).toContain("Try another status");
    expect(result.content[0].text).not.toContain("Start here");
    expect(result.content[0].text).toContain("Workflow: linear");
    expect(result.structuredContent?.briefing).toBeUndefined();
  });

  it("gives every tool a one-sentence rule", () => {
    const tools = loadExtension();
    expect([...tools.keys()].sort()).toEqual([
      "kanban_assign",
      "kanban_comment",
      "kanban_create",
      "kanban_list",
      "kanban_move",
    ]);
    for (const [name, tool] of tools) {
      const guidelines = tool.promptGuidelines ?? [];
      expect(guidelines.length, `${name} needs guidelines`).toBeGreaterThan(0);
      for (const guideline of guidelines) {
        expect(guideline, `${name}: ${guideline}`).toMatch(/^[^\n]+\.$/);
        expect(guideline.length).toBeLessThanOrEqual(220);
      }
    }
  });
});

describe("paging", () => {
  it("prints a header, the page, and a footer with the next offset", async () => {
    const board = makeBoard();
    seed(board, 60);
    const tools = loadExtension();

    const result = await list(tools, { limit: 10, offset: 5, project: board.root }, board.root);
    const text = result.content[0].text;

    expect(text).toContain("  showing 6-15 of 60 (offset 5, limit 10)");
    expect(text).toContain("  ... 45 more tasks (of 60). Next: offset 15, or narrow the filters.");
    for (const id of ["T-0006", "T-0010", "T-0015"]) expect(text).toContain(id);
    expect(text).not.toContain("T-0005 ");
    expect(text).not.toContain("T-0016 ");

    expect(result.structuredContent).toMatchObject({
      total: 60,
      offset: 5,
      limit: 10,
      returned: 10,
      hasMore: true,
      truncated: true,
    });
    expect((result.structuredContent?.tasks as unknown[]).length).toBe(10);
    expect(result.structuredContent?.workflow).toBeTruthy();
    expect(result.structuredContent?.root).toBe(board.root);
    expect(result.structuredContent?.dir).toBe(board.dir);
  });

  it("defaults to 50 rows and says how many remain", async () => {
    const board = makeBoard();
    seed(board, 60);
    const tools = loadExtension();

    const result = await list(tools, { project: board.root }, board.root);
    const text = result.content[0].text;

    expect(text).not.toContain("showing ");
    expect(text).toContain("  ... 10 more tasks (of 60). Next: offset 50, or narrow the filters.");
    expect(result.structuredContent).toMatchObject({ total: 60, offset: 0, limit: 50, returned: 50, hasMore: true });
  });

  it("sorts by workflow status order, then task id", async () => {
    const board = makeBoard();
    seed(board, 3, (index) => ["done", "working", "new"][index - 1]);
    const tools = loadExtension();

    const result = await list(tools, { project: board.root }, board.root);
    const ids = (result.structuredContent?.tasks as Array<{ id: string }>).map((task) => task.id);
    // new: T-0003, working: T-0002, done: T-0001
    expect(ids).toEqual(["T-0003", "T-0002", "T-0001"]);
    const text = result.content[0].text;
    expect(text.indexOf("T-0003")).toBeLessThan(text.indexOf("T-0002"));
    expect(text.indexOf("T-0002")).toBeLessThan(text.indexOf("T-0001"));
  });

  it("treats an offset past the end as an empty page, not an error", async () => {
    const board = makeBoard();
    seed(board, 4);
    const tools = loadExtension();

    const result = await list(tools, { offset: 4, limit: 50, project: board.root }, board.root);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("  No tasks at offset 4; 4 match. Reset with offset 0.");
    expect(result.structuredContent).toMatchObject({ total: 4, offset: 4, returned: 0, hasMore: false });
  });

  it("prints the workflow block for a page and does not grow with the board", async () => {
    const small = makeBoard();
    seed(small, 5);
    const large = makeBoard();
    seed(large, 60);
    const tools = loadExtension();

    const smallText = (await list(tools, { project: small.root }, small.root)).content[0].text;
    const largeText = (await list(tools, { limit: 5, project: large.root }, large.root)).content[0].text;
    const blockOf = (text: string) => text.slice(text.indexOf("Workflow: "));

    expect(blockOf(largeText)).toBe(blockOf(smallText));
    expect(largeText).toContain("initial=new");
  });
});

describe("summary", () => {
  it("returns counts only, with no task rows", async () => {
    const board = makeBoard();
    seed(board, 60, (index) => (index % 3 === 0 ? "working" : index % 3 === 1 ? "done" : "new"));
    const tools = loadExtension();

    const result = await list(tools, { summary: true, project: board.root }, board.root);
    const text = result.content[0].text;

    expect(text).toContain("Board  .pi/kanban");
    expect(text).toContain("60 tasks");
    expect(text).toMatch(/◆ Working\s+20\s+0 claimed/);
    expect(text).toMatch(/◇ New\s+20\s+0 claimed/);
    expect(text).toMatch(/◇ Done\s+20\s+terminal/);
    expect(text).not.toContain("T-0001");
    expect(text).not.toContain("showing ");
    expect(result.structuredContent).toMatchObject({ total: 60, returned: 0, hasMore: false });
    expect((result.structuredContent?.tasks as unknown[]).length).toBe(0);
  });

  it("applies filters before counting", async () => {
    const board = makeBoard();
    seed(board, 10, (index) => (index <= 4 ? "working" : "new"));
    const tools = loadExtension();

    const result = await list(tools, { summary: true, status: "working", project: board.root }, board.root);
    expect(result.structuredContent?.total).toBe(4);
    expect(result.content[0].text).toContain("4 tasks");
    expect(result.content[0].text).not.toContain("10 tasks");
  });
});
