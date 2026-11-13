import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

import {
  clearDocxRecovery,
  discardDocxRecovery,
  docxContentSha256,
  docxRecoveryKey,
  listDocxRecovery,
  readDocxRecovery,
  saveDocxRecovery,
  type DocxRecoveryIdentity,
  type DocxRecoveryMetadata,
} from "./docx-recovery";

const IDENTITY: DocxRecoveryIdentity = {
  appProjectId: "app-project",
  workbenchProjectId: "workbench-project",
  baseBaselineId: "baseline-7",
  sourceSha256: "a".repeat(64),
};

const METADATA: DocxRecoveryMetadata = {
  ...IDENTITY,
  recoveryKey: "b".repeat(64),
  revision: 4,
  updatedAt: "2026-11-11T08:30:15.123Z",
  contentSha256: "c".repeat(64),
};

beforeEach(() => {
  transport.invoke.mockReset();
});

describe("DOCX recovery transport", () => {
  it("derives one stable key for edits in the same working-copy identity", async () => {
    const first = await docxRecoveryKey(IDENTITY);
    const second = await docxRecoveryKey({ ...IDENTITY });

    expect(first).toBe("296d8e392fc181f4ec387ea8ee341712f3c45bd12762dbf3dfc93bf0ca8dbabc");
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await docxRecoveryKey({ ...IDENTITY, baseBaselineId: "baseline-8" })).not.toBe(first);
    expect(await docxRecoveryKey({ ...IDENTITY, appProjectId: "other-app-project" })).not.toBe(first);
  });

  it("writes captured bytes with the stable key and returns the native metadata", async () => {
    transport.invoke.mockResolvedValue(METADATA);
    const bytes = Uint8Array.from([80, 75, 3, 4]).buffer;

    await expect(saveDocxRecovery(IDENTITY, 4, bytes)).resolves.toEqual(METADATA);

    expect(transport.invoke).toHaveBeenCalledWith(
      "docx_recovery_save",
      expect.objectContaining({
        request: expect.objectContaining({
          ...IDENTITY,
          recoveryKey: await docxRecoveryKey(IDENTITY),
          revision: 4,
          contentBase64: "UEsDBA==",
        }),
      }),
    );
  });

  it("reads bytes through the same stable key", async () => {
    transport.invoke.mockResolvedValue({ ...METADATA, bytesBase64: "UEsDBA==" });

    const snapshot = await readDocxRecovery(IDENTITY);

    expect(snapshot).toEqual({ ...METADATA, bytes: Uint8Array.from([80, 75, 3, 4]) });
    expect(transport.invoke).toHaveBeenCalledWith("docx_recovery_read", {
      request: { recoveryKey: await docxRecoveryKey(IDENTITY) },
    });
  });

  it("lists recovery metadata and isolated failures without requesting package bytes", async () => {
    const listing = {
      snapshots: [METADATA],
      failures: [{ recoveryKey: "d".repeat(64), error: "content hash does not match" }],
    };
    transport.invoke.mockResolvedValue(listing);

    await expect(listDocxRecovery()).resolves.toEqual(listing);

    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("docx_recovery_list");
  });

  it("discards the selected key and hash without reading or hashing package bytes", async () => {
    transport.invoke.mockResolvedValue(false);

    await expect(discardDocxRecovery(METADATA)).resolves.toBe(false);

    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("docx_recovery_clear", {
      request: { recoveryKey: METADATA.recoveryKey, contentSha256: METADATA.contentSha256 },
    });
  });

  it("hashes ArrayBuffer contents and only the selected Uint8Array view", async () => {
    const bytes = new TextEncoder().encode("abc");
    const surrounded = new TextEncoder().encode("xabcx");
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    await expect(docxContentSha256(bytes.buffer)).resolves.toBe(expected);
    await expect(docxContentSha256(surrounded.subarray(1, 4))).resolves.toBe(expected);
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("clears only the snapshot matching the explicitly committed baseline bytes", async () => {
    transport.invoke.mockResolvedValue(true);
    const bytes = Uint8Array.from([80, 75, 3, 4]).buffer;

    await expect(clearDocxRecovery(IDENTITY, bytes)).resolves.toBe(true);

    expect(transport.invoke).toHaveBeenCalledWith("docx_recovery_clear", {
      request: {
        recoveryKey: await docxRecoveryKey(IDENTITY),
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });
});

it("stores task attribution and a fixed save with the exact checkpoint bytes", async () => {
  const { commitDocxRecovery, resumeDocxRecovery, recoveryPendingSave } = await import("./docx-recovery");
  const document = { sessionId: "original", appProjectId: IDENTITY.appProjectId, workbenchProjectId: IDENTITY.workbenchProjectId,
    baselineId: IDENTITY.baseBaselineId, sourceSha256: IDENTITY.sourceSha256, sessionRevision: 4, savedRevision: 0 };
  const taskState = { document, applied: [{ proposalId: "proposal", document }],
    receipts: [{ proposalId: "proposal", document, outcome: { kind: "applied" as const } }],
    pendingSave: recoveryPendingSave({ project_id: IDENTITY.workbenchProjectId, expected_baseline_id: IDENTITY.baseBaselineId,
      filename: "paper.docx", reason: "User save", request_id: "fixed", revision: 4, content_base64: "UEsDBA==" }) };
  transport.invoke.mockResolvedValue(METADATA);
  await saveDocxRecovery(IDENTITY, 4, Uint8Array.from([80, 75, 3, 4]).buffer, taskState);
  expect(transport.invoke).toHaveBeenLastCalledWith("docx_recovery_save", { request: expect.objectContaining({ contentBase64: "UEsDBA==", taskState }) });
  transport.invoke.mockResolvedValue({ ...METADATA, bytesBase64: "UEsDBA==", taskState });
  expect((await readDocxRecovery(IDENTITY))?.taskState).toEqual(taskState);
  await commitDocxRecovery(METADATA);
  expect(transport.invoke).toHaveBeenLastCalledWith("docx_recovery_commit", { request: { recoveryKey: METADATA.recoveryKey, contentSha256: METADATA.contentSha256 } });
  await resumeDocxRecovery(METADATA, { ...document, sessionId: "new", sessionRevision: 0, savedRevision: -1 });
  expect(transport.invoke).toHaveBeenLastCalledWith("docx_recovery_resume", { request: { recoveryKey: METADATA.recoveryKey, contentSha256: METADATA.contentSha256 }, document: { ...document, sessionId: "new", sessionRevision: 0, savedRevision: -1 } });
});
