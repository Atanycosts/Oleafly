import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _arguments: unknown): Promise<void> => {}),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { bytesToBase64 } from "@/lib/base64";
import {
  deriveJournalFormatSnapshot,
  mountJournalFormatBridge,
  type JournalFormatRequest,
} from "./journal-format-bridge";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function docx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8(`<Relationships xmlns="${REL}"><Relationship Id="doc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Format bridge</w:t></w:r></w:p></w:body></w:document>`),
  });
}

function request(overrides: Partial<JournalFormatRequest> = {}): JournalFormatRequest {
  return {
    token: "format-token",
    projectId: "app-project",
    baselineId: "baseline-1",
    sourceSha256: "0".repeat(64),
    contentBase64: bytesToBase64(docx()),
    ...overrides,
  };
}

function listener() {
  return (mocks.listen.mock.calls as unknown as [
    string,
    (event: { payload: JournalFormatRequest }) => Promise<void>,
  ][])[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.listen.mockReset().mockResolvedValue(vi.fn());
});

describe("journal format renderer bridge", () => {
  it("opens the actual DOCX core snapshot and rejects a source hash mismatch", async () => {
    await expect(deriveJournalFormatSnapshot(request())).rejects.toThrow(
      "does not match the retained source bytes",
    );
  });

  it("claims before work and reports the mismatch instead of returning an unverified snapshot", async () => {
    const stop = vi.fn();
    mocks.listen.mockResolvedValue(stop);
    const unmount = await mountJournalFormatBridge();
    await listener()({ payload: request() });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "journal_format_claim", {
      token: "format-token",
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("journal_format_result", {
      token: "format-token",
      result: null,
      error: "The DOCX format snapshot does not match the retained source bytes.",
    });
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[1],
    );
    unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not read bytes or answer when the native claim is refused", async () => {
    await mountJournalFormatBridge();
    mocks.invoke.mockRejectedValueOnce(new Error("This DOCX format request ended."));
    await listener()({ payload: request() });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("journal_format_claim", {
      token: "format-token",
    });
  });
});
