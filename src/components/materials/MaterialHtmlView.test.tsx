// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MaterialHtmlView } from "./MaterialHtmlView";
import { useMaterialAnnotationsStore } from "@/store/material-annotations";
import type { MaterialDocument } from "@/lib/material-surface";
import en from "@/i18n/locales/en/editor.json";
import { useAgentWorkspaceStore } from "@/store/agent-workspace";
const api = vi.hoisted(() => ({ restoreHtmlPreview: vi.fn(), closeHtmlPreview: vi.fn(async () => {}) }));
vi.mock("@/lib/notebook-commands", () => api);
const document: MaterialDocument = { projectId: "p", documentId: "report", path: null, title: "Report", revision: "frozen", kind: "html", source: { text: "bundle" } };
it("isolates executable HTML and accepts DOM selection only from the displayed frame", async () => {
  const { container } = render(<MaterialHtmlView document={document} bundle="bundle" previewUrl="http://127.0.0.1:1234/token/index.html" />);
  const frame = container.querySelector("iframe")!;
  expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  const button = screen.getByRole("button", { name: en.materials.annotateSelection });
  act(() => window.dispatchEvent(new MessageEvent("message", { source: window, data: { type: "oleafly-html-selection", selector: "#wrong", quote: "wrong" } })));
  expect(button).toBeDisabled();
  act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "oleafly-html-selection", selector: "#result", quote: "retained finding" } })));
  fireEvent.click(button);
  expect(useMaterialAnnotationsStore.getState()).toMatchObject({ document, anchor: { kind: "html", selector: "#result", quote: "retained finding" } });
});
it("restores the captured bundle and closes only its own server lease", async () => {
  api.restoreHtmlPreview.mockResolvedValue({ url: "http://127.0.0.1:1234/old/index.html" });
  const view = render(<MaterialHtmlView document={document} bundle="retained bundle" />);
  await waitFor(() => expect(view.container.querySelector("iframe")).toHaveAttribute("src", "http://127.0.0.1:1234/old/index.html"));
  expect(api.restoreHtmlPreview).toHaveBeenCalledWith("retained bundle");
  view.unmount();
  expect(api.closeHtmlPreview).toHaveBeenCalledWith("http://127.0.0.1:1234/old/index.html");
});


it("reveals a retained DOM anchor through a message to the isolated frame", () => {
  const anchor = { kind: "html" as const, selector: "#finding", quote: "finding" };
  const { container } = render(<MaterialHtmlView document={document} bundle="bundle" previewUrl="http://127.0.0.1:1234/a" anchor={anchor} />);
  const frame = container.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith({ type: "oleafly-html-anchor", selector: anchor.selector, quote: anchor.quote }, "*");
});

it("pauses following only for interaction inside its visible controlled frame", () => {
  useAgentWorkspaceStore.setState({ paused: false });
  const view = render(<MaterialHtmlView document={document} bundle="bundle" previewUrl="http://127.0.0.1:1234/a" />);
  const frame = view.container.querySelector("iframe")!;
  const send = (source: MessageEventSource | null) => act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { type: "oleafly-html-interaction" } })));
  send(window);
  expect(useAgentWorkspaceStore.getState().paused).toBe(false);
  view.container.hidden = true;
  send(frame.contentWindow);
  expect(useAgentWorkspaceStore.getState().paused).toBe(false);
  view.container.hidden = false;
  send(frame.contentWindow);
  expect(useAgentWorkspaceStore.getState().paused).toBe(true);
});
