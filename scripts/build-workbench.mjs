import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { workbenchBundleDecision } from "./workbench-bundle-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const service = join(root, "services", "research-workbench");
const source = join(service, "src");
const destination = join(root, "src-tauri", "resources", "research-workbench");
const buildRoot = join(service, "var", "workbench-bundle");
const supportedTargets = new Set(["aarch64-apple-darwin"]);

function hostTarget() {
  const architecture =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "darwin") return `${architecture}-apple-darwin`;
  if (process.platform === "win32") return `${architecture}-pc-windows-msvc`;
  if (process.platform === "linux") return `${architecture}-unknown-linux-gnu`;
  return `${architecture}-${process.platform}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
    }
    process.exit(result.status ?? 1);
  }
  return (result.stdout || "").trim();
}

function pythonExecutable() {
  const configured = process.env.OLEAFLY_WORKBENCH_BUILD_PYTHON;
  if (configured) return configured;
  const virtualEnvironment = join(
    service,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  if (existsSync(virtualEnvironment)) return virtualEnvironment;
  return process.platform === "win32" ? "python" : "python3";
}

function resetDestination() {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(destination)) {
    if (entry !== ".gitkeep") rmSync(join(destination, entry), { recursive: true, force: true });
  }
}

function makeSymlinksPortable(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (!isAbsolute(target)) continue;
      const portable = relative(dirname(path), target);
      if (portable === ".." || portable.startsWith(`..${sep}`)) {
        throw new Error(`Workbench bundle symlink escapes its directory: ${path} -> ${target}`);
      }
      unlinkSync(path);
      symlinkSync(portable, path);
    } else if (stat.isDirectory()) {
      makeSymlinksPortable(path);
    }
  }
}

function assertPortableBundle(directory) {
  const root = realpathSync(directory);
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== root && !target.startsWith(`${root}${sep}`)) {
          throw new Error(`Workbench bundle symlink escapes its directory: ${path}`);
        }
      } else if (stat.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
}

function signWorkbenchBundle(directory, identity) {
  const framework = join(directory, "_internal", "Python.framework");
  if (!existsSync(framework)) {
    throw new Error(`missing Python framework in Workbench bundle: ${framework}`);
  }
  const args = ["--force", "--deep"];
  if (identity !== "-") args.push("--options", "runtime", "--timestamp");
  args.push("--sign", identity, framework);
  run("/usr/bin/codesign", args);
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", framework]);
  run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    join(directory, "rfw-workbench"),
  ]);
}

const target = process.env.OLEAFLY_WORKBENCH_TARGET
  || process.env.TAURI_ENV_TARGET_TRIPLE
  || hostTarget();

let decision;
try {
  decision = workbenchBundleDecision({
    policy: process.env.OLEAFLY_WORKBENCH_BUNDLE_POLICY,
    target,
    hostTarget: hostTarget(),
    debug: process.env.TAURI_ENV_DEBUG === "true",
    supportedTargets,
  });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

if (decision.kind === "development") {
  process.stdout.write(
    "Research Workbench engine: debug build uses OLEAFLY_WORKBENCH_PYTHON.\n",
  );
  process.exit(0);
}

if (decision.kind === "unavailable") {
  resetDestination();
  writeFileSync(
    join(destination, ".gitkeep"),
    "",
  );
  if (decision.reason === "public-release") {
    process.stdout.write(
      "Research Workbench engine: omitted from this public release because PyMuPDF " +
        "redistribution has no approved corresponding-source or commercial policy.\n",
    );
  } else {
    process.stdout.write(
      `Research Workbench engine: unavailable for ${target}; this build will not fall back to Python.\n`,
    );
  }
  process.exit(0);
}

const python = pythonExecutable();
const version = run(
  python,
  ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
  { capture: true },
);
if (Number(version.split(".")[0]) < 3 || (Number(version.split(".")[0]) === 3 && Number(version.split(".")[1]) < 12)) {
  throw new Error(`Research Workbench packaging needs Python 3.12 or later, found ${version}`);
}
run(python, ["-m", "PyInstaller", "--version"], { capture: true });

rmSync(buildRoot, { recursive: true, force: true });
const dist = join(buildRoot, "dist");
const work = join(buildRoot, "work");
const spec = join(buildRoot, "spec");
const pyinstallerArgs = [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onedir",
  "--console",
  "--name",
  "rfw-workbench",
  "--distpath",
  dist,
  "--workpath",
  work,
  "--specpath",
  spec,
  "--paths",
  source,
  "--collect-data",
  "research_file_workbench.workbench",
  "--collect-data",
  "research_file_workbench.docx",
  "--osx-entitlements-file",
  join(root, "src-tauri", "entitlements.plist"),
];
const configuredIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const identity = configuredIdentity || "-";
if (configuredIdentity) pyinstallerArgs.push("--codesign-identity", configuredIdentity);
pyinstallerArgs.push(join(source, "research_file_workbench", "workbench", "launcher.py"));

run(python, pyinstallerArgs);
const built = join(dist, "rfw-workbench");
run(python, [
  join(root, "scripts", "workbench-notices.py"),
  "--output",
  join(built, "THIRD_PARTY_NOTICES.txt"),
]);

makeSymlinksPortable(built);
resetDestination();
for (const entry of readdirSync(built)) {
  cpSync(join(built, entry), join(destination, entry), {
    recursive: true,
    verbatimSymlinks: true,
  });
}
assertPortableBundle(destination);
signWorkbenchBundle(destination, identity);
process.stdout.write(`Research Workbench engine staged at ${destination}\n`);
rmSync(buildRoot, { recursive: true, force: true });
run(process.execPath, [join(root, "scripts", "test-workbench-bundle.mjs")]);
