import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const nodeOptions = ["--max-old-space-size=8192", process.env.NODE_OPTIONS]
  .filter(Boolean)
  .join(" ");
const result = spawnSync(process.execPath, [vite, "build", ...process.argv.slice(2)], {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
