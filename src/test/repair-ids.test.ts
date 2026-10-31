/**
 * T-0016: `/kanban repair-ids` renames a task file to the id its frontmatter
 * declares, and raises a low `counter.json` without ever lowering it. The
 * filename is the identity source of truth; prose is never rewritten.
 *
 * Every assertion is a line from `docs/product/design-v0.3.md` §5 and §7
 * (T-0016), including the literal output blocks.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveBoard, type BoardLocation } from "../paths.ts";
import { planRepairIds, repairIds, repairRefusal, validateBoard } from "../store.ts";
import { handleKanbanCommand } from "../command.ts";

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

/** Run `/kanban <args>` and return what it notified. */
async function kanban(board: BoardLocation, args: string): Promise<string> {
  const out: string[] = [];
  const ctx = { cwd: board.root, ui: { notify: (message: string) => out.push(message) } } as unknown as ExtensionCommandContext;
  await handleKanbanCommand(args, ctx);
  return out.join("\n");
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

describe("the dry run is a read", () => {
  it("prints the rename and says nothing was written", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    const text = await kanban(board, "repair-ids --dry-run");
    expect(text).toContain("  rename  T-0002.md -> T-0009.md");
    expect(text).toContain("Nothing was written.");
    expect(text).toContain("(dry run: nothing written)");
    expect(text).toContain("  counter next 12 is already above T-0009; left unchanged");
  });

  it("leaves every task file and counter.json byte-identical, and takes no lock", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);
    const before = snapshot(board);

    await kanban(board, "repair-ids --dry-run");

    expect(snapshot(board)).toEqual(before);
    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("prints the plan without a flag and writes nothing", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);
    const before = snapshot(board);

    const text = await kanban(board, "repair-ids");

    expect(text).toContain("(nothing written)");
    expect(text).toContain("Re-run with --yes to confirm:  /kanban repair-ids --yes");
    expect(snapshot(board)).toEqual(before);
  });
});

describe("applying the plan", () => {
  it("renames the file, keeps its declared id, and clears id_mismatch", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    await kanban(board, "repair-ids --yes");

    expect(existsSync(join(board.tasksDir, "T-0002.md"))).toBe(false);
    expect(existsSync(join(board.tasksDir, "T-0009.md"))).toBe(true);
    expect(read(join(board.tasksDir, "T-0009.md"))).toContain("id: T-0009");
    expect(validateBoard(board).problems.filter((problem) => problem.code === "id_mismatch")).toEqual([]);
  });

  it("prints the apply block with the operator", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    const text = await kanban(board, "repair-ids --yes");
    expect(text).toContain("Repaired 1 task id.");
    expect(text).toContain("  renamed  T-0002.md -> T-0009.md   id: T-0009");
    expect(text).toContain("  by       @human");
    expect(text).toContain("Run /kanban validate to confirm the board is clean.");
  });

  it("names the operator given by --as", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);

    expect(await kanban(board, "repair-ids --yes --as reviewer")).toContain("  by       @reviewer");
  });

  it("never bumps rev, updated, or history: a rename is not task activity", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix duplicate ids after a merge") }, 12);
    const before = read(join(board.tasksDir, "T-0002.md"));

    await kanban(board, "repair-ids --yes");

    // A rename is not task activity: the file is byte-identical, only its name
    // changed. No `rev` bump, no `updated` rewrite, no history entry.
    expect(read(join(board.tasksDir, "T-0009.md"))).toBe(before);
    expect(before).toContain("rev: 1");
  });

  it("applies a swap in two passes, with both ids correct", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0005", "Second"), "T-0005.md": taskFileText("T-0002", "Fifth") }, 12);

    const text = await kanban(board, "repair-ids --yes");

    expect(text).toContain("Repaired 2 task ids.");
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

    await kanban(board, "repair-ids --yes");

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

    const text = await kanban(board, "repair-ids --yes");

    expect(text).toContain("1 file was skipped and needs a hand edit:");
    expect(text).toContain(`  T-0007.md  no string "id" in frontmatter`);
    expect(existsSync(join(board.tasksDir, "T-0009.md"))).toBe(true);
    expect(existsSync(join(board.tasksDir, "T-0007.md"))).toBe(true);
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
});

describe("counter.json is raised, never lowered", () => {
  it("raises a low counter and clears counter_low", async () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 3);

    const text = await kanban(board, "repair-ids --yes");

    expect(text).toContain("  counter  next 3 -> 10  (raised above the highest id T-0009)");
    expect(text).toContain("Repaired 1 task id.");
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(10);
    expect(validateBoard(board).problems.filter((problem) => problem.code === "counter_low")).toEqual([]);
  });

  it("prints no renamed line when only the counter changes", async () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 3);

    const text = await kanban(board, "repair-ids --yes");
    expect(text).toContain("  by       @human");
    expect(text).not.toContain("renamed ");
  });

  it("does not touch a counter that is already above the highest id", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Ninth") }, 12);
    const bytes = read(join(board.dir, "counter.json"));

    await kanban(board, "repair-ids --yes");

    expect(read(join(board.dir, "counter.json"))).toBe(bytes);
  });

  it("reports nothing to repair on a clean board and writes nothing", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0002", "Fine") }, 12);
    const before = snapshot(board);

    const text = await kanban(board, "repair-ids --dry-run");

    expect(text).toContain("Nothing to repair: every frontmatter id matches its filename.");
    expect(text).toContain("  board    .pi/kanban");
    expect(text).toContain("  counter  next 12, above the highest id T-0002");
    expect(snapshot(board)).toEqual(before);
  });

  it("never lowers a counter that is somehow below the highest id after a hand edit", async () => {
    const board = boardWith({ "T-0009.md": taskFileText("T-0009", "Ninth") }, 40);

    // 40 > 9, so the plan has no counter change at all and the file keeps 40.
    await kanban(board, "repair-ids --yes");
    expect(JSON.parse(read(join(board.dir, "counter.json"))).next).toBe(40);
  });
});

describe("refusals write nothing", () => {
  it("refuses --dry-run --yes together", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);
    const before = snapshot(board);

    const text = await kanban(board, "repair-ids --dry-run --yes");

    expect(text).toContain("/kanban repair-ids takes one of two flags.");
    expect(text).toContain("Both at once is ambiguous; nothing was written.");
    expect(snapshot(board)).toEqual(before);
  });

  it("refuses a rename target that already exists", async () => {
    const board = boardWith(
      { "T-0002.md": taskFileText("T-0009", "Duplicate"), "T-0009.md": taskFileText("T-0009", "Original") },
      12,
    );
    const before = snapshot(board);

    const text = await kanban(board, "repair-ids --yes");

    expect(text).toContain("Cannot repair: T-0009.md already exists and T-0002.md declares id T-0009.");
    expect(text).toContain("Nothing written. Rename or delete one of them by hand, then re-run.");
    expect(snapshot(board)).toEqual(before);
  });

  it("refuses two files declaring the same id", async () => {
    const board = boardWith(
      { "T-0002.md": taskFileText("T-0009", "A"), "T-0005.md": taskFileText("T-0009", "B") },
      12,
    );
    const before = snapshot(board);

    const text = await kanban(board, "repair-ids --yes");

    expect(text).toContain("Cannot repair: two files declare the same id.");
    expect(text).toContain("  T-0002.md  declares T-0009");
    expect(text).toContain("  T-0005.md  declares T-0009");
    expect(snapshot(board)).toEqual(before);
  });

  it("refuses a duplicate id on the dry run too", async () => {
    const board = boardWith(
      { "T-0002.md": taskFileText("T-0009", "A"), "T-0005.md": taskFileText("T-0009", "B") },
      12,
    );

    expect(await kanban(board, "repair-ids --dry-run")).toContain("Cannot repair: two files declare the same id.");
  });
});

describe("the plan itself", () => {
  it("enumerates from filenames and reports every mismatch", () => {
    const board = boardWith(
      {
        "T-0001.md": taskFileText("T-0001", "Fine"),
        "T-0002.md": taskFileText("T-0009", "Mismatch"),
      },
      12,
    );

    const plan = planRepairIds(board);
    expect(plan.dir).toBe(board.dir);
    expect(plan.renames).toHaveLength(1);
    expect(plan.renames[0].filenameId).toBe("T-0002");
    expect(plan.renames[0].declaredId).toBe("T-0009");
    expect(plan.renames[0].target).toBe(join(board.tasksDir, "T-0009.md"));
    expect(plan.counter).toBeUndefined();
    expect(repairRefusal(plan)).toBeUndefined();
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

  it("re-plans under the lock rather than trusting a plan passed in", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);
    // A plan computed before the board changes must not bind the call.
    const stale = planRepairIds(board);
    writeFileSync(join(board.tasksDir, "T-0002.md"), taskFileText("T-0002", "Fixed by hand"), "utf8");

    const { plan, applied } = await repairIds(board, "human");

    expect(stale.renames).toHaveLength(1);
    expect(plan.renames).toEqual([]);
    expect(applied).toBe(false);
  });

  it("takes the board lock and releases it", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);

    await repairIds(board, "human");

    expect(existsSync(join(board.dir, ".lock"))).toBe(false);
  });

  it("rejects an invalid operator handle before writing", async () => {
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix") }, 12);

    await expect(repairIds(board, "not a handle")).rejects.toThrow(/Invalid agent/);
    expect(existsSync(join(board.tasksDir, "T-0002.md"))).toBe(true);
  });

  it("does not rewrite prose that mentions the old id", async () => {
    const body = "See T-0002 for the history of this. <!-- kanban:comment at=2026-10-30T09:00:00.000Z by=pm -->\nT-0002 again.\n";
    const board = boardWith({ "T-0002.md": taskFileText("T-0009", "Fix", body) }, 12);

    await kanban(board, "repair-ids --yes");

    const after = read(join(board.tasksDir, "T-0009.md"));
    expect(after).toContain("See T-0002 for the history of this.");
    expect(after).toContain("T-0002 again.");
  });
});
