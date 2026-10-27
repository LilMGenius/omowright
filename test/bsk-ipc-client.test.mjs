import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeBskDaemon } from "./fixtures/fake-bsk-daemon.mjs";
import { BskIpcClient, BskRpcError, readDaemonInfo, resolveBskHome } from "../src/bsk/ipc-client.js";

test("resolveBskHome prefers BSK_HOME and falls back to ~/.bsk", () => {
  assert.equal(resolveBskHome({ BSK_HOME: "/x/y", HOME: "/h" }), "/x/y");
  assert.equal(resolveBskHome({ BSK_HOME: "", HOME: "/h" }), path.join("/h", ".bsk"));
});

test("readDaemonInfo parses daemon.json and rejects a missing one", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    const info = readDaemonInfo(daemon.home);
    assert.equal(info.sock_path, daemon.sockPath);
    assert.equal(info.version, "0.3.0-fake");
    assert.equal(info.ws_port, 52800);
  } finally { await daemon.close(); }
  const empty = mkdtempSync(path.join(tmpdir(), "bsk-empty-"));
  try {
    assert.equal(readDaemonInfo(empty), null);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test("call round-trips a request frame and returns result", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const result = await client.call("system.ping", {});
    assert.deepEqual(result, { pong: true });
    assert.equal(daemon.requests.length, 1);
    const [frame] = daemon.requests;
    assert.equal(frame.method, "system.ping");
    assert.equal(typeof frame.id, "string");
    assert.ok(frame.id.length >= 8);
    assert.deepEqual(frame.params, {});
  } finally { await daemon.close(); }
});

test("call with a prefix produces ids the daemon can correlate and omits absent params", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "session.list": () => ({ result: { sessions: [] } }) } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await client.call("session.list", undefined, { idPrefix: "list" });
    assert.match(daemon.requests[0].id, /^list-[0-9a-f]{12}$/);
    assert.equal("params" in daemon.requests[0], false);
  } finally { await daemon.close(); }
});

test("error frames become BskRpcError with the daemon code and data", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "tool.click": () => ({ error: { code: "not_found", message: "ref e9 unknown", data: { reason: "ref_not_found" } } }) },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("tool.click", { session_id: "abcd", ref: "e9" }), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "not_found");
      assert.equal(err.message, "ref e9 unknown");
      assert.deepEqual(err.data, { reason: "ref_not_found" });
      return true;
    });
  } finally { await daemon.close(); }
});

test("an undecodable request is answered under id \"0\" and still surfaces the daemon's error", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "no.such": () => JSON.stringify({ id: "0", error: { code: "protocol_error", message: "invalid frame: unknown variant `no.such`" } }) },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("no.such", {}), (err) => {
      assert.equal(err.code, "protocol_error");
      assert.match(err.message, /unknown variant `no.such`/);
      return true;
    });
  } finally { await daemon.close(); }
});

test("a malformed reply line is a protocol_error, not a hang", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "system.status": () => "this is not json" } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    await assert.rejects(client.call("system.status", {}), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "protocol_error");
      return true;
    });
  } finally { await daemon.close(); }
});

test("a silent daemon trips the per-call timeout with code timeout", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "tool.navigate": () => undefined } });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(client.call("tool.navigate", { session_id: "abcd", url: "https://example.com" }), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "timeout");
      return true;
    });
    assert.ok(Date.now() - started < 2000, "timeout must not wait for the daemon");
  } finally { await daemon.close(); }
});

test("cancel sends a cancel frame on its own connection while the call is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const daemon = await startFakeBskDaemon({
    handlers: {
      "tool.navigate": () => undefined, // never answers on its own
      cancel: (frame) => { release(frame); return { result: { cancelled: true } }; },
    },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 5000 });
    const handle = client.callWithHandle("tool.navigate", { session_id: "abcd", url: "https://slow.example" }, { idPrefix: "navigate" });
    const cancelled = await client.cancel(handle.rpcId);
    const cancelFrame = await gate;
    assert.deepEqual(cancelled, { cancelled: true });
    assert.equal(cancelFrame.method, "cancel");
    assert.deepEqual(cancelFrame.params, { rpc_id: handle.rpcId });
    assert.match(cancelFrame.id, /^cancel-[0-9a-f]{12}$/);
    assert.equal(daemon.requests.length, 2, "two connections, two frames");
    handle.abort();
    await assert.rejects(handle.promise, (err) => err instanceof BskRpcError && err.code === "cancelled");
  } finally { await daemon.close(); }
});

test("abort while a daemon start is pending settles the handle as cancelled after exactly one start", async () => {
  // A home with no daemon.json and no live socket: the client has to start a daemon, and is aborted meanwhile.
  const home = mkdtempSync(path.join(tmpdir(), "bsk-abort-"));
  let starts = 0;
  try {
    let releaseStart = () => {};
    const client = new BskIpcClient({
      home, autoStart: true,
      startDaemon: () => { starts += 1; return new Promise((resolve) => { releaseStart = resolve; }); },
    });
    const handle = client.callWithHandle("system.ping", {});
    handle.abort();
    releaseStart();
    await assert.rejects(handle.promise, (err) => err instanceof BskRpcError && err.code === "cancelled");
    assert.equal(starts, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("with auto-start disabled and no daemon.json the client fails fast and explains why", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bsk-none-"));
  try {
    const client = new BskIpcClient({ home, autoStart: false });
    const started = Date.now();
    await assert.rejects(client.call("system.ping", {}), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "no_daemon");
      assert.match(err.message, /daemon\.json/);
      assert.match(err.message, /BSK_AUTO_START|bsk daemon start/);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("with auto-start enabled the client runs the starter once and retries discovery", async () => {
  const daemon = await startFakeBskDaemon();
  const home = mkdtempSync(path.join(tmpdir(), "bsk-late-"));
  const { copyFileSync, mkdirSync } = await import("node:fs");
  let starts = 0;
  try {
    const client = new BskIpcClient({
      home,
      autoStart: true,
      startDaemon: async () => {
        starts += 1;
        mkdirSync(path.join(home, "run"), { recursive: true });
        copyFileSync(path.join(daemon.home, "daemon.json"), path.join(home, "daemon.json"));
      },
    });
    const result = await client.call("system.ping", {});
    assert.deepEqual(result, { pong: true });
    assert.equal(starts, 1);
    await client.call("system.ping", {});
    assert.equal(starts, 1, "a discovered daemon is reused without restarting");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("a live daemon whose daemon.json vanished is re-adopted through its socket, never restarted (omo#10216)", async () => {
  const daemon = await startFakeBskDaemon();
  let starts = 0;
  try {
    rmSync(path.join(daemon.home, "daemon.json"));
    const client = new BskIpcClient({ home: daemon.home, autoStart: true, startDaemon: async () => { starts += 1; } });
    assert.deepEqual(await client.call("system.ping", {}), { pong: true });
    assert.equal(starts, 0, "starting a second daemon would fail on the held port");
  } finally { await daemon.close(); }
});

test("with auto-start disabled a live daemon without daemon.json is still found through its socket", async () => {
  const daemon = await startFakeBskDaemon();
  try {
    rmSync(path.join(daemon.home, "daemon.json"));
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    assert.deepEqual(await client.call("system.ping", {}), { pong: true });
  } finally { await daemon.close(); }
});

// Protocol/platform contract: daemon.json survives a daemon that was killed (a host closing the job it ran in),
// and the socket it names then answers nothing; the client must start a daemon instead of failing on that socket.
test("a daemon.json left by a daemon that no longer runs starts a new daemon instead of failing on its socket", async () => {
  const { spawnSync } = await import("node:child_process");
  const { copyFileSync, writeFileSync } = await import("node:fs");
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  const daemon = await startFakeBskDaemon();
  const home = mkdtempSync(path.join(tmpdir(), "bsk-dead-"));
  const staleSock = process.platform === "win32" ? "\\\\.\\pipe\\" + path.basename(home) : path.join(home, "run", "daemon.sock");
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: deadPid, sock_path: staleSock, ws_port: 52800, version: "0.3.0-fake" }));
  let starts = 0;
  try {
    const client = new BskIpcClient({
      home,
      autoStart: true,
      startDaemon: async () => {
        starts += 1;
        copyFileSync(path.join(daemon.home, "daemon.json"), path.join(home, "daemon.json"));
      },
    });
    assert.deepEqual(await client.call("system.ping", {}), { pong: true });
    assert.equal(starts, 1);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("a tool call's own timeoutMs extends the IPC wait, so a long evaluate is not cut short (omo#10217)", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "tool.evaluate": () => ({ result: { ok: true, value: 1 } }) }, delayMs: 300 });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
    const result = await client.call("tool.evaluate", { session_id: "abcd", expression: "1", timeout_ms: 1000 });
    assert.deepEqual(result, { ok: true, value: 1 });
  } finally { await daemon.close(); }
});

test("an IPC timeout cancels the in-flight call so the session stays usable (omo#10217)", async () => {
  let cancelled;
  const gotCancel = new Promise((resolve) => { cancelled = resolve; });
  const daemon = await startFakeBskDaemon({
    handlers: {
      "tool.evaluate": () => undefined,
      cancel: (frame) => { cancelled(frame); return { result: { cancelled: true } }; },
    },
  });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
    const handle = client.callWithHandle("tool.evaluate", { session_id: "abcd", expression: "new Promise(() => {})" }, { idPrefix: "evaluate" });
    await assert.rejects(handle.promise, (err) => err instanceof BskRpcError && err.code === "timeout");
    const frame = await Promise.race([gotCancel, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    assert.ok(frame, "the timed-out call must be cancelled at the daemon");
    assert.deepEqual(frame.params, { rpc_id: handle.rpcId });
  } finally { await daemon.close(); }
});

for (const [tool, params] of [
  ["tool.request_help", { session_id: "abcd", prompt: "log in please" }],
  ["tool.tab_borrow", { session_id: "abcd", tab_id: 7 }],
]) {
  test(`${tool} without its own timeout waits for the human past the default IPC wait and is never cancelled`, async () => {
    const daemon = await startFakeBskDaemon({ handlers: { [tool]: () => ({ result: { ok: true } }) }, delayMs: 400 });
    try {
      // The default wait (150 ms here, 35 s in production) is shorter than the human takes.
      const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
      assert.deepEqual(await client.call(tool, params), { ok: true });
      assert.equal(daemon.requests.filter((frame) => frame.method === "cancel").length, 0);
    } finally { await daemon.close(); }
  });
}

test("a tab borrow's confirmation_timeout_ms bounds the wait, and its timeout neither cancels nor claims a cancel", { timeout: 20_000 }, async () => {
  // confirmation_timeout_ms 0 gives a wait of exactly the 5 s grace; the daemon answers later.
  const daemon = await startFakeBskDaemon({ handlers: { "tool.tab_borrow": () => ({ result: { borrowed: true } }) }, delayMs: 7000 });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false, timeoutMs: 150 });
    const started = Date.now();
    await assert.rejects(client.call("tool.tab_borrow", { session_id: "abcd", tab_id: 7, confirmation_timeout_ms: 0 }), (err) => {
      assert.ok(err instanceof BskRpcError);
      assert.equal(err.code, "timeout");
      assert.doesNotMatch(err.message, /cancel/);
      return true;
    });
    assert.ok(Date.now() - started >= 4500, "the borrow's own budget, not the 150 ms default, bounds the wait");
    assert.equal(daemon.requests.filter((frame) => frame.method === "cancel").length, 0);
  } finally { await daemon.close(); }
});

test("an explicit timeoutMs option never cuts a tool below its own timeout_ms", async () => {
  const daemon = await startFakeBskDaemon({ handlers: { "tool.evaluate": () => ({ result: { ok: true } }) }, delayMs: 300 });
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const result = await client.call("tool.evaluate", { session_id: "abcd", expression: "1", timeout_ms: 1000 }, { timeoutMs: 150 });
    assert.deepEqual(result, { ok: true });
  } finally { await daemon.close(); }
});
