#!/usr/bin/env node

// Validate an unshipped source-build candidate with the shipping LSP smoke.
// The binary's identity and patch provenance travel with the hosted artifact.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentTarget } from "../fetch-language-servers.mjs";
import { smokeDiagnostics } from "../smoke-language-servers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [binaryArgument, outputArgument, sourceCommit] = process.argv.slice(2);
if (!binaryArgument || !outputArgument || !sourceCommit || process.argv.length !== 5) {
  throw new Error("Usage: validate-tinymist-candidate.mjs BINARY OUTPUT_DIRECTORY SOURCE_COMMIT");
}
const binary = resolve(binaryArgument);
const output = resolve(outputArgument);
const target = currentTarget();
const filename = target.includes("windows") ? "tinymist.exe" : "tinymist";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(
  await readFile(join(root, "scripts/language-servers/manifest.json"), "utf8"),
);
const server = manifest.servers.tinymist;
const bytes = await readFile(binary);
const binarySha256 = digest(bytes);
const probe = spawnSync(binary, server.versionProbe.args, {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
if (probe.error) throw probe.error;
const versionOutput = `${probe.stdout}\n${probe.stderr}`.trim();
const versionField = (name) =>
  versionOutput.split(/\r?\n/).find((line) => line.startsWith(`${name}:`))
    ?.slice(name.length + 1).trim();
if (
  probe.status !== 0 ||
  ![server.tag, `${server.tag}-dirty`].includes(versionField("Build Git Describe")) ||
  versionField("Commit SHA") !== sourceCommit ||
  versionField("Cargo Target Triple") !== target
) {
  throw new Error(`Tinymist candidate identity mismatch: ${versionOutput}`);
}

await smokeDiagnostics(
  "tinymist",
  server,
  binary,
  join(root, "test/fixtures/editor-support/project"),
);
if (digest(await readFile(binary)) !== binarySha256) {
  throw new Error("Tinymist candidate changed during validation");
}

const patchPath = join(root, "patches/tinymist/editor-diagnostics-revision.patch");
const patch = await readFile(patchPath);
const identity = {
  sourceCommit,
  patchSha256: digest(patch),
  target,
  binarySize: bytes.length,
  binarySha256,
  versionOutput,
};
await mkdir(output, { recursive: true });
await writeFile(join(output, filename), bytes, { mode: 0o755 });
await writeFile(join(output, `${filename}.sha256`), `${identity.binarySha256}  ${filename}\n`);
await writeFile(join(output, "candidate.json"), `${JSON.stringify(identity, null, 2)}\n`);
await writeFile(join(output, "editor-diagnostics-revision.patch"), patch);
await copyFile(join(root, "patches/tinymist/README.md"), join(output, "PATCH-README.md"));
console.log(`Verified source-build candidate: ${JSON.stringify(identity)}`);
