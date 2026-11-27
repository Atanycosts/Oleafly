import type {
  DocxFormatObject,
  DocxFormatSnapshotV1,
} from "./docx-format-types";

export interface DocxFormatSemanticLocation {
  objectId: string;
  kind: string;
  part: string;
  key: string;
  paraId?: string;
  run?: {
    ownerKey: string;
    start: number;
    end: number;
  };
}

export interface DocxFormatSemanticIndex {
  byObjectId: ReadonlyMap<string, DocxFormatSemanticLocation>;
}

export interface DocxFormatSemanticTarget {
  caseId: string;
  propertyPath: string;
  location?: DocxFormatSemanticLocation;
}

export interface DocxFormatComparableFinding {
  case_id: string;
  object_id: string;
  property_path: string;
}

const objectKey = (kind: string, part: string, ordinal: number) =>
  `${kind}\0${part}\0${ordinal}`;

function attributeText(object: DocxFormatObject, localName: string): string | undefined {
  const attributes = object.declared.attributes;
  if (!Array.isArray(attributes)) return undefined;
  for (const attribute of attributes) {
    if (
      attribute &&
      typeof attribute === "object" &&
      !Array.isArray(attribute) &&
      attribute.localName === localName &&
      typeof attribute.value === "string" &&
      attribute.value
    ) {
      return attribute.value;
    }
  }
  return undefined;
}

function paragraphAnchor(
  object: DocxFormatObject,
  objects: readonly DocxFormatObject[],
  objectsById: ReadonlyMap<string, DocxFormatObject>,
): DocxFormatObject | undefined {
  if (object.kind === "paragraph") return object;
  const ownerId = object.evidence.paragraph_object_id;
  if (typeof ownerId === "string") {
    const owner = objectsById.get(ownerId);
    if (owner?.kind === "paragraph") return owner;
  }
  const paragraphs = objects.filter(
    (candidate) => candidate.kind === "paragraph" && candidate.part === object.part,
  );
  if (object.kind === "section") {
    return paragraphs.find((candidate) =>
      candidate.region?.section_object_id === object.object_id,
    );
  }
  return paragraphs.find((candidate) =>
    object.path.length <= candidate.path.length &&
    object.path.every((value, index) => candidate.path[index] === value),
  );
}

/**
 * Build identity from structural order and paragraph-relative run text offsets.
 * Formatting can insert pPr/tcPr and split runs, so neither XML paths nor run
 * ordinals are stable across a candidate save.
 */
export function createDocxFormatSemanticIndex(
  snapshot: DocxFormatSnapshotV1,
): DocxFormatSemanticIndex {
  const objects = snapshot.objects;
  const objectsById = new Map(objects.map((object) => [object.object_id, object]));
  const paragraphKeys = new Map<string, string>();
  const paragraphOrdinals = new Map<string, number>();
  const partKindOrdinals = new Map<string, number>();
  for (const object of objects) {
    if (object.kind !== "paragraph") continue;
    const ordinal = paragraphOrdinals.get(object.part) ?? 0;
    paragraphOrdinals.set(object.part, ordinal + 1);
    paragraphKeys.set(object.object_id, objectKey("paragraph", object.part, ordinal));
  }
  const runCursors = new Map<string, number>();
  const runOrdinalAtStart = new Map<string, number>();
  const byObjectId = new Map<string, DocxFormatSemanticLocation>();
  for (const object of objects) {
    const paraId = (() => {
      const anchor = paragraphAnchor(object, objects, objectsById);
      return anchor ? attributeText(anchor, "paraId") : undefined;
    })();
    if (object.kind === "run") {
      const ownerId = typeof object.evidence.paragraph_object_id === "string"
        ? object.evidence.paragraph_object_id
        : undefined;
      const ownerKey = ownerId ? paragraphKeys.get(ownerId) : undefined;
      if (ownerKey && ownerId) {
        const start = runCursors.get(ownerId) ?? 0;
        const end = start + (object.text?.length ?? 0);
        runCursors.set(ownerId, end);
        const startKey = `${ownerKey}\0${start}`;
        const occurrence = runOrdinalAtStart.get(startKey) ?? 0;
        runOrdinalAtStart.set(startKey, occurrence + 1);
        byObjectId.set(object.object_id, {
          objectId: object.object_id,
          kind: object.kind,
          part: object.part,
          key: `${startKey}\0${occurrence}`,
          ...(paraId ? { paraId } : {}),
          run: { ownerKey, start, end },
        });
        continue;
      }
    }
    const counterKey = `${object.part}\0${object.kind}`;
    const ordinal = partKindOrdinals.get(counterKey) ?? 0;
    partKindOrdinals.set(counterKey, ordinal + 1);
    const key = objectKey(object.kind, object.part, ordinal);
    byObjectId.set(object.object_id, {
      objectId: object.object_id,
      kind: object.kind,
      part: object.part,
      key,
      ...(paraId ? { paraId } : {}),
    });
  }
  return { byObjectId };
}

/** A split or extended run still belongs to the original paragraph text span. */
export function sameDocxFormatSemanticObject(
  before: DocxFormatSemanticLocation | undefined,
  after: DocxFormatSemanticLocation | undefined,
): boolean {
  if (!before || !after || before.kind !== after.kind || before.part !== after.part) {
    return false;
  }
  if (before.run && after.run) {
    if (before.run.ownerKey !== after.run.ownerKey) return false;
    if (before.run.start === before.run.end) {
      return after.run.start === before.run.start;
    }
    return after.run.start >= before.run.start &&
      after.run.end <= before.run.end &&
      after.run.end > after.run.start;
  }
  return before.key === after.key;
}

export function semanticLocationOfFinding(
  index: DocxFormatSemanticIndex,
  objectId: string,
): DocxFormatSemanticLocation | undefined {
  return index.byObjectId.get(objectId);
}

export function findingMatchesSemanticTarget(
  finding: DocxFormatComparableFinding,
  target: DocxFormatSemanticTarget,
  index: DocxFormatSemanticIndex,
): boolean {
  return finding.property_path === target.propertyPath && (
    finding.case_id === target.caseId ||
    sameDocxFormatSemanticObject(
      target.location,
      index.byObjectId.get(finding.object_id),
    )
  );
}
