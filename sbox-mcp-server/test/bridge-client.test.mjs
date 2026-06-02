// Tests for the file-IPC transport's liveness + diagnostics behavior.
//
// Run with:  npm test     (builds first, then `node --test test/`)
//
// These cover the v1.3.2 robustness fixes:
//   - status.json is a HEARTBEAT, not a write-once flag: a stale heartbeat
//     must read as "not connected" (kills the permanent false-positive).
//   - request timeouts must name WHICH side broke (editor never read the
//     request vs. read it but never responded).
//   - the IPC directory must be overridable via SBOX_BRIDGE_IPC_DIR so a
//     Node-vs-C# temp-dir split can be forced back into agreement.
//
// No editor required — we drive the Node half against a scratch temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as bc from "../dist/transport/bridge-client.js";

// ── classifyStatus: the heartbeat-staleness decision ───────────────────────

test("classifyStatus: running with a fresh heartbeat is fresh", () => {
  const now = 1_000_000;
  const status = { running: true, heartbeat: new Date(now - 500).toISOString() };
  const r = bc.classifyStatus(status, now, bc.STATUS_STALE_MS);
  assert.equal(r.running, true);
  assert.equal(r.fresh, true);
});

test("classifyStatus: running with a STALE heartbeat is NOT fresh", () => {
  const now = 1_000_000;
  // heartbeat older than the stale window → editor isn't ticking
  const status = { running: true, heartbeat: new Date(now - (bc.STATUS_STALE_MS + 60_000)).toISOString() };
  const r = bc.classifyStatus(status, now, bc.STATUS_STALE_MS);
  assert.equal(r.running, true);
  assert.equal(r.fresh, false, "a stale heartbeat must read as not-fresh");
});

test("classifyStatus: no heartbeat field stays fresh (back-compat with old addons)", () => {
  const now = 1_000_000;
  const status = { running: true, startedAt: new Date(now - 9_000_000).toISOString() };
  const r = bc.classifyStatus(status, now, bc.STATUS_STALE_MS);
  assert.equal(r.running, true);
  assert.equal(r.fresh, true, "old addons have no heartbeat; must not regress to disconnected");
});

test("classifyStatus: null status is neither running nor fresh", () => {
  const r = bc.classifyStatus(null, 1_000_000, bc.STATUS_STALE_MS);
  assert.equal(r.running, false);
  assert.equal(r.fresh, false);
});

test("classifyStatus: running:false is not running", () => {
  const now = 1_000_000;
  const r = bc.classifyStatus({ running: false, heartbeat: new Date(now).toISOString() }, now, bc.STATUS_STALE_MS);
  assert.equal(r.running, false);
});

// ── describeTimeout: name the failing side ─────────────────────────────────

test("describeTimeout: req still present → editor never read it, and the dir is shown", () => {
  const msg = bc.describeTimeout({ reqConsumed: false, ipcDir: "C:\\tmp\\sbox-bridge-ipc", timeoutMs: 30000, command: "get_scene_hierarchy" });
  assert.match(msg, /get_scene_hierarchy/);
  assert.match(msg, /not consumed|never (read|picked up)/i);
  assert.ok(msg.includes("C:\\tmp\\sbox-bridge-ipc"), "must surface the server's IPC dir for the mismatch case");
  assert.match(msg, /\[SboxBridge\]/);
});

test("describeTimeout: req consumed → editor read it but never responded", () => {
  const msg = bc.describeTimeout({ reqConsumed: true, ipcDir: "C:\\tmp\\sbox-bridge-ipc", timeoutMs: 30000, command: "take_screenshot" });
  assert.match(msg, /take_screenshot/);
  assert.match(msg, /consumed|read/i);
  assert.match(msg, /never (wrote|sent|returned) a response|no response/i);
  assert.match(msg, /\[SboxBridge\]/);
});

// ── IPC dir resolution ─────────────────────────────────────────────────────

test("BridgeClient honors SBOX_BRIDGE_IPC_DIR", () => {
  const prev = process.env.SBOX_BRIDGE_IPC_DIR;
  const scratch = path.join(os.tmpdir(), "sbox-bridge-test-override");
  process.env.SBOX_BRIDGE_IPC_DIR = scratch;
  try {
    const client = new bc.BridgeClient();
    assert.equal(client.getIpcDir(), scratch);
  } finally {
    if (prev === undefined) delete process.env.SBOX_BRIDGE_IPC_DIR;
    else process.env.SBOX_BRIDGE_IPC_DIR = prev;
  }
});

test("BridgeClient defaults the IPC dir to <tmp>/sbox-bridge-ipc", () => {
  const prev = process.env.SBOX_BRIDGE_IPC_DIR;
  delete process.env.SBOX_BRIDGE_IPC_DIR;
  try {
    const client = new bc.BridgeClient();
    assert.equal(client.getIpcDir(), path.join(os.tmpdir(), "sbox-bridge-ipc"));
  } finally {
    if (prev !== undefined) process.env.SBOX_BRIDGE_IPC_DIR = prev;
  }
});

// ── isConnected() integration against a scratch dir (no editor) ─────────────

function withScratchClient(fn) {
  const prev = process.env.SBOX_BRIDGE_IPC_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sbox-bridge-it-"));
  process.env.SBOX_BRIDGE_IPC_DIR = scratch;
  try {
    const client = new bc.BridgeClient();
    return fn(client, scratch);
  } finally {
    if (prev === undefined) delete process.env.SBOX_BRIDGE_IPC_DIR;
    else process.env.SBOX_BRIDGE_IPC_DIR = prev;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function writeStatus(dir, obj) {
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(obj), "utf8");
}

test("isConnected(): fresh heartbeat → connected", () => {
  withScratchClient((client, dir) => {
    writeStatus(dir, { running: true, heartbeat: new Date().toISOString() });
    assert.equal(client.isConnected(), true);
  });
});

test("isConnected(): stale heartbeat → NOT connected (the false-positive bug)", () => {
  withScratchClient((client, dir) => {
    writeStatus(dir, { running: true, heartbeat: new Date(Date.now() - 3_600_000).toISOString() });
    assert.equal(client.isConnected(), false);
  });
});

test("isConnected(): missing status file → NOT connected", () => {
  withScratchClient((client) => {
    assert.equal(client.isConnected(), false);
  });
});
