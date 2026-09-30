import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PipeCdpClient, connectPipe } from "../src/pipe.js";
import { BrowserConnection } from "../src/connection.js";
import { resolveDialogAction } from "../src/dialog-policy.js";
import { createAgentTabs } from "../src/agent-tabs.js";

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

function captureClient(options = {}) {
  const client = new PipeCdpClient({ browserPath: process.execPath, ...options });
  const sent = [];
  client.send = async (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    return {};
  };
  return { client, sent };
}

function dialogOpening(params = {}, sessionId = "sess-1") {
  return {
    method: "Page.javascriptDialogOpening",
    sessionId,
    params: {
      type: "alert",
      message: "hi",
      defaultPrompt: "",
      url: "https://example.test/",
      ...params,
    },
  };
}

async function handledParams(client, sent, msg = dialogOpening()) {
  sent.length = 0;
  await client._handleTransportMessage(msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "Page.handleJavaScriptDialog");
  assert.equal(sent[0].sessionId, msg.sessionId);
  return sent[0].params;
}

test("resolveDialogAction maps policies and falls back when the function throws or rejects", async () => {
  assert.deepEqual(await resolveDialogAction({ accept: false }), { accept: false });
  assert.deepEqual(await resolveDialogAction({ accept: true, promptText: "hello" }), {
    accept: true,
    promptText: "hello",
  });

  const seen = [];
  const policy = (dialog) => {
    seen.push(dialog);
    if (dialog.type === "confirm") return false;
    return { accept: true, promptText: "typed" };
  };
  assert.deepEqual(
    await resolveDialogAction(policy, { type: "confirm", message: "x", url: "https://a.test/" }),
    { accept: false },
  );
  assert.deepEqual(
    await resolveDialogAction(policy, { type: "prompt", message: "q", defaultPrompt: "dflt", url: "https://example.test/" }),
    { accept: true, promptText: "typed" },
  );
  assert.deepEqual(seen, [
    { type: "confirm", message: "x", defaultPrompt: "", url: "https://a.test/" },
    { type: "prompt", message: "q", defaultPrompt: "dflt", url: "https://example.test/" },
  ]);

  assert.deepEqual(await resolveDialogAction(() => { throw new Error("policy boom"); }), { accept: true });
  assert.deepEqual(await resolveDialogAction(async () => { throw new Error("policy reject"); }), { accept: true });
});

test("PipeCdpClient default dialogPolicy auto-accepts", async () => {
  const { client, sent } = captureClient();
  assert.deepEqual(client.dialogPolicy, { accept: true });
  assert.deepEqual(await handledParams(client, sent), { accept: true });
});

test("object dialogPolicy can dismiss and supply promptText", async () => {
  const { client, sent } = captureClient({ dialogPolicy: { accept: false } });
  assert.deepEqual(client.dialogPolicy, { accept: false });
  assert.deepEqual(await handledParams(client, sent), { accept: false });

  client.setDialogPolicy({ accept: true, promptText: "hello" });
  assert.deepEqual(client.dialogPolicy, { accept: true, promptText: "hello" });
  assert.deepEqual(await handledParams(client, sent, dialogOpening({ type: "prompt", message: "q" })), {
    accept: true,
    promptText: "hello",
  });

  const decline = () => false;
  client.setDialogPolicy(decline);
  assert.equal(client.dialogPolicy, decline);
  assert.deepEqual(await handledParams(client, sent), { accept: false });
});

test("BrowserConnection.setDialogPolicy delegates or rejects by transport", () => {
  const { client } = captureClient();
  const connection = new BrowserConnection(client);
  connection.setDialogPolicy({ accept: false, promptText: "nope" });
  assert.deepEqual(client.dialogPolicy, { accept: false, promptText: "nope" });

  const unsupported = new BrowserConnection({
    ensureConnected: async () => {},
    send: async () => ({}),
    on: () => () => {},
    close: async () => {},
    discoverTargets: async () => [],
  });
  assert.throws(
    () => unsupported.setDialogPolicy({ accept: false }),
    { message: "dialog policy is not supported by this transport" },
  );
});

test("live dialogPolicy dismisses confirm, fills prompt, and still emits dialog", {
  skip: !SHELL && "no chromium binary found",
  timeout: 60_000,
}, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-dialogs-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
    dialogPolicy: { accept: false },
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;

    const confirmDialog = page.waitForEvent("dialog", { timeout: 5000 });
    const confirmed = page.evaluate(() => confirm("x"));
    assert.equal((await confirmDialog).type, "confirm");
    assert.equal((await confirmDialog).message, "x");
    assert.equal(await confirmed, false);

    connection.setDialogPolicy({ accept: true, promptText: "hello" });

    const promptDialog = page.waitForEvent("dialog", { timeout: 5000 });
    const prompted = page.evaluate(() => prompt("q"));
    assert.equal((await promptDialog).type, "prompt");
    assert.equal(await prompted, "hello");
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true });
  }
});
