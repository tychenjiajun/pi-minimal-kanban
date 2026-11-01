/**
 * T-0016: id repair renames a task file to the id its frontmatter declares, and
 * raises a low `counter.json` without ever lowering it. The filename is the
 * identity source of truth; prose is never rewritten.
 *
 * Since 0.4.0 `/kanban` is read-only, so `repair-ids` is no longer a
 * subcommand: these tests pin the behaviour of the exported store functions
 * (`planRepairIds`, `repairIds`, `repairRefusal`) that the tools build on.
 *
 * Every assertion is a line from `docs/product/design-v0.3.md` §5 and §7
 * (T-0016).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBoard, type BoardLocation } from "../paths.ts";
import { planRepairIds, repairIds, repairRefusal, validateBoard } from "../store.ts";

/** A board built file by file, so a corrupted `id` can be written literally. */
function boardWith(files: Record<string, string>, counter?: number): BoardLocation {
  const root = mkdtempSync(join(tmpdir(), "repair-"));
  const dir = join(root, ".pi/kanban");
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(
    join(dir, "workflow.yaml"),
    "name: linear\ninitial: new\nstatuses:\n  - id: new\n    label: New\n  - id: done\n    label: Done\n    terminal: true\ntransitions:\n  new: [done]\n  done: [new]\n",
    "utf8",
  );
  if (counter !== undefined) writeFileSync(join(dir, "counter.json"), `${JSON.stringify({ next: counter }, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "tasks", name), text, "utf8");
  return resolveBoard({ cwd: root, env: {} });
}

function taskFileText(id: string, title: string, body = ""): string {
  return `---\nid: ${id}\ntitle: ${title}\nstatus: new\ncreated: 2026-10-30T09:00:00.000Z\nupdated: 2026-10-30T10:05:00.000Z\nrev: 1\nhistory: []\n---\n\n${body}`;
}

const read = (path: string) => readFileSync(path, "utf8");

/** Names in one directory, sorted, or empty when it does not exist. */
function namesIn(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/** Every byte under `.pi/kanban`, so "nothing was written" is checkable. */
function snapshot(board: BoardLocation): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of namesIn(dir)) {
      const path = join(dir, name);
      try {
        out.set(path, read(path));
      } catch {
        walk(path);
      }
    }
  };
  walk(board.dir);
  return out;
}

describe("planRepairIds is a read", () => {
  it("names the rename the filename/declared-id mismatch needs", () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    const plan = planRepairIds(board);
    expect(plan.dir).toBe(board.dir);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0].filenameId).toBe("T-0002");
    expect(plan.renames[0].declaredId).toBe("T-0009");
    expect(plan.renames[0].target).toBe(join(board.tasksDir, "T-0009.md"));
    // 12 is already above T-0009, so there is nothing to raise.
    expect(plan.counter).toBeUndefined();
    expect(plan.skipped).toEqual([]);
    expect(repairRefusal(plan)).toBeUndefined();
  });

  it("leaves every task file and counter.json byte-identical, and takes no lock", () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);
    const before = snapshot(board);

    planRepairIds(board);

    expect(snapshot(board)).toEqual(before);
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("reports nothing to repair on a clean board", () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0002", "Fine") }, 12);
    const before = snapshot(board);

    const plan = planRepairIds(board);

    expect(plan.renames).toEqual([]);
    expect(plan.counter).toBeUndefined();
    expect(plan.skipped).toEqual([]);
    expect(snapshot(board)).toEqual(before);
  });

  it("is sorted by filename id", () => {
    const board = boardWith(
      {
        "T-0005.md": taskFileText("T-0030", "Five"),
        "T-0002.md": taskFileText("T-0020", "Two"),
      },
      40,
    );

    expect(planRepairIds(board).renames.map((rename) => rename.filenameId)).toEqual(["T-0002", "T-0005"]);
  });

  it("skips an id that is not a canonical task id", () => {
    const board = boardWith({ "T-0002.md": taskFileText("not-an-id", "Bad") }, 12);

    const plan = planRepairIds(board);
    expect(plan.renames).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].message).toContain("invalid id");
  });

  it("skips a file that is not a task file at all", () => {
    const board = boardWith({ "T-0002.md": "garbage\n" }, 12);

    expect(planRepairIds(board).skipped[0].message).toBe("not a readable task file");
  });

  it("surfaces a leftover .repair file as an interrupted run", () => {
    const board = boardWith({
      "T-0002.md": taskFileText("T-0002", "Fine"),
      ".repair.abc123.T-0003.md": taskFileText("T-0003", "Stranded"),
    });

    expect(planRepairIds(board).skipped).toEqual([
      { path: join(board.tasksDir, ".repair.abc123.T-0003.md"), message: "interrupted repair: restore or delete by hand" },
    ]);
  });

  it("leaves the counter alone when it is already above the highest id", () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 40);

    // 40 > 9, so the plan has no counter change at all and the file keeps 40.
    const plan = planRepairIds(board);
    expect(plan.counter).toBeUndefined();
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(40);
  });
});

describe("repairIds applies the plan", () => {
  it("renames the file, keeps its declared id, and clears id_mismatch", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(true);
    expect(plan.renames.map((rename) => `${rename.filenameId} -> ${rename.declaredId}`)).toEqual(["T-0002 -> T-0009"]);
    expect(existsSync(join(board.tasksDir, "T-0002.md"))).toBe(false);
    expect(existsSync(join(board.tasksDir, "T-0009.md"))).toBe(true);
    expect(read(join(board.tasksDir, "T-0009.md"))).toContain("id: T-0009");
    expect(validateBoard(board).problems.filter((problem) => problem.code === "id_mismatch")).toEqual([]);
  });

  it("never bumps rev, updated, or history: a rename is not task activity", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);
    const before = read(join(board.tasksDir, "T-0002.md"));

    await repairIds(board, "human");

    // A rename is not task activity: the file is byte-identical, only its name
    // changed. No `rev` bump, no `updated` rewrite, no history entry.
    expect(read(join(board.tasksDir, "T-0009.md"))).toBe(before);
    expect(before).toContain("rev: 1");
  });

  it("does not rewrite prose that mentions the old id", async () => {
    const body = "See T-0002 for the history of this. <!-- kanban:comment at=2026-10-30T09:00:00.000Z by=pm -->\nT-0002 again.\n";
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix", body) }, 12);

    await repairIds(board, "human");

    const after = read(join(board.tasksDir, "T-0009.md"));
    expect(after).toContain("See T-0002 for the history of this.");
    expect(after).toContain("T-0002 again.");
  });

  it("applies a swap in two passes, with both ids correct", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0005", "Second"), "T-0005.md": taskFileText("T-0002", "Fifth") }, 12);

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(true);
    expect(plan.renames).toHaveLength(2);
    expect(read(join(board.tasksDir, "T-0002.md"))).toContain("id: T-0002");
    expect(read(join(board.tasksDir, "T-0005.md"))).toContain("id: T-0005");
    // Neither task took the other's text: the swap really swapped.
    expect(read(join(board.tasksDir, "T-0002.md"))).toContain("title: Fifth");
    expect(read(join(board.tasksDir, "T-0005.md"))).toContain("title: Second");
    expect(validateBoard(board).problems.filter((problem) => problem.code === "id_mismatch")).toEqual([]);
  });

  it("applies a chain in two passes", async () => {
    const board = boardWith(
      {
        "T-0002.md": taskFileText("T-0003", "Two"),
        "T-0003.md": taskFileText("T-0004", "Three"),
      },
      12,
    );

    await repairIds(board, "human");

    expect(read(join(board.tasksDir, "T-0003.md"))).toContain("title: Two");
    expect(read(join(board.tasksDir, "T-0004.md"))).toContain("title: Three");
  });

  it("skips a file with no string id and still applies the rest", async () => {
    const board = boardWith(
      {
        "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge"),
        "T-0007.md": "---\ntitle: no id here\nstatus: new\n---\n",
      },
      12,
    );

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(true);
    expect(plan.skipped).toEqual([{ path: join(board.tasksDir, "T-0007.md"), message: `no string "id" in frontmatter` }]);
    expect(existsSync(join(board.tasksDir, "T-0009.md"))).toBe(true);
    expect(existsSync(join(board.tasksDir, "T-0007.md"))).toBe(true);
  });

  it("takes the board lock and releases it", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);

    await repairIds(board, "human");

    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("re-plans under the lock rather than trusting a plan passed in", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);
    // A plan computed before the board changes must not bind the call.
    const stale = planRepairIds(board);
    writeFileSync(join(board.tasksDir, "T-0002.md"), taskFileText("T-0002", "Fixed by hand"), "utf8");
    const before = snapshot(board);

    const { plan, applied } = await repairIds(board, "human");

    expect(stale.renames).toHaveLength(1);
    expect(plan.renames).toEqual([]);
    expect(applied).toBe(false);
    expect(snapshot(board)).toEqual(before);
  });

  it("rejects an invalid operator handle before writing", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);
    const before = snapshot(board);

    await expect(repairIds(board, "not a handle")).rejects.toThrow(/Invalid agent/);
    expect(snapshot(board)).toEqual(before);
  });
});

describe("counter.json is raised, never lowered", () => {
  it("raises a low counter to one above the highest id and clears counter_low", async () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 3);

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(true);
    expect(plan.renames).toEqual([]);
    expect(plan.counter).toEqual({ from: 3, to: 10 });
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(10);
    expect(validateBoard(board).problems.filter((problem) => problem.code === "counter_low")).toEqual([]);
  });

  it("raises the counter above a planned declared id, not just a filename", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Ninth") }, 3);

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(true);
    expect(plan.counter).toEqual({ from: 3, to: 10 });
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(10);
    expect(existsSync(join(board.tasksDir, "T-0009.md"))).toBe(true);
  });

  it("does not touch a counter that is already above the highest id", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Ninth") }, 12);
    const bytes = read(join(board.dir, "counter.json"));

    await repairIds(board, "human");

    expect(read(join(board.dir, "counter.json"))).toBe(bytes);
  });

  it("writes nothing and reports applied: false on a clean board with a healthy counter", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0002", "Fine") }, 12);
    const before = snapshot(board);

    const { plan, applied } = await repairIds(board, "human");

    expect(applied).toBe(false);
    expect(plan.renames).toEqual([]);
    expect(plan.counter).toBeUndefined();
    expect(snapshot(board)).toEqual(before);
  });

  it("never lowers a counter that is somehow below the highest id after a hand edit", async () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 40);

    // 40 > 9, so the plan has no counter change at all and the file keeps 40.
    await repairIds(board, "human");
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(40);
  });
});

describe("refusals write nothing", () => {
  it("refuses a rename target that already exists", async () => {
    const board = boardWith(
      { "T-0002.md": taskFileText("T-0009", "Duplicate"), "T-0009.md": taskFileText("T-0009", "Original") },
      12,
    );
    const before = snapshot(board);

    const plan = planRepairIds(board);
    expect(repairRefusal(plan)).toEqual({
      kind: "target_exists",
      entry: { filename: "T-0002.md", declaredId: "T-0009", existing: "T-0009.md" },
    });

    const result = await repairIds(board, "human");
    expect(result.applied).toBe(false);
    expect(snapshot(board)).toEqual(before);
  });

  it("refuses two files declaring the same id", async () => {
    const board = boardWith(
      { "T-0002.md": taskFileText("T-0009", "A"), "T-0005.md": taskFileText("T-0009", "B") },
      12,
    );
    const before = snapshot(board);

    const plan = planRepairIds(board);
    expect(repairRefusal(plan)).toEqual({
      kind: "duplicate",
      entries: [
        { filename: "T-0002.md", declaredId: "T-0009" },
        { filename: "T-0005.md", declaredId: "T-0009" },
      ],
    });

    const result = await repairIds(board, "human");
    expect(result.applied).toBe(false);
    expect(snapshot(board)).toEqual(before);
  });

  it("allows a swap: both targets are sources, so neither is a blocking target", () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0005", "Second"), "T-0005.md": taskFileText("T-0002", "Fifth") }, 12);

    expect(repairRefusal(planRepairIds(board))).toBeUndefined();
  });
});
