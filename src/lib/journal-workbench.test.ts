import { expect, it } from "vitest";
import { formatJournalValue, journalInputValue, journalResearchPrompt, parseJournalInput, type JournalWorld } from "./journal-workbench";

it("preserves exact font names through journal display and editable candidate values", () => {
  for (const family of ["Times New Roman", "宋体"]) {
    expect(formatJournalValue(family, "font_family")).toBe(family);
    expect(journalInputValue(family, "font_family")).toBe(family);
    expect(parseJournalInput(` ${family} `, "font_family")).toBe(family);
  }
  expect(journalInputValue(1440, "twips")).toBe("25.4");
  expect(parseJournalInput("25.4", "twips")).toBe(1440);
  expect(parseJournalInput("9.5", "half_points")).toBe(19);
});

it("asks journal research to retain the required family and its applicability", () => {
  const world = { journal_name: "Example", journal_id: "example", scope: { language: "en", stage: "initial_submission", article_type: "research_article" } } as JournalWorld;
  const prompt = journalResearchPrompt(world, "en", "Find required fonts", "https://example.org/guide");
  expect(prompt).toContain("body_font_family uses unit font_family");
  expect(prompt).toContain("Do not replace it with a similar or metrically compatible family");
  expect(prompt).toContain("manuscript alone does not establish a journal requirement");
  expect(prompt).toContain("separate scripts, sections or alternative fonts");
});
