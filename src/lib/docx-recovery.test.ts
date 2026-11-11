import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

import {
  clearDocxRecovery,
  docxRecoveryKey,
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
