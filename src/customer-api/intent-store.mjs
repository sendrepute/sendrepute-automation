import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Durable intent ledger for paid and billing operations.
 *
 * The identity is sha256(credential fingerprint, operation, method, path and the
 * canonical request body). Before an outbound paid request the intent is written
 * as "pending" under a cross-process lock. The outcome moves it to "completed",
 * "failed" (definitive refusal) or "ambiguous" (transport error, timeout, 5xx).
 * Pending, ambiguous and completed intents block an identical request from any
 * session, worker or restart until an operator releases them deliberately.
 */

const KEY_RE = /^[a-f0-9]{64}$/;
const LOCK_WAIT_MS = 5_000;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function intentKey(credentialFingerprint, prepared, body) {
  return createHash("sha256").update(["sendrepute-intent-v1", credentialFingerprint, prepared.op.id, prepared.method, prepared.path, body === undefined ? "" : canonicalJson(body)].join("\n")).digest("hex");
}

export function replayFieldFor(op) {
  if (op.bodyFields.includes("recoveryId")) return "recoveryId";
  if (op.bodyFields.includes("analysisId")) return "analysisId";
  return null;
}

export function newReplayId(field) {
  return field === "recoveryId" ? randomUUID() : field === "analysisId" ? `sr_${randomBytes(16).toString("hex")}` : null;
}

export class IntentConflict extends Error {
  constructor(status, code, message, record) {
    super(message);
    this.status = status;
    this.code = code;
    this.record = record;
  }
}

/** Shared state machine; subclasses supply atomic(key, fn) and all(). */
export class IntentLedger {
  begin(key, meta, nowSec) {
    return this.atomic(key, (rec) => {
      if (rec && ["pending", "ambiguous", "completed"].includes(rec.state)) return [undefined, { acquired: false, record: rec }];
      const next = {
        key, fingerprint: meta.fingerprint, operationId: meta.operationId, state: "pending",
        replayField: meta.replayField || null, replayId: rec && rec.replayId ? rec.replayId : (meta.replayId || null),
        createdAt: rec ? rec.createdAt : nowSec, updatedAt: nowSec, attempts: (rec ? rec.attempts : 0) + 1, httpStatus: null, note: null
      };
      return [next, { acquired: true, record: next }];
    });
  }

  finish(key, state, httpStatus, nowSec) {
    return this.atomic(key, (rec) => {
      if (!rec || rec.state !== "pending") return [undefined, rec];
      const next = { ...rec, state, httpStatus: httpStatus ?? null, updatedAt: nowSec };
      return [next, next];
    });
  }

  release(key, fingerprint, reason, nowSec) {
    return this.atomic(key, (rec) => {
      if (!rec || rec.fingerprint !== fingerprint) throw new IntentConflict(404, "INTENT_NOT_FOUND", "No intent with that key for this credential", null);
      // Never time-based: a pending intent may belong to a stalled worker whose request is still in flight.
      if (rec.state === "pending") throw new IntentConflict(409, "INTENT_IN_PROGRESS", "This request may still be in flight. If its worker crashed, stop all workers and run offline recovery; it then becomes ambiguous and can be reconciled and released.", rec);
      if (rec.state === "released" || rec.state === "failed") return [undefined, rec];
      // A completed charge must not reuse its replay id, otherwise upstream would replay the old result.
      const next = { ...rec, state: "released", replayId: rec.state === "completed" ? null : rec.replayId, updatedAt: nowSec, note: String(reason).slice(0, 200) };
      return [next, next];
    });
  }

  /**
   * OFFLINE ONLY (every worker stopped): no request can still be in flight, so
   * leftover pending intents become ambiguous for operator reconciliation.
   */
  recoverPendingAfterShutdown(nowSec) {
    const changed = [];
    for (const r of this.all()) {
      if (r.state !== "pending") continue;
      const rec = this.atomic(r.key, (cur) => cur && cur.state === "pending" ? [{ ...cur, state: "ambiguous", updatedAt: nowSec, note: "recovered offline after all workers stopped" }, cur.key] : [undefined, null]);
      if (rec) changed.push(rec);
    }
    return changed;
  }

  list(fingerprint) {
    return this.all().filter((r) => r.fingerprint === fingerprint && r.state !== "released").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
  }
}

/**
 * Filesystem intent store. SINGLE HOST ONLY: the lock is an exclusive-create
 * lock file, which is atomic across workers on one machine but not across
 * machines or on network filesystems. Construction fails unless singleHost is
 * acknowledged and the directory is absolute, private (0700) and owned by the
 * current user.
 */
export class FileIntentStore extends IntentLedger {
  #dir;
  #lockWaitMs;

  constructor({ directory, singleHost, lockWaitMs = LOCK_WAIT_MS } = {}) {
    super();
    if (singleHost !== true) throw new TypeError("FileIntentStore supports a single host only; set singleHost: true to acknowledge");
    if (typeof directory !== "string" || !isAbsolute(directory)) throw new TypeError("FileIntentStore directory must be an absolute path");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new TypeError("FileIntentStore directory must be a real directory");
    if ((st.mode & 0o077) !== 0) throw new TypeError("FileIntentStore directory must not be group or world accessible (chmod 700)");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new TypeError("FileIntentStore directory must be owned by the server user");
    if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) throw new TypeError("lockWaitMs out of range");
    this.#dir = directory;
    this.#lockWaitMs = lockWaitMs;
  }

  #lock(key) {
    const path = join(this.#dir, `${key}.lock`);
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, `${process.pid} ${Date.now()}`);
        closeSync(fd);
        return () => { try { unlinkSync(path); } catch { /* already gone */ } };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // No time-based takeover: a stalled owner may still be inside its critical
        // section. An abandoned lock fails closed until recoverAbandonedIntentLocks()
        // is run with every worker stopped.
        if (Date.now() > deadline) throw new IntentConflict(503, "INTENT_STORE_BUSY", "Intent store lock is held by another worker (or abandoned by a crashed one); nothing was sent", null);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  #read(key) {
    try { return JSON.parse(readFileSync(join(this.#dir, `${key}.json`), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  #write(key, rec) {
    const tmp = join(this.#dir, `${key}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(rec)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(this.#dir, `${key}.json`));
    try { const dfd = openSync(this.#dir, "r"); fsyncSync(dfd); closeSync(dfd); } catch { /* directory fsync unsupported */ }
  }

  atomic(key, fn) {
    if (!KEY_RE.test(key)) throw new TypeError("invalid intent key");
    const unlock = this.#lock(key);
    try {
      const [next, result] = fn(this.#read(key));
      if (next !== undefined) this.#write(key, next);
      return result;
    } finally {
      unlock();
    }
  }

  all() {
    const out = [];
    for (const name of readdirSync(this.#dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try { out.push(JSON.parse(readFileSync(join(this.#dir, name), "utf8"))); } catch { /* skip partial */ }
    }
    return out;
  }
}

/**
 * Offline recovery after a crashed worker. Only run this when EVERY console
 * worker using the directory is stopped; it never runs automatically. Removes
 * abandoned lock files and turns leftover pending intents into ambiguous ones,
 * which stay locked until an operator reconciles and releases them.
 */
export function recoverAbandonedIntentLocks({ directory, allWorkersStopped } = {}) {
  if (allWorkersStopped !== true) throw new TypeError("Stop every console worker first, then pass allWorkersStopped: true");
  const store = new FileIntentStore({ directory, singleHost: true });
  const removedLocks = [];
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.lock$/.test(name)) continue;
    unlinkSync(join(directory, name));
    removedLocks.push(name);
  }
  return { removedLocks, pendingMadeAmbiguous: store.recoverPendingAfterShutdown(Math.floor(Date.now() / 1000)) };
}
