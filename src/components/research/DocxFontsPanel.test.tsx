// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalWorld } from "@/lib/journal-workbench";
import type { ComponentInfo } from "@/lib/tauri";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ exact: vi.fn(), load: vi.fn(), install: vi.fn(), catalog: {
  status: "ready" as "idle" | "loading" | "ready" | "error",
  packs: [] as ComponentInfo[],
} }));
vi.mock("@/lib/docx-fonts", () => ({ hasExactDocxFont: mocks.exact }));
vi.mock("@/store/font-packs", async () => {
  const { create } = await import("zustand");
  const useFontPacksStore = create<Record<string, unknown>>(() => ({
    packs: [],
    status: "ready",
    installing: null,
    progress: null,
    revision: 0,
    lastError: null,
    load: mocks.load,
    install: mocks.install,
    remove: vi.fn(),
    downloadAll: vi.fn(),
  }));
  return { useFontPacksStore };
});
import { useFontPacksStore } from "@/store/font-packs";
import { DocxFontsPanel } from "./DocxFontsPanel";

const text = en.docx.fonts;
const status = { probed: true, missing: [{ family: "SimSun", weight: 400, style: "normal" as const }], aliases: [] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const catalogPack = (over: Pick<ComponentInfo, "id"> & Partial<ComponentInfo>): ComponentInfo => {
  const { id, ...values } = over;
  return {
    id,
    label: id,
    description: "",
    approx_bytes: 0,
    license: null,
    installed: false,
    kind: "font",
    families: [],
    ...values,
  };
};
function world(basis = "confirmed", family = "Exact Serif"): JournalWorld {
  const scope = { article_type: "research", stage: "submission", language: "en" };
  return { scope, version_id: "world-font-1", journal_name: "Example Journal", rules: [{ rule_id: "font-rule", property: "body_font_family", expected: family,
    scope: { ...scope, section_scope: "all" }, unit: "font_family", basis_status: basis, evidence: [{ source_id: "guide", locator: "p2", quote: `Use ${family}` }] }] } as JournalWorld;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.status = "ready";
  mocks.catalog.packs = [];
  mocks.exact.mockResolvedValue(false);
  mocks.load.mockImplementation(async () => {
    useFontPacksStore.setState({
      packs: mocks.catalog.packs,
      status: mocks.catalog.status,
    });
  });
  mocks.install.mockImplementation(async () => {
    useFontPacksStore.setState((state) => ({ revision: Number(state.revision) + 1 }));
    return true;
  });
  useFontPacksStore.setState({
    packs: mocks.catalog.packs,
    status: mocks.catalog.status,
    installing: null,
    progress: null,
    revision: 0,
    lastError: null,
  });
});

it("automatically installs only an exact catalog match for a confirmed journal requirement then rechecks", async () => {
  mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"] })];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByText(en.workspace.docxFonts.journalGuide)).toBeInTheDocument();
  expect(screen.getByText("Use Exact Serif", { selector: "blockquote" })).toBeInTheDocument();
  expect(screen.getByTestId("docx-font-missing-families")).toHaveTextContent("SimSun");
  expect(screen.getByText(text.acquisitionOnly)).toBeInTheDocument();
  expect(screen.queryByText("world-font-1")).not.toBeInTheDocument();
  expect(screen.queryByText("font-rule")).not.toBeInTheDocument();
});

it("acquires active template families without requiring a body-font guide rule", async () => {
  const target = world();
  target.rules = [];
  target.template = {
    source_id: "original", normalized_source_id: "normalized", snapshot_source_id: "snapshot",
    source_sha256: "a".repeat(64), original_sha256: "b".repeat(64), provenance: null,
    font_requirements: [{ family: "Exact CJK", roles: ["body", "heading"], scripts: ["east_asian"] }],
  };
  mocks.catalog.packs = [catalogPack({ id: "cjk", families: ["Exact CJK"] })];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={target} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("cjk");
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("Body、Heading");
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("East Asian");
  expect(screen.getByText(text.templateFonts)).toBeInTheDocument();
  expect(screen.queryByText(text.noRequirements)).not.toBeInTheDocument();
});

it("acquires a shared guide and template family once while showing both sources", async () => {
  const target = world();
  target.template = {
    source_id: "original", normalized_source_id: "normalized", snapshot_source_id: "snapshot",
    source_sha256: "a".repeat(64), original_sha256: "b".repeat(64), provenance: null,
    font_requirements: [{ family: "exact serif", roles: ["document_title"], scripts: ["latin"] }],
  };
  mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"] })];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<DocxFontsPanel ready world={target} status={status} onRefresh={vi.fn(async () => {})} />);
  await waitFor(() => expect(screen.getAllByTestId("docx-font-acquisition")).toHaveLength(2));
  await waitFor(() => expect(screen.getAllByTestId("docx-font-acquisition").every((element) => element.dataset.state === "available")).toBe(true));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(mocks.exact).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(text.confirmed);
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("Document title");
});

it.each(["candidate", "conflict"])("never downloads a %s journal rule or a document-only font", async (basis) => {
  render(<DocxFontsPanel ready world={world(basis)} status={status} onRefresh={vi.fn()} />);
  expect(screen.getByText(text.unconfirmed, { exact: false })).toBeInTheDocument();
  expect(mocks.exact).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});

it("reports no source when the catalog contains only a different family", async () => {
  mocks.catalog.packs = [catalogPack({ id: "noto", families: ["Noto Serif CJK SC"] })];
  render(<DocxFontsPanel ready world={world("confirmed", "SimSun")} status={status} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "noSource"));
  expect(mocks.install).not.toHaveBeenCalled();
});

it("matches a localized catalog family and does not install it when the cached face is available", async () => {
  const description = "Exact SimSun from the Microsoft Office font package.";
  mocks.catalog.packs = [catalogPack({ id: "microsoft-simsun", families: ["SimSun", "宋体"], description })];
  mocks.exact.mockResolvedValue(true);
  render(<DocxFontsPanel ready world={world("confirmed", "宋体")} status={{ probed: true, missing: [], aliases: [] }} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(description);
});

it("shows readable source, installation state, and version without hashes or aliases", async () => {
  const hash = "a".repeat(64);
  const description = "Exact SimSun from the Microsoft Office font package.";
  const licenseUrl = "https://github.com/fontist/formulas/blob/78a7195b56d073de453036c50c57513b27e1ce85/Formulas/office_preview.yml";
  mocks.catalog.packs = [catalogPack({
    id: "microsoft-simsun",
    families: ["SimSun", "宋体"],
    installed: true,
    description,
    license: { spdx: "LicenseRef-Microsoft-OfficeMac", author: "Microsoft Corporation", url: licenseUrl },
  })];
  mocks.exact.mockResolvedValue(true);
  render(<DocxFontsPanel ready world={world("confirmed", "SimSun")} status={{ probed: true, missing: [], aliases: [],
    loaded: [{ family: "SimSun", version: "Version 5.04i", sha256: hash }] }} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(description);
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent("Font pack installed");
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent("Installed version Version 5.04i");
  expect(screen.getByRole("link", { name: "View font source and license" })).toHaveAttribute("href", licenseUrl);
  expect(screen.queryByText(/SHA-256/)).not.toBeInTheDocument();
  expect(screen.queryByText(hash)).not.toBeInTheDocument();
  expect(screen.queryByText("LicenseRef-Microsoft-OfficeMac")).not.toBeInTheDocument();
});

it("summarizes unique missing font families without exposing face variants", async () => {
  render(<DocxFontsPanel
    ready
    world={null}
    status={{
      probed: true,
      missing: [
        { family: "SimSun", weight: 400, style: "normal" },
        { family: "SimSun", weight: 700, style: "normal" },
        { family: "simsun", weight: 400, style: "italic" },
        { family: "Calibri", weight: 400, style: "normal" },
      ],
      aliases: [],
    }}
    onRefresh={vi.fn()}
  />);

  expect(screen.getByTestId("docx-font-missing-families")).toHaveTextContent(/^SimSun, Calibri$/);
  expect(screen.queryByText("SimSun (400, normal)")).not.toBeInTheDocument();
  expect(screen.getByText(text.probeScope)).toBeInTheDocument();
  expect(screen.queryByTestId("docx-font-details")).not.toBeInTheDocument();
});

it("does not claim availability after a failed download", async () => {
  mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"] })];
  mocks.install.mockResolvedValue(false);
  const refresh = vi.fn();
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "failed"));
  expect(refresh).not.toHaveBeenCalled();
});

it("rechecks and repairs an installed pack when the exact face is unavailable", async () => {
  mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"], installed: true })];
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={vi.fn(async () => {})} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "stillMissing"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
});

it("refreshes manually installed fonts without a journal rule", async () => {
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={null} status={status} onRefresh={refresh} />);
  fireEvent.click(screen.getByTestId("docx-font-refresh"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(mocks.install).not.toHaveBeenCalled();
});

it("refreshes the live editor when Settings changes the shared font catalog", async () => {
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={null} status={status} onRefresh={refresh} />);
  expect(refresh).not.toHaveBeenCalled();

  act(() => {
    useFontPacksStore.setState({
      packs: [catalogPack({ id: "microsoft-simsun", families: ["SimSun", "宋体"], installed: true })],
      revision: 1,
    });
  });

  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(mocks.install).not.toHaveBeenCalled();
});

it("refreshes again when a second font finishes installing while setFonts is in flight", async () => {
  const firstRefresh = deferred();
  const refresh = vi.fn()
    .mockReturnValueOnce(firstRefresh.promise)
    .mockResolvedValue(undefined);
  render(<DocxFontsPanel ready world={null} status={status} onRefresh={refresh} />);

  act(() => {
    useFontPacksStore.setState({
      packs: [catalogPack({ id: "microsoft-simsun", families: ["SimSun", "宋体"], installed: true })],
      revision: 1,
    });
  });
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

  act(() => {
    useFontPacksStore.setState({
      packs: [
        catalogPack({ id: "microsoft-simsun", families: ["SimSun", "宋体"], installed: true }),
        catalogPack({ id: "microsoft-dengxian", families: ["DengXian", "等线"], installed: true }),
      ],
      revision: 2,
    });
  });
  expect(refresh).toHaveBeenCalledOnce();

  await act(async () => firstRefresh.resolve());
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});

it("waits for both the live editor and its first font probe before downloading", async () => {
  mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"] })];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const target = world();
  const refresh = vi.fn(async () => {});
  const view = render(<DocxFontsPanel ready={false} world={target} status={status} onRefresh={refresh} />);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-font-refresh")).toBeDisabled();
  view.rerender(<DocxFontsPanel ready world={target} status={{ ...status, probed: false }} onRefresh={refresh} />);
  expect(mocks.load).not.toHaveBeenCalled();
  view.rerender(<DocxFontsPanel ready world={target} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(refresh).toHaveBeenCalledOnce();
});

it.each(["article_type", "stage", "language"] as const)("does not acquire a confirmed rule with a different %s scope", async (field) => {
  const target = world();
  target.rules[0].scope[field] = "different";
  render(<DocxFontsPanel ready world={target} status={status} onRefresh={vi.fn()} />);
  expect(screen.getByText(text.outsideScope)).toBeInTheDocument();
  expect(screen.queryByTestId("docx-font-acquisition")).not.toBeInTheDocument();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.exact).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
});

it("does not install an old world's font when its pending exact-face check finishes", async () => {
  let finish!: (available: boolean) => void;
  mocks.exact.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
  mocks.catalog.packs = [catalogPack({ id: "old", families: ["Old Serif"] })];
  const refresh = vi.fn(async () => {});
  const view = render(<DocxFontsPanel ready world={world("confirmed", "Old Serif")} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(mocks.exact).toHaveBeenCalledWith("Old Serif"));
  view.rerender(<DocxFontsPanel ready world={world("candidate", "New Serif")} status={status} onRefresh={refresh} />);
  expect(screen.getByTestId("docx-font-refresh")).toBeEnabled();
  await act(async () => finish(false));
  expect(mocks.install).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("waits for an in-flight catalog load before matching the font package", async () => {
  let finish!: () => void;
  mocks.catalog.status = "loading";
  mocks.load.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={vi.fn(async () => {})} />);
  expect(mocks.exact).not.toHaveBeenCalled();
  await act(async () => {
    mocks.catalog.status = "ready";
    mocks.catalog.packs = [catalogPack({ id: "exact", families: ["Exact Serif"] })];
    useFontPacksStore.setState({ packs: mocks.catalog.packs, status: "ready" });
    finish();
  });
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
});
