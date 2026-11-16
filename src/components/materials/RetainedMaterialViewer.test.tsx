// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createMaterialDocument } from "@/lib/material-surface";
import type { MaterialViewerRequest } from "@/store/material-viewer";
import { loadMaterialView, RetainedMaterialViewer } from "./RetainedMaterialViewer";
import en from "@/i18n/locales/en/editor.json";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";

const renders = vi.hoisted(() => ({ currentMounts: 0, currentUnmounts: 0 }));
vi.mock("./MaterialPdfView", async () => {
  const { useEffect } = await import("react");
  return { MaterialPdfView: function Pdf({ document }: { document: { title: string } }) {
    useEffect(() => {
      if (document.title === "Current") renders.currentMounts += 1;
      return () => { if (document.title === "Current") renders.currentUnmounts += 1; };
    }, [document.title]);
    return <span>{document.title}</span>;
  } };
});
vi.mock("./MaterialImageView", () => ({ MaterialImageView: () => null }));
beforeEach(() => useAgentWorkspaceStore.setState({ views: {} }));

async function request(text: string): Promise<MaterialViewerRequest> {
  const document = await createMaterialDocument({ projectId: "project", documentId: "paper", path: null, kind: "pdf", title: "Current" }, { text });
  return { ...document, load: async () => text };
}

it("verifies the captured bytes instead of displaying content under an unrelated revision", async () => {
  const version = await request("retained\r\nbytes");
  const loaded = await loadMaterialView(version, { ...version, revision: `sha256:${version.revision}` });
  expect(new TextDecoder().decode(loaded.bytes)).toBe("retained\r\nbytes");
  expect(loaded.document.revision).toBe(version.revision);
  await expect(loadMaterialView(version, { ...version, load: async () => "changed" })).rejects.toThrow("material_version_mismatch");
});

it("keeps both renderers mounted while switching the spatial stack and a single version", async () => {
  renders.currentMounts = 0;
  renders.currentUnmounts = 0;
  const current = await request("current");
  const previous = await request("earlier");
  render(<RetainedMaterialViewer request={{ ...current, previous: { ...previous, title: "Earlier" } }} />);
  await screen.findByText("Current", { selector: "span" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.compare }), { button: 0, ctrlKey: false });
  await screen.findByText("Earlier", { selector: "span" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.single }), { button: 0, ctrlKey: false });
  expect(screen.getByText("Earlier", { selector: "span" }).closest("[data-version=previous]")).toHaveAttribute("hidden");
  expect(screen.getByTestId("material-version-stack")).toHaveAttribute("data-mode", "current");
  expect(renders).toEqual({ currentMounts: 1, currentUnmounts: 0 });
});

it("discards a delayed load after another material has opened", async () => {
  const current = await request("current");
  const old = await request("earlier");
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const view = render(<RetainedMaterialViewer request={{ ...old, title: "Old", load: () => pending }} />);
  view.rerender(<RetainedMaterialViewer request={current} />);
  await screen.findByText("Current", { selector: "span" });
  await act(async () => { finish("earlier"); });
  expect(screen.queryByText("Old", { selector: "span" })).toBeNull();
});

it.each([undefined, "task_input", "checked"] as const)("publishes the visible version's own %s role and ignores a retained hidden visit", async (role) => {
  const current = await request("current");
  const previous = await request("earlier");
  const view = render(<RetainedMaterialViewer request={{ ...current, role: "result", previous: { ...previous, title: "Earlier", role } }} />);
  await waitFor(() => expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: current.revision, role: "result" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: en.materials.compare }), { button: 0, ctrlKey: false });
  await screen.findByText("Earlier", { selector: "span" });
  fireEvent.click(screen.getByRole("button", { name: en.materials.previous }));
  await waitFor(() => expect(useAgentWorkspaceStore.getState().views.project).toMatchObject({ revision: previous.revision, role: role ?? "evidence" }));
  act(() => useAgentWorkspaceStore.getState().publishView({ projectId: "project", documentId: "working", title: "Working", kind: "docx", revision: "7", role: "working" }));
  view.rerender(<RetainedMaterialViewer request={current} active={false} />);
  await screen.findByText("Current", { selector: "span" });
  expect(useAgentWorkspaceStore.getState().views.project.documentId).toBe("working");
});
