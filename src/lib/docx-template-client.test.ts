import { beforeEach, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import type { DocxFormatSnapshotV1 } from "./docx-format-types";
import type { JournalProject } from "./journal-workbench";

const api = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn(), load: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("./journal-workbench", () => ({ journalRequest: api.request }));
vi.mock("./docx-workbench", () => ({ loadDocxSource: api.load }));
vi.mock("./docx-format", () => ({ openDocxFormatFacts: api.open }));
import { checkJournalTemplate, importJournalTemplate, retainDocxFormat } from "./docx-template-client";

const bytes = new Uint8Array([80, 75, 3, 4]);
const snapshot = { source_sha256: "normalized-hash" } as DocxFormatSnapshotV1;
const original = { filename: "original.doc", content_base64: "original-bytes" };
const normalized = { filename: "normalized.docx", content_base64: bytesToBase64(bytes), provenance: {
  engine: "LibreOffice", version: "verified-version", method: "convert-to docx", converted_sha256: "normalized-hash",
} };
beforeEach(() => {
  vi.clearAllMocks();
  api.invoke.mockResolvedValue({ original, normalized, original_sha256: "original-hash", source_sha256: "normalized-hash" });
  api.open.mockResolvedValue({ snapshot });
  api.load.mockResolvedValue({ bytes, source_sha256: "normalized-hash" });
  api.request.mockResolvedValue({ version_id: "world-one" });
});

it("adopts the normalized template facts while retaining the original bytes and conversion provenance", async () => {
  const file = new File([bytes], "selected.doc");
  const context = { journal_id: "ijam", journal_name: "IJAM", article_type: "research_article", stage: "initial_submission", language: "en" };
  const sources = [{ name: "guide.txt", kind: "guide_text", content_base64: "Z3VpZGU=" }];
  await importJournalTemplate(file, context, sources);
  expect(api.invoke).toHaveBeenCalledWith("journal_template_normalize", { name: "selected.doc", contentBase64: bytesToBase64(bytes), executable: null });
  expect(api.open).toHaveBeenCalledWith(bytes);
  expect(api.request).toHaveBeenCalledWith("/api/template-world", { ...context, original, normalized, snapshot, sources });
});

it("refuses source identity drift before storing any template or manuscript facts", async () => {
  api.open.mockResolvedValue({ snapshot: { source_sha256: "different-export" } });
  await expect(importJournalTemplate(new File([bytes], "selected.doc"), {
    journal_id: "j", journal_name: "J", article_type: "research_article", stage: "initial_submission", language: "en",
  })).rejects.toThrow("identity changed");
  await expect(retainDocxFormat("project", "baseline")).rejects.toThrow("does not match");
  expect(api.request).not.toHaveBeenCalled();
});

it("rechecks the exact saved baseline and explicit world using binding CAS", async () => {
  const project = { project_id: "paper", baseline_id: "baseline-two", binding: { binding_id: "binding-old" } } as JournalProject;
  await checkJournalTemplate(project, "world-selected", "agent");
  expect(api.load).toHaveBeenCalledWith("paper", "baseline-two");
  expect(api.request.mock.calls.map(([path]) => path)).toEqual(["/api/docx-format", "/api/template-check"]);
  expect(api.request).toHaveBeenLastCalledWith("/api/template-check", {
    project_id: "paper", expected_baseline_id: "baseline-two", world_version_id: "world-selected",
    expected_binding_id: "binding-old", request_id: expect.stringMatching(/^template-check-/), origin: { surface: "agent" },
  });
});
