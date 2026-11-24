import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.OLEAFLY_WORKBENCH_BUNDLE
  || join(
    root,
    "src-tauri",
    "resources",
    "research-workbench",
    process.platform === "win32" ? "rfw-workbench.exe" : "rfw-workbench",
  );
const contract = JSON.parse(
  readFileSync(
    join(root, "services", "research-workbench", "contracts", "journals", "world-contract.json"),
    "utf8",
  ),
);
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "oleafly-workbench-bundle-")));

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function getJson(address, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request_ = request(new URL(path, address), (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          rejectRequest(new Error(`${path} returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
    request_.on("error", rejectRequest);
    request_.end();
  });
}

function startService(name) {
  const library = join(temporary, name);
  const child = spawn(executable, ["--library-root", library], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  const ready = new Promise((resolveReady, rejectReady) => {
    let output = "";
    const deadline = setTimeout(() => {
      rejectReady(new Error(`packaged Workbench did not report readiness\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(deadline);
      resolveReady(output.slice(0, newline).trim());
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      rejectReady(new Error(`packaged Workbench exited before readiness (${code})\n${stderr}`));
    });
  });
  return { child, library, stderr: () => stderr, ready };
}

async function stopService(service) {
  service.child.stdin.end();
  await Promise.race([
    new Promise((resolveExit, rejectExit) => {
      service.child.once("exit", (code, signal) => {
        if (code === 0) resolveExit();
        else rejectExit(new Error(`packaged Workbench exited with ${code ?? signal}\n${service.stderr()}`));
      });
    }),
    delay(5_000).then(() => {
      service.child.kill("SIGKILL");
      throw new Error(`packaged Workbench did not stop after its control pipe closed\n${service.stderr()}`);
    }),
  ]);
}

try {
  if (!existsSync(executable)) throw new Error(`missing packaged Workbench: ${executable}`);
  const first = startService("first");
  const second = startService("second");
  try {
    const [firstAddress, secondAddress] = await Promise.all([first.ready, second.ready]);
    const firstUrl = new URL(firstAddress);
    const secondUrl = new URL(secondAddress);
    if (
      firstUrl.protocol !== "http:"
      || firstUrl.hostname !== "127.0.0.1"
      || !firstUrl.port
      || secondUrl.hostname !== "127.0.0.1"
      || !secondUrl.port
    ) {
      throw new Error("packaged Workbench did not bind a numeric loopback address");
    }
    if (firstUrl.port === secondUrl.port) throw new Error("packaged Workbench reused its loopback port");
    const [firstSession, secondSession] = await Promise.all([
      getJson(firstAddress, "/api/session"),
      getJson(secondAddress, "/api/session"),
    ]);
    if (firstSession.contract_version !== contract.method_versions.http) {
      throw new Error(`unexpected Workbench contract ${firstSession.contract_version}`);
    }
    if (!firstSession.token || !secondSession.token || firstSession.token === secondSession.token) {
      throw new Error("packaged Workbench did not issue distinct session tokens");
    }
    if (!existsSync(join(first.library, "worlds.sqlite3"))) {
      throw new Error("packaged Workbench did not initialize its selected library");
    }
    await Promise.all([stopService(first), stopService(second)]);
    await Promise.all(
      [firstAddress, secondAddress].map(async (address) => {
        try {
          await getJson(address, "/api/session");
          throw new Error(`packaged Workbench left ${address} serving after shutdown`);
        } catch (error) {
          if (error instanceof Error && error.message.includes("left ")) throw error;
        }
      }),
    );
    process.stdout.write("Packaged Workbench readiness and isolation passed.\n");
  } finally {
    for (const service of [first, second]) {
      if (service.child.exitCode === null && service.child.signalCode === null) {
        service.child.kill("SIGKILL");
      }
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
