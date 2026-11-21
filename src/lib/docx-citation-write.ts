import type { AutomationHandle, AutomationHost } from "@docx-editor.dev/core/automation";
import type { PaginatedSurface } from "@docx-editor.dev/core/editor";
import {
  findNode,
  fldCharType,
  insertChildren,
  listBookmarks,
  parentNodeOf,
  paragraphOffsetIndex,
  readDocumentProtection,
  readOoxmlPart,
  readTrackingSettings,
  settingsPartOf,
  storyParagraphs,
  withCustomXmlDataPart,
  withPart,
  type OoxmlElement,
  type OoxmlNode,
  type OoxmlPackage,
  type OoxmlPart,
} from "@docx-editor.dev/core/store";
import {
  bibliographyParts,
  bibliographySources,
  bibliographyText,
  WORD_BIBLIOGRAPHY,
} from "./docx-citation-fields";
import { docxCitationIdentity, docxCitationQueryDoi, docxDoiFromUrl } from "./docx-citation-doi";
import type { DocxApplyErrorCode, DocxApplyResult } from "./docx-session";
import { safeHttpUrl } from "./system-browser";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const DOCX_CITATION_PREVIEW = import.meta.env.VITE_DOCX_CITATION_PREVIEW === "1";

export interface DocxCitationArticle {
  readonly title: string;
  readonly journal: string;
  readonly authors: readonly { readonly family: string; readonly given?: string }[];
  readonly year: string;
  readonly volume?: string;
  readonly issue?: string;
  readonly pages?: string;
  readonly url?: string;
}

export interface DocxCitationSource {
  readonly tag: string;
  readonly title: string;
  readonly doi?: string;
}

export interface DocxCitationInsertRequest {
  readonly paragraphRef: string;
  readonly expectedRevision: number;
  readonly modelOffset: number;
  readonly source: { readonly existingTag: string } | { readonly article: DocxCitationArticle };
}

const citationTag = /^[\p{L}\p{M}\p{Nd}_-]+$/u;
const wordSourceText = /^[\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]{0,255}$/u;

const crossParagraphFields = new WeakMap<OoxmlElement, ReadonlySet<string>>();
const separateStoryContent = new Set(["drawing", "pict", "object", "txbxContent"]);

export function docxCitationWriteRestriction(pkg: OoxmlPackage): string | undefined {
  const settings = settingsPartOf(pkg)?.root;
  if (readDocumentProtection(settings).enforced) {
    return "Citation insertion is not available in a protected document.";
  }
  if (readTrackingSettings(settings).trackRevisions) {
    return "Citation insertion does not support Track Changes.";
  }
}

export function isDocxCitationBodyParagraph(part: OoxmlPart, paragraphId: string): boolean {
  const body = parentNodeOf(part, paragraphId);
  if (body?.kind !== "body") return false;
  let covered = crossParagraphFields.get(body);
  if (!covered) {
    const paragraphs = new Set<string>();
    let openFields = 0;
    const visit = (node: OoxmlNode) => {
      if (node.kind === "textValue" || node.kind === "fldSimple" || separateStoryContent.has(node.localName)) return;
      if (node.kind === "fldChar") {
        const type = fldCharType(node);
        if (type === "begin") openFields++;
        if (type === "end" && openFields > 0) openFields--;
      } else {
        node.children.forEach(visit);
      }
    };
    for (const paragraph of storyParagraphs(body)) {
      const startsInsideField = openFields > 0;
      visit(paragraph);
      if (startsInsideField || openFields > 0) paragraphs.add(paragraph.id);
    }
    covered = paragraphs;
    crossParagraphFields.set(body, covered);
  }
  return !covered.has(paragraphId);
}

export function listDocxCitationSources(pkg: OoxmlPackage): DocxCitationSource[] {
  const records = new Map<string, DocxCitationSource | null>();
  for (const part of bibliographyParts(pkg)) {
    for (const node of bibliographySources(part)) {
      const tag = bibliographyText(node, "Tag");
      if (!citationTag.test(tag)) continue;
      if (records.has(tag)) {
        records.set(tag, null);
        continue;
      }
      const title = bibliographyText(node, "Title");
      const identity = sourceDoi(node);
      const doi = identity.conflict ? null : identity.dois[0];
      records.set(tag, title ? { tag, title, ...(doi ? { doi } : {}) } : null);
    }
  }
  return [...records.values()].filter((source): source is DocxCitationSource => source !== null);
}

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sourceDoi(source: OoxmlElement) {
  return docxCitationIdentity(bibliographyText(source, "DOI"), bibliographyText(source, "URL"));
}

export function filterDocxCitationSources(
  sources: readonly DocxCitationSource[],
  query: string,
): DocxCitationSource[] {
  const typed = query.trim();
  if (!typed) return [...sources];
  const doi = docxCitationQueryDoi(typed);
  if (doi) return sources.filter((source) => source.doi === doi);
  const needle = typed.toLocaleLowerCase();
  return sources.filter(({ title }) => title.toLocaleLowerCase().includes(needle));
}

function articleDetails(article: DocxCitationArticle) {
  const title = article.title.trim();
  const journal = article.journal.trim();
  const year = article.year.trim();
  const authors = article.authors.map(({ family, given }) => ({ family: family.trim(), given: given?.trim() }));
  if (!title || !journal || !/^\d{4}$/u.test(year) || !authors.length || authors.some(({ family }) => !family)) return null;
  const url = article.url ? safeHttpUrl(article.url) : undefined;
  if (article.url && (!url || new URL(url).username || new URL(url).password)) return null;
  const details = { Title: title, JournalName: journal, Year: year, Volume: article.volume?.trim(),
    Issue: article.issue?.trim(), Pages: article.pages?.trim(), URL: url };
  if ([...Object.values(details), ...authors.flatMap(({ family, given }) => [family, given])]
    .some((value) => value && !wordSourceText.test(value))) return null;
  return { details, authors };
}

type DocxCitationSourcePlan =
  | { readonly kind: "reuse"; readonly tag: string; readonly title: string }
  | { readonly kind: "add"; readonly partName: string | undefined; readonly article: NonNullable<ReturnType<typeof articleDetails>> }
  | { readonly kind: "refused"; readonly code: DocxApplyErrorCode; readonly message: string };

export function planDocxCitationSource(pkg: OoxmlPackage, source: DocxCitationInsertRequest["source"]): DocxCitationSourcePlan {
  const parts = bibliographyParts(pkg);
  const sources = parts.flatMap(bibliographySources);
  const refuse = (code: DocxApplyErrorCode, message: string): DocxCitationSourcePlan => ({ kind: "refused", code, message });
  const byTag = (tag: string) => sources.filter((node) => bibliographyText(node, "Tag") === tag);
  if ("existingTag" in source) {
    const tag = source.existingTag;
    if (!citationTag.test(tag)) return refuse("unsupported-target", "The citation tag is not supported.");
    const matches = byTag(tag);
    if (matches.length === 1 && sourceDoi(matches[0]).conflict) {
      return refuse("ambiguous-citation-source", "The selected bibliography source declares conflicting DOIs.");
    }
    const title = matches.length === 1 ? bibliographyText(matches[0], "Title") : "";
    return title ? { kind: "reuse", tag, title } : refuse("unsupported-target", "The citation source is missing or ambiguous.");
  }

  const doi = source.article.url ? docxDoiFromUrl(source.article.url) : null;
  const matches = doi ? sources.flatMap((node) => {
    const identity = sourceDoi(node);
    return identity.dois.includes(doi) ? [{ node, conflict: identity.conflict }] : [];
  }) : [];
  if (matches.some(({ conflict }) => conflict)) {
    return refuse("ambiguous-citation-source", "A matching bibliography source declares conflicting DOIs.");
  }
  if (matches.length > 1) {
    return refuse("ambiguous-citation-source", "The DOI matches more than one bibliography source.");
  }
  if (matches.length === 1) {
    const { node } = matches[0];
    const tag = bibliographyText(node, "Tag");
    const title = bibliographyText(node, "Title");
    if (!citationTag.test(tag) || byTag(tag).length !== 1 || !title) {
      return refuse("ambiguous-citation-source", "The DOI match lacks a unique citation tag or title.");
    }
    return { kind: "reuse", tag, title };
  }
  if (parts.length > 1) return refuse("unsupported-target", "The document has multiple bibliographies.");
  const article = articleDetails(source.article);
  return article ? { kind: "add", partName: parts[0]?.name, article }
    : refuse("unsupported-citation-metadata", "The source metadata does not fit the Word bibliography format.");
}

function articleRecord({ details, authors }: NonNullable<ReturnType<typeof articleDetails>>, tag: string, guid: string) {
  const element = (name: string, value: string | null | undefined) =>
    value ? `<b:${name}>${xmlText(value)}</b:${name}>` : "";
  const names = authors.map(({ family, given }) =>
    `<b:Person>${element("Last", family)}${element("First", given)}</b:Person>`).join("");
  const fields = [element("Tag", tag), element("SourceType", "JournalArticle"), element("Guid", guid),
    `<b:Author><b:Author><b:NameList>${names}</b:NameList></b:Author></b:Author>`,
    ...Object.entries(details).map(([name, value]) => element(name, value))];
  const read = readOoxmlPart(`<b:Source xmlns:b="${WORD_BIBLIOGRAPHY}">${fields.join("")}</b:Source>`, {
    name: `/oleafly-citation/${tag}.xml`, contentType: "application/xml",
  });
  return read.ok ? read.part.root : null;
}

function appendSource(pkg: OoxmlPackage, partName: string | undefined, source: OoxmlPart["root"]): OoxmlPackage | null {
  if (!partName) {
    const created = withCustomXmlDataPart(pkg, pkg.mainDocumentPart, WORD_BIBLIOGRAPHY, "Sources");
    if (!created.part) return null;
    pkg = created.pkg;
    partName = created.part.partName;
  }
  const part = pkg.parts.get(partName);
  if (!part) return null;
  const edited = insertChildren(part, part.root.id, part.root.children.length, [source]);
  return edited.ok ? withPart(pkg, edited.part) : null;
}

export function insertDocxCitation(
  host: AutomationHost,
  surface: PaginatedSurface,
  paragraphHandle: AutomationHandle<"paragraph">,
  request: DocxCitationInsertRequest,
): DocxApplyResult {
  const refuse = (code: DocxApplyErrorCode, message: string): DocxApplyResult =>
    ({ ok: false, code, message, changed: false, revision: host.revision() });
  surface.flushPendingInput();
  if (host.revision() !== request.expectedRevision || paragraphHandle.ref !== request.paragraphRef) {
    return refuse("stale-target", "The citation insertion target changed. Choose the position again.");
  }
  if (surface.editingMode() !== "edit" || surface.collaborationSession()) {
    return refuse("unsupported-target", "Citation insertion requires an individual editing session.");
  }
  const currentPackage = surface.session.currentPackage();
  const restriction = docxCitationWriteRestriction(currentPackage);
  if (restriction) return refuse("unsupported-target", restriction);
  const response = host.execute({ operations: [
    { op: "getParagraphId", paragraph: paragraphHandle },
    { op: "getRevisions", scope: { paragraph: paragraphHandle } },
  ] });
  const [result, revisions] = response.results;
  const nodeId = result?.status === "ok" && result.value.kind === "text"
    ? surface.session.nodeIdOf(result.value.text) : null;
  const part = surface.session.part();
  const paragraph = nodeId ? findNode(part, nodeId) : null;
  if (paragraph?.kind !== "paragraph") return refuse("stale-target", "The citation paragraph is no longer available.");
  const offset = request.modelOffset;
  const index = paragraphOffsetIndex(paragraph);
  if (!Number.isInteger(offset) || offset < 0 || offset > index.length) {
    return refuse("invalid-range", "Choose an insertion position in the current paragraph.");
  }
  if (!isDocxCitationBodyParagraph(part, paragraph.id) || revisions?.status !== "ok" ||
      revisions.value.kind !== "handles" || revisions.value.handles.length > 0) {
    return refuse("unsupported-target", "Choose a body paragraph outside spanning fields and without pending revisions.");
  }
  const touchesBookmark = listBookmarks(part).some(({ start, end }) =>
    (start.paragraphId === paragraph.id && start.offset === offset) ||
    (end.paragraphId === paragraph.id && end.offset === offset));
  const touchesComment = paragraph.children.some((node) =>
    (node.localName === "commentRangeStart" || node.localName === "commentRangeEnd") &&
    index.spanOf(node)?.start === offset);
  if (touchesBookmark || touchesComment) {
    return refuse("unsupported-target", "Choose a position away from the edge of a bookmark or comment.");
  }

  const plan = planDocxCitationSource(currentPackage, request.source);
  if (plan.kind === "refused") return refuse(plan.code, plan.message);
  let tag: string;
  let title: string;
  let packageEdits: readonly ((pkg: OoxmlPackage) => OoxmlPackage)[] = [];
  if (plan.kind === "reuse") {
    ({ tag, title } = plan);
  } else {
    const guid = crypto.randomUUID();
    tag = `Oleafly${guid.replaceAll("-", "")}`;
    const record = articleRecord(plan.article, tag, `{${guid.toUpperCase()}}`);
    if (!record) return refuse("unsupported-citation-metadata", "The source metadata does not fit the Word bibliography format.");
    title = plan.article.details.Title;
    const planned = appendSource(currentPackage, plan.partName, record);
    if (!planned) return refuse("transaction-refused", "The document bibliography could not be updated.");
    packageEdits = [() => planned];
  }
  const read = readOoxmlPart(
    `<w:p xmlns:w="${WORD}"><w:fldSimple w:instr=" CITATION ${tag} " w:dirty="true"><w:r><w:t>${xmlText(`⟦${title}⟧`)}</w:t></w:r></w:fldSimple></w:p>`,
    { name: part.name, contentType: part.contentType },
  );
  if (!read.ok) return refuse("unsupported-target", "The citation field could not be generated.");
  const applied = surface.applyAutomationOps(() => surface.session.currentPackage() === currentPackage ? [{
    op: "insertFragment", paragraphId: paragraph.id, offset, blocks: [read.part.root],
  }] : null, undefined, packageEdits);
  return applied.rejected
    ? refuse("transaction-refused", applied.reason ?? "The document refused the citation insertion.")
    : { ok: true, changed: applied.committed, revision: host.revision() };
}
