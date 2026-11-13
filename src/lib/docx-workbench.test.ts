import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import type { DocxSource } from "./docx-workbench";

const transport = vi.hoisted(() => ({ journalRequest: vi.fn() }));

vi.mock("@/lib/journal-workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/journal-workbench")>();
  return { ...actual, journalRequest: transport.journalRequest };
});

import { loadDocxSource, prepareDocxSave, saveDocxBaseline } from "./docx-workbench";

const SOURCE: DocxSource = {
  project_id: "project-retained",
  baseline_id: "baseline-history-7",
  source_sha256: "e1c610b9a26f27b93f81343b391d5aacfbecb9027e0df8acdb2493fc4c7f243f",
  filename: "revised-paper.docx",
  bytes: Uint8Array.from([0, 1, 2, 127, 128, 254, 255]),
};

function responseFor(source: DocxSource) {
  const { bytes, ...identity } = source;
  return { ...identity, content_base64: bytesToBase64(bytes) };
}

function savedPayload(index = 0) {
  return transport.journalRequest.mock.calls[index]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  transport.journalRequest.mockReset();
});

describe("DOCX Workbench transport", () => {
  it("round-trips the exact retained DOCX bytes from an explicit historical baseline", async () => {
    transport.journalRequest.mockResolvedValue(responseFor(SOURCE));

    const loaded = await loadDocxSource(SOURCE.project_id, SOURCE.baseline_id);

    expect(loaded).toEqual(SOURCE);
    expect(Array.from(loaded.bytes)).toEqual([0, 1, 2, 127, 128, 254, 255]);
    expect(transport.journalRequest).toHaveBeenCalledWith(
      "/api/manuscript-source?project_id=project-retained&baseline_id=baseline-history-7",
    );
  });

  it("passes the selected baseline literally and never rewrites it to the current alias", async () => {
    transport.journalRequest.mockResolvedValue(responseFor(SOURCE));

    await loadDocxSource("project / with space", "baseline-selected");

    const path = transport.journalRequest.mock.calls[0]?.[0] as string;
    const url = new URL(path, "http://workbench.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project_id: "project / with space",
      baseline_id: "baseline-selected",
    });
    expect(url.searchParams.get("baseline_id")).not.toBe("current");
  });

  it("retries the same captured bytes, request ID, and expected baseline", async () => {
    const captured = Uint8Array.from([80, 75, 3, 4, 0, 255, 17]);
    const save = prepareDocxSave(SOURCE, 4, captured.buffer);
    transport.journalRequest
      .mockRejectedValueOnce(new Error("connection lost after dispatch"))
      .mockResolvedValueOnce({
        status: "APPLIED",
        result_baseline_id: "baseline-created-from-save",
      });

    await expect(saveDocxBaseline(save)).rejects.toThrow("connection lost");
    await saveDocxBaseline(save);

    expect(savedPayload(0)).toEqual(savedPayload(1));
    expect(savedPayload(1)).toMatchObject({
      project_id: SOURCE.project_id,
      expected_baseline_id: SOURCE.baseline_id,
      request_id: save.request_id,
      content_base64: bytesToBase64(captured),
    });
    expect(transport.journalRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/baseline",
      "/api/baseline",
    ]);
  });

  it("keeps the initiating session revision local and out of the HTTP payload", async () => {
    const captured = Uint8Array.from([80, 75, 3, 4, 7, 8, 9]);
    const save = prepareDocxSave(SOURCE, 11, captured.buffer);
    let finish!: (value: { status: "APPLIED"; result_baseline_id: string }) => void;
    transport.journalRequest.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    const pending = saveDocxBaseline(save);
    expect(savedPayload()).not.toHaveProperty("revision");
    finish({ status: "APPLIED", result_baseline_id: "baseline-after-revision-11" });

    await expect(pending).resolves.toEqual({
      baselineId: "baseline-after-revision-11",
      revision: 11,
    });
  });
});
