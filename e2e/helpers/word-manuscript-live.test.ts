import { describe, expect, it, vi } from "vitest";
import type {
  ResearchTask,
  TaskTranscriptEvent,
} from "../../src/lib/research-tasks";
import type { DocxActivity } from "../../src/lib/docx-task-activity";
import {
  collectModelReadReceipt,
  collectDocxDocumentPages,
  finalSavedMutation,
  sha256,
  waitForTask,
  type Page,
} from "./word-manuscript-live";
import type { DocxDocumentRead, DocxReadQuery } from "../../packages/ai-tools/src/tools";

const sourceSha256 = "a".repeat(64);
const liveSourceSha256 = "c".repeat(64);
const templateSha256 = "b".repeat(64);
const templateWorldVersionId = "world-template";

function event(
  sequence: number,
  value: TaskTranscriptEvent["event"],
): TaskTranscriptEvent {
  if (value.kind === "tool" && value.phase === "result"
    && !value.detail.includes("[output truncated]")) {
    value = { ...value, detail: JSON.stringify({
      content: [{ type: "text", text: value.detail }], isError: value.status === "error",
    }) };
  }
  return {
    taskId: "task",
    executionGeneration: 1,
    sequence,
    event: value,
    createdAt: sequence,
  };
}

describe("whole-manuscript live coverage", () => {
  function windowedReadFixture() {
    const document = { sessionId: "session", appProjectId: "app", workbenchProjectId: "manuscript",
      baselineId: "baseline", sourceSha256, sessionRevision: 0, savedRevision: 0,
      dirty: false, title: "Manuscript", filename: "manuscript.docx" };
    const modelText = "A\uFFFC😀B", displayText = "A[12]😀B";
    const payload = JSON.stringify({ code: "REF bookmark", label: "公式😀" });
    const split = payload.indexOf("😀") + 1;
    const atom = { objectRef: "field-1", kind: "field" as const,
      modelRange: { start: 1, end: 2 }, displayRange: { start: 1, end: 5 },
      complete: true, editable: false as const };
    const nextPayload = { offset: 0, textOffset: 0, textLimit: 2, atomOffset: 0,
      payloadOffset: split, expectedRevision: 0 };
    const nextText = { offset: 0, textOffset: 2, textLimit: 2, expectedRevision: 0 };
    const view = { paragraphRef: "p", revision: 0, modelTextLength: modelText.length,
      displayTextLength: displayText.length, modelTextTruncated: true, displayTextTruncated: true,
      editableRanges: [{ start: 0, end: 1 }] };
    const pages: DocxDocumentRead[] = [
      { document, offset: 0, nextOffset: null, totalParagraphs: 1, nextQuery: nextPayload,
        paragraphs: [{ ...view, text: "A[12]", modelText: "A\uFFFC", displayText: "A[12]",
          modelTextOffset: 0, displayTextOffset: 0, atoms: [{ ...atom,
            payloadJson: payload.slice(0, split), payloadOffset: 0, payloadLength: payload.length }] }] },
      { document, offset: 0, nextOffset: null, totalParagraphs: 1, nextQuery: nextText,
        paragraphs: [{ ...view, text: "A[12]", modelText: "A\uFFFC", displayText: "A[12]",
          modelTextOffset: 0, displayTextOffset: 0, atoms: [{ ...atom,
            payloadJson: payload.slice(split), payloadOffset: split, payloadLength: payload.length }] }] },
      { document, offset: 0, nextOffset: null, totalParagraphs: 1, nextQuery: null,
        paragraphs: [{ ...view, text: "😀B", modelText: "😀B", displayText: "😀B",
          modelTextOffset: 2, displayTextOffset: 5, atoms: [] }] },
    ];
    return { document, modelText, displayText, payload, pages,
      queries: [{}, nextPayload, nextText] as DocxReadQuery[] };
  }

  it("reconstructs model, display and atom JSON windows without splitting their coordinates", async () => {
    const f = windowedReadFixture();
    let cursor = 0;
    const read = vi.fn(async () => f.pages[cursor++]);
    const full = await collectDocxDocumentPages(read);
    expect(full.paragraphs[0]).toMatchObject({ modelText: f.modelText, text: f.displayText,
      displayText: f.displayText, atoms: [{ objectRef: "field-1", payload: JSON.parse(f.payload) }] });
    expect(read.mock.calls).toHaveLength(3);
    const incomplete = vi.fn().mockResolvedValueOnce(f.pages[0]).mockResolvedValueOnce(f.pages[2]);
    await expect(collectDocxDocumentPages(incomplete)).rejects.toThrow("unfinished text or payload");
  });

  it.each([false, true])("requires retained body text and atom payload continuations (missing=%s)", (missing) => {
    const f = windowedReadFixture();
    const activities: DocxActivity[] = f.pages.flatMap((page, index) => {
      if (missing && index === 1) return [];
      return [{ id: `read-${index}`, origin: { taskId: "task", generation: 1,
        groupId: null, memberId: null, executionId: null, workIds: [] },
        document: f.document, proposalId: null, createdAt: index,
        event: { type: "runtime", event: { kind: "operation", operation: "read",
          request: { ...f.queries[index] }, result: { operation: "read", ok: true,
            document: f.document, result: page } } } }];
    });
    const receipt = collectModelReadReceipt([], activities, { manuscriptRevision: 0,
      manuscriptSourceSha256: sourceSha256, manuscriptFormatSourceSha256: sourceSha256,
      templateWorldVersionId, templateSourceSha256: templateSha256,
      manuscriptParagraphs: [{ paragraphRef: "p", text: f.displayText, modelText: f.modelText }],
      nonBodyParagraphs: [] });
    const narrativeGaps = receipt.gaps.filter(gap => gap.startsWith("TaskStore"));
    if (missing) expect(narrativeGaps).toEqual(expect.arrayContaining([
      expect.stringContaining("incomplete payload"), expect.stringContaining("continuation was not consumed"),
    ]));
    else expect(narrativeGaps).toEqual([]);
  });

  it("keeps observing a running task after a bridge timeout and returns its actual failed status", async () => {
    const terminal = { id: "task", status: "failed" } as ResearchTask;
    const evaluate = vi.fn()
      .mockRejectedValueOnce(new Error("TauriPage command 'eval' failed: timeout (30s)"))
      .mockResolvedValueOnce({ id: "task", status: "running" })
      .mockResolvedValueOnce(terminal);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await waitForTask({ evaluate } as unknown as Page, "app", "task"))
        .toBe(terminal);
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("original task deadline"));
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    "TauriPage command 'eval' failed: task storage worker failed",
    "TauriPage command 'eval' failed: window 'main' not found",
    "timeout (30s)",
  ])("does not retry a different task observation error: %s", async (message) => {
    const error = new Error(message);
    const evaluate = vi.fn().mockRejectedValue(error);
    await expect(waitForTask({ evaluate } as unknown as Page, "app", "task"))
      .rejects.toBe(error);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("keeps the first saved hash and selects the last changed mutation before the final save", () => {
    const bound = { sessionId: "session", appProjectId: "app", workbenchProjectId: "manuscript",
      baselineId: "baseline-0", sourceSha256: templateSha256, sessionRevision: 0, savedRevision: 0 };
    const firstMutation = { ...bound, sessionRevision: 1 };
    const firstSave = { ...firstMutation, baselineId: "baseline-1", sourceSha256, savedRevision: 1 };
    const secondMutation = { ...firstSave, sessionRevision: 2 };
    const finalSave = { ...secondMutation, baselineId: "baseline-2", sourceSha256: liveSourceSha256,
      savedRevision: 2 };
    const origin = { taskId: "task", generation: 1, groupId: null, memberId: null,
      executionId: null, workIds: [] };
    const operation = (id: string, name: string, document: typeof bound, changed?: boolean): DocxActivity => ({
      id, document, origin, proposalId: null, createdAt: 0,
      event: { type: "runtime", event: { kind: "operation", operationId: id, operation: name,
        request: {}, result: { operation: name, ok: true, document, result: { changed } } } },
    });
    const saved = (id: string, operationId: string, document: typeof bound, hash: string, requestId: string): DocxActivity => ({
      id, document, origin, proposalId: null, createdAt: 0,
      event: { type: "operationCheckpoint", operationId, phase: "saved", recoveryKey: requestId,
        contentSha256: hash, fromDocument: document, requestId },
    });
    const activities = [operation("first", "format_batch", firstMutation, true),
      operation("save-1", "save", firstSave),
      saved("checkpoint-1", "first", firstMutation, sourceSha256, "request-1"),
      operation("second", "format", secondMutation, true),
      operation("noop", "format_batch", secondMutation, false), operation("save-2", "save", finalSave),
      saved("save-checkpoint-2", "save-2", finalSave, liveSourceSha256, "request-2"),
      saved("checkpoint-2", "second", secondMutation, liveSourceSha256, "request-2"),
      operation("later", "apply", { ...finalSave, sessionRevision: 3 }, true)];
    const receipt = finalSavedMutation(activities, "save-2");
    expect(receipt?.operationId).toBe("second");
    expect(receipt?.checkpoint?.document).toEqual(secondMutation);
    expect(receipt?.checkpoint?.event).toMatchObject({ contentSha256: liveSourceSha256,
      fromDocument: secondMutation, requestId: "request-2" });
    expect(receipt?.checkpoint?.document).not.toEqual(finalSave);
    expect(activities[2].event).toMatchObject({ contentSha256: sourceSha256 });
    expect(finalSavedMutation(activities, "missing")).toBeUndefined();
  });

  it.each(["done", "requested only", "error"])("uses toolRequested only to identify actual results: %s", status => {
    const snapshot = { operation: "format", source_sha256: templateSha256, collection: "objects",
      snapshot: { objects: [{ object_id: "template", kind: "paragraph", part: "/word/document.xml", text: "" }] },
      total: 1, has_more: false, next_offset: null };
    const events = [event(0, { kind: "observation", observation: { type: "toolRequested",
      callId: "template", name: "journal_read", inputSha256: "input" } }),
    event(1, { kind: "tool", callId: "template", name: "", phase: "update", status: "running",
      detail: JSON.stringify({ operation: "format", format_operation: "snapshot", collection: "objects",
        world_version_id: templateWorldVersionId, offset: 0, limit: 50 }) })];
    if (status !== "requested only") events.push(event(2, { kind: "tool", callId: "template", name: "",
      phase: "result", status, detail: JSON.stringify(snapshot) }));
    const receipt = collectModelReadReceipt(events, [], { manuscriptRevision: 0,
      manuscriptSourceSha256: sourceSha256, manuscriptFormatSourceSha256: liveSourceSha256,
      templateWorldVersionId, templateSourceSha256: templateSha256,
      manuscriptParagraphs: [], nonBodyParagraphs: [] });
    expect(receipt.template.expectedObjects).toBe(status === "done" ? 1 : null);
    if (status === "done") expect(receipt.successfulToolCalls).toEqual([
      expect.objectContaining({ callId: "template", name: "journal_read", identityBasis: "tool_requested" }),
    ]);
    else expect(receipt.successfulToolCalls).toEqual([]);
  });

  it.each([false, true])("assembles effective MCP fragments with Unicode offsets; missing final result=%s", missingResult => {
    const document = { sessionId: "session", appProjectId: "app", workbenchProjectId: "manuscript",
      baselineId: "baseline", sourceSha256, sessionRevision: 0, savedRevision: 0 };
    const paragraphs = [{ paragraphRef: "body", text: "Body" }];
    const origin = { taskId: "task", generation: 1, groupId: null, memberId: null,
      executionId: null, workIds: [] };
    const activities: DocxActivity[] = [{ id: "read", origin, document, proposalId: null, createdAt: 0,
      event: { type: "runtime", event: { kind: "read", offset: 0, paragraphs } } }];
    const metadata = { source_sha256: templateSha256 };
    const templateObject = { object_id: "template", kind: "paragraph", part: "/word/document.xml",
      text: "Template 🐼", properties: { bold: false } };
    const inventory = { ...metadata, objects: [templateObject], style_definitions: [] };
    const events = [event(0, { kind: "tool", callId: "overview", name: "read_docx_format", phase: "update",
      detail: JSON.stringify({ query: { kind: "overview", expected_revision: 0 } }) }),
    event(1, { kind: "tool", callId: "overview", name: "", phase: "result", status: "done",
      detail: JSON.stringify({ operation: "read_format", ok: true, document,
        result: { revision: 0, sourceSha256: liveSourceSha256, overview: { counts: { paragraphs: 1 } } } }) })];
    for (const collection of ["objects", "style_definitions"]) {
      const args = { operation: "format", format_operation: "snapshot", world_version_id: templateWorldVersionId,
        collection, detail: "effective", offset: 0, limit: 50 };
      const count = collection === "objects" ? 1 : 0;
      const projected = { source_sha256: templateSha256, collection, projection: "effective", projection_version: 1,
        offset: 0, delivered: count, total: count, has_more: false, next_offset: null,
        metadata_sha256: sha256(Buffer.from(JSON.stringify(metadata))), omitted_fields: ["/declared",
          "/properties/paragraph/props", "/properties/paragraph/inheritedRunProperties",
          "/properties/paragraph/markRunProperties", "/properties/paragraph/tabStopsCacheToken", "/properties/run_properties"],
        full_read: { tool: "journal_read", arguments: { ...args, detail: "full", limit: 1,
          expected_source_sha256: templateSha256 }, end_offset: count },
        snapshot: { ...metadata, [collection]: count ? [{ object_id: templateObject.object_id,
          kind: templateObject.kind, part: templateObject.part, text: templateObject.text, properties_ref: 0 }] : [],
        shared: { properties: count ? [templateObject.properties] : [], region: [], evidence: [], role_basis: [] } },
      };
      const json = JSON.stringify(projected);
      const scalars = Array.from(json);
      const split = scalars.indexOf("🐼") + 1;
      const fragments = count ? [scalars.slice(0, split).join(""), scalars.slice(split).join("")] : [json];
      let offset = 0;
      for (const [index, fragment] of fragments.entries()) {
        const callId = `${collection}-${index}`;
        events.push(event(events.length, { kind: "observation", observation: { type: "toolRequested", callId,
          name: "journal_read", inputSha256: "input" } }),
        event(events.length + 1, { kind: "tool", callId, name: "", phase: "update", status: "running",
          detail: JSON.stringify({ ...args, json_offset: offset }) }));
        if (!(missingResult && index === 1)) events.push(event(events.length, { kind: "tool", callId, name: "",
          phase: "result", status: "done", detail: JSON.stringify({ projection: "json_fragment",
            source_sha256: templateSha256, json_sha256: sha256(Buffer.from(json)), json_offset: offset,
            json_length: scalars.length, json: fragment, continuation: index + 1 < fragments.length
              ? { tool: "journal_read", arguments: { ...args, json_offset: offset + Array.from(fragment).length,
                expected_source_sha256: templateSha256, expected_json_sha256: sha256(Buffer.from(json)) } } : null }) }));
        offset += Array.from(fragment).length;
      }
    }
    const receipt = collectModelReadReceipt(events, activities, {
      manuscriptRevision: 0, manuscriptSourceSha256: sourceSha256,
      manuscriptFormatSourceSha256: liveSourceSha256, manuscriptParagraphs: paragraphs,
      nonBodyParagraphs: [], templateWorldVersionId, templateSourceSha256: templateSha256,
      templateInventory: inventory,
    });
    expect(receipt.complete, JSON.stringify(receipt.gaps)).toBe(!missingResult);
    expect(receipt.template.inventoryCoverage?.complete).toBe(!missingResult);
    if (missingResult) expect(receipt.gaps.some(gap => gap.includes("unfinished JSON fragment"))).toBe(true);
    else expect(receipt.template.inventoryCoverage?.collections[0].pages[0].callIds).toEqual(["objects-0", "objects-1"]);
  });

  it("uses exact TaskStore read windows and preserves terminal null offsets", () => {
    const paragraphs = [
      { paragraphRef: "p-1", text: "First paragraph", paraId: "00000001" },
      { paragraphRef: "p-2", text: "Second paragraph", paraId: "00000002" },
      { paragraphRef: "p-3", text: "", paraId: "00000003" },
    ];
    const document = {
      sessionId: "session",
      appProjectId: "app",
      workbenchProjectId: "manuscript",
      baselineId: "baseline",
      sourceSha256,
      sessionRevision: 0,
      savedRevision: 0,
      dirty: false,
      title: "Manuscript",
      filename: "manuscript.docx",
    };
    const events: TaskTranscriptEvent[] = [
      event(0, {
        kind: "tool", callId: "failed-read", name: "read_docx_document",
        phase: "result", detail: JSON.stringify({ error: "read failed" }), status: "error",
      }),
      event(1, {
        kind: "tool",
        callId: "read-display",
        name: "read_docx_document",
        phase: "request",
        detail: JSON.stringify({ offset: 0, limit: 50 }),
        status: "running",
      }),
      event(2, {
        kind: "tool",
        callId: "read-display",
        name: "",
        phase: "result",
        detail: JSON.stringify({
          document,
          paragraphs,
          offset: 0,
          nextOffset: null,
          totalParagraphs: 3,
        }),
        status: "done",
      }),
      event(3, {
        kind: "tool",
        callId: "read-cropped",
        name: "read_docx_document",
        phase: "request",
        detail: JSON.stringify({ offset: 0, limit: 20 }),
        status: "running",
      }),
      event(4, {
        kind: "tool",
        callId: "read-cropped",
        name: "",
        phase: "result",
        detail: `{"document":${JSON.stringify(document)}\n[output truncated]`,
        status: "done",
      }),
      event(5, {
        kind: "tool",
        callId: "format-overview",
        name: "read_docx_format",
        phase: "request",
        detail: JSON.stringify({
          query: { kind: "overview", expected_revision: 0 },
        }),
        status: "running",
      }),
      event(6, {
        kind: "tool",
        callId: "format-overview",
        name: "",
        phase: "result",
        detail: JSON.stringify({
          revision: 0,
          sourceSha256,
          overview: { counts: { paragraphs: 3 } },
        }),
        status: "done",
      }),
      event(7, {
        kind: "tool",
        callId: "template-page",
        name: "journal_read",
        phase: "request",
        detail: JSON.stringify({
          operation: "format",
          format_operation: "snapshot",
          collection: "objects",
          world_version_id: templateWorldVersionId,
          offset: 0,
          limit: 50,
        }),
        status: "running",
      }),
      event(8, {
        kind: "tool",
        callId: "template-page",
        name: "",
        phase: "result",
        detail: JSON.stringify({
          operation: "format",
          source_sha256: templateSha256,
          collection: "objects",
          snapshot: {
            objects: [{
              object_id: "template-paragraph",
              kind: "paragraph",
              part: "/word/document.xml",
              text: "Template paragraph",
            }],
          },
          total: 1,
          has_more: false,
          next_offset: null,
        }),
        status: "done",
      }),
      event(9, {
        kind: "tool",
        callId: "ordinary-write",
        name: "write_file",
        phase: "result",
        detail: "written",
        status: "done",
      }),
      event(10, {
        kind: "tool",
        callId: "ordinary-discovery",
        name: "discover_tools",
        phase: "result",
        detail: "tools available",
        status: "done",
      }),
      event(11, {
        kind: "tool",
        callId: "format-header",
        name: "read_docx_format",
        phase: "request",
        detail: JSON.stringify({
          query: {
            kind: "paragraphs",
            part: "/word/header4.xml",
            offset: 0,
            limit: 20,
            expected_revision: 0,
          },
        }),
        status: "running",
      }),
      event(12, {
        kind: "tool",
        callId: "format-header",
        name: "",
        phase: "result",
        detail: JSON.stringify({
          revision: 0,
          sourceSha256,
          total: 2,
          nextOffset: null,
          paragraphs: [
            {
              object_id: "header-paragraph-1",
              kind: "paragraph",
              part: "/word/header4.xml",
              text: "Hel",
              textOffset: 0,
              textLength: 5,
              textTruncated: true,
              textContinuation: {
                kind: "paragraphs",
                object_id: "header-paragraph-1",
                offset: 0,
                limit: 1,
                text_offset: 3,
                text_limit: 4000,
                expected_revision: 0,
              },
            },
            {
              object_id: "header-paragraph-2",
              kind: "paragraph",
              part: "/word/header4.xml",
              text: "Header",
              textOffset: 0,
              textLength: 6,
              textTruncated: false,
              textContinuation: null,
            },
          ],
        }),
        status: "done",
      }),
      event(13, {
        kind: "tool",
        callId: "format-header-continuation",
        name: "read_docx_format",
        phase: "request",
        detail: JSON.stringify({
          query: {
            kind: "paragraphs",
            object_id: "header-paragraph-1",
            offset: 0,
            limit: 1,
            text_offset: 3,
            expected_revision: 0,
          },
        }),
        status: "running",
      }),
      event(14, {
        kind: "tool",
        callId: "format-header-continuation",
        name: "",
        phase: "result",
        detail: JSON.stringify({
          revision: 0,
          sourceSha256,
          total: 1,
          nextOffset: null,
          paragraphs: [{
            object_id: "header-paragraph-1",
            kind: "paragraph",
            part: "/word/header4.xml",
            text: "lo",
            textOffset: 3,
            textLength: 5,
            textTruncated: false,
            textContinuation: null,
          }],
        }),
        status: "done",
      }),
    ];
    const templateResult = events.find(item => item.event.kind === "tool"
      && item.event.callId === "template-page" && item.event.phase === "result")!;
    if (templateResult.event.kind !== "tool") throw new Error("Missing template result");
    const templateJson = JSON.parse(templateResult.event.detail).content[0].text as string;
    templateResult.event.detail = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
      projection: "json_fragment", source_sha256: templateSha256,
      json_sha256: sha256(Buffer.from(templateJson)), json_offset: 0,
      json_length: templateJson.length, json: templateJson, continuation: null,
    }) }], isError: false });
    const noteParts = ["/word/footnotes.xml", "/word/endnotes.xml"];
    for (const [partIndex, part] of noteParts.entries()) {
      events.push(
        event(15 + partIndex * 2, {
          kind: "tool", callId: `notes-${partIndex}`, name: "read_docx_format", phase: "update",
          detail: JSON.stringify({ query: { kind: "paragraphs", part, offset: 0, limit: 20, expected_revision: 0 } }),
          status: "running",
        }),
        event(16 + partIndex * 2, {
          kind: "tool", callId: `notes-${partIndex}`, name: "", phase: "result",
          detail: JSON.stringify({ revision: 0, sourceSha256, total: 2, nextOffset: null,
            paragraphs: [0, 1].map(index => ({ object_id: `note-${partIndex}-${index}`,
              kind: "paragraph", part, text: "", textLength: 0, textContinuation: null })) }),
          status: "done",
        }),
      );
    }
    for (const item of events) {
      if (item.event.kind !== "tool" || item.event.phase !== "result"
        || item.event.detail.includes("[output truncated]")) continue;
      const envelope = JSON.parse(item.event.detail);
      if (!Array.isArray(envelope.content)) continue;
      if (!envelope.content[0].text.startsWith("{")) continue;
      const result = JSON.parse(envelope.content[0].text);
      if (result.revision === undefined) continue;
      envelope.content[0].text = JSON.stringify({ ...result, document, sourceSha256: liveSourceSha256 });
      item.event.detail = JSON.stringify(envelope);
    }
    // Native task format reads add an operation receipt inside the MCP text block.
    for (const item of events) {
      if (item.event.kind !== "tool" || item.event.phase !== "result"
        || item.event.detail.includes("[output truncated]")) continue;
      const envelope = JSON.parse(item.event.detail);
      if (!envelope.content[0].text.startsWith("{")) continue;
      const result = JSON.parse(envelope.content[0].text);
      if (result.revision === undefined) continue;
      const { sourceSha256: _baselineSource, ...innerDocument } = document;
      envelope.content[0].text = JSON.stringify({
        operation: "read_format", ok: true, document,
        result: { ...result, document: innerDocument },
      });
      item.event.detail = JSON.stringify(envelope);
    }
    for (const item of events) {
      if (item.event.kind !== "tool" || item.event.callId !== "template-page") continue;
      item.event.name = "";
      if (item.event.phase === "request") item.event.phase = "update";
    }
    const activities: DocxActivity[] = [
      {
        id: "activity-1",
        origin: {
          taskId: "task",
          generation: 1,
          groupId: null,
          memberId: null,
          executionId: null,
          workIds: [],
        },
        document,
        proposalId: null,
        createdAt: 1,
        event: {
          type: "runtime",
          event: { kind: "read", offset: 0, paragraphs: paragraphs.slice(0, 2) },
        },
      },
      {
        id: "activity-2",
        origin: {
          taskId: "task",
          generation: 1,
          groupId: null,
          memberId: null,
          executionId: null,
          workIds: [],
        },
        document,
        proposalId: null,
        createdAt: 2,
        event: {
          type: "runtime",
          event: { kind: "read", offset: 2, paragraphs: paragraphs.slice(2) },
        },
      },
    ];

    const receipt = collectModelReadReceipt(events, activities, {
      manuscriptRevision: 0,
      manuscriptSourceSha256: sourceSha256,
      manuscriptFormatSourceSha256: liveSourceSha256,
      templateWorldVersionId,
      templateSourceSha256: templateSha256,
      manuscriptParagraphs: paragraphs,
      nonBodyParagraphs: [
        ...noteParts.flatMap(part => [0, 1].map(index => ({ part, index, text: "" }))),
        {
          part: "word/header4.xml",
          index: 0,
          text: "Hello",
        },
        {
          part: "word/header4.xml",
          index: 1,
          text: "Header",
        },
      ],
    });

    expect(receipt.complete, receipt.gaps.join("\n")).toBe(true);
    expect(receipt.gaps).toEqual([]);
    expect(receipt.failedReadAttempts).toContain("read_docx_document failed-read returned isError");
    expect(receipt.format.nonBody.filter(part => part.part.endsWith("notes.xml")))
      .toEqual(expect.arrayContaining(noteParts.map(part => expect.objectContaining({
        part, expectedParagraphs: 2, observedParagraphs: 2, completeText: true,
      }))));
    expect(receipt.template.sourceSha256).toBe(templateSha256);
    expect(receipt.template.expectedObjects).toBe(1);
    expect(receipt.template.paragraphs).toHaveLength(1);
    expect(receipt.successfulToolCalls.find(call => call.callId === "template-page"))
      .toMatchObject({ name: "journal_read", identityBasis: "format_update_result" });
    expect(receipt.manuscript.observedParagraphs).toBe(3);
    expect(receipt.manuscript.activityWindows).toEqual([
      { offset: 0, nextOffset: 2, paragraphRefs: ["p-1", "p-2"] },
      { offset: 2, nextOffset: null, paragraphRefs: ["p-3"] },
    ]);
    expect(receipt.manuscript.paragraphs.map((paragraph) => paragraph.textSha256))
      .toEqual([
        sha256(Buffer.from("First paragraph")),
        sha256(Buffer.from("Second paragraph")),
        sha256(Buffer.from("")),
      ]);
    expect(receipt.displayProjectionGaps).toHaveLength(1);
    expect(receipt.format.overviewRead).toBe(true);
    const header = receipt.format.nonBody.find(part => part.part === "/word/header4.xml");
    expect(header).toMatchObject({
      part: "/word/header4.xml",
      expectedParagraphs: 2,
      observedParagraphs: 2,
      completeText: true,
    });
    expect(header?.paragraphs[0]).toMatchObject({
      textSha256: sha256(Buffer.from("Hello")),
      readOffsets: [0, 3],
      continuations: 1,
    });
  });

  it.each(["valid", "live revision", "live source", "format source", "ok false", "isError"])(
    "validates native read-format receipt identities: %s",
    (scenario) => {
      const paragraphs = [{ paragraphRef: "p", text: "Body" }];
      const document = {
        sessionId: "session", appProjectId: "app", workbenchProjectId: "manuscript",
        baselineId: "baseline", sourceSha256, sessionRevision: 0, savedRevision: 0,
      };
      const toolEvents: TaskTranscriptEvent[] = [];
      for (const kind of ["overview", "paragraphs"] as const) {
        const query = { kind, expected_revision: 0,
          ...(kind === "paragraphs" ? { part: "/word/footnotes.xml", offset: 0 } : {}) };
        toolEvents.push(event(toolEvents.length, {
          kind: "tool", callId: kind, name: "read_docx_format", phase: "update",
          detail: JSON.stringify({ query }), status: "running",
        }));
        const response = {
          operation: "read_format", ok: scenario !== "ok false",
          document: { ...document,
            ...(scenario === "live revision" ? { sessionRevision: 1 } : {}),
            ...(scenario === "live source" ? { sourceSha256: "d".repeat(64) } : {}),
          },
          result: {
            document: { sessionId: "session", sessionRevision: 0 },
            revision: 0,
            sourceSha256: scenario === "format source" ? "d".repeat(64) : liveSourceSha256,
            ...(kind === "overview" ? { overview: { counts: { paragraphs: 1 } } } : {
              paragraphs: [0, 1].map(index => ({ object_id: `note-${index}`,
                kind: "paragraph", part: "/word/footnotes.xml", text: "", textLength: 0,
                textContinuation: null })), total: 2, nextOffset: null,
            }),
          },
        };
        const resultEvent = event(toolEvents.length, {
          kind: "tool", callId: kind, name: "", phase: "result",
          detail: JSON.stringify(response), status: "done",
        });
        if (scenario === "isError" && resultEvent.event.kind === "tool") {
          const envelope = JSON.parse(resultEvent.event.detail);
          envelope.isError = true;
          resultEvent.event.detail = JSON.stringify(envelope);
        }
        toolEvents.push(resultEvent);
      }
      const receipt = collectModelReadReceipt(toolEvents, [], {
        manuscriptRevision: 0, manuscriptSourceSha256: sourceSha256,
        manuscriptFormatSourceSha256: liveSourceSha256,
        templateWorldVersionId, templateSourceSha256: templateSha256,
        manuscriptParagraphs: paragraphs,
        nonBodyParagraphs: [0, 1].map(index => ({ part: "/word/footnotes.xml", index, text: "" })),
      });
      expect(receipt.format.overviewRead).toBe(scenario === "valid");
      expect(receipt.format.nonBody[0].completeText).toBe(scenario === "valid");
      if (scenario === "valid") {
        expect(receipt.format.successfulCalls[0]).toMatchObject({
          revision: 0, sourceSha256: liveSourceSha256,
          liveRevision: 0, liveSourceSha256: sourceSha256,
        });
      } else expect(receipt.failedReadAttempts.length).toBeGreaterThan(0);
    },
  );

  it("fails when the model receives a backend safety-limit truncation", () => {
    const document = {
      sessionId: "session",
      appProjectId: "app",
      workbenchProjectId: "manuscript",
      baselineId: "baseline",
      sourceSha256,
      sessionRevision: 0,
      savedRevision: 0,
      dirty: false,
      title: "Manuscript",
      filename: "manuscript.docx",
    };
    const events: TaskTranscriptEvent[] = [
      event(1, {
        kind: "tool",
        callId: "read-truncated",
        name: "read_docx_document",
        phase: "result",
        detail: JSON.stringify({
          document,
          text_truncated: true,
        }),
        status: "done",
      }),
    ];

    const receipt = collectModelReadReceipt(events, [], {
      manuscriptRevision: 0,
      manuscriptSourceSha256: sourceSha256,
      manuscriptFormatSourceSha256: sourceSha256,
      templateWorldVersionId,
      templateSourceSha256: templateSha256,
      manuscriptParagraphs: [],
      nonBodyParagraphs: [],
    });

    expect(receipt.complete).toBe(false);
    expect(receipt.modelDeliveryFailures).toEqual([
      "read_docx_document read-truncated reached the model as a backend safety-limit error",
    ]);
    expect(receipt.failedReadAttempts).toContain(receipt.modelDeliveryFailures[0]);
    expect(receipt.gaps).toContain("no successful model narrative read activity reached the pre-task manuscript revision");
  });
});
