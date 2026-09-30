import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function listDocs() {
  const skillDir = path.join(repoRoot, "skills", "omowright");
  const docs = [path.join(skillDir, "SKILL.md")];
  for (const f of await readdir(path.join(skillDir, "references"))) {
    if (f.endsWith(".md")) docs.push(path.join(skillDir, "references", f));
  }
  for (const d of await readdir(path.join(repoRoot, "presets"))) {
    const p = path.join(repoRoot, "presets", d, "SKILL.md");
    try { await stat(p); docs.push(p); } catch {}
  }
  return docs;
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "missing YAML frontmatter");
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

// Paths a reader is expected to open: package-root files, home-relative install
// paths, and doc-relative `references/x.md` / `presets/x/SKILL.md` links.
function referencedPaths(text, docPath) {
  const out = new Set();
  const docDir = path.dirname(docPath);
  for (const m of text.matchAll(/`((?:TOOLS|README)\.md|docs\/[A-Za-z0-9_-]+\.md)`/g)) out.add(path.join(repoRoot, m[1]));
  for (const m of text.matchAll(/~\/\.agents\/skills\/omowright\/([A-Za-z0-9_./-]+\.md)/g)) out.add(path.join(repoRoot, "skills", "omowright", m[1]));
  for (const m of text.matchAll(/`(references\/[A-Za-z0-9_-]+\.md)`/g)) out.add(path.join(docDir, m[1]));
  for (const m of text.matchAll(/`(presets\/[A-Za-z0-9_-]+\/SKILL\.md)`/g)) out.add(path.join(repoRoot, m[1]));
  for (const m of text.matchAll(/`(skills\/omowright\/references\/[A-Za-z0-9_-]+\.md)`/g)) out.add(path.join(repoRoot, m[1]));
  return [...out].map((p) => p.replace(/[.,;:)]+$/, ""));
}

const docs = await listDocs();
assert.ok(docs.length >= 6, `expected skill + presets docs, found ${docs.length}`);

for (const doc of docs) {
  const rel = path.relative(repoRoot, doc);
  const text = await readFile(doc, "utf8");

  if (path.basename(doc) === "SKILL.md") {
    test(`${rel}: frontmatter name matches its directory`, () => {
      const { name, description } = frontmatter(text);
      assert.equal(name, path.basename(path.dirname(doc)));
      assert.ok(description && description.length > 20, "description must route the skill");
      assert.ok(!/\n/.test(description), "description must be a single line");
    });
  }

  test(`${rel}: every referenced doc path exists`, async () => {
    const missing = [];
    for (const p of referencedPaths(text, doc)) {
      const candidates = [p, p.replace(/\/\.\.\.\//, "/")];
      if (p.includes("/.../")) continue; // elided glob examples, not links
      let ok = false;
      for (const c of candidates) { try { await stat(c); ok = true; break; } catch {} }
      if (!ok) missing.push(p);
    }
    assert.deepEqual(missing, [], `dangling references in ${rel}`);
  });
}
