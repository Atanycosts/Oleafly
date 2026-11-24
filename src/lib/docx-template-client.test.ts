import { beforeEach, expect, it, vi } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import type { DocxFormatSnapshotV1 } from "./docx-format-types";
import type { JournalProject } from "./journal-workbench";
import { JournalWorkbenchError } from "./journal-workbench";

const api = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn(), load: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("./journal-workbench", async (original) => ({ ...await original<typeof import("./journal-workbench")>(), journalRequest: api.request }));
vi.mock("./docx-workbench", () => ({ loadDocxSource: api.load }));
vi.mock("./docx-format", () => ({ openDocxFormatFacts: api.open }));
import {
  checkCandidateJournalTemplate, checkJournalTemplate, importJournalTemplate, loadTemplateSource,
  prepareJournalTemplate, recordDocxFormat, referenceDocxFormat, retainDocxFormat, startTemplateWorkingCopy,
} from "./docx-template-client";

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

it("sends the exact snapshot identity without registration metadata", async () => {
  const project = { project_id: "candidate", baseline_id: "baseline-new", binding: null } as JournalProject;
  const reference = {
    baseline_id: project.baseline_id,
    source_sha256: "source-digest",
    snapshot_artifact_version_id: "artifact-version-digest",
    method_version: "docx-core-format-snapshot-1.3.0",
  };
  api.request.mockResolvedValueOnce({ ...reference, snapshot_id: "format-snapshot", engine: { name: "docx-core" } });
  const recorded = await recordDocxFormat(project.project_id, project.baseline_id, snapshot);
  await checkCandidateJournalTemplate(project, "world-selected", recorded);
  const copy = { ...project, project_id: "copy", baseline_id: "baseline-copy" };
  await referenceDocxFormat(copy, project.project_id, recorded);
  expect(api.request).toHaveBeenNthCalledWith(2, "/api/template-check", {
    project_id: "candidate", expected_baseline_id: "baseline-new", world_version_id: "world-selected",
    expected_binding_id: null, request_id: expect.stringMatching(/^template-check-/), origin: { surface: "agent" },
    response: "candidate", snapshot_reference: reference,
  });
  expect(api.request).toHaveBeenNthCalledWith(3, "/api/docx-format", {
    project_id: "copy", baseline_id: "baseline-copy", retained_snapshot: { project_id: "candidate", reference },
  });
});

it("starts a template draft from retained server bytes with a stable retry ID", async () => {
  await startTemplateWorkingCopy("world-selected", "Draft", "start-fixed");
  expect(api.request).toHaveBeenCalledExactlyOnceWith("/api/template-copy", {
    world_version_id: "world-selected", name: "Draft", request_id: "start-fixed",
  });
  expect(api.invoke).not.toHaveBeenCalled();
  expect(api.load).not.toHaveBeenCalled();
});

it("reads one selected retained template and rejects source hash or world substitution", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  const sourceSha256 = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  api.request.mockResolvedValue({ world_version_id: "world-selected", source_sha256: sourceSha256, content_base64: bytesToBase64(bytes) });
  expect(await loadTemplateSource("world-selected")).toEqual({ worldVersionId: "world-selected", sourceSha256, bytes });
  expect(api.request).toHaveBeenCalledWith("/api/template-source?world_version_id=world-selected");
  api.request.mockResolvedValue({ world_version_id: "other", source_sha256: sourceSha256, content_base64: bytesToBase64(bytes) });
  await expect(loadTemplateSource("world-selected")).rejects.toThrow("another world");
  api.request.mockResolvedValue({ world_version_id: "world-selected", source_sha256: "0".repeat(64), content_base64: bytesToBase64(bytes) });
  await expect(loadTemplateSource("world-selected")).rejects.toThrow("source hash");
});

it("recaptures a supported legacy template from its retained DOCX without normalizing a .doc again", async () => {
  const sourceSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes.buffer)).toString("hex");
  const current = { ...snapshot, source_sha256: sourceSha256, method_version: "docx-core-format-snapshot-1.3.0" };
  const upgraded = { world: { version_id: "world-current" }, refreshed: true };
  api.open.mockResolvedValueOnce({ snapshot: current });
  api.request.mockRejectedValueOnce(new JournalWorkbenchError({ error: "Reader changed", code: "template_snapshot_recapture_required", world_version_id: "world-old" }))
    .mockResolvedValueOnce({ world_version_id: "world-old", source_sha256: sourceSha256, content_base64: bytesToBase64(bytes) })
    .mockResolvedValueOnce(upgraded);
  await expect(prepareJournalTemplate("draft", "baseline", undefined, "agent", true)).resolves.toEqual(upgraded);
  expect(api.open).toHaveBeenCalledWith(bytes);
  expect(api.invoke).not.toHaveBeenCalled();
  expect(api.request).toHaveBeenNthCalledWith(2, "/api/template-source?world_version_id=world-old");
  expect(api.request).toHaveBeenNthCalledWith(3, "/api/template-prepare", {
    project_id: "draft", expected_baseline_id: "baseline", surface: "agent", include_snapshot_reference: true,
    retained_snapshot: { world_version_id: "world-old", snapshot: current },
  });
});

it("keeps an unsupported reader refusal and does not try to recapture it", async () => {
  const refusal = new JournalWorkbenchError({ error: "Recapture that exact template.", code: "template_snapshot_outdated", action: "recapture_template" });
  api.request.mockRejectedValueOnce(refusal);
  await expect(prepareJournalTemplate("draft", "baseline", "world-old")).rejects.toBe(refusal);
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(api.open).not.toHaveBeenCalled();
});
