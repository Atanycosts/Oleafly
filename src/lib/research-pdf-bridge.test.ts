import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const extractPdfText = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/pdf-text", () => ({ extractPdfText: (...args: unknown[]) => extractPdfText(...args) }));

import { listen } from "@tauri-apps/api/event";
import { answerPdfPagesRequest, answerPdfTextRequest, mountResearchPdfBridge } from "./research-pdf-bridge";

const renderPages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pdf-image", () => ({ renderPages }));

describe("research PDF bridge", () => {
  beforeEach(() => {
    invoke.mockReset();
    extractPdfText.mockReset();
  });

  it("answers a pdf text request with page texts", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "research_pdf_text_fetch" ? new Uint8Array([37, 80, 68, 70]).buffer : undefined,
    );
    extractPdfText.mockResolvedValue({ pages: ["one", "two"], numPages: 2 });

    await answerPdfTextRequest("t1");

    expect(extractPdfText).toHaveBeenCalledWith(expect.any(Uint8Array), { maxPages: 300 });
    expect(invoke).toHaveBeenCalledWith("research_pdf_text_result", {
      token: "t1",
      pages: ["one", "two"],
      error: null,
    });
  });

  it("reports an extraction failure instead of hanging", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "research_pdf_text_fetch" ? new ArrayBuffer(4) : undefined,
    );
    extractPdfText.mockRejectedValue(new Error("Invalid PDF structure."));

    await answerPdfTextRequest("t2");

    expect(invoke).toHaveBeenCalledWith("research_pdf_text_result", {
      token: "t2",
      pages: null,
      error: "Invalid PDF structure.",
    });
  });

  it("reports a PDF it could not fetch without reading anything", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "research_pdf_text_fetch") throw new Error("The request expired.");
      return undefined;
    });

    await answerPdfTextRequest("t3");

    expect(extractPdfText).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith("research_pdf_text_result", {
      token: "t3",
      pages: null,
      error: "The request expired.",
    });
  });

  it("reports a failure that is not an Error as its text", async () => {
    invoke.mockImplementation(async (command: string) =>
      command === "research_pdf_text_fetch" ? new ArrayBuffer(4) : undefined,
    );
    extractPdfText.mockRejectedValue("bad xref table");

    await answerPdfTextRequest("t4");

    expect(invoke).toHaveBeenLastCalledWith("research_pdf_text_result", {
      token: "t4",
      pages: null,
      error: "bad xref table",
    });
  });

  it("gives up quietly when the task stopped waiting for the text", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "research_pdf_text_fetch") return new ArrayBuffer(4);
      throw new Error("The task stopped waiting.");
    });
    extractPdfText.mockResolvedValue({ pages: ["one"], numPages: 1 });

    await expect(answerPdfTextRequest("t5")).resolves.toBeUndefined();

    expect(invoke.mock.calls).toEqual([
      ["research_pdf_text_fetch", { token: "t5" }],
      ["research_pdf_text_result", { token: "t5", pages: ["one"], error: null }],
      ["research_pdf_text_result", { token: "t5", pages: null, error: "The task stopped waiting." }],
    ]);
  });

  it("answers each request the backend sends while mounted", async () => {
    vi.mocked(listen).mockClear();
    invoke.mockImplementation(async (command: string) =>
      command === "research_pdf_text_fetch" ? new Uint8Array([37, 80, 68, 70]).buffer : undefined,
    );
    extractPdfText.mockResolvedValue({ pages: ["page one"], numPages: 1 });

    const stop = await mountResearchPdfBridge();
    const [name, handler] = vi.mocked(listen).mock.calls[0];
    handler({ event: name, id: 1, payload: { token: "t6" } });

    expect(name).toBe("research-pdf-text-request");
    expect(stop).toEqual(expect.any(Function));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("research_pdf_text_result", {
        token: "t6",
        pages: ["page one"],
        error: null,
      }),
    );
    expect(invoke).toHaveBeenCalledWith("research_pdf_text_fetch", { token: "t6" });
  });
});

it("returns rendered page image bytes through the task request token", async () => {
  invoke.mockImplementation(async (command: string) => command === "research_pdf_pages_fetch" ? new ArrayBuffer(4) : undefined);
  renderPages.mockImplementation(async function* () { yield "data:image/png;base64,iVBORw0KGgo="; });
  await answerPdfPagesRequest("pages-a", [2], 1.5);
  expect(renderPages).toHaveBeenCalledWith(expect.any(Uint8Array), [2], 1.5);
  expect(invoke).toHaveBeenCalledWith("research_pdf_pages_result", { token:"pages-a", images:["iVBORw0KGgo="], error:null });
});

it("reports page render failures without returning partial page images", async () => {
  invoke.mockImplementation(async (command: string) => command === "research_pdf_pages_fetch" ? new ArrayBuffer(4) : undefined);
  renderPages.mockImplementation(async function* () { yield "data:image/png;base64,iVBORw0KGgo="; throw new Error("page out of range"); });
  await answerPdfPagesRequest("pages-b", [1, 5], 1);
  expect(invoke).toHaveBeenCalledWith("research_pdf_pages_result", { token:"pages-b", images:null, error:"page out of range" });
});
