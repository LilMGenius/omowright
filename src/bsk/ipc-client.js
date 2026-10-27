// CLI-shaped client for the BrowserSkill daemon IPC: one Unix-socket
// connection per call, one JSON Lines request frame out, one response frame
// back (`crates/bsk-cli/src/ipc_client.rs`, `crates/bsk-protocol/src/frame.rs`).
// `cancel` opens a second connection exactly as the CLI's SIGINT path does.
import { connect } from "node:net";
import { existsSync } from "node:fs";
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
// (`crates/bsk-cli/src/daemon/info.rs`: `$BSK_HOME/run/daemon.sock`).
export function defaultSocketPath(home) {
  return path.join(home, "run", "daemon.sock");
}

// True when something answers system.ping on `sockPath`: a live daemon whose daemon.json was lost.
function probeSocket(sockPath) {
  if (process.platform === "win32" || !existsSync(sockPath)) return Promise.resolve(false);
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

// daemon.json outlives a daemon that was killed, as when a host closes the job it ran in; its pid then
// names no process and its socket answers nothing, so it counts as absent and a new daemon is started.
function liveDaemonInfo(home) {
  const info = readDaemonInfo(home);
  if (!info || !Number.isInteger(info.pid)) return info;
  try {
    process.kill(info.pid, 0);
    return info;
  } catch (error) {
    return error.code === "EPERM" ? info : null;
  }
}

export class BskIpcClient {
  #home; #sockPath; #autoStart; #startDaemon; #timeoutMs; #starting = null;

  constructor({ home, env = process.env, sockPath, autoStart, startDaemon, timeoutMs = DEFAULT_TIMEOUT_MS, bskBin } = {}) {
    this.#home = home ?? resolveBskHome(env);
    this.#sockPath = sockPath ?? null;
    this.#autoStart = autoStart ?? env.BSK_AUTO_START !== "0";
    this.#startDaemon = startDaemon ?? (() => startDaemonWithCli({ home: this.#home, env, bskBin }));
    this.#timeoutMs = timeoutMs;
  }

  get home() { return this.#home; }

  async resolveSocket({ isAborted = () => false } = {}) {
    if (this.#sockPath) return this.#sockPath;
    const found = liveDaemonInfo(this.#home);
    if (found) return found.sock_path;
    // daemon.json can vanish while the daemon keeps running; starting another one then fails on the held port.
    const orphan = defaultSocketPath(this.#home);
    // Probe only when the socket file exists, so a fresh home starts its daemon in the same tick as before.
    if (existsSync(orphan)) {
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
      const info = liveDaemonInfo(this.#home);
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
