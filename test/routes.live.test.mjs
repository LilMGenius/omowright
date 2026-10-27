import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { createRoutes } from "../src/routes.js";

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

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html><head><title>routes fixture</title></head>
<body>
<script>window.__imgError=false;window.__imgLoad=false;</script>
<img src="/pixel.png" id="pic"
  onerror="window.__imgError=true"
  onload="window.__imgLoad=true">
<p>fixture page with enough text content for the readiness probe to pass on load</p>
</body></html>`);
      return;
    }
    if (url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PIXEL_PNG);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
    server.on("error", reject);
  });
}

test("live abort of png fires img onerror", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-routes-png-"));
  const { server, url } = await startFixtureServer();
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const routes = createRoutes(page);
    await routes.route("*.png", route => route.abort());
    await page.goto(url);
    const imgState = await page.evaluate(`new Promise((resolve, reject) => {
      const finish = () => resolve({ error: window.__imgError === true, load: window.__imgLoad === true });
      if (window.__imgError || window.__imgLoad) return finish();
      const img = document.getElementById("pic");
      if (!img) return reject(new Error("img#pic missing"));
      img.addEventListener("error", finish);
      img.addEventListener("load", finish);
      setTimeout(() => reject(new Error("timed out waiting for img error or load")), 8000);
    })`);
    assert.equal(imgState.error, true, "aborted image fires onerror");
    assert.equal(imgState.load, false, "aborted image does not load");
    await routes.dispose();
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
    await new Promise(resolve => server.close(resolve));
  }
});

test("live fulfill mocks /api/x json even when the server returns 404", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-routes-api-"));
  const { server, url } = await startFixtureServer();
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const routes = createRoutes(page);
    await routes.route("*/api/x", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ mocked: true }),
    }));
    await page.goto(url);
    const payload = await page.evaluate("fetch('/api/x').then(r => r.json())");
    assert.deepEqual(payload, { mocked: true });
    await routes.dispose();
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
    await new Promise(resolve => server.close(resolve));
  }
});
