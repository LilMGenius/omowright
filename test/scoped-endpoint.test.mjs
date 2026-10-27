// Protocol contract: a scoped CDP endpoint that allows only OMOWRIGHT_PAGE_CDP_METHODS and requires a Bearer token
// is enough for the page API. This fake forwards Target.* to the real browser; scoping them per thread is the
// endpoint's job (tested in the OmO desktop app). A new command in the page path, or a token sent outside the Authorization header,
// fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { CdpClient, OMOWRIGHT_PAGE_CDP_METHODS, compactSnapshot, connect, createAgentTabs } from "../src/index.js";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(process.env.HOME, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const ALLOWED = new Set(OMOWRIGHT_PAGE_CDP_METHODS);
const GOOD = "Bearer scoped-good";

const PAGE = `<!doctype html><title>Scoped</title>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent = 'hi ' + document.getElementById('name').value">Greet</button>
<p id="out"></p>`;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function launchChromium(userDataDir) {
  const child = spawn(SHELL, ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stderr.on("data", (chunk) => {
      buffered += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`chromium exited early (${code})`)));
  });
  return { child, wsUrl, httpBase: wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "") };
}

// The endpoint under test: answers discovery, demands the Bearer token on every request and the upgrade, and
// forwards only allowlisted methods to the real browser.
async function startScopedEndpoint(upstream) {
  const refused = [];
  const unauthorized = [];
  const authorized = (req) => {
    if (req.headers.authorization === GOOD && !req.url.includes("token")) return true;
    unauthorized.push(req.url);
    return false;
  };
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    const port = server.address().port;
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Scoped/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/scoped` }));
      return;
    }
    if (req.url === "/json/list") {
      const targets = await (await fetch(`${upstream.httpBase}/json/list`)).json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(targets.filter((t) => t.type === "page").map(({ webSocketDebuggerUrl: _ws, devtoolsFrontendUrl: _fe, ...t }) => t)));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const browser = new WebSocket(upstream.wsUrl);
      const pending = [];
      browser.on("open", () => pending.splice(0).forEach((m) => browser.send(m)));
      browser.on("message", (data) => client.send(data.toString()));
      browser.on("close", () => client.close());
      client.on("close", () => browser.close());
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (!ALLOWED.has(message.method)) {
          refused.push(message.method);
          client.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error: { code: -32601, message: `'${message.method}' wasn't found` } }));
          return;
        }
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
        else pending.push(data.toString());
      });
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, refused, unauthorized, close: () => new Promise((r) => { wss.close(); server.close(() => r()); }) };
}

test("the page API runs through an endpoint that allows only OMOWRIGHT_PAGE_CDP_METHODS", { skip: !SHELL && "no chromium binary found", timeout: 90000 }, async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-scoped-"));
  const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  const sitePort = await listen(site);
  const upstream = await launchChromium(userDataDir);
  const endpoint = await startScopedEndpoint(upstream);
  const forceRefreshes = [];
  let token = "Bearer scoped-stale";
  let connection;
  try {
    connection = await connect(endpoint.url, {
      storageRoot: userDataDir,
      client: {
        authorizer: {
          // A stale token first: the endpoint answers 401 and OmOWright must ask again with forceRefresh.
          resolveAuthorization: async ({ forceRefresh } = {}) => {
            forceRefreshes.push(Boolean(forceRefresh));
            if (forceRefresh) token = GOOD;
            return token;
          },
        },
      },
    });
    const { page } = await createAgentTabs(connection).create("about:blank");
    await page.goto(`http://127.0.0.1:${sitePort}/`);
    const snapshot = compactSnapshot(await page.snapshot());
    assert.match(snapshot, /button "Greet"/);
    await page.locator("#name").fill("scoped");
    await page.getByRole("button", { name: "Greet" }).click();
    assert.equal(await page.evaluate("document.getElementById('out').textContent"), "hi scoped");
    const shot = await page.screenshot({ path: "scoped.png" });
    assert.ok(shot, "screenshot taken");

    assert.deepEqual(endpoint.refused, [], `methods outside OMOWRIGHT_PAGE_CDP_METHODS: ${endpoint.refused.join(", ")}`);
    assert.ok(forceRefreshes.includes(true), "a 401 makes the authorizer refresh");
    assert.ok(endpoint.unauthorized.length > 0, "the stale token was refused");
  } finally {
    await connection?.close().catch(() => {});
    await endpoint.close();
    const exited = upstream.child.exitCode === null ? once(upstream.child, "exit") : Promise.resolve();
    upstream.child.kill();
    await exited;
    site.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10 });
  }
});


// Security contract (#75): a CdpClient has no default endpoint. 127.0.0.1:9222 is where a user's own Chrome listens
// once remote debugging is enabled from chrome://inspect, so a missing URL must refuse, never dial a browser there.
// fetch and WebSocket are intercepted at the global boundary the client dials through; nothing reaches the network.
// The 15 s budget only matters on a regression: an unrefused client walks its full reconnect schedule (~5.5 s).
test("a CdpClient without a URL refuses and dials nothing", { timeout: 15_000 }, async () => {
  const dialed = [];
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  globalThis.fetch = async (url) => {
    dialed.push(String(url));
    throw new Error("network blocked by test");
  };
  globalThis.WebSocket = class {
    constructor(url) {
      dialed.push(String(url));
      throw new Error("network blocked by test");
    }
  };
  const outcomes = [];
  try {
    for (const options of [undefined, { reconnectDelaysMs: [0] }, { cdpUrl: "", reconnectDelaysMs: [0] }]) {
      try {
        const client = new CdpClient(options);
        await client.ensureConnected().catch(() => {});
        await client.close();
        outcomes.push("constructed");
      } catch (error) {
        outcomes.push(error instanceof TypeError && /requires a cdpUrl/.test(error.message) ? "refused" : String(error));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = RealWebSocket;
  }
  assert.deepEqual({ outcomes, dialed }, { outcomes: ["refused", "refused", "refused"], dialed: [] });
});
