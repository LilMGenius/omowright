// CLI-shaped client for the BrowserSkill daemon IPC: one Unix-socket
// connection per call, one JSON Lines request frame out, one response frame
// back (`crates/bsk-cli/src/ipc_client.rs`, `crates/bsk-protocol/src/frame.rs`).
// `cancel` opens a second connection exactly as the CLI's SIGINT path does.
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readDaemonInfo, resolveBskHome, startDaemonWithCli } from "./daemon-info.js";

export { readDaemonInfo, resolveBskHome } from "./daemon-info.js";

const DEFAULT_TIMEOUT_MS = 35_000; // daemon tool budget 30s + grace, as cli/mod.rs
const DISCOVERY_RETRY_MS = 250;
const DISCOVERY_BUDGET_MS = 15_000;

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
    const found = readDaemonInfo(this.#home);
    if (found) return found.sock_path;
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
  callWithHandle(method, params, { idPrefix = method.replace(/[^a-z0-9]+/gi, "-"), timeoutMs = this.#timeoutMs } = {}) {
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
        const timer = setTimeout(() => finish(reject, new BskRpcError("timeout", `${method} did not answer within ${timeoutMs}ms`)), timeoutMs);
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
