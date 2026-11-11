import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

import { readProjectPaper, readRetainedPaperPdf, verifyCitation, type CitationCheck } from "./research-literature";

const VERIFIED: CitationCheck = {
  verified: true,
  source: "doi",
  doi: "10.1000/xyz",
  matchedTitle: "Attention Is All You Need",
  score: 0.98,
  bibtex: "@article{vaswani2017, title={Attention Is All You Need}}",
  reason: null,
};

beforeEach(() => {
  native.invoke.mockReset();
});

describe("citation checks", () => {
  it("checks a DOI against the title it should carry", async () => {
    native.invoke.mockResolvedValueOnce(VERIFIED);

    await expect(verifyCitation({ doi: "10.1000/xyz", title: "Attention Is All You Need" })).resolves.toBe(VERIFIED);
    expect(native.invoke).toHaveBeenCalledWith("verify_citation", {
      doi: "10.1000/xyz",
      title: "Attention Is All You Need",
    });
  });

  it("sends a missing DOI or title as null", async () => {
    native.invoke.mockResolvedValue({ ...VERIFIED, source: "crossref-search" });

    await verifyCitation({ title: "Attention Is All You Need" });
    await verifyCitation({ doi: "10.1000/xyz" });
    await verifyCitation({});

    expect(native.invoke.mock.calls).toEqual([
      ["verify_citation", { doi: null, title: "Attention Is All You Need" }],
      ["verify_citation", { doi: "10.1000/xyz", title: null }],
      ["verify_citation", { doi: null, title: null }],
    ]);
  });

  it("passes a failed lookup on to the caller", async () => {
    native.invoke.mockRejectedValueOnce(new Error("No matching Crossref record found."));

    await expect(verifyCitation({ title: "A paper nobody wrote" })).rejects.toThrow(
      "No matching Crossref record found.",
    );
  });
});

describe("paper reading IPC", () => {
  it.each([
    [{ doi: "10.1000/paper", arxiv: "1706.03762", url: "https://example.org/a.pdf", path: "a.pdf" }, { kind: "doi", doi: "10.1000/paper" }],
    [{ arxiv: "1706.03762", url: "https://example.org/a.pdf", path: "a.pdf" }, { kind: "arxiv", id: "1706.03762" }],
    [{ url: "https://example.org/a.pdf", path: "a.pdf" }, { kind: "url", url: "https://example.org/a.pdf" }],
    [{ path: "a.pdf" }, { kind: "path", path: "a.pdf", root_id: null }],
    [{ path: "a.pdf", root_id: "refs" }, { kind: "path", path: "a.pdf", root_id: "refs" }],
  ])("preserves backend source precedence: %j", async (input, request) => {
    await readProjectPaper("original", input);
    expect(native.invoke).toHaveBeenCalledWith("read_project_paper", { projectId: "original", request, offset: null, maxChars: null, reference: null });
  });

  it("passes window limits and exact source metadata unchanged", async () => {
    const result = { text: "[p. 2]\nEvidence", nextOffset: 8192, source: { offset: 4096, endOffset: 8192 }, pdfReference: { projectId: "original", path: "sources/papers/a.pdf", pdfSha256: "hash" } };
    native.invoke.mockResolvedValue(result);
    expect(await readProjectPaper("original", { path: "a.pdf", offset: 4096, max_chars: 4000 })).toBe(result);
    expect(native.invoke).toHaveBeenCalledWith("read_project_paper", { projectId: "original", request: { kind: "path", path: "a.pdf", root_id: null }, offset: 4096, maxChars: 4000, reference: null });
  });

  it("reads retained PDF bytes with the original project and expected hash", async () => {
    const reference = { projectId: "original", path: "sources/papers/a.pdf", pdfSha256: "original-hash" };
    const bytes = new ArrayBuffer(32);
    native.invoke.mockResolvedValue(bytes);
    expect(await readRetainedPaperPdf(reference)).toBe(bytes);
    expect(native.invoke).toHaveBeenCalledWith("read_retained_paper_pdf", { reference });
    native.invoke.mockRejectedValue(new Error("PDF hash mismatch"));
    await expect(readRetainedPaperPdf(reference)).rejects.toThrow("PDF hash mismatch");
  });
});

it("continues a retained version with its complete reference instead of re-reading a changed local path", async () => {
  const reference = { projectId: "original", path: "sources/hash/papers/a.pdf", pdfSha256: "original-hash" };
  await readProjectPaper("original", { reference, offset: 4096 });
  expect(native.invoke).toHaveBeenCalledWith("read_project_paper", {
    projectId: "original", request: { kind: "path", path: "", root_id: null }, offset: 4096, maxChars: null, reference,
  });
});
