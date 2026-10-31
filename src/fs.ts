import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

/** Atomic-ish write: a temp file in the same directory, then rename over. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Read a UTF-8 text file. */
export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Ensure a directory exists, creating parents. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * File lock for a whole board.
 *
 * Cross-process: `mkdir` is atomic, so exactly one process creates the lock
 * directory. In-process: promises for the same lock path are chained, so two
 * tool calls never interleave a read-modify-write pair.
 *
 * A crashed owner is recovered by checking its PID (same host only) or by age.
 * The lock is a directory (`.pi/kanban/.lock`) so it can carry `owner.json`
 * without clobbering user files.
 *
 * Recovery never deletes a lock blindly: it renames the directory to a unique
 * tombstone (an atomic operation, so only one process can win) and deletes it
 * only after re-reading the tombstone's `owner.json` and confirming it is the
 * owner that was judged stale. A lock that changed hands in that window is put
 * back instead of being destroyed. See `stealLock`.
 *
 * Entry is atomic too: a lock is built as `<lockDir>.entry.<token>/` with its
 * `owner.json` already inside, and renamed onto `lockDir`, which fails if the
 * path is taken. A lock directory therefore never exists empty, so a recovery
 * cannot restore a directory over a half-built one, and `release` cannot delete
 * a lock that changed hands after its read.
 *
 * Because a recovery empties the lock path for as long as the tombstone exists,
 * acquisition re-checks after renaming its entry directory in: a visible
 * tombstone means the path is not authoritative, so the caller gives its
 * directory back and retries. Abandoned tombstones are reaped (`reapStrays`), so
 * one crash cannot block the board forever.
 */
const chains = new Map<string, Promise<unknown>>();

export interface LockOptions {
  /** Max time to wait for the lock before failing. */
  acquireTimeoutMs?: number;
  /** Age after which an owner is considered stale even if the PID is alive. */
  staleMs?: number;
  /** Hostname used for PID checks. Injectable for tests. */
  host?: string;
  /**
   * Runs between the staleness read and the delete, for tests that need to land
   * another process in that window. Production never sets it.
   */
  beforeSteal?: (attempt: StealAttempt) => void | Promise<void>;
}

const DEFAULT_ACQUIRE_TIMEOUT = 15_000;
const DEFAULT_STALE_MS = 120_000;
const RETRY_MS = 25;
/** Grace for the window between `mkdir` and `owner.json`, when no age is known. */
const NO_OWNER_GRACE_MS = 5_000;
/** Suffix of the tombstone a recovery renames a lock directory to. */
const STEAL_SUFFIX = ".steal.";
/** Suffix of the complete, not-yet-renamed directory a lock is built in. */
const ENTRY_SUFFIX = ".entry.";
/** Suffix of a directory on its way out, so deletes never race a writer. */
const TRASH_SUFFIX = ".trash.";

interface Owner {
  pid: number;
  token: string;
  at: number;
  host: string;
}

function readOwner(lockDir: string): Owner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${lockDir}/owner.json`, "utf8")) as Partial<Owner>;
    if (typeof parsed.pid === "number" && typeof parsed.token === "string" && typeof parsed.at === "number") {
      return {
        pid: parsed.pid,
        token: parsed.token,
        at: parsed.at,
        host: typeof parsed.host === "string" ? parsed.host : "",
      };
    }
  } catch {
    /* missing or unreadable owner */
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete a lock directory by taking it out of the way first.
 *
 * `rm -r` walks the tree, so it fails with `ENOTEMPTY` when another process is
 * writing into the same directory, and two processes removing the same tree can
 * collide. Renaming first is atomic and makes exactly one caller the owner of
 * the removed directory; the loser sees `ENOENT` and does nothing.
 */
function discard(path: string): void {
  const trash = `${path}${TRASH_SUFFIX}${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, trash);
  } catch {
    return; // Already gone, or another process took it out of the way first.
  }
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {
    // A leftover trash directory holds no lock; the next reaper collects it.
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** Age of the lock directory itself, used while `owner.json` is absent. */
function lockDirAgeMs(lockDir: string): number {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Directories in the lock's parent that belong to this lock and end with `suffix`. */
function siblingsOf(lockDir: string, suffix: string): string[] {
  const prefix = `${basename(lockDir)}${suffix}`;
  try {
    return readdirSync(dirname(lockDir))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dirname(lockDir), name));
  } catch {
    return [];
  }
}

/**
 * Tombstones that belong to this lock: lock directories a recovery moved aside
 * and has not finished with.
 *
 * While one exists the path is not authoritative — it is free until the
 * recovery puts a lock back — so `acquire` gives its own directory back and
 * retries instead of entering. See `reapStrays` for the ones nobody owns.
 */
function tombstonesOf(lockDir: string): string[] {
  // A directory already on its way out (`.trash.`) is not authoritative.
  return siblingsOf(lockDir, STEAL_SUFFIX).filter((path) => !path.includes(TRASH_SUFFIX));
}

/**
 * Remove the stray directories of this lock that nobody can be using.
 *
 * `.entry.*` is never a lock (entry directories are renamed into place, so a
 * leftover is only a crash artifact). A `.steal.*` tombstone is reaped when its
 * `owner.json` is gone, when its pid is dead on this host, or when it is older
 * than the no-owner grace; a live owner with a fresh directory keeps it, because
 * it may be about to put that lock back.
 *
 * Without this, one orphan tombstone is a permanent write outage: `acquire`
 * refuses to enter while any tombstone exists.
 */
function reapStrays(lockDir: string, host: string): void {
  for (const entry of siblingsOf(lockDir, ENTRY_SUFFIX)) {
    // A young entry may be a live acquirer between `mkdir` and its rename.
    if (lockDirAgeMs(entry) > NO_OWNER_GRACE_MS) discard(entry);
  }
  try {
    const parent = dirname(lockDir);
    const prefix = `${basename(lockDir)}.`;
    for (const name of readdirSync(parent)) {
      // Whatever the trash came from (lock, entry, tombstone), it holds no lock.
      if (name.startsWith(prefix) && name.includes(TRASH_SUFFIX)) discard(join(parent, name));
    }
  } catch {
    /* the parent is gone: nothing to reap */
  }
  for (const tombstone of tombstonesOf(lockDir)) {
    const owner = readOwner(tombstone);
    const deadOnThisHost = owner !== undefined && owner.host === host && !isAlive(owner.pid);
    if (owner === undefined || deadOnThisHost || lockDirAgeMs(tombstone) > NO_OWNER_GRACE_MS) {
      discard(tombstone);
    }
  }
}

/**
 * Put a tombstone back, but never on top of a directory this process did not
 * move: POSIX `rename` onto an existing *empty* directory silently replaces it,
 * so that case is checked first. When the path was re-taken the tombstone is
 * left behind, and `reapStrays` collects it once its owner is gone.
 */
function restoreTombstone(tombstone: string, lockDir: string, hooks?: StealHooks): void {
  // Test-only seam: lets a test land a directory at the path between the move
  // and the restore. Production passes no hook.
  hooks?.beforeRestore?.(tombstone, lockDir);
  try {
    if (!existsSync(lockDir)) renameSync(tombstone, lockDir);
  } catch {
    /* Lost the race: the tombstone stays for the next recovery to reap. */
  }
}

/** Test-only seams for `stealLock`; production never passes them. */
export interface StealHooks {
  /** Runs after the directory is moved aside and before it is verified. */
  beforeVerify?: (tombstone: string, lockDir: string) => void;
  /** Runs at the start of a restore, before the target is checked. */
  beforeRestore?: (tombstone: string, lockDir: string) => void;
}

/**
 * Move `path` aside, verify, then delete.
 *
 * The rename is atomic, so of two processes racing to move the same directory
 * exactly one wins and the loser sees `ENOENT`. Verification then happens on the
 * moved directory, which nobody else can observe. `expectedToken` is the
 * `owner.json` token the caller expects to find, or `null` when the caller saw
 * no readable owner at all.
 *
 * A directory carrying any other token (or an owner where `null` was expected)
 * is renamed back and left alone: deleting it would drop a live owner's lock.
 * Returns `"removed"`, `"restored"`, or `"absent"` when there was nothing there.
 */
function disposeAside(
  path: string,
  expectedToken: string | null,
  hooks?: StealHooks,
): "removed" | "restored" | "absent" {
  const tombstone = `${path}${STEAL_SUFFIX}${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, tombstone);
  } catch {
    return "absent"; // Another process moved or released it first.
  }

  hooks?.beforeVerify?.(tombstone, path);
  const moved = readOwner(tombstone);
  const expected = expectedToken === null ? moved === undefined : moved?.token === expectedToken;
  if (!expected) {
    restoreTombstone(tombstone, path, hooks);
    return "restored";
  }

  discard(tombstone);
  return "removed";
}

/**
 * Remove `lockDir`, but only if it still carries `expectedToken`: the token the
 * caller judged stale, or `null` for a directory with no readable owner.
 *
 * Returns true when a stale lock was actually removed.
 */
export function stealLock(lockDir: string, expectedToken: string | null, hooks?: StealHooks): boolean {
  return disposeAside(lockDir, expectedToken, hooks) === "removed";
}

/**
 * What a caller is about to recover, passed to `LockOptions.beforeSteal`.
 * `owner` is the staleness read that justified the steal.
 */
export interface StealAttempt {
  lockDir: string;
  reason: "age" | "pid" | "no-owner";
  owner?: Owner;
}

async function acquire(lockDir: string, options: LockOptions): Promise<Owner> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const host = options.host ?? hostname();
  const started = Date.now();

  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    const owner: Owner = { pid: process.pid, token: randomBytes(8).toString("hex"), at: Date.now(), host };

    // Entry is all-or-nothing: build a complete, non-empty entry directory next
    // to the lock and rename it into place. A rename onto an existing directory
    // that is not empty fails, so a lock directory in this scheme always carries
    // its `owner.json` — there is no empty-directory window for a recovering
    // process to overwrite.
    const entryDir = `${lockDir}${ENTRY_SUFFIX}${owner.token}`;
    discard(entryDir);
    mkdirSync(entryDir, { recursive: true });
    try {
      writeFileSync(`${entryDir}/owner.json`, `${JSON.stringify(owner)}\n`, "utf8");
    } catch (error) {
      discard(entryDir);
      throw error;
    }

    let entered = false;
    try {
      renameSync(entryDir, lockDir);
      entered = true;
    } catch (error) {
      discard(entryDir);
      const code = errorCode(error);
      // ENOTEMPTY (Linux) / EEXIST / ENOTDIR: the path belongs to someone else.
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "ENOTDIR" && code !== "EISDIR") {
        throw error;
      }
    }

    if (entered && tombstonesOf(lockDir).length === 0) return owner;

    if (entered) {
      // A recovery is moving a lock directory aside, so the path is not
      // authoritative. Give ours back — only if it is still ours — and wait.
      if (readOwner(lockDir)?.token === owner.token) discard(lockDir);
    }

    reapStrays(lockDir, host);

    if (Date.now() - started > acquireTimeoutMs) {
      // Name the directory that is actually blocking us: naming `.lock` when a
      // tombstone is what is left would send the operator to the wrong place.
      const tombstones = tombstonesOf(lockDir);
      throw new Error(
        `Board is locked by another process (waited ${acquireTimeoutMs}ms). Retry shortly, or remove ${tombstones.length > 0 ? tombstones.join(", ") : lockDir} if you know the owner crashed.`,
      );
    }

    const current = readOwner(lockDir);
    let attempt: StealAttempt | undefined;
    if (current) {
      if (Date.now() - current.at > staleMs) attempt = { lockDir, reason: "age", owner: current };
      else if (current.host === host && !isAlive(current.pid)) attempt = { lockDir, reason: "pid", owner: current };
    } else if (lockDirAgeMs(lockDir) > NO_OWNER_GRACE_MS) {
      // No readable owner: the owner is between entry and its write, or it
      // crashed. The age is the directory's, not our waiting time.
      attempt = { lockDir, reason: "no-owner" };
    }

    if (attempt) {
      // Seam for tests: everything above is the staleness read, everything below
      // is the delete. Production passes no hook.
      if (options.beforeSteal) await options.beforeSteal(attempt);
      // Only the lock that was judged stale is removed: if the token changed
      // hands in the meantime, `disposeAside` puts it back.
      if (attempt.reason === "no-owner") stealLock(lockDir, null);
      else stealLock(lockDir, attempt.owner!.token);
    }

    await sleep(RETRY_MS);
  }
}

/**
 * Release our own lock: rename-verify-delete, so a recovery that hands the lock
 * to a new owner between our read and our delete cannot make us delete theirs.
 * A directory that is not ours is put back rather than removed.
 */
function release(lockDir: string, owner: Owner): void {
  if (disposeAside(lockDir, owner.token) === "removed") return;
  // A recovery moved our directory aside and could not put it back, so the lock
  // is a tombstone now. We are past our critical section, so take our own
  // tombstone with us: a live-pid tombstone is otherwise unreapable, and one of
  // those would stall every other writer for the whole grace period.
  for (const tombstone of tombstonesOf(lockDir)) {
    if (readOwner(tombstone)?.token === owner.token) discard(tombstone);
  }
}

/**
 * Run `fn` while holding the board lock. Rejects if the lock cannot be
 * acquired. The lock is always released, including when `fn` throws.
 */
export async function withBoardLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const previous = chains.get(lockDir) ?? Promise.resolve();
  const run = previous.then(async () => {
    const owner = await acquire(lockDir, options);
    try {
      return await fn();
    } finally {
      release(lockDir, owner);
    }
  });

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(lockDir, tail);
  try {
    return await run;
  } finally {
    if (chains.get(lockDir) === tail) chains.delete(lockDir);
  }
}
