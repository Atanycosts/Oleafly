import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const service = join(root, "services", "research-workbench");
const environment = join(service, ".venv");
const python = join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

function run(args) {
  const result = spawnSync("uv", args, { cwd: service, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(python)) run(["venv", "--python", "3.12", environment]);
run(["pip", "install", "--python", python, "-e", ".[dev,fixture-building]"]);
process.stdout.write(`Workbench Python: ${python}\n`);
