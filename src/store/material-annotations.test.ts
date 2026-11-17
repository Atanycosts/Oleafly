import { beforeEach, expect, it, vi } from "vitest";
import type { MaterialDocument } from "@/lib/material-surface";
import { openMaterialAnnotations, useMaterialAnnotationsStore } from "./material-annotations";

const retained: MaterialDocument = { projectId: "paper", documentId: "paper.docx", title: "Paper", path: null,
  kind: "docx", revision: "retained", source: { bytes: new Uint8Array([80, 75]) } };

beforeEach(() => useMaterialAnnotationsStore.getState().close());

it("retains the exact document and live task-binding callback without executing it when feedback opens", async () => {
  const beforeStartTask = vi.fn(async (_taskId: string) => {});
  const source = vi.fn(async () => ({ bytes: new Uint8Array([80, 75]) }));
  const working = { ...retained, revision: "working", source };
  const anchor = { kind: "text" as const, from: 3, to: 7, quote: "word" };
  openMaterialAnnotations(working, anchor, { beforeStartTask });
  const state = useMaterialAnnotationsStore.getState();
  expect(state.document).toBe(working);
  expect(state.anchor).toBe(anchor);
  expect(source).not.toHaveBeenCalled();
  expect(beforeStartTask).not.toHaveBeenCalled();
  await state.options.beforeStartTask?.("task-1");
  expect(beforeStartTask).toHaveBeenCalledWith("task-1");
});

it("clears an earlier working-copy binding when whole feedback opens for a retained source", () => {
  openMaterialAnnotations({ ...retained, revision: "working" }, { kind: "object", id: "paragraph-1" }, { beforeStartTask: vi.fn() });
  openMaterialAnnotations(retained);
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document: retained, anchor: { kind: "whole" }, options: {} });
});

it("clears document, selection and live binding on close before opening another material", () => {
  openMaterialAnnotations(retained, { kind: "object", id: "paragraph-1" }, { beforeStartTask: vi.fn() });
  useMaterialAnnotationsStore.getState().close();
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document: null, anchor: { kind: "whole" }, options: {} });
  const next = { ...retained, documentId: "next.docx", revision: "next-retained" };
  openMaterialAnnotations(next);
  expect(useMaterialAnnotationsStore.getState().document).toBe(next);
  expect(useMaterialAnnotationsStore.getState().options).toEqual({});
});
