// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useFilesStore } from "@/store/files";
import { MarkdownPreview } from "./MarkdownPreview";

const openProjectLocation = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/open-location", () => ({ openProjectLocation }));

const loadAssetThumbnail = vi.hoisted(() => vi.fn<(project: string, path: string) => Promise<string | null>>());
vi.mock("./cm/hover-asset", () => ({ loadAssetThumbnail }));

function openContent(content: string, projectId = "first") {
  useFilesStore.setState({
    projectId,
    activePath: "chapters/notes.md",
    files: { "chapters/notes.md": { content, dirty: true } },
  });
}

beforeEach(() => {
  loadAssetThumbnail.mockReset().mockResolvedValue(null);
  openProjectLocation.mockClear();
});

it("renders the unsaved Markdown buffer and follows edits and file changes", async () => {
  openContent("# Research notes\n\n| Sample | Result |\n| --- | --- |\n| A | 42 |\n\n$x^2$");
  const { container } = render(<MarkdownPreview />);
  expect(screen.getByRole("heading", { name: "Research notes" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "42" })).toBeVisible();
  expect(container.querySelector(".katex")).not.toBeNull();

  act(() => openContent("# Revised notes\n\n**Unsaved** changes."));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Revised notes" })).toBeVisible());
  expect(screen.queryByRole("heading", { name: "Research notes" })).not.toBeInTheDocument();
  expect(screen.getByText("Unsaved").tagName).toBe("STRONG");

  act(() => useFilesStore.setState({ activePath: "empty.md", files: {} }));
  await waitFor(() => expect(screen.queryByRole("heading")).not.toBeInTheDocument());
});

it("resolves relative images and ignores an old project response", async () => {
  let resolveFirst!: (url: string) => void;
  const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
  loadAssetThumbnail.mockReturnValueOnce(first).mockResolvedValueOnce("data:image/png;base64,current");
  openContent("![Plot](../figures/my%20plot.png)");
  render(<MarkdownPreview />);
  await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith("first", "figures/my plot.png"));

  act(() => openContent("![Plot](../figures/my%20plot.png)", "second"));
  await waitFor(() => expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute("src", "data:image/png;base64,current"));
  await act(async () => resolveFirst("data:image/png;base64,stale"));
  expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute("src", "data:image/png;base64,current");
});

it("shows a web image directly without asking the project", () => {
  openContent('![Logo](https://example.com/logo.png "Brand")');
  render(<MarkdownPreview />);
  const image = screen.getByRole("img", { name: "Logo" });
  expect(image).toHaveAttribute("src", "https://example.com/logo.png");
  expect(image).toHaveAttribute("title", "Brand");
  expect(loadAssetThumbnail).not.toHaveBeenCalled();
});

it("falls back to the alt text for images it cannot load", async () => {
  openContent("![Broken %E0%A4%A](bad%E0%A4%A.png)\n\n![Outside](../../../escape.png)\n\n![Missing](missing.png)\n\n![]()");
  render(<MarkdownPreview />);
  await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith("first", "chapters/missing.png"));
  expect(loadAssetThumbnail).toHaveBeenCalledOnce();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("Missing")).toBeInTheDocument();
  expect(screen.getByText("Outside")).toBeInTheDocument();
});

it("shows alt text for project images while no project is open", () => {
  openContent("![Plot](plot.png)", "");
  useFilesStore.setState({ projectId: null });
  render(<MarkdownPreview />);
  expect(screen.getByText("Plot")).toBeInTheDocument();
  expect(loadAssetThumbnail).not.toHaveBeenCalled();
});

it("links notes by their project path so a copied link names the right file", () => {
  openContent("[Land](<../Сведения о земельном участке.md#план>) and [site](https://example.com/a)");
  useFilesStore.setState({ tree: [{ path: "Сведения о земельном участке.md", is_dir: false }] });
  render(<MarkdownPreview />);
  const note = screen.getByRole("link", { name: "Land" });
  expect(note.getAttribute("href")).toBe(
    "/%D0%A1%D0%B2%D0%B5%D0%B4%D0%B5%D0%BD%D0%B8%D1%8F%20%D0%BE%20%D0%B7%D0%B5%D0%BC%D0%B5%D0%BB%D1%8C%D0%BD%D0%BE%D0%BC%20%D1%83%D1%87%D0%B0%D1%81%D1%82%D0%BA%D0%B5.md#%D0%BF%D0%BB%D0%B0%D0%BD",
  );
  expect(screen.getByRole("link", { name: "site" })).toHaveAttribute("href", "https://example.com/a");
});

it("opens a linked note in Oleafly and ignores a link to a missing file", () => {
  openContent("[Plan](plan.md) and [Gone](gone.md)");
  useFilesStore.setState({ tree: [{ path: "chapters/plan.md", is_dir: false }] });
  render(<MarkdownPreview />);
  const plan = new MouseEvent("click", { bubbles: true, cancelable: true });
  screen.getByRole("link", { name: "Plan" }).dispatchEvent(plan);
  expect(plan.defaultPrevented).toBe(true);
  expect(openProjectLocation).toHaveBeenCalledWith({ path: "chapters/plan.md" });
  const gone = new MouseEvent("click", { bubbles: true, cancelable: true });
  screen.getByRole("link", { name: "Gone" }).dispatchEvent(gone);
  expect(gone.defaultPrevented).toBe(true);
  expect(openProjectLocation).toHaveBeenCalledTimes(1);
});

it("opens a note whose link was saved with the app's own address, as 0.4.7 did", () => {
  openContent(
    "[Land](http://tauri.localhost/%D0%A1%D0%B2%D0%B5%D0%B4%D0%B5%D0%BD%D0%B8%D1%8F.md) and [Plan](tauri://localhost/chapters/plan.md)",
  );
  useFilesStore.setState({ tree: [{ path: "Сведения.md", is_dir: false }, { path: "chapters/plan.md", is_dir: false }] });
  render(<MarkdownPreview />);
  const land = screen.getByRole("link", { name: "Land" });
  // No target="_blank": the shell plugin would send it to the system browser.
  expect(land).not.toHaveAttribute("target");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  land.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(openProjectLocation).toHaveBeenCalledWith({ path: "Сведения.md" });
  screen.getByRole("link", { name: "Plan" }).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(openProjectLocation).toHaveBeenLastCalledWith({ path: "chapters/plan.md" });
});

it("loads a project image whose path was saved with the app's own address", async () => {
  openContent("![plot](http://tauri.localhost/figures/plot%201.png)");
  loadAssetThumbnail.mockResolvedValue("blob:plot");
  render(<MarkdownPreview />);
  await waitFor(() => expect(screen.getByRole("img", { name: "plot" })).toHaveAttribute("src", "blob:plot"));
  expect(loadAssetThumbnail).toHaveBeenCalledWith("first", "figures/plot 1.png");
});

it("renders retained content independently and maps selected rendered text to its actual source block", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { useMaterialAnnotationsStore } = await import("@/store/material-annotations");
  const en = (await import("@/i18n/locales/en/editor.json")).default;
  openContent("# Current buffer");
  const content = "# Retained\n\nA **bold** result.";
  render(<MarkdownPreview content={content} projectId="retained-project" path="old.md" />);
  expect(screen.queryByRole("heading", { name: "Current buffer" })).toBeNull();
  const text = screen.getByText("bold").firstChild!;
  const range = document.createRange(); range.selectNodeContents(text);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  fireEvent.mouseUp(screen.getByTestId("markdown-preview"));
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateSelection }));
  await waitFor(() => expect(useMaterialAnnotationsStore.getState().document?.projectId).toBe("retained-project"));
  const anchor = useMaterialAnnotationsStore.getState().anchor;
  expect(anchor.kind).toBe("text");
  if (anchor.kind === "text") expect(anchor.quote).toBe(content.slice(anchor.from, anchor.to));
  expect(anchor).toEqual({ kind: "text", from: 12, to: content.length, quote: "A **bold** result." });
});


it("preserves a retained material identity when adding feedback and reveals its source block anchor", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { useMaterialAnnotationsStore } = await import("@/store/material-annotations");
  const en = (await import("@/i18n/locales/en/editor.json")).default;
  const document = { projectId: "original-project", documentId: "retained:stable-id", path: "old.md", title: "Retained", kind: "markdown" as const, revision: "exact-hash", source: { text: "# Retained" } };
  render(<MarkdownPreview document={document} anchor={{ kind: "text", from: 0, to: 10, quote: "# Retained" }} />);
  expect(screen.getByRole("heading")).toHaveAttribute("data-material-anchor", "true");
  fireEvent.click(screen.getByRole("button", { name: en.materials.annotateWhole }));
  expect(useMaterialAnnotationsStore.getState().document).toBe(document);
});


it("never reloads current project or remote image bytes when displaying a retained Markdown document", async () => {
  const en = (await import("@/i18n/locales/en/editor.json")).default;
  const content = "![Original plot](figures/plot.png)\n\n![Remote plot](https://example.com/plot.png)";
  const document = { projectId: "original-project", documentId: "retained-md", path: "old.md", title: "Retained", kind: "markdown" as const, revision: "frozen-text", source: { text: content } };
  render(<MarkdownPreview document={document} />);
  expect(loadAssetThumbnail).not.toHaveBeenCalled();
  expect(screen.queryByRole("img")).toBeNull();
  const placeholders = screen.getAllByTestId("retained-image-placeholder");
  expect(placeholders).toHaveLength(2);
  expect(placeholders[0]).toHaveTextContent(`Original plot · ${en.materials.retainedImageUnavailable}`);
  expect(placeholders[1]).toHaveTextContent(`Remote plot · ${en.materials.retainedImageUnavailable}`);
});
