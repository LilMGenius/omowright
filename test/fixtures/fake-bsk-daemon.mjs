// In-process stand-in for the BrowserSkill daemon's CLI-facing IPC: a Unix
// socket server speaking one JSON Lines frame per request, mirroring
// `crates/bsk-cli/src/daemon/ipc.rs` (RequestFrame {id, method, params} ->
// ResponseFrame {id, result} | {id, error}). Tests script replies per method
// and read back every request the daemon saw.
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function startFakeBskDaemon({ handlers = {}, delayMs = 0 } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "fake-bsk-home-"));
  mkdirSync(path.join(home, "run"));
  // The real daemon publishes a named pipe on Windows, where a socket file under tmpdir cannot be listened on.
  const sockPath = process.platform === "win32"
    ? "\\\\.\\pipe\\" + path.basename(home)
    : path.join(home, "run", "daemon.sock");
  const requests = [];
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        handle(socket, line);
      }
    });
  });

  function handle(socket, line) {
    let frame;
    try { frame = JSON.parse(line); } catch { socket.write("not json\n"); return; }
    requests.push(frame);
    const handler = handlers[frame.method] ?? defaultHandler;
    const reply = handler(frame);
    if (reply === undefined) return; // scripted silence: the client must time out
    const send = () => {
      const body = typeof reply === "string" ? reply : JSON.stringify({ id: frame.id, ...reply });
      if (!socket.destroyed) socket.write(body + "\n");
    };
    if (delayMs > 0) setTimeout(send, delayMs); else send();
  }

  function defaultHandler(frame) {
    if (frame.method === "system.ping") return { result: { pong: true } };
    if (frame.method === "cancel") return { result: { cancelled: true } };
    return { error: { code: "unknown_method", message: `unknown method ${frame.method}` } };
  }

  await new Promise((resolve, reject) => server.once("error", reject).listen(sockPath, resolve));
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify({
    pid: process.pid,
    sock_path: sockPath,
    ws_port: 52800,
    version: "0.3.0-fake",
    started_at_epoch_secs: Math.floor(Date.now() / 1000),
  }));

  return {
    home,
    sockPath,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
