import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stealLock, withBoardLock } from "../fs.ts";
import { createTask, readBoard, readTask } from "../store.ts";
import { makeBoard } from "./helpers.ts";

/** Run a script in a separate Node process against the same board. */
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

describe("file lock", () => {
  it("serialises two in-process callers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    const order: string[] = [];

    const first = withBoardLock(lock, async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push("a:end");
    });
    const second = withBoardLock(lock, async () => {
      order.push("b:start");
      order.push("b:end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("releases the lock when the body throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    await expect(withBoardLock(lock, () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    // A second acquisition proves the first released.
    await withBoardLock(lock, () => undefined);
  });

  it("queues in-process callers instead of failing them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    const holder = withBoardLock(lock, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await withBoardLock(lock, () => undefined);
    // The second caller waited for the first rather than timing out.
    expect(Date.now() - started).toBeGreaterThan(60);
    await holder;
  });

  it("only steals the lock whose owner token it judged stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 1, token: "fresh", at: Date.now(), host: hostname() }),
      "utf8",
    );

    // The owner changed between the staleness check and the steal: restore it.
    expect(stealLock(lock, "stale")).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBe("fresh");

    // The no-owner path must never delete a lock that has an owner.
    expect(stealLock(lock, null)).toBe(false);
    expect(existsSync(lock)).toBe(true);

    // The lock we judged stale is removed.
    expect(stealLock(lock, "fresh")).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // A second thief finds nothing to rename and reports a lost race.
    expect(stealLock(lock, "fresh")).toBe(false);
  });

  it("leaves a foreign lock alone when release runs with another token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");

    await withBoardLock(lock, () => {
      // Another process took over the lock directory under us.
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, token: "intruder", at: Date.now(), host: hostname() }),
        "utf8",
      );
    });

    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBe("intruder");
  });

  it("leaves the no-owner path its own recovery when owner.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");

    await withBoardLock(lock, () => {
      // A half-written lock has no readable owner: release() must not guess.
      rmSync(join(lock, "owner.json"), { force: true });
    });

    expect(existsSync(lock)).toBe(true);

    // Left for the no-owner recovery path, which the next caller drives...
    const dirStat = statSync(lock);
    expect(Date.now() - dirStat.mtimeMs).toBeLessThan(5_000);
  });

  it("releases only its own token, never a directory it did not move", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "someone-else", at: Date.now(), host: hostname() }),
      "utf8",
    );

    // A lock carrying a live foreign token is never moved or deleted.
    expect(stealLock(lock, "mine")).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBe("someone-else");
  });

  it("takes its own tombstone with it when a recovery moved the lock aside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    const tombstone = `${lock}.steal.moved`;
    let ours: string | undefined;

    await withBoardLock(lock, () => {
      ours = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token;
      // A recovery moves our live lock aside, and someone else takes the path.
      renameSync(lock, tombstone);
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, token: "other", at: Date.now(), host: hostname() }),
        "utf8",
      );
    });

    // Our release did not delete the foreign lock, and it cleaned up after
    // itself: a live-pid tombstone is otherwise unreapable and would stall
    // every writer for the whole grace period.
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBe("other");
    expect(existsSync(tombstone)).toBe(false);
    expect(ours).toBeTypeOf("string");
  });

  it("refuses to restore a tombstone onto a directory it did not move", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      // The token changed after the staleness read, so this steal must restore.
      JSON.stringify({ pid: process.pid, token: "newer", at: Date.now(), host: hostname() }),
      "utf8",
    );
    let movedAside: string | undefined;

    // A directory appears at the path between the move and the restore — exactly
    // a half-built lock, which POSIX `rename` would replace silently.
    const removed = stealLock(lock, "judged-stale", {
      beforeVerify: (tombstone) => {
        movedAside = tombstone;
      },
      beforeRestore: (tombstone, target) => {
        expect(target).toBe(lock);
        expect(existsSync(tombstone)).toBe(true);
        mkdirSync(target, { recursive: true });
      },
    });

    expect(removed).toBe(false);
    expect(movedAside).toBeDefined();
    // The restore refused: the directory at the path is still the empty one, and
    // the moved lock is left for the reaper instead of being swapped in.
    expect(readdirSync(lock)).toEqual([]);
    expect(existsSync(movedAside!)).toBe(true);
  });

  it("never restores a tombstone onto a lock directory someone else created", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "moved", at: Date.now(), host: hostname() }),
      "utf8",
    );

    // A recovery moved it aside, and a new owner took the path before the verify.
    const tombstone = `${lock}.steal.deadbeef`;
    renameSync(lock, tombstone);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "new", at: Date.now(), host: hostname() }),
      "utf8",
    );

    expect(stealLock(lock, "stale")).toBe(false);
    // The newcomer's lock is intact — not replaced by the moved directory — and
    // the moved one is still on disk for the reaper.
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBe("new");
    expect(existsSync(tombstone)).toBe(true);
  });

  it("never puts an empty lock directory in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");

    await withBoardLock(
      lock,
      () => {
        // Entry is a rename of a complete entry directory, so the lock the
        // critical section runs under always carries its owner.json, and no
        // half-built directory is left next to it.
        expect(existsSync(join(lock, "owner.json"))).toBe(true);
        const strays = readdirSync(dir).filter((name) => name.includes(".entry.") || name.includes(".steal."));
        expect(strays).toEqual([]);
      },
      { staleMs: 1, acquireTimeoutMs: 2_000 },
    );
    expect(existsSync(lock)).toBe(false);
  });

  it("reaps tombstones a crashed recovery left behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    const host = hostname();
    // A dead pid on this host: no such process, and kill(2) reports ESRCH.
    const deadPid = 2 ** 31 - 1;

    // (1) crash between the rename and the delete: no owner.json at all.
    const ownerless = `${lock}.steal.ownerless`;
    mkdirSync(ownerless, { recursive: true });
    // (2) a tombstone whose owner is dead on this host.
    const dead = `${lock}.steal.dead`;
    mkdirSync(dead, { recursive: true });
    writeFileSync(
      join(dead, "owner.json"),
      JSON.stringify({ pid: deadPid, token: "dead", at: Date.now(), host }),
      "utf8",
    );

    // A lock that would otherwise be refused for as long as the tombstones live.
    await withBoardLock(lock, () => undefined, { staleMs: 60_000, acquireTimeoutMs: 3_000 });

    expect(existsSync(ownerless)).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps a tombstone whose owner may still put it back, and names it on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    const tombstone = `${lock}.steal.inflight`;
    mkdirSync(tombstone, { recursive: true });
    writeFileSync(
      join(tombstone, "owner.json"),
      // Our own pid: alive on this host, with a fresh directory, so the recovery
      // may be about to restore it.
      JSON.stringify({ pid: process.pid, token: "inflight", at: Date.now(), host: hostname() }),
      "utf8",
    );

    await expect(
      withBoardLock(lock, () => undefined, { staleMs: 60_000, acquireTimeoutMs: 150 }),
    ).rejects.toThrow(tombstone);
    expect(existsSync(tombstone)).toBe(true);
  });

  it("does not delete a lock that changed hands between the staleness read and the delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "stale", at: Date.now() - 60_000, host: hostname() }),
      "utf8",
    );

    let seamCalls = 0;
    let seen: string | undefined;
    let seenAfterSteal: string | undefined;
    const acquired = withBoardLock(lock, () => "body", {
      staleMs: 1,
      acquireTimeoutMs: 5_000,
      beforeSteal: (attempt) => {
        seamCalls += 1;
        seen = attempt.owner?.token;
        // A live owner takes the lock between the staleness read and the delete.
        writeFileSync(
          join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, token: "live", at: Date.now(), host: hostname() }),
          "utf8",
        );
        // Inspect what the recovery did to that live lock, then let the (now
        // stale) live owner go so the test finishes.
        setImmediate(() => {
          try {
            seenAfterSteal = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token;
          } catch {
            seenAfterSteal = "gone";
          }
          rmSync(lock, { recursive: true, force: true });
        });
      },
    });

    await expect(acquired).resolves.toBe("body");
    expect(seen).toBe("stale");
    expect(seamCalls).toBe(1);
    // The live owner's lock was put back by the verify, not deleted by the steal.
    expect(seenAfterSteal).toBe("live");
    expect(readdirSync(dir).filter((name) => name.includes(".steal."))).toEqual([]);
  });

  it("times out when a foreign process owns the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"));
    const lock = join(dir, ".lock");
    mkdirSync(lock, { recursive: true });
    // PID 1 is alive on every POSIX host but is not us, so the lock is foreign
    // and never considered stale during this test.
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 1, token: "foreign", at: Date.now(), host: require("node:os").hostname() }),
      "utf8",
    );

    await expect(withBoardLock(lock, () => undefined, { acquireTimeoutMs: 80, staleMs: 60_000 })).rejects.toThrow(
      /locked/,
    );
  });
});

describe("cross-process claims", () => {
  it("stops two processes from claiming the same task", async () => {
    const board = makeBoard();
    const task = await createTask(board, { title: "contested", agent: "seed" });

    // Both children try to move T-0001 into `working` at the same time; exactly
    // one must win the claim, the other must fail with wrong_owner.
    const script = `
import { moveTask } from ${JSON.stringify(join(import.meta.dirname, "../store.ts"))};
import { resolveBoard } from ${JSON.stringify(join(import.meta.dirname, "../paths.ts"))};
const root = process.argv[2];
const agent = process.argv[3];
const board = resolveBoard({ cwd: root, env: {} });
const delay = Number(process.argv[4] ?? 0);
await new Promise((r) => setTimeout(r, delay));
try {
  const task = await moveTask(board, { task: "T-0001", to: "working", agent });
  console.log(JSON.stringify({ ok: true, assignee: task.assignee }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.details?.code ?? "error" }));
}
`;
    const [a, b] = await Promise.all([
      runChild(script, [board.root, "alpha", "0"]),
      runChild(script, [board.root, "beta", "5"]),
    ]);

    const results = [a, b].map((result) => JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"));
    const winners = results.filter((result) => result.ok === true);
    const losers = results.filter((result) => result.ok !== true);
    // Exactly one process wins the claim. The loser is refused either because
    // the winner already holds the claim (wrong_owner) or because the winner's
    // move landed first and the task is already in the target status. Both
    // outcomes keep a single assignee; which process wins is a race.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(["wrong_owner", "already_in_status"]).toContain(losers[0].code);

    const after = readTask(board, task.id);
    expect(after.status).toBe("working");
    expect(after.assignee).toBe(winners[0].assignee);
    expect(after.history.filter((entry) => entry.action === "assign")).toHaveLength(1);
  });
});

describe("stale lock recovery across processes", () => {
  /**
   * Smoke test for the recovery path under real contention, not a regression
   * test for the blind-delete race (that is the deterministic seam test above).
   *
   * A holder takes the lock and stays alive inside its critical section while
   * its lock age passes the contenders' `staleMs`; it then `process.exit`s
   * without releasing, leaving the directory behind. The contenders inherit that
   * stale lock and then contend with each other. Their sections do a
   * read-modify-write with a sleep in the middle, guarded by an exclusive
   * inside-marker, so a lost update or two simultaneous holders would show.
   *
   * The holder does no read-modify-write, so a wrongful steal of *its* lock is
   * not observable here — the seam test covers that window deterministically.
   */
  const SCRIPT = `
import { withBoardLock } from ${JSON.stringify(join(import.meta.dirname, "../fs.ts"))};
import { createTask } from ${JSON.stringify(join(import.meta.dirname, "../store.ts"))};
import { resolveBoard } from ${JSON.stringify(join(import.meta.dirname, "../paths.ts"))};
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const role = process.argv[3];
const iterationCount = Number(process.argv[4] ?? 3);
const phase = process.argv[5] ?? "0";
const journal = join(root, "journal-" + phase + ".log");
const marker = join(root, "inside.marker");
const counterPath = join(root, "counter-" + phase + ".txt");
const board = resolveBoard({ cwd: root, env: {} });
const lock = join(board.dir, ".lock");
const log = (line) => appendFileSync(journal, line + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readCounter = () => {
  try {
    return Number(readFileSync(counterPath, "utf8")) || 0;
  } catch {
    return 0;
  }
};

if (role === "holder") {
  // Written outside the lock: the store takes the same lock itself.
  await createTask(board, { title: "held " + phase, agent: "holder" });
  await withBoardLock(
    lock,
    async () => {
      log("holding");
      await sleep(iterationCount);
      // Crash while holding: release() never runs, so the lock survives.
      process.exit(0);
    },
    { staleMs: 60_000, acquireTimeoutMs: 10_000 },
  );
} else {
  for (let i = 0; i < iterationCount; i += 1) {
    await withBoardLock(
      lock,
      async () => {
        let mine = false;
        try {
          writeFileSync(marker, role, { flag: "wx" });
          mine = true;
        } catch (error) {
          if (error && error.code === "EEXIST") {
            let other = "?";
            try {
              other = readFileSync(marker, "utf8");
            } catch {
              /* the other process left between the two calls */
            }
            log("violation " + role + " overlapping " + other);
          } else {
            throw error;
          }
        }
        const value = readCounter();
        await sleep(40);
        writeFileSync(counterPath, String(value + 1));
        if (mine) rmSync(marker, { force: true });
      },
      { staleMs: 200, acquireTimeoutMs: 20_000 },
    );
  }
  // Real board writes, through the store's own lock.
  for (let i = 0; i < 2; i += 1) {
    await createTask(board, { title: role + " task " + phase + "/" + i, agent: role });
  }
  log("done " + role);
}
`;

  const WORKERS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const ITERATIONS = 2;

  it("recovers the lock once and loses no update when contenders pass staleMs", async () => {
    const board = makeBoard();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Two rounds of the same race: a holder dies inside its critical section
    // and eight fresh contenders all judge the leftover lock stale at once.
    for (let phase = 0; phase < 2; phase += 1) {
      const journal = join(board.root, `journal-${phase}.log`);
      const holder = runChild(SCRIPT, [board.root, "holder", "400", String(phase)]);

      // Wait until the holder is inside its critical section, then wait past the
      // contenders' staleMs so its lock looks abandoned to all of them.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(journal) && readFileSync(journal, "utf8").includes("holding")) break;
        await wait(20);
      }
      expect(existsSync(join(board.dir, ".lock"))).toBe(true);
      await wait(300);

      const results = await Promise.all([
        holder,
        ...WORKERS.map((role) => runChild(SCRIPT, [board.root, role, String(ITERATIONS), String(phase)])),
      ]);
      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
      }

      const lines = readFileSync(journal, "utf8").trim().split("\n");
      // A stolen live lock shows up as two processes inside at the same time.
      expect(lines.filter((line) => line.startsWith("violation"))).toEqual([]);
      expect(WORKERS.every((role) => lines.includes(`done ${role}`))).toBe(true);
      // A read-modify-write that interleaved drops one increment per overlap.
      expect(Number(readFileSync(join(board.root, `counter-${phase}.txt`), "utf8"))).toBe(
        WORKERS.length * ITERATIONS,
      );
      // Every lock was released by its owner and no tombstone was left behind.
      expect(existsSync(join(board.dir, ".lock"))).toBe(false);
      expect(readdirSync(board.dir).filter((name) => name.includes(".steal."))).toEqual([]);
    }

    // No task lost or duplicated: one per holder round plus two per contender round.
    const tasks = readBoard(board).tasks;
    const expected = 2 + 2 * WORKERS.length * 2;
    expect(tasks).toHaveLength(expected);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(expected);
    expect(new Set(tasks.map((task) => task.title)).size).toBe(expected);
  }, 90_000);
});
