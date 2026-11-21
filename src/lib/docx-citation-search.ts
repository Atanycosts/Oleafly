import { plainText } from "@/lib/zotero/rich-text";
import { declaredDocxDoi, docxCitationQueryDoi, docxDoiUrl } from "./docx-citation-doi";
import type { DocxCitationArticle } from "./docx-citation-write";
import { crossrefSearchJournalTitles, crossrefWork } from "./tauri";

type DocxCitationAuthor = DocxCitationArticle["authors"][number];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? plainText(value) || undefined : undefined;
}

function firstText(value: unknown): string | undefined {
  return text(Array.isArray(value) ? value[0] : value);
}

function issuedYear(value: unknown): string | undefined {
  const dateParts = record(value)?.["date-parts"];
  const datePart = Array.isArray(dateParts) ? dateParts[0] : undefined;
  const rawYear = Array.isArray(datePart) ? datePart[0] : undefined;
  const year = typeof rawYear === "number"
    ? Number.isInteger(rawYear) ? String(rawYear) : undefined
    : text(rawYear);
  return year && /^\d{4}$/u.test(year) ? year : undefined;
}

function personAuthors(value: unknown): readonly DocxCitationAuthor[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const authors: DocxCitationAuthor[] = [];
  for (const valueAuthor of value) {
    const author = record(valueAuthor);
    const family = text(author?.family);
    if (!family) return undefined;
    const given = text(author?.given);
    authors.push(given ? { family, given } : { family });
  }
  return authors;
}

function article(value: unknown, expectedDoi?: string): DocxCitationArticle | undefined {
  const item = record(value);
  if (item?.type !== "journal-article") return undefined;
  const doi = typeof item.DOI === "string" ? declaredDocxDoi(item.DOI) : null;
  if (expectedDoi !== undefined && doi !== expectedDoi) return undefined;
  const title = firstText(item.title);
  const journal = firstText(item["container-title"]);
  const year = issuedYear(item.issued);
  const authors = personAuthors(item.author);
  if (!title || !journal || !year || !authors) return undefined;
  const volume = text(item.volume);
  const issue = text(item.issue);
  const pages = text(item.page);
  const url = doi ? docxDoiUrl(doi) : undefined;
  return {
    title,
    journal,
    authors,
    year,
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
    ...(url ? { url } : {}),
  };
}

export async function searchDocxCitationArticles(
  query: string,
): Promise<readonly DocxCitationArticle[]> {
  const doi = docxCitationQueryDoi(query);
  if (doi) {
    const found = article(await crossrefWork(doi), doi);
    return found ? [found] : [];
  }
  const response = await crossrefSearchJournalTitles(query);
  let payload: unknown;
  try {
    payload = JSON.parse(response);
  } catch {
    return [];
  }
  const items = record(record(payload)?.message)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const parsed = article(item);
    return parsed ? [parsed] : [];
  });
}
