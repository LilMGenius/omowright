import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { describeLayers, layersHeader, snapshotWithLayers } from "../src/layers.js";

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
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function startFixtureServer() {
  const server = createServer((req, res) => {
    const name = path.basename((req.url ?? "/").split("?")[0]);
    if (!name.startsWith("layers-")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    try {
      const body = readFileSync(path.join(FIXTURE_DIR, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        urlFor: name => `http://127.0.0.1:${port}/${name}`,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
    server.on("error", reject);
  });
}

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-layers-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  return {
    connection,
    cleanup: async () => {
      await connection.close();
      rmSync(ud, { recursive: true, force: true });
    },
  };
}

test("layersHeader formats none and blocking lines", () => {
  assert.equal(layersHeader({ blocking: null, candidates: [], viewport: { width: 1440, height: 900 } }), "@layers none");
  assert.equal(
    layersHeader({
      blocking: {
        tagName: "DIV",
        role: "dialog",
        name: "Cookie consent",
        coverage: 0.96,
        position: "fixed",
        selectorHint: "div",
        ariaModal: false,
      },
      candidates: [],
      viewport: { width: 1440, height: 900 },
    }),
    `@layers blocking=dialog "Cookie consent" coverage=96% hint=div`,
  );
  assert.equal(
    layersHeader({
      blocking: {
        tagName: "DIV",
        role: "",
        name: "Saved",
        coverage: 0.08,
        position: "fixed",
        selectorHint: "#toast",
        ariaModal: false,
      },
      candidates: [],
      viewport: { width: 1440, height: 900 },
    }),
    `@layers blocking=DIV "Saved" coverage=8% hint=#toast`,
  );
});

test("describeLayers and snapshotWithLayers classify live overlays", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const fixtures = await startFixtureServer();
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;

    await page.goto(fixtures.urlFor("layers-dialog.html"));
    const dialogLayers = await describeLayers(page);
    assert.equal(dialogLayers.blocking?.role, "dialog");
    assert.equal(dialogLayers.blocking?.name, "Cookie consent");
    assert.ok(dialogLayers.blocking?.coverage >= 0.9, `dialog coverage ${dialogLayers.blocking?.coverage}`);
    assert.ok(
      layersHeader(dialogLayers).includes(`blocking=dialog "Cookie consent"`),
      layersHeader(dialogLayers),
    );

    await page.goto(fixtures.urlFor("layers-plain.html"));
    const plainLayers = await describeLayers(page);
    assert.equal(plainLayers.blocking, null);
    assert.equal(layersHeader(plainLayers), "@layers none");

    const snapshot = await page.snapshot();
    const withLayers = await snapshotWithLayers(page);
    const headerLine = layersHeader(withLayers.layers);
    assert.equal(withLayers.tree.startsWith(`${headerLine}\n`), true);
    const snapshotFirstLine = snapshot.tree.split("\n")[0];
    assert.ok(snapshotFirstLine.length > 0);
    assert.ok(
      withLayers.tree.split("\n").slice(1).join("\n").includes(snapshotFirstLine),
      "snapshotWithLayers tree still contains the snapshot's first line after the header",
    );

    await page.goto(fixtures.urlFor("layers-toast.html"));
    const toastLayers = await describeLayers(page);
    assert.equal(toastLayers.blocking, null, "a toast must not register as a blocking layer");
  } finally {
    await cleanup();
    await fixtures.close();
  }
});
