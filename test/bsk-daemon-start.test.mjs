import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemonWithCli, windowsDaemonTaskName } from "../src/bsk/daemon-info.js";

// Platform contract: when bsk cannot detach its daemon from the caller's Job Object, the start
// must still succeed through a scheduled task that opens no console window, whatever the home path holds.
// Each case registers a real scheduled task and waits for it to run, about 6 s on Windows: past
// bun test's 5 s default, which node --test does not have.
const windowsOnly = { skip: process.platform !== "win32", timeout: 30_000 };
const REFUSAL = "cannot start an independent Windows daemon; the host may prohibit Job Object breakaway";

// A compiled stand-in for bsk: `status` refuses breakaway, `daemon start` records what the task gave it.
const FAKE_BSK = `import { writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "status") { console.log(JSON.stringify({ message: ${JSON.stringify(REFUSAL)}, exit_code: 2 })); process.exit(2); }
writeFileSync(path.join(process.env.BSK_HOME, "started.txt"), args.join(" "));
`;

let dir;
let bskBin;

function powershell(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }).trim();
}

before(() => {
  if (process.platform !== "win32") return;
  dir = mkdtempSync(path.join(tmpdir(), "bsk-task-"));
  writeFileSync(path.join(dir, "fake-bsk.mjs"), FAKE_BSK);
  mkdirSync(path.join(dir, "bin & (x)"));
  bskBin = path.join(dir, "bin & (x)", "bsk.exe");
  execFileSync("bun", ["build", "--compile", path.join(dir, "fake-bsk.mjs"), "--outfile", bskBin], { stdio: "ignore" });
});

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

for (const name of ["Tom&Jerry (x) ^ ;", "100% %PATH% home", "O'Brien", "O\u2019Brien", "\u2018quoted\u201B \u201A"]) {
  test(`a refused breakaway starts the daemon from a headless task for a home named ${name}`, windowsOnly, async () => {
    const home = path.join(dir, name);
    mkdirSync(home);
    const task = windowsDaemonTaskName(home);
    try {
      await startDaemonWithCli({ home, bskBin });
      const [execute, args] = powershell(`$a = (Get-ScheduledTask -TaskName '${task}').Actions[0]; $a.Execute + '|' + $a.Arguments`).split("|");
      assert.match(execute, /\\conhost\.exe$/i);
      assert.match(args, /^--headless powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
      const marker = path.join(home, "started.txt");
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(readFileSync(marker, "utf8"), "daemon start --foreground");
    } finally {
      powershell(`Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue; exit 0`);
    }
  });
}
