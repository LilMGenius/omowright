import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { createTrace } from "../src/trace.js";
import { startTraceServer } from "./fixtures/trace-server.mjs";

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
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test(
  "a live trace records navigation, network bodies and step screenshots",
  { skip: !SHELL && "no chromium binary found", timeout: 60_000 },
  async () => {
    const server = await startTraceServer();
    const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-trace-live-"));
    const traceDir = mkdtempSync(path.join(tmpdir(), "omowright-trace-out-"));
    let connection = null;
    try {
      connection = await connectPipe({
        browserPath: SHELL,
        browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${userDataDir}`],
        storageRoot: userDataDir,
      });
      const page = (await createAgentTabs(connection).create("about:blank")).page;
      const trace = createTrace(page, { dir: traceDir });

      await page.goto(server.url);
      assert.deepEqual(await page.evaluate("window.__data"), { items: [{ id: 1 }, { id: 2 }], source: "load" });

      const clicked = await trace.step("click", async () => {
        await page.locator("#go").click();
        return await page.evaluate("window.__clicked");
      });
      assert.deepEqual(clicked, { clicked: true });

      const summary = await trace.stop();
      assert.equal(summary.steps, 1);
      assert.ok(summary.network >= 2, `expected the page and its api calls, got ${summary.network}`);
      assert.equal(summary.url, server.url);

      const har = JSON.parse(readFileSync(path.join(traceDir, "trace.har"), "utf8"));
      assert.equal(har.log.version, "1.2");
      const data = har.log.entries.find(entry => entry.request.url === `${server.url}api/data`);
      assert.ok(data, `no /api/data entry in ${har.log.entries.map(entry => entry.request.url).join(", ")}`);
      assert.equal(data.response.status, 200);
      assert.equal(data.response.content.mimeType, "application/json");
      assert.deepEqual(JSON.parse(data.response.content.text), { items: [{ id: 1 }, { id: 2 }], source: "load" });
      assert.ok(data.time >= 0);
      assert.ok(data.request.headers.length > 0);

      const shots = readdirSync(path.join(traceDir, "screenshots")).sort();
      assert.equal(shots.length, 2, `expected before/after screenshots, got ${shots.join(", ")}`);
      assert.ok(shots[0].endsWith("-click-after.png"), shots[0]);
      assert.ok(shots[1].endsWith("-click-before.png"), shots[1]);
      for (const shot of shots) {
        const bytes = readFileSync(path.join(traceDir, "screenshots", shot));
        assert.deepEqual(bytes.subarray(0, 8), PNG_MAGIC, `${shot} is not a png`);
        assert.ok(bytes.length > 100, `${shot} is suspiciously small`);
      }

      const lines = readFileSync(path.join(traceDir, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(lines.map(line => line.seq), lines.map((_line, index) => index));
      const navigation = lines.find(line => line.kind === "navigation" && line.url === server.url);
      assert.ok(navigation, `no navigation event for ${server.url}`);
      assert.equal(typeof navigation.frameId, "string");
      assert.equal(lines.filter(line => line.kind === "step").length, 1);
      assert.ok(lines.some(line => line.kind === "network" && line.url === `${server.url}api/click`), "click traffic is captured");
    } finally {
      await connection?.close();
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10 });
      rmSync(traceDir, { recursive: true, force: true, maxRetries: 10 });
      await server.close();
    }
  },
);
