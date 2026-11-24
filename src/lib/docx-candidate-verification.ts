import type { DocxFindingVerdict } from "./docx-finding-review";
import type { DocxFormatSemanticIndex, DocxFormatSemanticLocation } from "./docx-format-finding-identity";

export interface DocxCandidateTarget {
  caseId: string;
  propertyPath: string;
  expected: unknown;
  location?: DocxFormatSemanticLocation;
}

export interface DocxCandidateVerificationTarget {
  case_id: string;
  property_path: string;
  object_ids: string[];
}

export interface DocxCandidateVerificationFinding {
  object_id: string;
  property_path: string;
  observed: unknown;
  verdict: DocxFindingVerdict;
}

export function candidateVerificationTargets(
  targets: readonly DocxCandidateTarget[],
  finalIndex: DocxFormatSemanticIndex,
): DocxCandidateVerificationTarget[] {
  const byKey = new Map<string, string>();
  const runs = new Map<string, DocxFormatSemanticLocation[]>();
  for (const location of finalIndex.byObjectId.values()) {
    if (!location.run) {
      byKey.set(location.key, location.objectId);
      continue;
    }
    const list = runs.get(location.run.ownerKey) ?? [];
    list.push(location);
    runs.set(location.run.ownerKey, list);
  }
  return targets.map(({ caseId, propertyPath, location }) => {
    const object_ids: string[] = [];
    if (location?.run) {
      const span = location.run;
      const overlapping = (runs.get(span.ownerKey) ?? []).flatMap((item) => {
        const range = item.run;
        return range && range.start < span.end && range.end > span.start ? [{ item, range }] : [];
      });
      if (span.start < span.end && overlapping[0]?.range.start === span.start && overlapping.at(-1)?.range.end === span.end) {
        object_ids.push(...overlapping.map(({ item }) => item.objectId));
      }
    } else if (location) {
      const final = byKey.get(location.key);
      if (final) object_ids.push(final);
    }
    return { case_id: caseId, property_path: propertyPath, object_ids };
  });
}

export function confirmedCandidateTargets(
  targets: readonly DocxCandidateTarget[],
  selection: readonly DocxCandidateVerificationTarget[],
  findings: readonly DocxCandidateVerificationFinding[],
): boolean[] {
  const byField = new Map(findings.map((item) => [`${item.object_id}\0${item.property_path}`, item]));
  return targets.map((target, index) => {
    const { object_ids } = selection[index];
    return object_ids.length > 0 && object_ids.every((objectId) => {
      const finding = byField.get(`${objectId}\0${target.propertyPath}`);
      return finding?.verdict === "observed_match" && finding.observed === target.expected;
    });
  });
}
