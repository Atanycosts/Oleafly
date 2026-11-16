import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync, unlinkSync } from "node:fs";
import { getPriority, setPriority, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Plugin, ResolvedConfig } from "vite";

// Independent agent chats can invoke Vite directly, bypassing package scripts.
// macOS shlock gives those builds one queue and recovers a terminated owner's
// lock without introducing a resident process or a third-party dependency.
export function serializeMacosBuild(repo: string): Plugin {
  const id = createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 16);
  const lock = path.join(tmpdir(), `oleafly-build-${id}.lock`);
  let config: ResolvedConfig;
  let acquired = false;
  const release = () => {
    if (!acquired) return;
    acquired = false;
    unlinkSync(lock);
    process.off("exit", release);
  };

  return {
    name: "serialize-macos-build",
    apply: "build",
    configResolved(resolved) { config = resolved; },
    async buildStart() {
      if (process.platform !== "darwin" || config.isWorker) return;
      // Favor interactive apps while this background build and its children
      // run. Preserve an explicitly lower priority selected by the caller.
      setPriority(Math.max(10, getPriority()));
      let waiting = false;
      for (;;) {
        const result = spawnSync("/usr/bin/shlock", ["-p", String(process.pid), "-f", lock]);
        if (result.error) throw result.error;
        if (result.status === 0) break;
        if (result.status !== 1) throw new Error(`shlock exited with ${result.status}`);
        if (!waiting) {
          config.logger.info("Another Oleafly build is running; waiting for it to finish.");
          waiting = true;
        }
        await setTimeout(2_000);
      }
      acquired = true;
      process.once("exit", release);
    },
    buildEnd(error) {
      if (error) release();
    },
    closeBundle: release,
  };
}
