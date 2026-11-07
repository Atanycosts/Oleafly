import { strToU8, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { test, expect, reloadNativePage } from "../fixtures";
import { openRailTab } from "../helpers";

function manuscript(width: number, height: number, columns: number) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Journal integration manuscript</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/><w:cols w:num="${columns}"/></w:sectPr></w:body></w:document>`),
  }));
}

test("journal sources, manuscript evidence, revision and history use the real Workbench", async ({ tauriPage }) => {
  test.skip(!process.env.OLEAFLY_WORKBENCH_PYTHON, "Requires an installed Workbench Python environment.");
  test.setTimeout(180_000);
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
  await tauriPage.waitForFunction(`document.documentElement.lang === "en"`, 10_000);
  const fillText = async (selector: string, value: string) => {
    await expect(tauriPage.locator(selector)).toBeVisible();
    return tauriPage.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(value)});
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
  const journalId = `journal-${projectId}`;
  await openRailTab(tauriPage, "Journal checks");
  const panel = tauriPage.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled();
  await panel.getByText("Import DOCX", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input:not([type="file"])', "Retained manuscript");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "manuscript.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: manuscript(12240, 15840, 1),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);

  await expect(panel.getByText("Import journal sources", { exact: true })).toBeEnabled();
  await panel.getByText("Import journal sources", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input[id$="-name"]', "Test journal");
  await tauriPage.fill('[role="dialog"] input[id$="-journal"]', journalId);
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "guide.txt", mimeType: "text/plain", buffer: Buffer.from("All manuscript pages must use A4 paper.\nAll manuscript pages must have 25.4 mm margins on all sides.\nAll manuscript pages must use 2 columns."),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await expect(panel.getByText("Use this version", { exact: true })).toBeEnabled();
  await panel.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Version bound", { exact: true })).toBeVisible();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expect(panel.getByText("Violation 3", { exact: true })).toBeVisible();
  await panel.getByText("Page width", { exact: true }).click();
  await expect(tauriPage.getByText("All manuscript pages must use A4 paper.", { exact: true })).toBeVisible();
  await tauriPage.getByText("Read retained section", { exact: true }).click();
  await expect(tauriPage.getByText("Retained section data", { exact: true })).toBeVisible();
  await tauriPage.click('[role="dialog"] button:has(.lucide-x)');

  await panel.getByText("Update DOCX", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input:not([type="file"])', "Match A4 and two columns");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "revised.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: manuscript(11906, 16838, 2),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await expect(panel.getByText("The manuscript has changed.", { exact: false })).toBeVisible();
  await expect(panel.locator('[aria-label="Check results"] strong')).toHaveText("Historical · rerun needed");
  await expect(panel.getByText("Run check", { exact: true })).toBeDisabled();
  await expect(panel.getByText("Use this version", { exact: true })).toBeEnabled();
  await panel.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expect(panel.getByText("Compliant 7", { exact: true })).toBeVisible();
  const saved = await tauriPage.evaluate(`(async () => {
    const { getResearchWorkspace } = await import("/src/lib/research-workspace.ts");
    const { journalRequest } = await import("/src/lib/journal-workbench.ts");
    const workspace = await getResearchWorkspace(${JSON.stringify(projectId)});
    const history = await journalRequest("/api/history?project_id=" + workspace.journalProjectId);
    return { workspace, checks: history.checks.map(c => ({ id: c.check_id, baseline: c.baseline_id, validity: c.validity, summary: c.summary })), reads: history.reads.length };
  })()`);
  expect(saved.checks).toHaveLength(2);
  expect(saved.checks[0].summary.violation).toBe(3);
  expect(saved.checks[0].validity).toBe("STALE");
  expect(saved.checks[1].summary.compliant).toBe(7);
  expect(saved.checks[1].validity).toBe("CURRENT");
  expect(saved.reads).toBe(1);
  expect(saved.workspace.journalProjectId).toMatch(/^project-/);
  await reloadNativePage(tauriPage);
  await tauriPage.evaluate(`import("/src/store/files.ts").then(({ useFilesStore }) => useFilesStore.getState().openProject(${JSON.stringify(projectId)}))`);
  await openRailTab(tauriPage, "Journal checks");
  await expect(tauriPage.getByTestId("journal-checks-panel").getByText("Compliant 7", { exact: true })).toBeVisible();

  await panel.getByText("Page width", { exact: true }).click();
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
  await expect(panel.getByText("已保存新期刊版本。审阅后可选择“使用此版本”，再重新检查。", { exact: true })).toBeVisible();
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
  await expect(panel.getByText("Use this version", { exact: true })).toBeVisible();
  await expect(panel.getByText("Use this version", { exact: true })).toBeEnabled();
  await expect(panel.getByText("Run check", { exact: true })).toBeDisabled();
  await panel.getByText("Compare versions", { exact: true }).click();
  await expect(tauriPage.getByText("210.01 mm · Confirmed requirement → 215.9 mm · Confirmed requirement", { exact: true })).toBeVisible();
  await tauriPage.click('[role="dialog"] button:has(.lucide-x)');

  await panel.getByText("Import candidate JSON", { exact: true }).click();
  await fillText('[aria-label="Candidate rule component JSON"]', JSON.stringify({
    schema_version: "journal-rule-component-1.0.0", component_id: "source-review", component_version: "1.0.0",
    applicability: { journal_ids: [journalId], article_types: ["research_article"], stages: ["initial_submission"], languages: ["en"], basis: "Operator-supplied guidance for the example" },
    sources: [{ source_id: "type-guide", title: "Typography guide", locator: "line:1", quote: "Use 9.5-point body type throughout." }],
    rules: [{ property: "body_font_size_halfpoints", expected: 19, unit: "half_points", source_refs: ["type-guide"] }],
  }));
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await panel.getByText("Body font size", { exact: true }).click();
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
    const project = state.projects.find(p => p.project_id === ${JSON.stringify(saved.workspace.journalProjectId)});
    const versions = state.worlds.filter(w => w.journal_id === ${JSON.stringify(journalId)});
    const latest = await journalRequest("/api/world?version_id=" + versions.sort((a,b) => b.version_ordinal-a.version_ordinal)[0].version_id);
    return { binding: project.binding.world_version_id, current: project.latest_check,
      sources: latest.sources.length, rules: latest.rules.map(r => ({ property: r.property, expected: r.expected, basis: r.basis_status })) };
  })()`);
  expect(reviewed.binding).toBe(reviewed.current.world_version_id);
  expect(reviewed.current.validity).toBe("CURRENT");
  expect(reviewed.current.summary.compliant).toBe(7);
  expect(reviewed.current.dispositions[0].note).toBe("Keep the original finding; review the next guide version.");
  expect(reviewed.sources).toBe(2);
  expect(reviewed.rules.find(r => r.property === "page_width_twips").expected).toBe(12240);
  expect(reviewed.rules.find(r => r.property === "body_font_size_halfpoints")).toMatchObject({ expected: 19, basis: "confirmed" });
  await expect(panel.getByText("Use this version", { exact: true })).toBeEnabled();
  await panel.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expect(panel.getByText("Violation 1", { exact: true })).toBeVisible();
  await expect(panel.getByText("Cannot determine 1", { exact: true })).toBeVisible();
  for (const [locale, title] of [["zh-Hans", "研究期刊要求"], ["en", "Research journal requirements"]]) {
    await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference(${JSON.stringify(locale)}))`);
    await expect(panel.getByText(title, { exact: true })).toBeVisible();
    const layout = await tauriPage.evaluate(`(() => {
      const card = document.querySelector('[data-testid="journal-research-panel"]');
      const button = card.querySelector('button');
      const outer = card.getBoundingClientRect();
      const inner = button.getBoundingClientRect();
      return { contained: inner.left >= outer.left && inner.right <= outer.right, scroll: button.scrollWidth, width: button.clientWidth, wrapping: getComputedStyle(button).whiteSpace };
    })()`);
    expect(layout.contained).toBe(true);
    expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.wrapping).toBe("normal");
  }
});

test("live journal research returns cited candidates and adopts them into a manuscript check", async ({ tauriPage }) => {
  test.skip(process.env.OLEAFLY_JOURNAL_RESEARCH_LIVE !== "1", "Opt in to a real provider call.");
  test.setTimeout(2_400_000);
  await tauriPage.evaluate(`import("/src/store/settings.ts").then(({ useSettingsStore }) => useSettingsStore.getState().setUiLocalePreference("en"))`);
  await tauriPage.waitForFunction(`document.documentElement.lang === "en"`, 10_000);
  const manuscriptPath = process.env.OLEAFLY_JOURNAL_MANUSCRIPT;
  const guidePath = process.env.OLEAFLY_JOURNAL_GUIDE;
  if (!manuscriptPath || !guidePath) throw new Error("Select the retained manuscript and journal guide for the live run.");
  const fillText = async (selector: string, value: string) => {
    await expect(tauriPage.locator(selector)).toBeVisible();
    await tauriPage.evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  };
  const projectId = await tauriPage.evaluate<string>(`(async () => {
    const { createMarkdownProject } = await import("/src/lib/tauri.ts");
    const { useFilesStore } = await import("/src/store/files.ts");
    const id = await createMarkdownProject("期刊研究 · TDSC 与真实稿件");
    await useFilesStore.getState().openProject(id);
    return id;
  })()`);
  await openRailTab(tauriPage, "Journal checks");
  const panel = tauriPage.getByTestId("journal-checks-panel");
  await expect(panel.getByText("Import DOCX", { exact: true })).toBeEnabled();
  await panel.getByText("Import DOCX", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input:not([type="file"])', "Retained IJAM manuscript · TDSC comparison");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "manuscript.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: readFileSync(manuscriptPath),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await panel.getByText("Import journal sources", { exact: true }).click();
  await tauriPage.fill('[role="dialog"] input[id$="-name"]', "IEEE Transactions on Dependable and Secure Computing");
  await tauriPage.fill('[role="dialog"] input[id$="-journal"]', "tdsc-live-research");
  await tauriPage.setInputFiles('[role="dialog"] input[type="file"]', [{
    name: "tdsc-page-format-2026-10-14.txt", mimeType: "text/plain", buffer: readFileSync(guidePath),
  }]);
  await expect(tauriPage.locator('[role="dialog"] button[type="submit"]')).toBeEnabled();
  await tauriPage.click('[role="dialog"] button[type="submit"]');
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  await panel.getByText("Use this version", { exact: true }).click();
  await expect(panel.getByText("Run check", { exact: true })).toBeEnabled();
  await panel.getByText("Run check", { exact: true }).click();
  await expect(panel.locator('[aria-label="Check results"]')).toBeVisible();
  await panel.getByText("Research journal requirements", { exact: true }).click();
  await fillText('[role="dialog"] textarea[id$="-request"]',
    "Write the result in Chinese. Focus this task on the five numeric comparison values in the retained double-column page definition: width, height, columns, body type size and vertical spacing. Fetch the official Computer Society author-resources page and its linked IEEE article-template page to investigate the definition's applicability to initial submission. This is a format comparison, not full venue acceptance. Once those sources resolve the comparison's basis, deliver the cited candidates and manuscript actions. Do not expand into an audit of publication ethics or unrelated requirements. If the TDSC-specific JavaScript page is unreadable, use the readable publisher guidance for this comparison and state that exact remaining submission condition. Include only paths actually saved by web_fetch in source_paths.");
  await fillText('[role="dialog"] textarea[id$="-urls"]', "https://www.computer.org/publications/author-resources\nhttps://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/authoring-tools-and-templates/tools-for-ieee-authors/ieee-article-templates/");
  await expect(tauriPage.locator('[role="dialog"] select[aria-label="Research model"]')).toHaveValue('["xiaobai","gpt-6.1-sol"]');
  await tauriPage.press('[data-testid="ai-effort-selector"]', "Enter");
  await tauriPage.locator('[role="menuitemradio"]').filter({ hasText: process.env.OLEAFLY_JOURNAL_EFFORT ?? "Max" }).click();
  await expect(tauriPage.getByText("Start research", { exact: true })).toBeEnabled();
  await tauriPage.getByText("Start research", { exact: true }).click();
  await expect(tauriPage.locator('[role="dialog"]')).toHaveCount(0);
  const task = await tauriPage.evaluate(`(async () => {
    const { getResearchWorkspace } = await import("/src/lib/research-workspace.ts");
    return (await getResearchWorkspace(${JSON.stringify(projectId)})).journalResearch;
  })()`);
  expect(task.taskId).toBeTruthy();
  console.log("Live journal project:", projectId, "task:", task.taskId);
  await expect(panel.getByText("Review research result", { exact: true })).toBeVisible({ timeout: 2_000_000 });
  await panel.getByText("Review research result", { exact: true }).click();
  await expect(tauriPage.locator('[role="dialog"]')).toBeVisible();
  const result = await tauriPage.evaluate(`import("/src/lib/journal-workbench.ts").then(m => m.loadJournalResearchResult(${JSON.stringify(task.taskId)}))`);
  expect(result.summary.length).toBeGreaterThan(100);
  expect(result.sources.length).toBeGreaterThan(0);
  expect(result.component.rules.length).toBeGreaterThan(0);
  expect(result.component.sources.every((source: { quote: string; locator: string }) => source.quote && source.locator)).toBe(true);
  const confirmations = tauriPage.locator('[role="dialog"] button[role="checkbox"][id$="-confirm"]');
  const count = await confirmations.count();
  expect(count).toBe(result.component.rules.length);
  for (let index = 0; index < count; index += 1) await confirmations.nth(index).click();
  await fillText('[role="dialog"] textarea[aria-label="Reason and source context"]',
    "Operator confirms these as numeric comparison expectations for this TDSC format exercise after reviewing the cited definition and submission conditions. This does not establish universal initial-submission requirements or IJAM acceptance.");
  await expect(tauriPage.getByText("Adopt selected requirements", { exact: true })).toBeEnabled();
  await tauriPage.getByText("Adopt selected requirements", { exact: true }).click();
  await expect(panel.getByText("Research requirements adopted and manuscript checked.", { exact: true })).toBeVisible({ timeout: 30_000 });
  const saved = await tauriPage.evaluate(`(async () => {
    const { getResearchWorkspace } = await import("/src/lib/research-workspace.ts");
    const { journalRequest } = await import("/src/lib/journal-workbench.ts");
    const workspace = await getResearchWorkspace(${JSON.stringify(projectId)});
    const state = await journalRequest("/api/state");
    const project = state.projects.find(p => p.project_id === workspace.journalProjectId);
    const world = await journalRequest("/api/world?version_id=" + project.binding.world_version_id);
    const history = await journalRequest("/api/history?project_id=" + project.project_id);
    return { project: project.project_id, check: project.latest_check, worldSources: world.sources.length, rules: world.rules, checks: history.checks.length };
  })()`);
  expect(saved.check.validity).toBe("CURRENT");
  expect(saved.checks).toBe(2);
  expect(saved.worldSources).toBeGreaterThan(2);
  console.log("Adopted journal result:", JSON.stringify({ project: saved.project, check: saved.check.check_id, summary: saved.check.summary, sources: saved.worldSources }));
});
