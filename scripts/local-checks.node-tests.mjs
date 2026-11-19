import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOOK = join(ROOT, ".githooks/pre-commit");
const FULL = join(ROOT, "scripts/check-full.sh");

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oleafly-local-checks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  await mkdir(bin);
  await mkdir(join(root, "docsite"));
  for (const tool of ["pnpm", "cargo"]) {
    const path = join(bin, tool);
    await writeFile(path, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.OLEAFLY_CHECK_TEST_LOG, JSON.stringify({
  tool: ${JSON.stringify(tool)}, args: process.argv.slice(2), cwd: process.cwd(),
  embedManifest: process.env.OLEAFLY_EMBED_TEST_MANIFEST,
}) + "\\n");
if (process.env.OLEAFLY_CHECK_TEST_FAIL === ${JSON.stringify(tool)}) process.exit(23);
`);
    await chmod(path, 0o755);
  }
  const uname = join(bin, "uname");
  await writeFile(uname, '#!/bin/sh\nprintf "%s\\n" "${OLEAFLY_CHECK_TEST_PLATFORM:-Darwin}"\n');
  await chmod(uname, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OLEAFLY_CHECK_TEST_LOG: log };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  const stage = async (path, text = "fixture\n") => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
    git("add", "--", path);
  };
  const run = (script = HOOK, args = [], overrides = {}) => spawnSync("sh", [script, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8",
  });
  const calls = async () => {
    try {
      return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }
  };
  return { root, git, stage, run, calls };
}

const commands = calls => calls.map(({ tool, args }) => [tool, ...args]);
const lint = ["pnpm", "exec", "biome", "lint", "--staged", "--vcs-enabled=true", "--vcs-client-kind=git", "--no-errors-on-unmatched"];
const catalogs = [["pnpm", "i18n:types:check"], ["pnpm", "i18n:validate", "--locale", "zh-Hans"]];
const format = ["cargo", "fmt", "--all", "--", "--check"];

test("empty, documentation and frontend lockfile commits never compile or test", async t => {
  for (const path of [null, "docs/Editor.md", "docsite/src/page.astro", "pnpm-lock.yaml"]) {
    await t.test(String(path), async t => {
      const f = await fixture(t);
      if (path) await f.stage(path);
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await f.calls(), []);
    });
  }
});

test("staged frontend paths with spaces lint without broad tests or a bundle", async t => {
  const f = await fixture(t);
  await f.stage("src/a view.tsx");
  await f.stage("packages/editor/src/view.ts");
  assert.equal(f.run().status, 0);
  assert.deepEqual(commands(await f.calls()), [lint]);
});

test("catalog changes run the existing English and Simplified Chinese checks", async t => {
  const f = await fixture(t);
  await f.stage("src/i18n/locales/en/editor.json", "{}\n");
  assert.equal(f.run().status, 0);
  assert.deepEqual(commands(await f.calls()), catalogs);
});

test("Rust sources, workspace locks and toolchain settings only request formatting", async t => {
  for (const path of ["crates/core/src/lib.rs", "src-tauri/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml", "rust-toolchain.toml"]) {
    await t.test(path, async t => {
      const f = await fixture(t);
      await f.stage(path);
      assert.equal(f.run().status, 0);
      assert.deepEqual(commands(await f.calls()), [format]);
    });
  }
});

test("deleted catalogs and Rust files keep their checks", async t => {
  const f = await fixture(t);
  await f.stage("src/i18n/locales/en/removed.json", "{}\n");
  await f.stage("crates/core/src/removed.rs");
  f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  f.git("rm", "src/i18n/locales/en/removed.json", "crates/core/src/removed.rs");
  assert.equal(f.run().status, 0);
  assert.deepEqual(commands(await f.calls()), [...catalogs, format]);
});

test("unstaged source changes do not broaden a documentation commit", async t => {
  const f = await fixture(t);
  await f.stage("docs/Editor.md");
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src/unstaged.ts"), "fixture\n");
  assert.equal(f.run().status, 0);
  assert.deepEqual(await f.calls(), []);
});

test("staged whitespace failures block a commit before any tool starts", async t => {
  const f = await fixture(t);
  await f.stage("src/view.ts", "trailing space \n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staged diff failed/);
  assert.deepEqual(await f.calls(), []);
});

test("lint, catalog and format failures block the hook", async t => {
  for (const [path, tool] of [["src/view.ts", "pnpm"], ["src/i18n/locales/en/editor.json", "pnpm"], ["crates/core/src/lib.rs", "cargo"]]) {
    await t.test(path, async t => {
      const f = await fixture(t);
      await f.stage(path);
      const result = f.run(HOOK, [], { OLEAFLY_CHECK_TEST_FAIL: tool });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /pre-commit: .* failed/);
      assert.equal((await f.calls()).length, 1);
    });
  }
});

test("full checks require an explicit area and reject unknown areas", async t => {
  const f = await fixture(t);
  for (const args of [[], ["--help"]]) assert.equal(f.run(FULL, args).status, 0);
  assert.equal(f.run(FULL, ["unknown"]).status, 2);
  assert.deepEqual(await f.calls(), []);
});

test("manual full frontend checks retain the build with one Vitest worker", async t => {
  const f = await fixture(t);
  assert.equal(f.run(FULL, ["frontend"]).status, 0);
  assert.deepEqual(commands(await f.calls()), [["pnpm", "lint"], ...catalogs, ["pnpm", "build"], ["pnpm", "exec", "vitest", "run", "--maxWorkers=1"]]);
});

test("manual full Rust checks use one compilation job and stop on failure", async t => {
  const f = await fixture(t);
  assert.equal(f.run(FULL, ["rust"]).status, 0);
  assert.deepEqual(commands(await f.calls()), [format,
    ["cargo", "clippy", "--workspace", "--all-targets", "--jobs", "1", "--", "-D", "warnings"],
    ["cargo", "test", "--workspace", "--all-targets", "--jobs", "1"],
  ]);
  const failed = await fixture(t);
  assert.equal(failed.run(FULL, ["rust"], { OLEAFLY_CHECK_TEST_FAIL: "cargo" }).status, 23);
  assert.deepEqual(commands(await failed.calls()), [format]);
});

test("manual Windows Rust checks retain embedded-manifest and CLI coverage", async t => {
  const f = await fixture(t);
  assert.equal(f.run(FULL, ["rust"], { OLEAFLY_CHECK_TEST_PLATFORM: "MINGW64_NT" }).status, 0);
  const calls = await f.calls();
  assert.deepEqual(commands(calls).slice(2), [
    ["cargo", "test", "--workspace", "--lib", "--jobs", "1"],
    ["cargo", "test", "-p", "oleafly-cli", "--test", "cli", "--jobs", "1"],
  ]);
  assert.equal(calls[2].embedManifest, "1");
});

test("manual docs checks run inside docsite and all runs areas sequentially", async t => {
  const f = await fixture(t);
  assert.equal(f.run(FULL, ["all"]).status, 0);
  const calls = await f.calls();
  assert.deepEqual(calls.map(({ tool }) => tool), ["pnpm", "pnpm", "pnpm", "pnpm", "pnpm", "cargo", "cargo", "cargo", "pnpm"]);
  assert.deepEqual(commands(calls).at(-1), ["pnpm", "build"]);
  assert.equal(calls.at(-1).cwd, join(f.root, "docsite"));
});
