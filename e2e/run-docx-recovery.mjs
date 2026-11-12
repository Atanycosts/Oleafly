import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repository);
const identifier = "com.oleafly.app.e2e";
const binary = process.env.OLEAFLY_E2E_APP_BINARY;
const author = process.env.OLEAFLY_REAL_DOCX;
const expectedHash = process.env.OLEAFLY_REAL_DOCX_SHA256;
const renderer = process.env.OLEAFLY_LIBREOFFICE ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice";
const python = process.env.OLEAFLY_WORKBENCH_PYTHON ?? resolve("services/research-workbench/.venv/bin/python");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (path) => lstat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });

if (process.platform !== "darwin") throw new Error("This recovery acceptance runner currently supports packaged macOS Tauri apps only.");
if (!binary || !author || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) throw new Error("Set OLEAFLY_E2E_APP_BINARY, OLEAFLY_REAL_DOCX and its exact OLEAFLY_REAL_DOCX_SHA256.");
await Promise.all([access(binary), access(author), access(renderer), access(python)]);
const runningApps = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n");
for (const line of runningApps) {
  const executable = line.trim().replace(/^\d+\s+/, "");
  if (!executable.includes("/Contents/MacOS/")) continue;
  const plist = resolve(dirname(executable), "../Info.plist");
  if (!await exists(plist)) continue;
  let appIdentifier;
  try { appIdentifier = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { continue; }
  if (appIdentifier === identifier) throw new Error("An E2E app is already running. Close that instance before isolated acceptance.");
}
const bundledIdentifier = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", resolve(dirname(binary), "../Info.plist")], { encoding: "utf8" }).trim();
if (bundledIdentifier !== identifier) throw new Error(`Refusing app identifier ${bundledIdentifier}. Build with src-tauri/tauri.e2e.conf.json.`);
if (sha256(await readFile(author)) !== expectedHash) throw new Error("Author input SHA-256 does not match the supplied exact hash.");

const parent = resolve(".private/docx-recovery-native");
await mkdir(parent, { recursive: true });
const run = await mkdtemp(join(parent, "run-"));
const data = join(run, "data");
const socket = `/tmp/oleafly-docx-${process.pid}.sock`;
const lock = process.env.OLEAFLY_E2E_LOCK_DIR ?? "/tmp/oleafly-e2e-bridge.lock";
const webStores = [
  `Library/WebKit/${identifier}`,
  `Library/Caches/${identifier}`,
  `Library/HTTPStorages/${identifier}`,
  `Library/HTTPStorages/${identifier}.binarycookies`,
  `Library/Application Support/${identifier}`,
  `Library/Saved Application State/${identifier}.savedState`,
  `Library/Logs/${identifier}`,
].map((path) => join(homedir(), path));
const moves = [];
const lifecycle = [];
let app;
let playwright;
let locked = false;
let outcome = "FAILED";
let failure;
let cleaning;

async function move(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try { await rename(source, target); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    const pending = `${target}.copying`;
    await cp(source, pending, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rename(pending, target);
    await rm(source, { recursive: true, force: true });
  }
}

async function record() {
  await writeFile(join(run, "runner.json"), JSON.stringify({ outcome, failure, author, expectedHash, binary, data, socket, lifecycle, webStorage: moves }, null, 2));
}

async function stopApp(signal) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const owned = app;
  const stopped = new Promise((accept) => owned.once("exit", (code, receivedSignal) => accept({ code, signal: receivedSignal })));
  // Workbench inherits stderr and exits when the app's owner pipe closes.
  // ChildProcess.close waits for those inherited handles as well as app exit.
  const closed = new Promise((accept) => owned.once("close", accept));
  lifecycle.push({ action: "signal", pid: owned.pid, signal, at: new Date().toISOString() });
  if (!owned.kill(signal)) throw new Error(`Could not send ${signal} to owned app PID ${owned.pid}.`);
  const timeout = new AbortController();
  let result;
  try { result = await Promise.race([Promise.all([stopped, closed]).then(([exit]) => exit), delay(10_000, null, { signal: timeout.signal })]); }
  finally { timeout.abort(); }
  if (result === null) throw new Error(`Owned app PID ${owned.pid} did not exit after ${signal}.`);
  if (signal === "SIGKILL" && result.signal !== "SIGKILL") throw new Error(`Owned app PID ${owned.pid} exited without the requested SIGKILL.`);
  lifecycle.push({ action: "exit", pid: owned.pid, ...result, at: new Date().toISOString() });
  app = undefined;
  await rm(socket, { force: true });
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (playwright && playwright.exitCode === null && playwright.signalCode === null) playwright.kill("SIGTERM");
    await stopApp("SIGKILL");
    for (const entry of [...moves].reverse()) {
      if (entry.restored) continue;
      const backupExists = await exists(entry.backup);
      if (entry.existed && !backupExists) { entry.restored = true; continue; }
      if (await exists(entry.original)) await move(entry.original, entry.after);
      if (backupExists) await move(entry.backup, entry.original);
      entry.restored = true;
      await record();
    }
    await rm(socket, { force: true });
    if (locked) {
      const owner = await readFile(join(lock, "owner"), "utf8");
      if (owner.trim() === String(process.pid)) await rm(lock, { recursive: true });
      locked = false;
    }
  })();
  return cleaning;
}

const bootSeed = {
  "oleafly.locale": "en",
  "oleafly.tours": JSON.stringify({ state: { schemaVersion: 1, enabled: false, tours: {} }, version: 1 }),
  "oleafly.latexTools": "1", "oleafly.openInTree": "0", "oleafly.appFontSize": "16",
  "oleafly.assistant-runtime.v1": JSON.stringify({ state: { runtime: "built-in" }, version: 0 }),
};
const environment = {
  ...process.env,
  OLEAFLY_DATA_DIR: data,
  OLEAFLY_WORKBENCH_PYTHON: python,
  OLEAFLY_LIBREOFFICE: renderer,
  OLEAFLY_E2E_PRODUCTION: "1",
  OLEAFLY_DOCX_RECOVERY_RUN: run,
  OLEAFLY_REAL_DOCX: resolve(author),
  OLEAFLY_E2E_BOOT_LOCALSTORAGE: JSON.stringify(bootSeed),
  OLEAFLY_E2E_LAUNCH_LOCALSTORAGE: JSON.stringify({ "oleafly.liveCollaboration": "0", "oleafly.preview.detached.*": null }),
  TAURI_PLAYWRIGHT_SOCKET: socket,
};

async function startApp(stage) {
  await rm(socket, { force: true });
  const log = createWriteStream(join(run, `${stage}-app.log`));
  app = spawn(binary, [], { cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.pipe(log, { end: false });
  app.stderr.pipe(log, { end: false });
  app.once("close", () => log.end());
  let launchError;
  app.once("error", (error) => { launchError = error; });
  lifecycle.push({ action: "launch", pid: app.pid, stage, at: new Date().toISOString() });
  await record();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Native app exited during ${stage}; see ${stage}-app.log.`);
    if (await exists(socket)) return;
    await delay(250);
  }
  throw new Error(`Native bridge did not appear during ${stage}; see ${stage}-app.log.`);
}

async function runStage(stage) {
  await startApp(stage);
  console.log(`docx-recovery: ${stage}, owned app PID ${app.pid}`);
  const log = createWriteStream(join(run, `${stage}-playwright.log`));
  playwright = spawn("pnpm", ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "e2e/tests/127-docx-recovery.spec.ts", "--grep", `${stage} native`, "--retries=0", "--output", join(run, stage)], {
    cwd: repository, env: { ...environment, OLEAFLY_DOCX_RECOVERY_STAGE: stage }, stdio: ["ignore", "pipe", "pipe"],
  });
  playwright.stdout.pipe(process.stdout, { end: false });
  playwright.stderr.pipe(process.stderr, { end: false });
  playwright.stdout.pipe(log, { end: false });
  playwright.stderr.pipe(log, { end: false });
  const code = await new Promise((accept, reject) => {
    playwright.once("error", reject);
    playwright.once("exit", accept);
  });
  log.end();
  playwright = undefined;
  if (code !== 0) throw new Error(`${stage} failed with Playwright exit ${code}.`);
  await stopApp("SIGKILL");
  await record();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  failure = `Runner received ${signal}`;
  void cleanup().then(record).then(() => process.exit(130), (error) => { console.error(error); process.exit(1); });
});

try {
  await mkdir(lock);
  locked = true;
  await writeFile(join(lock, "owner"), `${process.pid}\n`);
  await mkdir(data);
  await writeFile(join(data, "config.json"), JSON.stringify({ ui_locale: "en", checkpoints_enabled: false }));
  for (const [index, original] of webStores.entries()) {
    const entry = { original, backup: join(run, "webkit-before", String(index)), after: join(run, "webkit-after", String(index)), existed: await exists(original), backedUp: false, restored: false };
    moves.push(entry);
    await record();
    if (entry.existed) { await move(original, entry.backup); entry.backedUp = true; await record(); }
  }
  console.log(`docx-recovery: retained acceptance data ${run}`);
  for (const stage of ["prepare", "restore", "discard"]) await runStage(stage);
  if (sha256(await readFile(author)) !== expectedHash) throw new Error("Author input changed during acceptance.");
  outcome = "PASSED";
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  try {
    const authorHashAfter = sha256(await readFile(author));
    lifecycle.push({ action: "author-hash-after", sha256: authorHashAfter });
    if (authorHashAfter !== expectedHash) throw new Error("Author input changed during acceptance.");
  } catch (error) { failure = `${failure ?? ""}\n${error.stack ?? error}`; outcome = "FAILED"; process.exitCode = 1; }
  try { await cleanup(); }
  catch (error) { failure = `${failure ?? ""}\nCleanup failed: ${error.stack ?? error}`; outcome = "FAILED"; process.exitCode = 1; console.error(failure); }
  await record();
  console.log(`docx-recovery: ${outcome}, evidence ${run}`);
}
