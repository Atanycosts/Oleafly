// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(), pick: vi.fn(), write: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@/lib/native-file-dialog", () => ({ pickSavePath: mocks.pick }));
vi.mock("@/lib/tauri", () => ({ writeBytesFile: mocks.write }));
import { downloadDocxCopy } from "./docx-download";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.pick.mockResolvedValue("/chosen/recovery.docx");
});

it("exports exact recovery bytes through the existing native save grant", async () => {
  await downloadDocxCopy(Uint8Array.from([80, 75, 0, 255]), "recovered.docx");
  expect(mocks.pick).toHaveBeenCalledWith({ defaultPath: "recovered.docx", filters: [{ name: "DOCX", extensions: ["docx"] }] });
  expect(mocks.write).toHaveBeenCalledWith("/chosen/recovery.docx", "UEsA/w==");
});

it("leaves recovery bytes untouched when the save dialog is cancelled or writing fails", async () => {
  const bytes = Uint8Array.from([80, 75, 9, 9]);
  mocks.pick.mockResolvedValueOnce(null);
  await downloadDocxCopy(bytes, "recovered.docx");
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.write.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(downloadDocxCopy(bytes, "recovered.docx")).rejects.toThrow("disk unavailable");
  expect([...bytes]).toEqual([80, 75, 9, 9]);
});
