import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, fstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ execute: vi.fn(), directories: [] as string[] }));
vi.mock("node:child_process", () => ({ execFileSync: boundary.execute }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdtempSync: (prefix: string) => {
    const directory = actual.mkdtempSync(prefix);
    boundary.directories.push(directory);
    return directory;
  } };
});
import { readManuscriptOracle } from "./word-manuscript-oracle";

const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
let descriptors: number[] = [];

function usePython(script: string) {
  boundary.execute.mockImplementation((executable: string, _args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
    const descriptor = Array.isArray(options.stdio) ? options.stdio[0] : undefined;
    expect(typeof descriptor).toBe("number");
    if (typeof descriptor !== "number") throw new Error("Oracle stdin must be a file descriptor.");
    descriptors.push(descriptor);
    expect(fstatSync(descriptor).isFile()).toBe(true);
    expect(options.input).toBeUndefined();
    if (process.platform !== "win32") {
      expect(statSync(boundary.directories.at(-1)!).mode & 0o777).toBe(0o700);
      expect(statSync(join(boundary.directories.at(-1)!, "input.json")).mode & 0o777).toBe(0o600);
    }
    // Only substitute the child program: use the real process and its stdin/stdout.
    return childProcess.execFileSync(executable, ["-c", script], { ...options, timeout: 5_000 });
  });
}

beforeEach(() => {
  boundary.execute.mockReset();
  boundary.directories.length = 0;
  descriptors = [];
});
afterEach(() => {
  for (const descriptor of descriptors) {
    expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  }
  for (const directory of boundary.directories) expect(existsSync(directory)).toBe(false);
});

describe("manuscript oracle process I/O", () => {
  it("delivers a complete multi-megabyte JSON input through finite stdin and preserves UTF-8 output", () => {
    usePython(`import base64, hashlib, json, os, stat, sys
payload = json.loads(sys.stdin.read())
data = base64.b64decode(payload["source"]["base64"])
json.dump({"sourceSha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data),
    "mode": payload["mode"], "regularStdin": stat.S_ISREG(os.fstat(0).st_mode),
    "base64": payload["source"]["base64"], "label": "完整输入 🐼"}, sys.stdout, ensure_ascii=False)
`);
    const bytes = randomBytes(2 * 1024 * 1024 + 11);
    expect(readManuscriptOracle(bytes)).toEqual({
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      mode: "read",
      regularStdin: true,
      base64: bytes.toString("base64"),
      label: "完整输入 🐼",
    });
    expect(boundary.execute).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("retains child stderr and cleans its input when Python rejects the request", () => {
    usePython(`import json, sys
json.loads(sys.stdin.read())
sys.stderr.write("Independent I/O fixture refusal.\\n")
sys.exit(2)
`);
    expect(() => readManuscriptOracle(new Uint8Array([1, 2, 3])))
      .toThrow("Independent DOCX XML oracle failed.\nIndependent I/O fixture refusal.");
  }, 10_000);

  it("cleans its input after invalid child JSON without accepting a result", () => {
    usePython(`import json, sys
json.loads(sys.stdin.read())
sys.stdout.write("invalid result")
`);
    expect(() => readManuscriptOracle(new Uint8Array([4, 5, 6])))
      .toThrow("Independent DOCX XML oracle failed.");
  }, 10_000);
});
