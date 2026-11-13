import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repository);
const binary = process.env.OLEAFLY_E2E_APP_BINARY;
const identifier = "com.oleafly.app.e2e";
const exists = async path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const bundleIdentifier = executable => execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", resolve(dirname(executable), "../Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (process.platform !== "darwin" || !binary) throw new Error("Set OLEAFLY_E2E_APP_BINARY to the packaged macOS E2E executable.");
if (bundleIdentifier(binary) !== identifier) throw new Error(`The app must be bundled as ${identifier}.`);
for (const line of execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n")) {
  const executable = line.trim().replace(/^\d+\s+/, "");
  if (!executable.includes("/Contents/MacOS/") || !await exists(resolve(dirname(executable), "../Info.plist"))) continue;
  if (bundleIdentifier(executable) === identifier) throw new Error("An E2E app is already running; use the next free native acceptance slot.");
}
const parent = resolve(".private/task-checkpoint-native");
await mkdir(parent, { recursive: true });
const run = await mkdtemp(join(parent, "run-"));
const data = join(run, "data");
const socket = `/tmp/oleafly-checkpoint-${process.pid}.sock`;
const lock = process.env.OLEAFLY_E2E_LOCK_DIR ?? "/tmp/oleafly-e2e-bridge.lock";
const moves = [];
const lifecycle = [];
const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
let app;
let playwright;
let locked = false;
let outcome = "FAILED";
let failure;
let cleaning;

async function record() {
  await writeFile(join(run, "runner.json"), JSON.stringify({ outcome, failure, binary, binarySha256, data, lifecycle, webStorage: moves }, null, 2));
}

async function move(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try { await rename(source, target); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(source, { recursive: true });
  }
}

async function stopApp(required = false) {
  if (!app || app.exitCode !== null || app.signalCode !== null) {
    if (required) throw new Error("The app exited before the required restart boundary.");
    return;
  }
  const owned = app;
  const stopped = new Promise(accept => owned.once("close", (code, signal) => accept({ code, signal })));
  if (!owned.kill("SIGKILL")) throw new Error(`Could not stop owned app PID ${owned.pid}.`);
  const timeout = new AbortController();
  let result;
  try { result = await Promise.race([stopped, delay(10_000, null, { signal: timeout.signal })]); }
  finally { timeout.abort(); }
  if (!result || result.signal !== "SIGKILL") throw new Error(`Owned app PID ${owned.pid} did not exit at the SIGKILL boundary.`);
  lifecycle.push({ action: "exit", pid: owned.pid, ...result, at: new Date().toISOString() });
  app = undefined;
  await rm(socket, { force: true });
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (playwright && playwright.exitCode === null && playwright.signalCode === null) playwright.kill("SIGTERM");
    await stopApp();
    for (const entry of [...moves].reverse()) {
      if (entry.restored) continue;
      if (entry.existed && !entry.backedUp) continue;
      if (await exists(entry.original)) await move(entry.original, entry.after);
      if (entry.existed) await move(entry.backup, entry.original);
      entry.restored = true;
      await record();
    }
    await rm(socket, { force: true });
    if (locked && (await readFile(join(lock, "owner"), "utf8")).trim() === String(process.pid)) await rm(lock, { recursive: true });
  })();
  return cleaning;
}

const bootSeed = {
  "oleafly.locale": "en", "oleafly.latexTools": "1", "oleafly.openInTree": "0", "oleafly.appFontSize": "16",
  "oleafly.tours": JSON.stringify({ state: { schemaVersion: 1, enabled: false, tours: {} }, version: 1 }),
  "oleafly.assistant-runtime.v1": JSON.stringify({ state: { runtime: "built-in" }, version: 0 }),
};
const environment = { ...process.env, OLEAFLY_DATA_DIR: data, OLEAFLY_E2E_PRODUCTION: "1", OLEAFLY_CHECKPOINT_RUN: run, TAURI_PLAYWRIGHT_SOCKET: socket, OLEAFLY_E2E_BOOT_LOCALSTORAGE: JSON.stringify(bootSeed), OLEAFLY_E2E_LAUNCH_LOCALSTORAGE: JSON.stringify({ "oleafly.liveCollaboration": "0", "oleafly.preview.detached.*": null }) };

async function runStage(stage) {
  await rm(socket, { force: true });
  const appLog = createWriteStream(join(run, `${stage}-app.log`));
  app = spawn(binary, [], { cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.pipe(appLog, { end: false });
  app.stderr.pipe(appLog, { end: false });
  app.once("close", () => appLog.end());
  let launchError;
  app.once("error", error => { launchError = error; });
  lifecycle.push({ action: "launch", stage, pid: app.pid, at: new Date().toISOString() });
  await record();
  const deadline = Date.now() + 90_000;
  while (!await exists(socket)) {
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode !== null || Date.now() >= deadline) throw new Error(`Native bridge unavailable during ${stage}; inspect ${stage}-app.log.`);
    await delay(250);
  }
  console.log(`task-checkpoint: ${stage}, owned app PID ${app.pid}`);
  const log = createWriteStream(join(run, `${stage}-playwright.log`));
  playwright = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", "e2e/playwright.config.ts", "e2e/tests/132-task-checkpoint-recovery.spec.ts", "--grep", `${stage} native`, "--retries=0", "--output", join(run, stage)], { cwd: repository, env: { ...environment, OLEAFLY_CHECKPOINT_STAGE: stage }, stdio: ["ignore", "pipe", "pipe"] });
  playwright.stdout.pipe(process.stdout, { end: false });
  playwright.stderr.pipe(process.stderr, { end: false });
  playwright.stdout.pipe(log, { end: false });
  playwright.stderr.pipe(log, { end: false });
  const code = await new Promise((accept, reject) => { playwright.once("error", reject); playwright.once("exit", accept); });
  log.end();
  playwright = undefined;
  if (code !== 0) throw new Error(`${stage} failed with Playwright exit ${code}.`);
  await stopApp(true);
  await record();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  failure = `Runner received ${signal}`;
  void cleanup().then(record).then(() => process.exit(130), error => { console.error(error); process.exit(1); });
});

try {
  await mkdir(lock);
  locked = true;
  await writeFile(join(lock, "owner"), `${process.pid}\n`);
  await mkdir(data);
  await writeFile(join(data, "config.json"), JSON.stringify({ ui_locale: "en", checkpoints_enabled: false, research_tasks_enabled: true, research_background_enabled: false }));
  const paths = [`WebKit/${identifier}`, `Caches/${identifier}`, `HTTPStorages/${identifier}`, `HTTPStorages/${identifier}.binarycookies`, `Application Support/${identifier}`, `Saved Application State/${identifier}.savedState`, `Logs/${identifier}`];
  for (const [index, path] of paths.entries()) {
    const original = join(homedir(), "Library", path);
    const entry = { original, backup: join(run, "webkit-before", String(index)), after: join(run, "webkit-after", String(index)), existed: await exists(original), backedUp: false, restored: false };
    moves.push(entry);
    if (entry.existed) { await move(original, entry.backup); entry.backedUp = true; }
    await record();
  }
  console.log(`task-checkpoint: retained evidence ${run}`);
  for (const stage of ["prepare", "resume", "verify"]) await runStage(stage);
  outcome = "PASSED";
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) { failure = `${failure ?? ""}\nCleanup failed: ${error.stack ?? error}`; outcome = "FAILED"; process.exitCode = 1; console.error(failure); }
  await record();
  console.log(`task-checkpoint: ${outcome}, evidence ${run}`);
}
