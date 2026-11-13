// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { JournalWorld } from "@/lib/journal-workbench";
import en from "@/i18n/locales/en/researchTools.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ exact: vi.fn(), load: vi.fn(), install: vi.fn(), catalog: {
  status: "ready", packs: [] as {
    id: string;
    families: string[];
    installed: boolean;
    description?: string;
    license?: { spdx: string; author: string; url: string } | null;
  }[],
} }));
vi.mock("@/lib/docx-fonts", () => ({ hasExactDocxFont: mocks.exact }));
vi.mock("@/store/font-packs", () => ({ useFontPacksStore: { getState: () => ({ ...mocks.catalog, load: mocks.load, install: mocks.install }) } }));
import { DocxFontsPanel } from "./DocxFontsPanel";

const text = en.docx.fonts;
const status = { probed: true, missing: [{ family: "SimSun", weight: 400, style: "normal" as const }], aliases: [] };
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
  mocks.load.mockResolvedValue(undefined);
  mocks.install.mockResolvedValue(true);
});

it("automatically installs only an exact catalog match for a confirmed journal requirement then rechecks", async () => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: false }];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByTestId("docx-font-world")).toHaveTextContent("world-font-1");
  expect(screen.getByText("guide · p2 · Use Exact Serif")).toBeInTheDocument();
  expect(screen.getByTestId("docx-font-missing")).toHaveTextContent("SimSun");
  expect(screen.getByText(text.acquisitionOnly)).toBeInTheDocument();
});

it("acquires active template families without requiring a body-font guide rule", async () => {
  const target = world();
  target.rules = [];
  target.template = {
    source_id: "original", normalized_source_id: "normalized", snapshot_source_id: "snapshot",
    source_sha256: "a".repeat(64), original_sha256: "b".repeat(64), provenance: null,
    font_requirements: [{ family: "Exact CJK", roles: ["body", "heading"], scripts: ["east_asian"] }],
  };
  mocks.catalog.packs = [{ id: "cjk", families: ["Exact CJK"], installed: false }];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const refresh = vi.fn(async () => {});
  render(<DocxFontsPanel ready world={target} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("cjk");
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("body, heading");
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("east_asian");
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
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: false }];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<DocxFontsPanel ready world={target} status={status} onRefresh={vi.fn(async () => {})} />);
  await waitFor(() => expect(screen.getAllByTestId("docx-font-acquisition")).toHaveLength(2));
  await waitFor(() => expect(screen.getAllByTestId("docx-font-acquisition").every((element) => element.dataset.state === "available")).toBe(true));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(mocks.exact).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(text.confirmed);
  expect(screen.getByTestId("docx-template-font")).toHaveTextContent("document_title");
});

it.each(["candidate", "conflict"])("never downloads a %s journal rule or a document-only font", async (basis) => {
  render(<DocxFontsPanel ready world={world(basis)} status={status} onRefresh={vi.fn()} />);
  expect(screen.getByText(text.unconfirmed, { exact: false })).toBeInTheDocument();
  expect(mocks.exact).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});

it("reports no source when the catalog contains only a different family", async () => {
  mocks.catalog.packs = [{ id: "noto", families: ["Noto Serif CJK SC"], installed: false }];
  render(<DocxFontsPanel ready world={world("confirmed", "SimSun")} status={status} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "noSource"));
  expect(mocks.install).not.toHaveBeenCalled();
});

it("matches a localized catalog family and does not install it when the cached face is available", async () => {
  const description = "Exact SimSun from the Microsoft Office font package.";
  mocks.catalog.packs = [{ id: "microsoft-simsun", families: ["SimSun", "宋体"], installed: false, description }];
  mocks.exact.mockResolvedValue(true);
  render(<DocxFontsPanel ready world={world("confirmed", "宋体")} status={{ probed: true, missing: [], aliases: [] }} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).not.toHaveBeenCalled();
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(description);
});

it("shows loaded face identity and the matching catalog description and license", async () => {
  const hash = "a".repeat(64);
  const description = "Exact SimSun from the Microsoft Office font package.";
  const licenseUrl = "https://github.com/fontist/formulas/blob/78a7195b56d073de453036c50c57513b27e1ce85/Formulas/office_preview.yml";
  mocks.catalog.packs = [{
    id: "microsoft-simsun",
    families: ["SimSun", "宋体"],
    installed: true,
    description,
    license: { spdx: "LicenseRef-Microsoft-OfficeMac", author: "Microsoft Corporation", url: licenseUrl },
  }];
  mocks.exact.mockResolvedValue(true);
  render(<DocxFontsPanel ready world={world("confirmed", "SimSun")} status={{ probed: true, missing: [], aliases: [],
    loaded: [{ family: "SimSun", version: "Version 5.04i", sha256: hash }] }} onRefresh={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(screen.getByTestId("docx-font-versions")).toHaveTextContent(`SimSun · Version 5.04i · SHA-256 ${hash}`);
  expect(screen.getByTestId("docx-journal-font")).toHaveTextContent(description);
  expect(screen.getByRole("link", { name: "LicenseRef-Microsoft-OfficeMac" })).toHaveAttribute("href", licenseUrl);
});

it("does not claim availability after a failed download", async () => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: false }];
  mocks.install.mockResolvedValue(false);
  const refresh = vi.fn();
  render(<DocxFontsPanel ready world={world()} status={status} onRefresh={refresh} />);
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "failed"));
  expect(refresh).not.toHaveBeenCalled();
});

it("rechecks and repairs an installed pack when the exact face is unavailable", async () => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: true }];
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

it("waits for both the live editor and its first font probe before downloading", async () => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: false }];
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
  mocks.catalog.packs = [{ id: "old", families: ["Old Serif"], installed: false }];
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
    mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"], installed: false }];
    finish();
  });
  await waitFor(() => expect(screen.getByTestId("docx-font-acquisition")).toHaveAttribute("data-state", "available"));
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
});
