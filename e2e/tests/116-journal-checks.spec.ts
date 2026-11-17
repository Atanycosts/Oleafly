import type { TauriPage } from "@srsholmes/tauri-playwright";
import { strToU8, zipSync } from "fflate";
import { test, expect, reloadNativePage } from "../fixtures";
import { openRailTab } from "../helpers";
import { startMockAiServer } from "../mock-ai-server";
import { scriptValue } from "../script-value";
import type { JournalComponent, JournalWorld } from "../../src/lib/journal-workbench";

const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
const LETTER_WIDTH_TWIPS = 12240;

function manuscript(width: number, height: number, columns: number) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Journal integration manuscript</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/><w:cols w:num="${columns}"/></w:sectPr></w:body></w:document>`),
  }));
}

function component(
  journalId: string,
  rules: JournalComponent["rules"],
  sources: JournalComponent["sources"],
  componentId: string,
): JournalComponent {
  return {
    schema_version: "journal-rule-component-1.0.0",
    component_id: componentId,
    component_version: "1.0.0",
    applicability: {
      journal_ids: [journalId],
      article_types: ["research_article"],
      stages: ["initial_submission"],
      languages: ["en"],
      basis: "Explicit component for the captured guide evidence in this acceptance fixture.",
    },
    sources,
    rules,
  };
}

async function createConfirmedWorld(
  page: TauriPage,
  journalId: string,
  journalName: string,
  guide: string,
  rules: JournalComponent["rules"],
  sources: JournalComponent["sources"],
): Promise<JournalWorld> {
  const requirementComponent = component(journalId, rules, sources, "page-geometry");
  const decisions = rules.map((rule) => ({
    property: rule.property,
    expected: rule.expected,
    reason: "Operator confirmed the explicit component against the captured guide evidence.",
  }));
  return page.evaluate<JournalWorld>(`import("/src/lib/journal-workbench.ts").then(async (j) => {
    await j.connectJournalWorkbench();
    const base = await j.journalRequest("/api/worlds", {
      journal_id: ${scriptValue(journalId)},
      journal_name: ${scriptValue(journalName)},
      article_type: "research_article",
      stage: "initial_submission",
      language: "en",
      sources: [{
        name: "guide.txt",
        kind: "guide_text",
        content_base64: ${scriptValue(Buffer.from(guide).toString("base64"))},
      }],
    });
    return j.journalRequest("/api/world-component", {
      version_id: base.version_id,
      name: "requirements.json",
      content_base64: ${scriptValue(Buffer.from(JSON.stringify(requirementComponent)).toString("base64"))},
      decisions: ${scriptValue(decisions)},
    });
  })`);
}

async function addCandidateComponent(
  page: TauriPage,
  worldVersionId: string,
  document: JournalComponent,
): Promise<JournalWorld> {
  return page.evaluate<JournalWorld>(`import("/src/lib/journal-workbench.ts").then((j) =>
    j.journalRequest("/api/world-component", {
      version_id: ${scriptValue(worldVersionId)},
      name: "typography.json",
      content_base64: ${scriptValue(Buffer.from(JSON.stringify(document)).toString("base64"))},
    })
  )`);
}

async function refreshAndSelectWorld(
  page: TauriPage,
  versionId: string,
) {
  const panel = page.getByTestId("journal-checks-panel");
  await panel.locator('button[aria-label="Refresh journal checks"]').click();
  await expect.poll(() => page.evaluate<string[]>(`Array.from(
    document.querySelector('[data-testid="journal-world-select"]')?.options ?? []
  ).map((option) => option.value)`)).toContain(versionId);
  await page.selectOption('[data-testid="journal-world-select"]', versionId);
  await expect(page.getByTestId("journal-world-select")).toHaveValue(versionId);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
}

async function expectVerdictCount(
  page: TauriPage,
  verdict: string,
  count: number,
) {
  await expect.poll(() => page.evaluate<string | null>(`(() => {
    const cards = Array.from(document.querySelectorAll('[aria-label="Check results"] div.grid > div'));
    const card = cards.find((item) => item.children[0]?.textContent === ${scriptValue(verdict)});
    return card?.children[1]?.textContent ?? null;
  })()`)).toBe(String(count));
}

test("journal sources, manuscript evidence, revision and history use the real Workbench", async ({ tauriPage }) => {
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires an installed Workbench Python environment.");
  test.setTimeout(240_000);
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
  await tauriPage.waitForFunction(`document.documentElement.lang === "en"`, 10_000);
  const fillText = async (selector: string, value: string) => {
    await expect(tauriPage.locator(selector)).toBeVisible();
    return tauriPage.evaluate(`(() => {
      const field = document.querySelector(${scriptValue(selector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${scriptValue(value)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  };
  const projectId = await tauriPage.evaluate<string>(`(async () => {
    const { createMarkdownProject } = await import("/src/lib/tauri.ts");
    const { useFilesStore } = await import("/src/store/files.ts");
    const id = await createMarkdownProject("Journal checks " + Date.now());
    await useFilesStore.getState().openProject(id);
    return id;
  })()`);
  await openRailTab(tauriPage, "Journal checks");
  const panel = tauriPage.getByTestId("journal-checks-panel");
  const workspace = tauriPage.getByTestId("journal-workspace");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled();
  await panel.getByText("Import DOCX", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input:not([type="file"])', "Retained manuscript");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "manuscript.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: manuscript(LETTER_WIDTH_TWIPS, 15840, 1),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");

  const journalId = `journal-fixture-${Date.now()}`;
  const guide = [
    "All manuscript pages must use A4 paper.",
    "All manuscript pages must have 25.4 mm margins on all sides.",
    "All manuscript pages must use 2 columns.",
  ].join("\n");
  const geometrySources: JournalComponent["sources"] = [
    {
      source_id: "page-size",
      title: "Page-size guidance",
      locator: "line:1",
      quote: "All manuscript pages must use A4 paper.",
    },
    {
      source_id: "margins",
      title: "Margin guidance",
      locator: "line:2",
      quote: "All manuscript pages must have 25.4 mm margins on all sides.",
    },
    {
      source_id: "columns",
      title: "Column guidance",
      locator: "line:3",
      quote: "All manuscript pages must use 2 columns.",
    },
  ];
  const geometryRules: JournalComponent["rules"] = [
    { property: "page_width_twips", expected: A4_WIDTH_TWIPS, unit: "twips", source_refs: ["page-size"] },
    { property: "page_height_twips", expected: A4_HEIGHT_TWIPS, unit: "twips", source_refs: ["page-size"] },
    { property: "top_margin_twips", expected: 1440, unit: "twips", source_refs: ["margins"] },
    { property: "right_margin_twips", expected: 1440, unit: "twips", source_refs: ["margins"] },
    { property: "bottom_margin_twips", expected: 1440, unit: "twips", source_refs: ["margins"] },
    { property: "left_margin_twips", expected: 1440, unit: "twips", source_refs: ["margins"] },
    { property: "columns", expected: 2, unit: "count", source_refs: ["columns"] },
  ];
  const initialWorld = await createConfirmedWorld(
    tauriPage,
    journalId,
    "Test journal",
    guide,
    geometryRules,
    geometrySources,
  );
  await refreshAndSelectWorld(tauriPage, initialWorld.version_id);
  await expect(workspace.getByText("Use this version", { exact: true })).toBeEnabled();
  await workspace.getByText("Use this version", { exact: true }).click();
  await expect(workspace.getByText("Version bound", { exact: true })).toBeVisible();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  const results = workspace.locator('[aria-label="Check results"]');
  await expect(results).toBeVisible();
  await expectVerdictCount(tauriPage, "Violation", 3);
  await workspace.getByText("Page width", { exact: true }).click();
  const ruleDialog = tauriPage.locator('[role="dialog"]');
  await expect(ruleDialog.getByText("All manuscript pages must use A4 paper.", { exact: true })).toBeVisible();
  await ruleDialog.getByText("Read retained section", { exact: true }).click();
  await expect(ruleDialog.getByText("Retained section data", { exact: true })).toBeVisible();
  await tauriPage.press('[role="dialog"]', "Escape");

  await panel.getByText("Update DOCX", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input:not([type="file"])', "Match A4 and two columns");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "revised.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: manuscript(A4_WIDTH_TWIPS, A4_HEIGHT_TWIPS, 2),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
  await expect(workspace.getByText("The manuscript has changed.", { exact: false })).toBeVisible();
  await expect(results.getByText("Historical · rerun needed", { exact: true })).toBeVisible();
  await expect(panel.getByText("Run check", { exact: true })).toBeDisabled();
  await expect(workspace.getByText("Use this version", { exact: true })).toBeEnabled();
  await workspace.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expectVerdictCount(tauriPage, "Compliant", 7);
  const saved = await tauriPage.evaluate(`(async () => {
    const { getResearchWorkspace } = await import("/src/lib/research-workspace.ts");
    const { journalRequest } = await import("/src/lib/journal-workbench.ts");
    const workspace = await getResearchWorkspace(${scriptValue(projectId)});
    const history = await journalRequest("/api/history?project_id=" + workspace.journalProjectId);
    return {
      workspace,
      checks: history.checks.map(c => ({
        id: c.check_id,
        baseline: c.baseline_id,
        validity: c.validity,
        summary: c.summary,
      })),
      reads: history.reads.length,
    };
  })()`);
  expect(saved.checks).toHaveLength(2);
  expect(saved.checks[0].summary.violation).toBe(3);
  expect(saved.checks[0].validity).toBe("STALE");
  expect(saved.checks[1].summary.compliant).toBe(7);
  expect(saved.checks[1].validity).toBe("CURRENT");
  expect(saved.reads).toBe(1);
  expect(saved.workspace.journalProjectId).toMatch(/^project-/);
  await reloadNativePage(tauriPage);
  await tauriPage.evaluate(`import("/src/store/files.ts").then(({ useFilesStore }) => useFilesStore.getState().openProject(${scriptValue(projectId)}))`);
  await openRailTab(tauriPage, "Journal checks");
  await expect(tauriPage.getByTestId("journal-workspace").locator('[aria-label="Check results"]')).toContainText("Compliant");

  await workspace.getByText("Page width", { exact: true }).click();
  await fillText('[aria-label="Handling note"]', "Keep the original finding; review the next guide version.");
  await expect(tauriPage.getByText("Save handling note", { exact: true })).toBeEnabled();
  await tauriPage.getByText("Save handling note", { exact: true }).click();
  await expect(tauriPage.getByText("Keep the original finding; review the next guide version.", { exact: true })).toBeVisible();
  await tauriPage.getByText("Confirm or revise this requirement", { exact: true }).click();
  await tauriPage.getByLabel("Expected (mm)", { exact: true }).fill("215.9");
  await fillText('[role="dialog"] textarea[id$="-reason"]', "Operator chooses Letter width after reviewing the guide.");
  await expect(tauriPage.getByText("Save requirement version", { exact: true })).toBeEnabled();
  await tauriPage.getByText("Save requirement version", { exact: true }).click();
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("zh-Hans"))`);
  await expect(workspace.getByText("已保存新期刊版本。审阅后可选择“使用此版本”，再重新检查。", { exact: true })).toBeVisible();
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
  await expect(workspace.getByText("Use this version", { exact: true })).toBeEnabled();
  await expect(panel.getByText("Run check", { exact: true })).toBeDisabled();
  await workspace.getByText("Compare versions", { exact: true }).click();
  await expect(tauriPage.getByText("210.01 mm · Confirmed requirement → 215.9 mm · Confirmed requirement", { exact: true })).toBeVisible();
  await tauriPage.press('[role="dialog"]', "Escape");

  const revisedVersionId = await tauriPage.evaluate<string>(`import("/src/lib/journal-workbench.ts").then(async (j) => {
    const state = await j.journalRequest("/api/state");
    return state.worlds
      .filter((world) => world.journal_id === ${scriptValue(journalId)})
      .sort((a, b) => b.version_ordinal - a.version_ordinal)[0].version_id;
  })`);
  const typography = component(
    journalId,
    [{ property: "body_font_size_halfpoints", expected: 19, unit: "half_points", source_refs: ["type-guide"] }],
    [{
      source_id: "type-guide",
      title: "Typography guide",
      locator: "line:1",
      quote: "Use 9.5-point body type throughout.",
    }],
    "typography",
  );
  const candidateWorld = await addCandidateComponent(tauriPage, revisedVersionId, typography);
  await refreshAndSelectWorld(tauriPage, candidateWorld.version_id);
  await workspace.getByText("Body font size", { exact: true }).click();
  await expect(tauriPage.getByText("Candidate observation · 9.5 pt · Not checked", { exact: true })).toBeVisible();
  await tauriPage.getByText("Confirm or revise this requirement", { exact: true }).click();
  await expect(tauriPage.getByLabel("Expected (pt)", { exact: true })).toHaveValue("9.5");
  await fillText('[role="dialog"] textarea[id$="-reason"]', "Confirmed against supplied typography guide.");
  await expect(tauriPage.getByText("Save requirement version", { exact: true })).toBeEnabled();
  await tauriPage.getByText("Save requirement version", { exact: true }).click();
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  const reviewed = await tauriPage.evaluate(`(async () => {
    const { journalRequest } = await import("/src/lib/journal-workbench.ts");
    const state = await journalRequest("/api/state");
    const project = state.projects.find(p => p.project_id === ${scriptValue(saved.workspace.journalProjectId)});
    const versions = state.worlds.filter(w => w.journal_id === ${scriptValue(journalId)});
    const latest = await journalRequest("/api/world?version_id=" + versions.sort((a, b) => b.version_ordinal - a.version_ordinal)[0].version_id);
    return {
      binding: project.binding.world_version_id,
      current: project.latest_check,
      sources: latest.sources.length,
      rules: latest.rules.map(r => ({
        property: r.property,
        expected: r.expected,
        basis: r.basis_status,
      })),
    };
  })()`);
  expect(reviewed.binding).toBe(reviewed.current.world_version_id);
  expect(reviewed.current.validity).toBe("CURRENT");
  expect(reviewed.current.summary.compliant).toBe(7);
  expect(reviewed.current.dispositions[0].note).toBe("Keep the original finding; review the next guide version.");
  expect(reviewed.sources).toBe(3);
  expect(reviewed.rules.find((rule: { property: string }) => rule.property === "page_width_twips").expected).toBe(LETTER_WIDTH_TWIPS);
  expect(reviewed.rules.find((rule: { property: string }) => rule.property === "body_font_size_halfpoints")).toMatchObject({
    expected: 19,
    basis: "confirmed",
  });
  await expect(workspace.getByText("Use this version", { exact: true })).toBeEnabled();
  await workspace.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expectVerdictCount(tauriPage, "Violation", 1);
  await expectVerdictCount(tauriPage, "Cannot determine", 1);
});

test("analyze with agent prepares a bounded review from the current journal check", async ({ tauriPage }) => {
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires an installed Workbench Python environment.");
  test.setTimeout(120_000);
  const server = await startMockAiServer();
  try {
    await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
    await tauriPage.waitForFunction(`document.documentElement.lang === "en"`, 10_000);
    const projectId = await tauriPage.evaluate<string>(`(async () => {
      const { createMarkdownProject } = await import("/src/lib/tauri.ts");
      const { useFilesStore } = await import("/src/store/files.ts");
      const id = await createMarkdownProject("Journal agent " + Date.now());
      await useFilesStore.getState().openProject(id);
      return id;
    })()`);
    expect(await tauriPage.evaluate(`window.__aiConnect?.("ollama", ${scriptValue(server.url)}, "llama3.2") ?? false`)).toBe(true);
    const journalId = `journal-agent-${Date.now()}`;
    const journalName = "Journal checks agent";
    const quote = "All manuscript pages must use A4 paper.";
    const world = await createConfirmedWorld(
      tauriPage,
      journalId,
      journalName,
      quote,
      [
        { property: "page_width_twips", expected: A4_WIDTH_TWIPS, unit: "twips", source_refs: ["a4"] },
        { property: "page_height_twips", expected: A4_HEIGHT_TWIPS, unit: "twips", source_refs: ["a4"] },
      ],
      [{ source_id: "a4", title: "Page-size guidance", locator: "line:1", quote }],
    );
    await tauriPage.evaluate(`import("/src/lib/journal-workbench.ts").then(async (j) => {
      const manuscript = await j.journalRequest("/api/projects", {
        name: "Agent review manuscript",
        filename: "manuscript.docx",
        content_base64: ${scriptValue(manuscript(LETTER_WIDTH_TWIPS, 15840, 1).toString("base64"))},
      });
      await j.linkJournalProject(${scriptValue(projectId)}, manuscript.project_id);
      await j.journalRequest("/api/bind", {
        project_id: manuscript.project_id,
        world_version_id: ${scriptValue(world.version_id)},
        expected_binding_id: null,
      });
      await j.journalRequest("/api/check", { project_id: manuscript.project_id });
    })`);
    await openRailTab(tauriPage, "Journal checks");
    const workspace = tauriPage.getByTestId("journal-workspace");
    await expect(workspace.locator('[aria-label="Check results"]')).toBeVisible();
    await expect(workspace.getByText("Analyze with agent", { exact: true })).toBeEnabled();
    await workspace.getByText("Analyze with agent", { exact: true }).click();
    await expect.poll(() => tauriPage.evaluate<string>(
      `document.querySelector('textarea[placeholder*="Ask AI"]')?.value ?? ""`,
    )).toContain(journalName);
    const handoff = await tauriPage.evaluate<string>(
      `document.querySelector('textarea[placeholder*="Ask AI"]')?.value ?? ""`,
    );
    expect(handoff).toContain("Read the saved check and its sources through the journal tools.");
    expect(server.requestCount()).toBe(0);
  } finally {
    await server.close();
  }
});
