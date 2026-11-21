// @vitest-environment jsdom
import { mountPaginatedSurface, type DocxEditorInstance } from "@docx-editor.dev/core/editor";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bibliographyParts, bibliographySources, readDocxFieldAction, WORD_BIBLIOGRAPHY } from "./docx-citation-fields";
import { filterDocxCitationSources, listDocxCitationSources } from "./docx-citation-write";
import { createDocxSession } from "./docx-session";

const pickerMocks = vi.hoisted(() => ({
  search: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/docx-citation-search", () => ({
  searchDocxCitationArticles: pickerMocks.search,
}));

import { DocxCitationPicker } from "@/components/research/DocxCitationPicker";

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRel = "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
const customXml = "http://schemas.openxmlformats.org/officeDocument/2006/customXml";
const relationships = (entries: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
const otherField = '<w:fldSimple w:instr=" ADDIN ZOTERO_ITEM CSL_CITATION {} "><w:r><w:t>[4]</w:t></w:r></w:fldSimple>';
const original = `<w:p><w:r><w:t>AB</w:t></w:r>${otherField}</w:p>`;
const article = {
  title: "A & B < C",
  authors: [{ family: "Li", given: "Ming" }, { family: "Rao" }],
  journal: "Methods Quarterly",
  year: "2024",
  url: "https://doi.org/10.1234/article",
};

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

function open(bytes: Uint8Array) {
  const container = document.createElement("div");
  document.body.append(container);
  const opened = mountPaginatedSurface(container, bytes, {
    editingMode: "edit",
    measurer: { measure: (text) => text.length * 6, lineMetrics: () => ({ height: 14, baseline: 11 }) },
  });
  if (!opened.ok) throw new Error(opened.reason);
  const { surface } = opened;
  const session = createDocxSession({ surface, on: () => () => {} } as unknown as DocxEditorInstance);
  disposals.push(() => { session.dispose(); surface.destroy(); container.remove(); });
  const paragraph = () => session.readParagraph(session.listParagraphHandles()[0]);
  return { tree: surface.session, surface, session, paragraph, save: () => surface.save() };
}

function fixture(
  body = original,
  sources: readonly string[] = [],
  settings?: string,
) {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8(relationships(`<Relationship Id="doc" Type="${rel}/officeDocument" Target="word/document.xml"/>`)),
    "word/document.xml": strToU8(`<w:document xmlns:w="${word}"><w:body>${body}<w:sectPr/></w:body></w:document>`),
  };
  const sourceRels = sources.map((xml, index) => {
      const filename = `sources${index}.xml`;
      parts[`customXml/${filename}`] = strToU8(xml);
      return `<Relationship Id="rId${index + 1}" Type="${rel}/customXml" Target="../customXml/${filename}"/>`;
  }).join("");
  const settingsRel = settings ? `<Relationship Id="settings" Type="${rel}/settings" Target="settings.xml"/>` : "";
  if (settings) {
    parts["word/settings.xml"] = strToU8(`<w:settings xmlns:w="${word}">${settings}</w:settings>`);
  }
  if (sourceRels || settingsRel) parts["word/_rels/document.xml.rels"] = strToU8(relationships(sourceRels + settingsRel));
  return open(zipSync(parts));
}

const sourcesXml = (entries: string) => `<b:Sources xmlns:b="${WORD_BIBLIOGRAPHY}" StyleName="APA">${entries}</b:Sources>`;
const existing = '<b:Source><b:Tag>Existing</b:Tag><b:Title>Existing paper</b:Title></b:Source>';
const source = (
  tag: string,
  title: string,
  fields: { readonly doi?: string; readonly url?: string; readonly extra?: string } = {},
) => `<b:Source><b:Tag>${tag}</b:Tag>${title ? `<b:Title>${title}</b:Title>` : ""}${
  fields.doi ? `<b:DOI>${fields.doi}</b:DOI>` : ""}${fields.url ? `<b:URL>${fields.url}</b:URL>` : ""}${
  fields.extra ?? ""}</b:Source>`;

function insert(document: ReturnType<typeof open>, offset: number, revision = document.session.revision(), metadata = article) {
  return document.session.insertCitation?.({ paragraphRef: document.paragraph().paragraphRef, expectedRevision: revision,
    modelOffset: offset, source: { article: metadata } });
}

describe("DOCX citation source lookup", () => {
  const lookupSources = () => listDocxCitationSources(fixture(original, [sourcesXml(
    source("Field", "Field paper", { doi: "doi: 10.1234/FIELD" }) +
    source("Url", "URL paper", { url: "https://doi.org/10.1234/URL" }) +
    source("Same", "Same paper", {
      doi: "10.1234/same",
      url: "https://doi.org/10.1234/SAME",
    }) +
    source("Conflict", "Conflicting paper", {
      doi: "10.1234/field",
      url: "https://doi.org/10.1234/other",
    }) +
    source("Duplicate", "First duplicate") +
    source("Duplicate", "Second duplicate"),
  )]).tree.currentPackage());

  it("lists one confirmed DOI per unique tag and ignores conflicting declarations", () => {
    expect(lookupSources()).toEqual([
      { tag: "Field", title: "Field paper", doi: "10.1234/field" },
      { tag: "Url", title: "URL paper", doi: "10.1234/url" },
      { tag: "Same", title: "Same paper", doi: "10.1234/same" },
      { tag: "Conflict", title: "Conflicting paper" },
    ]);
  });

  it.each([
    ["a bare DOI", "10.1234/field"],
    ["a doi: prefix", "doi: 10.1234/FIELD"],
    ["a DOI link", "https://doi.org/10.1234/FIELD"],
    ["a resolver link without a scheme", "doi.org/10.1234/FIELD"],
  ])("matches %s by normalized DOI only", (_name, query) => {
    const sources = lookupSources();
    expect(filterDocxCitationSources(sources, query).map(({ tag }) => tag)).toEqual(["Field"]);
    expect(filterDocxCitationSources(sources, `${query}-different`)).toEqual([]);
    expect(filterDocxCitationSources(sources, "URL PAPER").map(({ tag }) => tag)).toEqual(["Url"]);
    expect(filterDocxCitationSources(sources, "Conflicting paper").map(({ tag }) => tag))
      .toEqual(["Conflict"]);
  });

  it("keeps multiple unique tags with the same confirmed DOI for manual selection", () => {
    const document = fixture(original, [sourcesXml(
      source("First", "Shared result", { doi: "10.1234/shared" }) +
      source("Second", "Shared result", { url: "https://doi.org/10.1234/SHARED" }),
    )]);
    const sources = listDocxCitationSources(document.tree.currentPackage());
    expect(filterDocxCitationSources(sources, "https://doi.org/10.1234/shared").map(({ tag }) => tag))
      .toEqual(["First", "Second"]);
  });
});

describe("DOCX citation picker local DOI lookup", () => {
  const pkg = () => fixture(original, [sourcesXml(
    source("Alpha", "Alpha study", { doi: "10.1234/alpha" }) +
    source("SharedA", "Shared study", { doi: "10.1234/shared" }) +
    source("SharedB", "Shared study", { doi: "10.1234/shared" }) +
    source("Conflict", "Conflict study", { doi: "10.1234/conflict", url: "https://doi.org/10.1234/other" }),
  )]).tree.currentPackage();

  const renderPicker = (onClose = vi.fn()) => render(createElement(DocxCitationPicker, {
    pkg: pkg(), insert: pickerMocks.insert, onClose,
  }));

  beforeEach(() => {
    pickerMocks.search.mockReset();
    pickerMocks.insert.mockReset();
  });

  it("keeps title search and does not search or select automatically for a DOI", async () => {
    renderPicker();
    const search = screen.getByRole("searchbox");
    await userEvent.clear(search);
    await userEvent.type(search, "alpha");
    expect(screen.getByRole("button", { name: "Alpha study" })).toBeVisible();

    await userEvent.clear(search);
    await userEvent.type(search, "https://doi.org/10.1234/SHARED");
    expect(screen.getByRole("button", { name: "Shared study (SharedA)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Shared study (SharedB)" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Insert citation$/u })).toBeDisabled();
    expect(pickerMocks.search).not.toHaveBeenCalled();
  });

  it("lets the keyboard choose a local DOI result", async () => {
    const user = userEvent.setup();
    renderPicker();
    const search = screen.getByRole("searchbox");
    await user.type(search, "10.1234/SHARED");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    const first = screen.getByRole("button", { name: "Shared study (SharedA)" });
    expect(first).toHaveFocus();
    expect(first).toHaveAccessibleDescription("10.1234/shared");
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Insert citation" })).toHaveAccessibleDescription("Reuse: Shared study");
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(pickerMocks.insert).toHaveBeenCalledWith({ existingTag: "SharedA" });
  });

  it("does not offer confirmation when a hidden conflicting record matches a Crossref DOI", async () => {
    pickerMocks.search.mockResolvedValue([{ ...article, url: "https://doi.org/10.1234/other" }]);
    renderPicker();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "10.1234/other");
    await user.click(screen.getByRole("button", { name: "Search Crossref" }));
    await user.click(await screen.findByRole("button", { name: article.title }));
    expect(screen.getByRole("alert")).toHaveTextContent("The draft has conflicting source records or DOI details.");
    expect(screen.getByRole("button", { name: "Insert citation" })).toBeDisabled();
    expect(pickerMocks.insert).not.toHaveBeenCalled();
  });
});

describe("DOCX native citation transaction", () => {
  it.each(["BIBLIOGRAPHY", "ADDIN ENDNOTE PLACEHOLDER"])("does not insert into the middle paragraph of a %s field", (instruction) => {
    const document = fixture(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${instruction}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>First result</w:t></w:r></w:p>` +
      '<w:p><w:r><w:t>Middle result</w:t></w:r></w:p><w:p><w:r><w:t>Last result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
      '<w:p><w:r><w:t>Ordinary body</w:t></w:r></w:p>');
    const [first, middle, last, body] = document.session.listParagraphHandles();
    const before = document.tree.currentPackage();
    const revision = document.session.revision();
    const insertIn = (target: typeof middle) => document.session.insertCitation?.({
      paragraphRef: target.ref, expectedRevision: revision, modelOffset: 3, source: { article },
    });
    for (const target of [first, middle, last]) {
      expect(insertIn(target)).toMatchObject({ ok: false, code: "unsupported-target", changed: false, revision });
    }
    expect(document.tree.currentPackage()).toBe(before);
    expect(insertIn(body)).toMatchObject({ ok: true, changed: true });
    const xml = strFromU8(unzipSync(document.save())["word/document.xml"]);
    expect(xml).toContain("Middle result</w:t>");
    expect(xml.indexOf(`>${instruction}</w:instrText>`)).toBeLessThan(xml.indexOf("Middle result</w:t>"));
    expect(xml.lastIndexOf('w:fldCharType="end"')).toBeLessThan(xml.indexOf("CITATION Oleafly"));
  });

  it("inserts a cached native field and its source, with one undo/redo and save/reopen", () => {
    const document = fixture();
    const preserved = document.paragraph().atoms[0];
    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
    const inserted = document.paragraph();
    expect(inserted.displayText).toBe("A⟦A & B < C⟧B[4]");
    expect(inserted.atoms).toHaveLength(2);
    expect(inserted.atoms[1].payload).toEqual(preserved.payload);
    expect(inserted.atoms[0].payload).toMatchObject({ code: expect.stringMatching(/CITATION Oleafly[\da-f]{32}/u) });
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(1);

    document.surface.undo();
    expect(document.paragraph().displayText).toBe("AB[4]");
    expect(bibliographyParts(document.tree.currentPackage())).toHaveLength(0);
    document.surface.redo();
    expect(document.paragraph().displayText).toBe(inserted.displayText);

    const reopened = open(document.save());
    const after = reopened.paragraph();
    expect(after.atoms[1].payload).toEqual(preserved.payload);
    expect(readDocxFieldAction(after, after.atoms[0].modelRange, () => reopened.tree.currentPackage())?.action)
      .toEqual({ kind: "citation", sources: [{ title: article.title, url: article.url }] });
  });

  it("saves one related bibliography store for two citations and removes it when both are undone", () => {
    const document = fixture();
    const originalParts = unzipSync(document.save());
    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
    expect(insert(document, 2)).toMatchObject({ ok: true, changed: true });
    const files = unzipSync(document.save());
    const parse = (name: string) => new DOMParser().parseFromString(strFromU8(files[name]), "application/xml");
    const targets = (name: string, type: string) => Array.from(parse(name).getElementsByTagNameNS(packageRel, "Relationship"))
      .filter((relationship) => relationship.getAttribute("Type") === `${rel}/${type}`)
      .map((relationship) => relationship.getAttribute("Target"));

    expect(targets("word/_rels/document.xml.rels", "customXml")).toEqual(["../customXml/item1.xml"]);
    expect(targets("customXml/_rels/item1.xml.rels", "customXmlProps")).toEqual(["itemProps1.xml"]);
    const props = parse("customXml/itemProps1.xml");
    expect(props.documentElement.getAttributeNS(customXml, "itemID")).toMatch(/^\{[\da-f-]{36}\}$/iu);
    expect(props.getElementsByTagNameNS(customXml, "schemaRef")[0].getAttributeNS(customXml, "uri")).toBe(WORD_BIBLIOGRAPHY);
    const overrides = Array.from(parse("[Content_Types].xml").getElementsByTagNameNS(contentTypes, "Override"));
    expect(overrides.find((element) => element.getAttribute("PartName") === "/customXml/itemProps1.xml")?.getAttribute("ContentType"))
      .toBe("application/vnd.openxmlformats-officedocument.customXmlProperties+xml");
    const bibliography = parse("customXml/item1.xml");
    expect(bibliography.getElementsByTagNameNS(WORD_BIBLIOGRAPHY, "Source")).toHaveLength(1);
    const tag = bibliography.getElementsByTagNameNS(WORD_BIBLIOGRAPHY, "Tag")[0].textContent;
    const fields = Array.from(parse("word/document.xml").getElementsByTagNameNS(word, "fldSimple"));
    expect(fields.map((field) => field.getAttributeNS(word, "instr")?.trim())).toEqual([
      `CITATION ${tag}`, `CITATION ${tag}`, "ADDIN ZOTERO_ITEM CSL_CITATION {}",
    ]);

    document.surface.undo();
    expect(document.paragraph().atoms).toHaveLength(2);
    expect(unzipSync(document.save())["customXml/item1.xml"]).toEqual(files["customXml/item1.xml"]);
    document.surface.undo();
    expect(document.paragraph().displayText).toBe("AB[4]");
    expect(Object.keys(unzipSync(document.save())).sort()).toEqual(Object.keys(originalParts).sort());
  });

  it("saves a 255-character title without shortening or counting XML escapes as text", () => {
    const title = `${"A&".repeat(127)}B`;
    const document = fixture();
    expect(insert(document, 1, document.session.revision(), { ...article, title })).toMatchObject({ ok: true, changed: true });
    const reopened = open(document.save());
    const paragraph = reopened.paragraph();
    expect(readDocxFieldAction(paragraph, paragraph.atoms[0].modelRange, () => reopened.tree.currentPackage())?.action)
      .toEqual({ kind: "citation", sources: [{ title, url: article.url }] });
  });

  it.each([
    ["the title is longer than 255 characters", { title: "T".repeat(256) }],
    ["an author name is longer than 255 characters", { authors: [{ family: "N".repeat(256), given: "Ming" }] }],
    ["the DOI URL is longer than 255 characters", { url: `https://doi.org/10.1234/${"x".repeat(255)}` }],
    ["the journal name contains an XML-invalid character", { journal: "Methods\u0000Quarterly" }],
  ])("does not write a new source when %s", (_name, metadata) => {
    const document = fixture();
    const before = document.tree.currentPackage();
    const revision = document.session.revision();
    expect(insert(document, 1, revision, { ...article, ...metadata })).toMatchObject({
      ok: false, code: "unsupported-citation-metadata", changed: false, revision,
    });
    expect(document.tree.currentPackage()).toBe(before);
    expect(document.paragraph().displayText).toBe("AB[4]");
  });

  it("appends without replacing the bibliography or unrelated custom XML", () => {
    const foreign = '<preserved xmlns="urn:example">third-party</preserved>';
    const document = fixture(original, [sourcesXml(existing), foreign]);
    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
    const files = unzipSync(document.save());
    expect(strFromU8(files["customXml/sources0.xml"])).toContain('StyleName="APA"');
    expect(strFromU8(files["customXml/sources0.xml"])).toContain(existing);
    expect(strFromU8(files["customXml/sources1.xml"])).toBe(foreign);
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(2);
  });

  it("reuses a uniquely identified source without changing the bibliography", () => {
    const wordField = '<w:fldSimple w:instr=" CITATION Existing "><w:r><w:t>[1]</w:t></w:r></w:fldSimple>';
    const document = fixture(`<w:p>${wordField}<w:r><w:t>AB</w:t></w:r></w:p>`, [sourcesXml(existing)]);
    const before = unzipSync(document.save())["customXml/sources0.xml"];
    expect(document.session.insertCitation?.({
      paragraphRef: document.paragraph().paragraphRef, expectedRevision: document.session.revision(),
      modelOffset: 2, source: { existingTag: "Existing" },
    })).toMatchObject({ ok: true, changed: true });
    const paragraph = document.paragraph();
    expect(paragraph.displayText).toBe("[1]A⟦Existing paper⟧B");
    expect(readDocxFieldAction(paragraph, paragraph.atoms[1].modelRange, () => document.tree.currentPackage())?.action)
      .toEqual({ kind: "citation", sources: [{ title: "Existing paper", url: null }] });
    expect(unzipSync(document.save())["customXml/sources0.xml"]).toEqual(before);
  });

  it.each([
    { tag: "\u674e\u738b2024", pick: "document" },
    { tag: "Mu\u0308ller2024", pick: "crossref" },
  ])("reuses the exact localized Word tag $tag from $pick", ({ tag, pick }) => {
    const title = "Existing DOI paper";
    const wordField = `<w:fldSimple w:instr=" CITATION ${tag} "><w:r><w:t>[1]</w:t></w:r></w:fldSimple>`;
    const document = fixture(`<w:p>${wordField}<w:r><w:t>AB</w:t></w:r>${otherField}</w:p>`, [sourcesXml(
      source(tag, title, { url: article.url }),
    )]);
    const before = unzipSync(document.save())["customXml/sources0.xml"];
    const paragraph = document.paragraph();
    const resolveCitation = (doc: ReturnType<typeof open>, index: number) => {
      const current = doc.paragraph();
      return readDocxFieldAction(current, current.atoms[index].modelRange, () => doc.tree.currentPackage())?.action;
    };
    expect(resolveCitation(document, 0)).toEqual({ kind: "citation", sources: [{ title, url: article.url }] });
    expect(filterDocxCitationSources(listDocxCitationSources(document.tree.currentPackage()), article.url))
      .toEqual([{ tag, title, doi: "10.1234/article" }]);
    expect(document.session.insertCitation?.({
      paragraphRef: paragraph.paragraphRef, expectedRevision: paragraph.revision,
      modelOffset: 2, source: pick === "document" ? { existingTag: tag } : { article },
    })).toMatchObject({ ok: true, changed: true });

    const saved = document.save();
    expect(unzipSync(saved)["customXml/sources0.xml"]).toEqual(before);
    const reopened = open(saved);
    expect(reopened.paragraph().displayText).toBe(`[1]A⟦${title}⟧B[4]`);
    expect(reopened.paragraph().atoms.map(({ payload }) => payload)).toEqual([
      expect.objectContaining({ code: ` CITATION ${tag} ` }),
      expect.objectContaining({ code: ` CITATION ${tag} ` }),
      paragraph.atoms[1].payload,
    ]);
    expect(resolveCitation(reopened, 1)).toEqual(resolveCitation(document, 0));
  });

  it("refuses a manually selected source with conflicting DOI declarations without writing", () => {
    const document = fixture(original, [sourcesXml(source("Conflict", "Conflict paper", {
      doi: "10.1234/field",
      url: article.url,
    }))]);
    const before = document.tree.currentPackage();
    const text = document.paragraph().displayText;
    expect(document.session.insertCitation?.({
      paragraphRef: document.paragraph().paragraphRef, expectedRevision: document.session.revision(),
      modelOffset: 1, source: { existingTag: "Conflict" },
    })).toMatchObject({
      ok: false,
      code: "ambiguous-citation-source",
      changed: false,
    });
    expect(document.tree.currentPackage()).toBe(before);
    expect(document.paragraph().displayText).toBe(text);
  });

  it("uses a manually selected unique tag when several sources share its DOI", () => {
    const document = fixture(original, [sourcesXml(
      source("First", "First paper", { url: article.url }) +
      source("Second", "Second paper", { url: article.url }),
    )]);
    const before = unzipSync(document.save())["customXml/sources0.xml"];
    expect(document.session.insertCitation?.({
      paragraphRef: document.paragraph().paragraphRef, expectedRevision: document.session.revision(),
      modelOffset: 1, source: { existingTag: "Second" },
    })).toMatchObject({ ok: true, changed: true });
    expect(document.paragraph().displayText).toBe("A⟦Second paper⟧B[4]");
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(2);
    expect(unzipSync(document.save())["customXml/sources0.xml"]).toEqual(before);
  });

  it("reuses the unique DOI source for repeated insertions and keeps its bibliography through undo", () => {
    const document = fixture(original, [sourcesXml(source("DoiExisting", "Existing DOI paper", {
      url: article.url,
      extra: "<b:Comments>Third-party source field</b:Comments>",
    }))]);
    const preserved = document.paragraph().atoms[0];
    const before = unzipSync(document.save())["customXml/sources0.xml"];

    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
    expect(document.paragraph().displayText).toBe("A⟦Existing DOI paper⟧B[4]");
    expect(insert(document, 2)).toMatchObject({ ok: true, changed: true });

    const inserted = document.paragraph();
    expect(inserted.displayText).toBe("A⟦Existing DOI paper⟧⟦Existing DOI paper⟧B[4]");
    expect(inserted.atoms.flatMap((atom) => {
      const action = readDocxFieldAction(inserted, atom.modelRange, () => document.tree.currentPackage())?.action;
      return action?.kind === "citation" ? action.sources.map(({ title }) => title) : [];
    })).toEqual(["Existing DOI paper", "Existing DOI paper"]);
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(1);
    expect(unzipSync(document.save())["customXml/sources0.xml"]).toEqual(before);

    document.surface.undo();
    const undone = document.paragraph();
    expect(undone.displayText).toBe("A⟦Existing DOI paper⟧B[4]");
    const thirdPartyFields = undone.atoms.filter(({ kind, payload }) =>
      kind === "field" && payload !== null && typeof payload === "object" &&
      "code" in payload && payload.code === " ADDIN ZOTERO_ITEM CSL_CITATION {} ");
    expect(thirdPartyFields).toHaveLength(1);
    expect(thirdPartyFields[0].payload).toEqual(preserved.payload);
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(1);
    expect(unzipSync(document.save())["customXml/sources0.xml"]).toEqual(before);
  });

  it.each([
    ["multiple DOI matches", source("First", "First paper", { url: article.url }) +
      source("Second", "Second paper", { url: article.url })],
    ["a duplicated matched tag", source("Shared", "DOI paper", { url: article.url }) +
      source("Shared", "Other paper", { url: "https://doi.org/10.1234/other" })],
    ["a missing matched tag", source("", "DOI paper", { url: article.url })],
    ["an invalid matched tag", source("not a tag", "DOI paper", { url: article.url })],
    ["a matched tag containing a field switch", source('Bad" \\m Other', "DOI paper", { url: article.url })],
    ["conflicting DOI declarations", source("Conflict", "DOI paper", {
      doi: "10.1234/other",
      url: article.url,
    })],
  ])("refuses automatic DOI reuse for %s without writing", (_name, entries) => {
    const document = fixture(original, [sourcesXml(entries)]);
    const before = document.tree.currentPackage();
    const text = document.paragraph().displayText;
    expect(insert(document, 1)).toMatchObject({
      ok: false,
      code: "ambiguous-citation-source",
      changed: false,
    });
    expect(document.tree.currentPackage()).toBe(before);
    expect(document.paragraph().displayText).toBe(text);
  });

  it("ignores conflicting DOI declarations that do not match the inserted article", () => {
    const document = fixture(original, [sourcesXml(source("Unrelated", "Unrelated paper", {
      doi: "10.1234/unrelated-field",
      url: "https://doi.org/10.1234/unrelated-url",
    }))]);
    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(2);
  });

  it.each(["readOnly", "comments", "forms", "trackedChanges"])("leaves a document with %s protection intact", (protection) => {
    const document = fixture(original, [], `<w:documentProtection w:edit="${protection}" w:enforcement="1"/>`);
    const before = document.tree.currentPackage();
    const revision = document.session.revision();
    expect(insert(document, 1)).toMatchObject({ ok: false, code: "unsupported-target", revision });
    expect(document.tree.currentPackage()).toBe(before);
  });

  it("does not insert an untracked citation when the document requests Track Changes", () => {
    const document = fixture(original, [], "<w:trackRevisions/>");
    expect(document.surface.editingMode()).toBe("edit");
    const before = document.tree.currentPackage();
    const revision = document.session.revision();
    expect(insert(document, 1)).toMatchObject({ ok: false, changed: false, code: "unsupported-target", revision });
    expect(document.tree.currentPackage()).toBe(before);
  });

  it("allows insertion when Track Changes is explicitly off", () => {
    const document = fixture(original, [], '<w:trackRevisions w:val="0"/>');
    expect(insert(document, 1)).toMatchObject({ ok: true, changed: true });
  });

  it("does not write to a stale, ambiguous or protected target", () => {
    const stale = fixture();
    const before = stale.session.revision();
    expect(insert(stale, 1, before)).toMatchObject({ ok: true, changed: true });
    expect(insert(stale, 0, before)).toMatchObject({ ok: false, code: "stale-target" });
    expect(bibliographyParts(stale.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(1);

    const ambiguous = fixture(original, [sourcesXml(existing), sourcesXml(existing)]);
    const locked = fixture('<w:p><w:sdt><w:sdtPr><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent><w:r><w:t>ABC</w:t></w:r></w:sdtContent></w:sdt></w:p>');
    for (const [document, code] of [[ambiguous, "unsupported-target"], [locked, "transaction-refused"]] as const) {
      const unchanged = document.tree.currentPackage();
      expect(insert(document, 1)).toMatchObject({ ok: false, code, changed: false });
      expect(document.tree.currentPackage()).toBe(unchanged);
    }
  });

  it("leaves the document intact when a related store uses the bibliography namespace with a different root", () => {
    const seeded = fixture();
    expect(insert(seeded, 1)).toMatchObject({ ok: true });
    const files = unzipSync(seeded.save());
    const [sourcePart] = bibliographyParts(seeded.tree.currentPackage());
    files[sourcePart.name.slice(1)] = strToU8(`<b:NotSources xmlns:b="${WORD_BIBLIOGRAPHY}"/>`);
    const document = open(zipSync(files));
    const before = document.tree.currentPackage();
    const revision = document.session.revision();
    expect(insert(document, 0)).toMatchObject({ ok: false, code: "transaction-refused", revision });
    expect(document.tree.currentPackage()).toBe(before);
  });

  it.each([
    '<w:p><w:r><w:t>A</w:t></w:r><w:bookmarkStart w:id="1" w:name="Named"/><w:r><w:t>B</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
    '<w:p><w:r><w:t>A</w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>B</w:t></w:r><w:commentRangeEnd w:id="1"/></w:p>',
    '<w:p><w:r><w:t>A</w:t></w:r><w:ins w:id="1" w:author="Reviewer"><w:r><w:t>B</w:t></w:r></w:ins></w:p>',
  ])("does not change a range marker at the insertion point or a pending revision", (body) => {
    const document = fixture(body);
    const before = document.tree.currentPackage();
    expect(insert(document, 1)).toMatchObject({ ok: false, code: "unsupported-target" });
    expect(document.tree.currentPackage()).toBe(before);
  });

  it.each([
    {
      name: "between a native citation and a third-party field",
      offset: 1,
      display: "[1]⟦A & B < C⟧Smith 2020, after.",
      order: ["CITATION Existing", "CITATION Oleafly", "ADDIN ZOTERO_ITEM", "Smith 2020", ", after."],
      codes: [" CITATION Existing ", null, " ADDIN ZOTERO_ITEM CSL_CITATION {\"citationID\":\"private\"} "],
    },
    {
      name: "after a third-party field and before punctuation",
      offset: 2,
      display: "[1]Smith 2020⟦A & B < C⟧, after.",
      order: ["CITATION Existing", "ADDIN ZOTERO_ITEM", "Smith 2020", "CITATION Oleafly", ", after."],
      codes: [" CITATION Existing ", " ADDIN ZOTERO_ITEM CSL_CITATION {\"citationID\":\"private\"} ", null],
    },
  ])("keeps adjacent same-paragraph fields when inserting $name", ({ offset, display, order, codes }) => {
    const native = '<w:fldSimple w:instr=" CITATION Existing "><w:r><w:t>[1]</w:t></w:r></w:fldSimple>';
    const thirdParty = '<w:r><w:fldChar w:fldCharType="begin" w:fldLock="1"><w:fldData>cGF5bG9hZA==</w:fldData></w:fldChar></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM</w:instrText></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> CSL_CITATION {"citationID":"private"} </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:rPr><w:i/></w:rPr><w:t>Smith 2020</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/><w:t xml:space="preserve">, after.</w:t></w:r>';
    const document = fixture(`<w:p>${native}${thirdParty}</w:p>`);
    const fieldCodes = (paragraph: ReturnType<typeof document.paragraph>) => paragraph.atoms.flatMap(({ kind, payload }) =>
      kind === "field" && payload !== null && typeof payload === "object" && "code" in payload
        ? [(payload as { code: string }).code] : []);
    expect(document.paragraph().displayText).toBe("[1]Smith 2020, after.");

    expect(insert(document, offset)).toMatchObject({ ok: true, changed: true });
    expect(document.paragraph().displayText).toBe(display);
    expect(fieldCodes(document.paragraph())).toEqual(codes.map((code) =>
      code ?? expect.stringMatching(/^ CITATION Oleafly[\da-f]{32} $/u)));
    expect(bibliographyParts(document.tree.currentPackage()).flatMap(bibliographySources)).toHaveLength(1);

    document.surface.undo();
    expect(document.paragraph().displayText).toBe("[1]Smith 2020, after.");
    expect(bibliographyParts(document.tree.currentPackage())).toHaveLength(0);
    document.surface.redo();

    const saved = document.save();
    const reopened = open(saved);
    expect(reopened.paragraph().displayText).toBe(display);
    expect(fieldCodes(reopened.paragraph())).toEqual(fieldCodes(document.paragraph()));
    const xml = strFromU8(unzipSync(saved)["word/document.xml"]);
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    const fieldCharacters = Array.from(parsed.getElementsByTagNameNS(word, "fldChar"));
    const begin = fieldCharacters.find((node) => node.getAttributeNS(word, "fldCharType") === "begin");
    expect(begin?.getAttributeNS(word, "fldLock")).toBe("1");
    expect(begin?.getElementsByTagNameNS(word, "fldData")[0].textContent).toBe("cGF5bG9hZA==");
    const positions = order.map((text) => xml.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(fieldCharacters.map((node) => node.getAttributeNS(word, "fldCharType"))).toEqual([
      "begin", "separate", "end",
    ]);
  });

});
