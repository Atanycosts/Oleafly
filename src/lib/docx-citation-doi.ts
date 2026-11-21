const doiPattern = /^10\.\d{4,9}\/[^\s\p{Cc}\p{Cs}]+$/iu;

export function docxDoiFromUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        (url.hostname !== "doi.org" && url.hostname !== "dx.doi.org") ||
        url.port || url.username || url.password || url.search || url.hash) return null;
    const doi = decodeURIComponent(url.pathname.slice(1));
    return doiPattern.test(doi) ? doi.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function declaredDocxDoi(value: string): string | null {
  const bare = value.trim().replace(/^doi:\s*/iu, "");
  return doiPattern.test(bare) ? bare.toLowerCase() : docxDoiFromUrl(bare);
}

export function docxCitationIdentity(declared: string, link: string) {
  const fieldDoi = declaredDocxDoi(declared);
  const urlDoi = docxDoiFromUrl(link);
  return {
    dois: [...new Set([fieldDoi, urlDoi].filter((doi): doi is string => doi !== null))],
    conflict: fieldDoi !== null && urlDoi !== null && fieldDoi !== urlDoi,
  };
}

export function docxDoiUrl(doi: string): string {
  return `https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`;
}

export function docxCitationQueryDoi(value: string): string | null {
  const typed = value.trim();
  return /^(?:dx\.)?doi\.org\//iu.test(typed)
    ? docxDoiFromUrl(`https://${typed}`)
    : declaredDocxDoi(typed);
}
