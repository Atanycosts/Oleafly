import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_ROOT = "src-tauri/resources/skills";
const SCRIPT_FILES = ["sync-kdense.mjs", "frontmatter.mjs", "yaml-check.mjs", "exec.mjs"];

async function fixture(t, skills) {
  const root = await mkdtemp(join(tmpdir(), "oleafly-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts/skills");
  await mkdir(scripts, { recursive: true });
  for (const file of SCRIPT_FILES) {
    await cp(join(REPO_ROOT, "scripts/skills", file), join(scripts, file));
  }
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "LICENSE.md"), "MIT test input\n");
  await writeFile(join(scripts, "kdense-manifest.json"), JSON.stringify({
    repo: "https://example.org/test-skills", pin: "test-revision", exclude: [], skills,
  }));
  return { root, source, scripts };
}

function sync({ root, source }) {
  return spawnSync(process.execPath, ["scripts/skills/sync-kdense.mjs", "--source", source], {
    cwd: root, encoding: "utf8",
  });
}

test("synchronizing reapplies the existing Typst adaptations and Hayagriva asset", async (t) => {
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "scripts/skills/kdense-manifest.json"), "utf8"));
  const entries = manifest.skills.filter((entry) => entry.patch);
  const f = await fixture(t, entries);
  await cp(join(REPO_ROOT, "scripts/skills/patches"), join(f.scripts, "patches"), { recursive: true });

  for (const entry of entries) {
    const dir = join(f.root, SKILL_ROOT, entry.id);
    await mkdir(dir, { recursive: true });
    await cp(join(REPO_ROOT, SKILL_ROOT, entry.id, "SKILL.md"), join(dir, "SKILL.md"));
    if (entry.id === "citation-management") {
      await mkdir(join(dir, "assets"));
      await cp(join(REPO_ROOT, SKILL_ROOT, entry.id, "assets/hayagriva_template.yml"),
        join(dir, "assets/hayagriva_template.yml"));
    }
    const reverse = spawnSync("git", ["apply", "--reverse", join(f.scripts, entry.patch)], {
      cwd: f.root, encoding: "utf8",
    });
    assert.equal(reverse.status, 0, reverse.stderr);
    const beforeAdaptation = (await readFile(join(dir, "SKILL.md"), "utf8"))
      .replace(/\n  oleafly:\n    tier: vendored\n    phase: [^\n]+\n    origin:\n      repo: [^\n]+\n      commit: [^\n]+\n/, "\n");
    const upstream = join(f.source, "skills", entry.id);
    await mkdir(upstream, { recursive: true });
    await writeFile(join(upstream, "SKILL.md"), beforeAdaptation);
  }
  const originalManifest = { ...manifest, skills: entries };
  await writeFile(join(f.scripts, "kdense-manifest.json"), JSON.stringify(originalManifest));

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = sync(f);
    assert.equal(result.status, 0, result.stderr);
    for (const entry of entries) {
      assert.deepEqual(await readFile(join(f.root, SKILL_ROOT, entry.id, "SKILL.md")),
        await readFile(join(REPO_ROOT, SKILL_ROOT, entry.id, "SKILL.md")));
    }
    assert.deepEqual(await readFile(join(f.root, SKILL_ROOT, "citation-management/assets/hayagriva_template.yml")),
      await readFile(join(REPO_ROOT, SKILL_ROOT, "citation-management/assets/hayagriva_template.yml")));
  }
});

test("an incompatible adaptation fails without replacing the installed skill", async (t) => {
  const f = await fixture(t, [{ id: "sample", phase: "research", patch: "sample.patch" }]);
  const installed = join(f.root, SKILL_ROOT, "sample");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "retained installed content\n");
  const upstream = join(f.source, "skills/sample");
  await mkdir(upstream, { recursive: true });
  await writeFile(join(upstream, "SKILL.md"),
    "---\nname: sample\ndescription: Test skill\nlicense: MIT\n---\n\nNew upstream body\n");
  await writeFile(join(f.scripts, "sample.patch"),
    "diff --git a/src-tauri/resources/skills/sample/SKILL.md b/src-tauri/resources/skills/sample/SKILL.md\n" +
    "--- a/src-tauri/resources/skills/sample/SKILL.md\n+++ b/src-tauri/resources/skills/sample/SKILL.md\n" +
    "@@ -1 +1 @@\n-Old upstream body\n+Local adaptation\n");
  const result = sync(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local adaptation failed/);
  assert.equal(await readFile(join(installed, "SKILL.md"), "utf8"), "retained installed content\n");
});

test("an unmodified vendor skill still syncs with its origin metadata", async (t) => {
  const f = await fixture(t, [{ id: "sample", phase: "research" }]);
  const upstream = join(f.source, "skills/sample");
  await mkdir(upstream, { recursive: true });
  await writeFile(join(upstream, "SKILL.md"),
    "---\nname: sample\ndescription: Test skill\nlicense: MIT\n---\n\nOriginal body\n");
  const result = sync(f);
  assert.equal(result.status, 0, result.stderr);
  const { parseFrontmatterMapping } = await import("./frontmatter.mjs");
  const text = await readFile(join(f.root, SKILL_ROOT, "sample/SKILL.md"), "utf8");
  assert.equal(parseFrontmatterMapping(text).metadata.oleafly.origin.commit, "test-revision");
  assert.ok(text.endsWith("Original body\n"));
});
