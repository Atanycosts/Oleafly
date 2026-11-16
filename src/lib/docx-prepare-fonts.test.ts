import { beforeEach, expect, it, vi } from "vitest";
import type { JournalWorld } from "@/lib/journal-workbench";

const mocks = vi.hoisted(() => ({
  exact: vi.fn(),
  load: vi.fn(),
  install: vi.fn(),
  catalog: {
    status: "ready" as "idle" | "loading" | "ready" | "error",
    packs: [] as { id: string; families?: string[] }[],
  },
}));

vi.mock("@/lib/docx-fonts", () => ({ hasExactDocxFont: mocks.exact }));
vi.mock("@/store/font-packs", () => ({
  useFontPacksStore: {
    getState: () => ({
      ...mocks.catalog,
      load: mocks.load,
      install: mocks.install,
    }),
  },
}));

import {
  ensureDocxFonts,
  requiredDocxFontFamilies,
  type DocxFontAcquisition,
} from "./docx-prepare-fonts";

function world(): JournalWorld {
  const scope = { article_type: "research", stage: "submission", language: "en" };
  const evidence = [{ source_id: "guide", locator: "p1", quote: "Use this font." }];
  return {
    journal_id: "journal",
    journal_name: "Journal",
    version_id: "world-1",
    version_ordinal: 1,
    created_at: "2026-11-15T00:00:00Z",
    scope,
    sources: [],
    coverage_gaps: [],
    limitations: [],
    rules: [
      {
        rule_id: "confirmed",
        property: "body_font_family",
        expected: "Exact Serif",
        scope: { ...scope, section_scope: "body" },
        unit: "font_family",
        basis_status: "confirmed",
        evidence,
        limitations: [],
        confirmation_method: "manual",
      },
      {
        rule_id: "candidate",
        property: "body_font_family",
        expected: "Candidate Sans",
        scope: { ...scope, section_scope: "body" },
        unit: "font_family",
        basis_status: "candidate",
        evidence,
        limitations: [],
        confirmation_method: "manual",
      },
      {
        rule_id: "space",
        property: "body_font_family",
        expected: "  EXACT SERIF  ",
        scope: { ...scope, section_scope: "title" },
        unit: "font_family",
        basis_status: "confirmed",
        evidence,
        limitations: [],
        confirmation_method: "manual",
      },
      {
        rule_id: "template",
        property: "body_font_family",
        expected: "Template Font",
        scope: { ...scope, section_scope: "body" },
        unit: "font_family",
        basis_status: "confirmed",
        evidence,
        limitations: [],
        confirmation_method: "manual",
      },
    ],
    template: {
      source_id: "template",
      normalized_source_id: "normalized",
      snapshot_source_id: "snapshot",
      source_sha256: "a".repeat(64),
      original_sha256: "b".repeat(64),
      provenance: null,
      font_requirements: [
        { family: "exact serif", roles: ["body"], scripts: ["latin"] },
        { family: "Template Font", roles: ["heading"], scripts: ["latin"] },
        { family: "CJK Font", roles: ["caption"], scripts: ["east_asian"] },
      ],
    },
  };
}

function oneFamily(family = "Exact Serif") {
  const target = world();
  target.rules = [target.rules[0]];
  target.rules[0].expected = family;
  target.template = null;
  return target;
}

function states() {
  const calls: { family: string; state: DocxFontAcquisition }[] = [];
  return {
    calls,
    onState: (family: string, state: DocxFontAcquisition) => calls.push({ family, state }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.status = "ready";
  mocks.catalog.packs = [];
  mocks.exact.mockResolvedValue(false);
  mocks.install.mockResolvedValue(true);
  mocks.load.mockImplementation(async () => {
    if (mocks.catalog.status !== "loading") return;
    mocks.catalog.status = "ready";
  });
});

it("collects only confirmed in-scope journal and template families in source order", () => {
  const target = world();
  target.rules.push(
    {
      ...target.rules[0],
      rule_id: "outside-language",
      expected: "Outside Language",
      scope: { ...target.rules[0].scope, language: "zh" },
    },
    {
      ...target.rules[0],
      rule_id: "outside-article-type",
      expected: "Outside Article",
      scope: { ...target.rules[0].scope, article_type: "review" },
    },
    {
      ...target.rules[0],
      rule_id: "outside-stage",
      expected: "Outside Stage",
      scope: { ...target.rules[0].scope, stage: "revision" },
    },
    {
      ...target.rules[0],
      rule_id: "wrong-unit",
      expected: "Wrong Unit",
      unit: "effective_format",
    },
  );

  expect(requiredDocxFontFamilies(target)).toEqual(["Exact Serif", "Template Font", "CJK Font"]);
  expect(requiredDocxFontFamilies(null)).toEqual([]);
});

it("reports an available exact face while loading catalog provenance without installing a pack", async () => {
  mocks.exact.mockResolvedValue(true);
  const observed = states();
  const result = await ensureDocxFonts(oneFamily(), { onState: observed.onState });

  expect(result).toEqual({ families: [{ family: "Exact Serif", state: "available" }] });
  expect(observed.calls).toEqual([
    { family: "Exact Serif", state: "checking" },
    { family: "Exact Serif", state: "available" },
  ]);
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.install).not.toHaveBeenCalled();
});

it("installs only an exact catalog family and requires an exact recheck afterward", async () => {
  mocks.catalog.packs = [
    { id: "wrong", families: ["Exact Serif Display"] },
    { id: "exact", families: ["exact serif"] },
  ];
  mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const attemptedPacks = new Set<string>();
  const observed = states();

  const result = await ensureDocxFonts(oneFamily(), { attemptedPacks, onState: observed.onState });

  expect(result).toEqual({
    families: [{ family: "Exact Serif", state: "available", packId: "exact" }],
  });
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.install).toHaveBeenCalledExactlyOnceWith("exact");
  expect(mocks.exact).toHaveBeenCalledTimes(2);
  expect(attemptedPacks).toEqual(new Set(["exact"]));
  expect(observed.calls.map(({ state }) => state)).toEqual([
    "checking",
    "downloading",
    "available",
  ]);
});

it("reports noSource when the catalog has only a different family", async () => {
  mocks.catalog.packs = [{ id: "similar", families: ["Exact Serif Display"] }];
  const result = await ensureDocxFonts(oneFamily());

  expect(result).toEqual({ families: [{ family: "Exact Serif", state: "noSource" }] });
  expect(mocks.install).not.toHaveBeenCalled();
});

it("does not redownload a pack already attempted by the caller", async () => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"] }];
  const attemptedPacks = new Set(["exact"]);

  const result = await ensureDocxFonts(oneFamily(), { attemptedPacks });

  expect(result).toEqual({
    families: [{ family: "Exact Serif", state: "stillMissing", packId: "exact" }],
  });
  expect(mocks.install).not.toHaveBeenCalled();
});

it.each([
  ["download failure", false, false, "failed"],
  ["post-install missing face", true, false, "stillMissing"],
  ["post-install exact face", true, true, "available"],
] as const)("reports %s honestly", async (_name, installed, rechecked, expected) => {
  mocks.catalog.packs = [{ id: "exact", families: ["Exact Serif"] }];
  mocks.install.mockResolvedValue(installed);
  if (installed) mocks.exact.mockResolvedValueOnce(false).mockResolvedValueOnce(rechecked);
  const result = await ensureDocxFonts(oneFamily());

  expect(result.families[0]).toEqual({
    family: "Exact Serif",
    state: expected,
    packId: "exact",
  });
  expect(mocks.exact).toHaveBeenCalledTimes(installed ? 2 : 1);
});

it("distinguishes a failed catalog load from a missing source", async () => {
  mocks.catalog.status = "loading";
  mocks.load.mockImplementationOnce(async () => {
    mocks.catalog.status = "error";
  });

  const result = await ensureDocxFonts(oneFamily());

  expect(result).toEqual({ families: [{ family: "Exact Serif", state: "failed" }] });
  expect(mocks.install).not.toHaveBeenCalled();
});

it("propagates exact-face probe failures", async () => {
  mocks.exact.mockRejectedValue(new Error("font probe failed"));

  await expect(ensureDocxFonts(oneFamily())).rejects.toThrow("font probe failed");
});

it("stops between asynchronous stages when its caller is no longer active", async () => {
  const isActive = vi.fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);

  const result = await ensureDocxFonts(oneFamily(), { isActive });

  expect(result).toEqual({ families: [] });
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.exact).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
});
