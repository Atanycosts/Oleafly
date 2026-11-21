// @vitest-environment jsdom
import type { OoxmlPackage } from "@docx-editor.dev/core/store";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DocxCitationArticle,
  DocxCitationInsertRequest,
} from "@/lib/docx-citation-write";
import { useSettingsStore } from "@/store/settings";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  sources: [
    { tag: "Local", title: "Local DOI study", doi: "10.1234/local" },
    { tag: "Other", title: "Other study", doi: "10.1234/other" },
  ],
}));

vi.mock("@/lib/docx-citation-search", () => ({
  searchDocxCitationArticles: mocks.search,
}));

vi.mock("@/lib/docx-citation-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/docx-citation-write")>();
  return {
    ...actual,
    listDocxCitationSources: () => mocks.sources,
    planDocxCitationSource: (
      _pkg: OoxmlPackage,
      source: DocxCitationInsertRequest["source"],
    ) => {
      if ("existingTag" in source) {
        const entry = mocks.sources.find((candidate) => candidate.tag === source.existingTag);
        return { kind: "reuse", tag: source.existingTag, title: entry?.title ?? source.existingTag };
      }
      return {
        kind: "add",
        partName: undefined,
        article: {
          details: {
            Title: source.article.title,
            JournalName: source.article.journal,
            Year: source.article.year,
          },
          authors: source.article.authors,
        },
      };
    },
  };
});

import { DocxCitationPicker } from "./DocxCitationPicker";

function renderPicker() {
  const insert = vi.fn(() => null);
  const onClose = vi.fn();
  render(<DocxCitationPicker pkg={{} as OoxmlPackage} insert={insert} onClose={onClose} />);
  return { insert, onClose };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function article(title: string): DocxCitationArticle {
  return { title, journal: "Journal", authors: [{ family: "Li" }], year: "2024" };
}

beforeEach(() => {
  mocks.search.mockReset();
  useSettingsStore.setState({ offline: false });
});

describe("DocxCitationPicker search form", () => {
  it("submits a DOI from Enter without inserting it", async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue([]);
    const { insert } = renderPicker();
    const search = screen.getByRole("searchbox", { name: "Title or DOI" });

    await user.type(search, "10.1234/local");
    expect(screen.getByRole("button", { name: "Local DOI study" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Insert citation" })).toBeDisabled();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledExactlyOnceWith("10.1234/local"));
    expect(insert).not.toHaveBeenCalled();
    expect(search).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Local DOI study" }));
    expect(insert).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Insert citation" }));
    expect(insert).toHaveBeenCalledExactlyOnceWith({ existingTag: "Local" });
  });

  it("keeps the Tab order and returns focus to the search while it is pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<readonly DocxCitationArticle[]>();
    mocks.search.mockReturnValueOnce(pending.promise);
    renderPicker();
    const search = screen.getByRole("searchbox", { name: "Title or DOI" });
    const searchButton = screen.getByRole("button", { name: "Search Crossref" });

    await user.type(search, "10.1234/remote");
    await user.tab();
    expect(searchButton).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(searchButton).toHaveFocus();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledOnce());
    expect(search).toHaveFocus();
    expect(searchButton).toBeDisabled();
    expect(screen.getByText("Searching Crossref…")).toBeVisible();

    await act(async () => pending.resolve([]));
  });

  it("does not query blank, offline, or loading searches", async () => {
    const user = userEvent.setup();
    renderPicker();
    const search = screen.getByRole("searchbox", { name: "Title or DOI" });
    const searchButton = screen.getByRole("button", { name: "Search Crossref" });

    await user.keyboard("{Enter}");
    expect(mocks.search).not.toHaveBeenCalled();

    act(() => useSettingsStore.setState({ offline: true }));
    await user.type(search, "10.1234/remote");
    await user.keyboard("{Enter}");
    expect(searchButton).toBeDisabled();
    expect(mocks.search).not.toHaveBeenCalled();

    act(() => useSettingsStore.setState({ offline: false }));
    const pending = deferred<readonly DocxCitationArticle[]>();
    mocks.search.mockReturnValueOnce(pending.promise);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledOnce());
    const form = search.closest("form");
    if (!form) throw new Error("The citation search is not inside a form.");
    fireEvent.submit(form);
    expect(mocks.search).toHaveBeenCalledOnce();

    await act(async () => pending.resolve([]));
  });

  it.each([
    ["a composing Enter", { isComposing: true }],
    ["WebKit's 229 Enter", { keyCode: 229 }],
  ] as const)("does not submit %s", (_name, init) => {
    renderPicker();
    const search = screen.getByRole("searchbox", { name: "Title or DOI" });
    fireEvent.change(search, { target: { value: "10.1234/remote" } });

    const enter = createEvent.keyDown(search, { key: "Enter", ...init });
    fireEvent(search, enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("keeps the newest query result when an older search resolves later", async () => {
    const user = userEvent.setup();
    const first = deferred<readonly DocxCitationArticle[]>();
    const second = deferred<readonly DocxCitationArticle[]>();
    mocks.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderPicker();
    const search = screen.getByRole("searchbox", { name: "Title or DOI" });

    await user.type(search, "first query");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.search).toHaveBeenNthCalledWith(1, "first query"));

    await user.clear(search);
    await user.type(search, "second query");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.search).toHaveBeenNthCalledWith(2, "second query"));

    await act(async () => second.resolve([article("Second result")]));
    expect(await screen.findByRole("button", { name: "Second result" })).toBeVisible();
    await act(async () => first.resolve([article("First result")]));

    expect(screen.queryByRole("button", { name: "First result" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second result" })).toBeVisible();
  });
});
