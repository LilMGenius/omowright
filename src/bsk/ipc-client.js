// CLI-shaped client for the BrowserSkill daemon IPC: one Unix-socket
// connection per call, one JSON Lines request frame out, one response frame
// back (`crates/bsk-cli/src/ipc_client.rs`, `crates/bsk-protocol/src/frame.rs`).
// `cancel` opens a second connection exactly as the CLI's SIGINT path does.
import { connect } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readDaemonInfo, resolveBskHome, startDaemonWithCli } from "./daemon-info.js";

export { readDaemonInfo, resolveBskHome } from "./daemon-info.js";

const DEFAULT_TIMEOUT_MS = 35_000; // daemon tool budget 30s + grace, as cli/mod.rs
const DISCOVERY_RETRY_MS = 250;
const DISCOVERY_BUDGET_MS = 15_000;
// A tool call that names its own budget (timeout_ms, or confirmation_timeout_ms for a tab borrow)
// gets that budget plus this grace on the IPC wait.
const TOOL_TIMEOUT_GRACE_MS = 5_000;
// Tools that wait for a person: the daemon owns their deadline, so with no budget from the caller the
// client only keeps a long backstop, and it never cancels them (that would tear down the user's overlay).
const HUMAN_WAIT_METHODS = new Set(["tool.request_help", "tool.tab_borrow"]);
const HUMAN_WAIT_BACKSTOP_MS = 3_600_000;

function ownBudgetMs(params) {
  const budgets = [params?.timeout_ms, params?.confirmation_timeout_ms].filter((value) => typeof value === "number");
  return budgets.length > 0 ? Math.max(...budgets) + TOOL_TIMEOUT_GRACE_MS : undefined;
}
const PROBE_TIMEOUT_MS = 2_000;

// Where the daemon listens when it was started with the default layout
// (`crates/bsk-cli/src/daemon/paths.rs`): `$BSK_HOME/run/daemon.sock`, or on Windows the named pipe
// `render_pipe_name` derives from USERNAME and the home.
export function defaultSocketPath(home, env = process.env) {
  if (process.platform !== "win32") return path.join(home, "run", "daemon.sock");
  return `\\\\.\\pipe\\bsk-daemon-${rustStrHash(env.USERNAME ?? "default", home)}`;
}

// Rust's DefaultHasher (SipHash-1-3, zero keys) over each value's UTF-8 bytes plus the 0xff
// terminator `str::hash` writes, which is how bsk hashes the pipe name.
function rustStrHash(...values) {
  const bytes = Buffer.concat(values.flatMap((value) => [Buffer.from(value, "utf8"), Buffer.from([0xff])]));
  const mask = (1n << 64n) - 1n;
  const rotl = (x, b) => ((x << b) | (x >> (64n - b))) & mask;
  let [v0, v1, v2, v3] = [0x736f6d6570736575n, 0x646f72616e646f6dn, 0x6c7967656e657261n, 0x7465646279746573n];
  const round = () => {
    v0 = (v0 + v1) & mask; v1 = rotl(v1, 13n) ^ v0; v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & mask; v3 = rotl(v3, 16n) ^ v2;
    v0 = (v0 + v3) & mask; v3 = rotl(v3, 21n) ^ v0;
    v2 = (v2 + v1) & mask; v1 = rotl(v1, 17n) ^ v2; v2 = rotl(v2, 32n);
  };
  const compress = (word) => { v3 ^= word; round(); v0 ^= word; };
  const whole = bytes.length - (bytes.length % 8);
  for (let i = 0; i < whole; i += 8) compress(bytes.readBigUInt64LE(i));
  let last = BigInt(bytes.length & 0xff) << 56n;
  for (let i = whole; i < bytes.length; i += 1) last |= BigInt(bytes[i]) << BigInt(8 * (i - whole));
  compress(last);
  v2 ^= 0xffn;
  round(); round(); round();
  return ((v0 ^ v1 ^ v2 ^ v3) & mask).toString(16).padStart(16, "0");
}

// Node's existsSync cannot see a named pipe, so on Windows the pipe namespace is listed instead.
function socketExists(sockPath) {
  if (process.platform !== "win32") return existsSync(sockPath);
  return readdirSync("\\\\.\\pipe\\").includes(path.win32.basename(sockPath));
}

// True when something answers system.ping on `sockPath`: a live daemon whose daemon.json was lost.
function probeSocket(sockPath) {
  if (!socketExists(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = connect(sockPath);
    const done = (alive) => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ id: "probe-orphan", method: "system.ping" }) + "\n"));
    socket.on("data", () => done(true));
  });
}

export class BskRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "BskRpcError";
    this.code = code;
    this.data = data;
  }
}

function shortId() { return randomBytes(6).toString("hex"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class BskIpcClient {
  #home; #env; #sockPath; #autoStart; #startDaemon; #timeoutMs; #starting = null;

  constructor({ home, env = process.env, sockPath, autoStart, startDaemon, timeoutMs = DEFAULT_TIMEOUT_MS, bskBin } = {}) {
    this.#home = home ?? resolveBskHome(env);
    this.#sockPath = sockPath ?? null;
    this.#autoStart = autoStart ?? env.BSK_AUTO_START !== "0";
    this.#startDaemon = startDaemon ?? (() => startDaemonWithCli({ home: this.#home, env, bskBin }));
    this.#timeoutMs = timeoutMs;
    this.#env = env;
  }

  get home() { return this.#home; }

  async resolveSocket({ isAborted = () => false } = {}) {
    if (this.#sockPath) return this.#sockPath;
    const found = readDaemonInfo(this.#home);
    if (found) return found.sock_path;
    // daemon.json can vanish while the daemon keeps running; starting another one then fails on the held port.
    const orphan = defaultSocketPath(this.#home, this.#env);
    // Probe only when the socket file exists, so a fresh home starts its daemon in the same tick as before.
    if (socketExists(orphan)) {
      if (await probeSocket(orphan)) return orphan;
      if (isAborted()) throw new BskRpcError("cancelled", "cancelled before the daemon was located");
    }
    if (!this.#autoStart) {
      throw new BskRpcError("no_daemon", `no BrowserSkill daemon published at ${this.#home}/daemon.json and automatic start is disabled (BSK_AUTO_START=0); run \`bsk daemon start\` in the environment that owns it`);
    }
    if (!this.#starting) this.#starting = this.#startDaemon().finally(() => { this.#starting = null; });
    await this.#starting;
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    while (Date.now() < deadline && !isAborted()) {
      const info = readDaemonInfo(this.#home);
      if (info) return info.sock_path;
      await sleep(DISCOVERY_RETRY_MS);
    }
    if (isAborted()) throw new BskRpcError("cancelled", "cancelled while waiting for the daemon to publish daemon.json");
    throw new BskRpcError("no_daemon", `daemon start was requested but ${this.#home}/daemon.json never appeared`);
  }

  call(method, params, options = {}) {
    return this.callWithHandle(method, params, options).promise;
  }

  // {rpcId, promise, abort()} — rpcId is known before the frame is sent so a
  // caller can cancel a long tool call from another connection.
  callWithHandle(method, params, { idPrefix = method.replace(/[^a-z0-9]+/gi, "-"), timeoutMs } = {}) {
    const ownBudget = ownBudgetMs(params);
    const humanWait = HUMAN_WAIT_METHODS.has(method);
    // An explicit timeoutMs is a floor, never a cut below the tool's own budget.
    const waitMs = humanWait && ownBudget === undefined && timeoutMs === undefined
      ? HUMAN_WAIT_BACKSTOP_MS
      : Math.max(timeoutMs ?? this.#timeoutMs, ownBudget ?? 0);
    const rpcId = `${idPrefix}-${shortId()}`;
    const frame = { id: rpcId, method };
    if (params !== undefined) frame.params = params;
    let aborted = false;
    let abortSocket = () => {};
    const promise = (async () => {
      const sockPath = await this.resolveSocket({ isAborted: () => aborted });
      if (aborted) throw new BskRpcError("cancelled", `${method} cancelled by caller`);
      return new Promise((resolve, reject) => {
        const socket = connect(sockPath);
        let buffer = "";
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          fn(value);
        };
        const timer = setTimeout(() => {
          const cancels = method !== "cancel" && !humanWait;
          finish(reject, new BskRpcError("timeout", `${method} did not answer within ${waitMs}ms${cancels ? "; a cancel was requested at the daemon" : ""}`));
          // The daemon would otherwise keep running it and hold the session for the next call.
          if (cancels) this.cancel(rpcId).catch(() => {});
        }, waitMs);
        abortSocket = () => finish(reject, new BskRpcError("cancelled", `${method} cancelled by caller`));
        socket.on("error", (error) => finish(reject, new BskRpcError("no_daemon", `IPC socket ${sockPath}: ${error.code ?? error.message}`)));
        socket.on("connect", () => socket.write(JSON.stringify(frame) + "\n"));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const idx = buffer.indexOf("\n");
          if (idx === -1) return;
          try { finish(resolve, decodeResponse(buffer.slice(0, idx), rpcId, method)); } catch (error) { finish(reject, error); }
        });
        socket.on("close", () => finish(reject, new BskRpcError("protocol_error", `${method}: daemon closed the connection without a reply`)));
      });
    })();
    return { rpcId, promise, abort: () => { aborted = true; abortSocket(); } };
  }

  async cancel(rpcId) {
    return this.call("cancel", { rpc_id: rpcId }, { idPrefix: "cancel", timeoutMs: 2_000 });
  }
}

function decodeResponse(line, rpcId, method) {
  let reply;
  try { reply = JSON.parse(line); } catch {
    throw new BskRpcError("protocol_error", `${method}: daemon reply is not JSON: ${line.slice(0, 120)}`);
  }
  // The daemon answers a frame it could not decode under id "0".
  const undecodableFrame = reply.id === "0" && reply.error;
  if (reply.id !== rpcId && !undecodableFrame) {
    throw new BskRpcError("protocol_error", `${method}: reply id ${reply.id} does not match request ${rpcId}`);
  }
  if (reply.error) {
    const { code = "protocol_error", message = "daemon error", data } = reply.error;
    throw new BskRpcError(code, message, data);
  }
  return reply.result;
}
