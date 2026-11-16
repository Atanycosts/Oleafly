import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, createLogger, type Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";
import { serializeMacosBuild } from "./serialize-macos-build";

describe.skipIf(process.platform !== "darwin")("macOS build queue", () => {
  it("waits for the previous build to finish writing before starting another", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oleafly-build-queue-"));
    writeFileSync(path.join(root, "entry.js"), "console.log('built');");
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondWaiting!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const waiting = new Promise<void>((resolve) => { secondWaiting = resolve; });
    const secondStart = vi.fn();
    const logger = createLogger("silent");
    logger.info = () => { secondWaiting(); };
    const run = (plugin: Plugin, customLogger = createLogger("silent")) => build({
      configFile: false,
      root,
      customLogger,
      plugins: [serializeMacosBuild(root), plugin],
      build: { outDir: plugin.name, rollupOptions: { input: path.join(root, "entry.js") } },
    });
    try {
      const first = run({
        name: "hold-first-build",
        async writeBundle() { firstStarted(); await holdFirst; },
      });
      await started;
      const second = run({ name: "observe-second-build", buildStart: secondStart }, logger);
      await waiting;
      expect(secondStart).not.toHaveBeenCalled();
      releaseFirst();
      await Promise.all([first, second]);
      expect(secondStart).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("releases the queue after a build fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oleafly-build-failure-"));
    writeFileSync(path.join(root, "entry.js"), "console.log('built');");
    const logger = createLogger("silent");
    const info = vi.spyOn(logger, "info");
    const options = {
      configFile: false as const,
      root,
      customLogger: logger,
      build: { write: false, rollupOptions: { input: path.join(root, "entry.js") } },
    };
    try {
      await expect(build({
        ...options,
        plugins: [serializeMacosBuild(root), {
          name: "fail-build",
          buildStart() { this.error("fixture build failure"); },
        }],
      })).rejects.toThrow("fixture build failure");
      await build({ ...options, plugins: [serializeMacosBuild(root)] });
      expect(info.mock.calls.flat().join(" ")).not.toContain("Another Oleafly build");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
