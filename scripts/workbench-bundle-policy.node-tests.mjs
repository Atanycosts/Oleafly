import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveWorkbenchBundlePolicy,
  workbenchBundleDecision,
} from "./workbench-bundle-policy.mjs";

const supportedTargets = new Set(["aarch64-apple-darwin"]);
const scripts = dirname(fileURLToPath(import.meta.url));

test("local packaging remains the default on a supported arm64 macOS host", () => {
  assert.equal(resolveWorkbenchBundlePolicy(undefined), "local");
  assert.deepEqual(
    workbenchBundleDecision({
      policy: undefined,
      target: "aarch64-apple-darwin",
      hostTarget: "aarch64-apple-darwin",
      debug: false,
      supportedTargets,
    }),
    { kind: "build", policy: "local" },
  );
});

test("public releases fail closed without bundling the Workbench engine", () => {
  assert.deepEqual(
    workbenchBundleDecision({
      policy: "public-unbundled",
      target: "aarch64-apple-darwin",
      hostTarget: "aarch64-apple-darwin",
      debug: false,
      supportedTargets,
    }),
    { kind: "unavailable", policy: "public-unbundled", reason: "public-release" },
  );
  assert.deepEqual(
    workbenchBundleDecision({
      policy: "public-unbundled",
      target: "aarch64-apple-darwin",
      hostTarget: "aarch64-apple-darwin",
      debug: true,
      supportedTargets,
    }),
    { kind: "unavailable", policy: "public-unbundled", reason: "public-release" },
  );
});

test("unknown distribution policies are refused instead of falling back to local", () => {
  assert.throws(
    () => resolveWorkbenchBundlePolicy("publish-anyway"),
    /verified PyMuPDF corresponding-source or commercial release policy/,
  );
});

test("debug and unsupported targets do not borrow a Python runtime", () => {
  assert.equal(
    workbenchBundleDecision({
      policy: "local",
      target: "aarch64-apple-darwin",
      hostTarget: "aarch64-apple-darwin",
      debug: true,
      supportedTargets,
    }).kind,
    "development",
  );
  assert.deepEqual(
    workbenchBundleDecision({
      policy: "local",
      target: "x86_64-apple-darwin",
      hostTarget: "aarch64-apple-darwin",
      debug: false,
      supportedTargets,
    }),
    { kind: "unavailable", policy: "local", reason: "unsupported-target" },
  );
});

test("the public bundle path removes stale engine files before a release build", () => {
  const temporary = mkdtempSync(join(tmpdir(), "oleafly-public-bundle-"));
  try {
    const copiedScripts = join(temporary, "scripts");
    mkdirSync(copiedScripts);
    for (const name of ["build-workbench.mjs", "workbench-bundle-policy.mjs"]) {
      cpSync(join(scripts, name), join(copiedScripts, name));
    }
    const destination = join(
      temporary,
      "src-tauri",
      "resources",
      "research-workbench",
    );
    mkdirSync(join(destination, "_internal"), { recursive: true });
    writeFileSync(join(destination, "rfw-workbench"), "stale engine");
    writeFileSync(join(destination, "_internal", "libmupdf.dylib"), "stale PDF library");

    const result = spawnSync(
      process.execPath,
      [join(copiedScripts, "build-workbench.mjs")],
      {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          OLEAFLY_WORKBENCH_BUNDLE_POLICY: "public-unbundled",
          OLEAFLY_WORKBENCH_TARGET: "aarch64-apple-darwin",
          TAURI_ENV_DEBUG: "false",
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /omitted from this public release/);
    assert.equal(existsSync(join(destination, "rfw-workbench")), false);
    assert.equal(existsSync(join(destination, "_internal", "libmupdf.dylib")), false);
    assert.equal(existsSync(join(destination, ".gitkeep")), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an invalid policy leaves an existing local bundle untouched", () => {
  const temporary = mkdtempSync(join(tmpdir(), "oleafly-invalid-policy-"));
  try {
    const copiedScripts = join(temporary, "scripts");
    mkdirSync(copiedScripts);
    for (const name of ["build-workbench.mjs", "workbench-bundle-policy.mjs"]) {
      cpSync(join(scripts, name), join(copiedScripts, name));
    }
    const destination = join(
      temporary,
      "src-tauri",
      "resources",
      "research-workbench",
    );
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "rfw-workbench"), "local engine");

    const result = spawnSync(
      process.execPath,
      [join(copiedScripts, "build-workbench.mjs")],
      {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          OLEAFLY_WORKBENCH_BUNDLE_POLICY: "publish-anyway",
          OLEAFLY_WORKBENCH_TARGET: "aarch64-apple-darwin",
          TAURI_ENV_DEBUG: "false",
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported OLEAFLY_WORKBENCH_BUNDLE_POLICY/);
    assert.equal(readFileSync(join(destination, "rfw-workbench"), "utf8"), "local engine");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("the release workflow keeps public engine packaging fail-closed", () => {
  const workflow = readFileSync(
    join(dirname(scripts), ".github", "workflows", "release.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /OLEAFLY_WORKBENCH_BUNDLE_POLICY: public-unbundled/,
  );
  assert.match(workflow, /Preflight the public Workbench bundle policy/);
  assert.match(workflow, /Verify the public app has no Workbench engine/);
  assert.match(workflow, /echo "sign_tinymist=\$sign_tinymist"/);
  assert.match(workflow, /steps\.capabilities\.outputs\.sign_tinymist == 'true'/);
  assert.match(
    workflow,
    /steps\.capabilities\.outputs\.workbench_engine == 'true'/,
  );
});
