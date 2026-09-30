import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as omowright from "../src/index.js";

test("resolveCloakProfile creates and reuses a fixed fingerprint seed", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    const first = await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });
    const second = await omowright.resolveCloakProfile({ profileDir });

    assert.equal(first.fingerprintSeed, 31415);
    assert.deepEqual(second, first);
    assert.deepEqual(first.browserArgs, [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      `--user-data-dir=${profileDir}`,
      "--fingerprint=31415",
      // CloakBrowser ships macOS and Windows fingerprints; every non-macOS host presents as Windows.
      `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
    ]);

    const metadataPath = path.join(profileDir, ".omowright-cloak.json");
    assert.equal(JSON.parse(readFileSync(metadataPath, "utf8")).fingerprintSeed, 31415);
    assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
    assert.equal(statSync(profileDir).mode & 0o777, 0o700);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("resolveCloakProfile rejects an explicit seed that changes identity", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });

    await assert.rejects(
      omowright.resolveCloakProfile({ profileDir, fingerprintSeed: 27182 }),
      /fingerprint seed mismatch/i,
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("buildCloakBrowserArgs rejects every identity override form", () => {
  for (const extraArgs of [
    ["--fingerprint=27182"],
    ["--fingerprint", "27182"],
    ["--fingerprint-platform=windows"],
    ["--user-data-dir=/tmp/other-profile"],
    ["--user-data-dir", "/tmp/other-profile"],
  ]) {
    assert.throws(
      () => omowright.buildCloakBrowserArgs({
        profileDir: "/tmp/profile",
        fingerprintSeed: 31415,
        extraArgs,
      }),
      /override fixed profile identity/i,
    );
  }
});

test("resolveCloakProfile tightens existing metadata permissions", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));
  const metadataPath = path.join(profileDir, ".omowright-cloak.json");

  try {
    writeFileSync(metadataPath, '{"fingerprintSeed":31415}\n', { mode: 0o644 });
    chmodSync(metadataPath, 0o644);

    await omowright.resolveCloakProfile({ profileDir });

    assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});
