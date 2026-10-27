import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, globSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { connectPipe, createAgentTabs, createChromeApi, UnsupportedOperationError } from "../src/index.js";

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
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const msToChromeTime = ms => BigInt(Math.floor((ms + CHROME_EPOCH_OFFSET_MS) * 1000));

function makeProfileFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "omowright-profile-"));
  mkdirSync(path.join(root, "Default"), { recursive: true });

  writeFileSync(path.join(root, "Default", "Bookmarks"), JSON.stringify({
    checksum: "fixture",
    roots: {
      bookmark_bar: {
        id: "1", name: "Bookmarks bar", type: "folder",
        children: [
          { id: "10", name: "Example", type: "url", url: "https://example.com/", date_added: "13300000000000000" },
          { id: "11", name: "Docs", type: "folder", children: [
            { id: "12", name: "MDN", type: "url", url: "https://developer.mozilla.org/", date_added: "13400000000000000" },
          ], date_added: "13350000000000000" },
        ],
      },
      other: { id: "2", name: "Other bookmarks", type: "folder", children: [] },
      synced: { id: "3", name: "Mobile bookmarks", type: "folder", children: [] },
    },
    version: 1,
  }));

  const historyDb = new DatabaseSync(path.join(root, "Default", "History"));
  historyDb.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER, last_visit_time INTEGER);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);
    CREATE TABLE downloads (id INTEGER PRIMARY KEY, target_path LONGVARCHAR, start_time INTEGER, received_bytes INTEGER, total_bytes INTEGER, state INTEGER);
    CREATE TABLE downloads_url_chains (id INTEGER, chain_index INTEGER, url LONGVARCHAR);
  `);
  const visitTime = msToChromeTime(Date.parse("2026-08-20T12:00:00Z"));
  historyDb.prepare("INSERT INTO urls VALUES (1, 'https://example.com/', 'Example Domain', 3, ?)").run(visitTime);
  historyDb.prepare("INSERT INTO urls VALUES (2, 'https://github.com/', 'GitHub', 1, ?)").run(visitTime - 1000000n);
  historyDb.prepare("INSERT INTO visits VALUES (100, 1, ?, 805306368)").run(visitTime);
  historyDb.prepare("INSERT INTO downloads VALUES (7, '/tmp/old-file.zip', ?, 100, 100, 1)").run(visitTime);
  historyDb.prepare("INSERT INTO downloads_url_chains VALUES (7, 0, 'https://files.example.com/old-file.zip')").run();
  historyDb.close();

  const topDb = new DatabaseSync(path.join(root, "Default", "Top Sites"));
  topDb.exec("CREATE TABLE top_sites (url LONGVARCHAR PRIMARY KEY, url_rank INTEGER, title LONGVARCHAR)");
  topDb.prepare("INSERT INTO top_sites VALUES ('https://example.com/', 0, 'Example Domain')").run();
  topDb.prepare("INSERT INTO top_sites VALUES ('https://github.com/', 1, 'GitHub')").run();
  topDb.close();

  return root;
}

test("chrome.tabs and chrome.windows expose CDP target and window state", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-chrome-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const chrome = createChromeApi(connection);
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto("https://example.com");

    const all = await chrome.tabs.query({});
    assert.ok(all.length >= 1, "at least one tab");
    const tab = all.find(item => item.url.includes("example.com"));
    assert.ok(tab, "example.com tab present");
    assert.equal(tab.title, "Example Domain");
    assert.equal(typeof tab.windowId, "number");

    const filtered = await chrome.tabs.query({ url: "*://example.com/*" });
    assert.equal(filtered.length, 1);
    const byTitle = await chrome.tabs.query({ title: "Example" });
    assert.equal(byTitle.length, 1);

    const got = await chrome.tabs.get(tab.id);
    assert.equal(got.url, tab.url);

    const wins = await chrome.windows.getAll({ populate: true });
    assert.equal(wins.length, 1);
    assert.ok(wins[0].tabs.some(item => item.url.includes("example.com")));
    const current = await chrome.windows.getCurrent();
    assert.equal(current.id, wins[0].id);
    const single = await chrome.windows.get(wins[0].id);
    assert.equal(single.id, wins[0].id);
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("chrome.bookmarks, history, and topSites read real Chrome profile formats", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const profileRoot = makeProfileFixture();
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-chrome-prof-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const chrome = createChromeApi(connection, { profilePath: profileRoot });

    const tree = await chrome.bookmarks.getTree();
    assert.equal(tree.length, 3);
    const bar = tree.find(node => node.title === "Bookmarks bar");
    assert.equal(bar.children.length, 2);

    const hits = await chrome.bookmarks.search("mdn");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, "https://developer.mozilla.org/");

    const recent = await chrome.bookmarks.getRecent(1);
    assert.equal(recent[0].title, "MDN");

    const children = await chrome.bookmarks.getChildren("11");
    assert.equal(children[0].title, "MDN");

    const historyHits = await chrome.history.search({ text: "example" });
    assert.equal(historyHits.length, 1);
    assert.equal(historyHits[0].visitCount, 3);
    assert.equal(historyHits[0].lastVisitTime, Date.parse("2026-08-20T12:00:00Z"));

    const visits = await chrome.history.getVisits({ url: "https://example.com/" });
    assert.equal(visits.length, 1);
    assert.equal(visits[0].visitTime, Date.parse("2026-08-20T12:00:00Z"));

    const tops = await chrome.topSites.get();
    assert.deepEqual(tops.map(site => site.url), ["https://example.com/", "https://github.com/"]);

    const dls = await chrome.downloads.search({});
    assert.equal(dls.length, 1);
    assert.equal(dls[0].state, "complete");
    assert.equal(dls[0].url, "https://files.example.com/old-file.zip");
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
    rmSync(profileRoot, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("chrome.downloads.download saves a file through a real server", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]);
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="server-file.bin"',
    });
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const ud = mkdtempSync(path.join(tmpdir(), "omowright-dl-test-"));
  const downloadDir = mkdtempSync(path.join(tmpdir(), "omowright-dl-dir-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const chrome = createChromeApi(connection, { downloadDir });
    const result = await chrome.downloads.download({ url: `http://127.0.0.1:${port}/file` });
    assert.equal(result.state, "complete");
    assert.ok(result.filename.endsWith("server-file.bin"));
    assert.deepEqual(readFileSync(result.filename), payload);
  } finally {
    await connection.close();
    server.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
    rmSync(downloadDir, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("extension-bridge-only chrome methods throw UnsupportedOperationError", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-chrome-unsup-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const chrome = createChromeApi(connection);
    await assert.rejects(() => chrome.bookmarks.create({ title: "x", url: "https://x.com" }), UnsupportedOperationError);
    await assert.rejects(() => chrome.history.addUrl({ url: "https://x.com" }), UnsupportedOperationError);
    await assert.rejects(() => chrome.downloads.cancel(1), UnsupportedOperationError);
    await assert.rejects(() => chrome.bookmarks.getTree(), UnsupportedOperationError);
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
  }
});
