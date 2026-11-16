import {
  resolveContentTypeOf,
  resolveImageRelationship,
  sniffImageMime,
  type OoxmlElement,
  type OoxmlNode,
  type OoxmlPackage,
} from "@docx-editor.dev/core/store";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const V = "urn:schemas-microsoft-com:vml";
const O = "urn:schemas-microsoft-com:office:office";

export interface DocxImageReadRequest {
  readonly paragraphRef: string;
  readonly objectRef: string;
  readonly expectedRevision: number;
}

export interface DocxImageReadResult {
  readonly revision: number;
  readonly objectRef: string;
  readonly part: string;
  readonly relationshipId: string;
  readonly mediaPart: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly description?: string;
  readonly widthEmu?: number;
  readonly heightEmu?: number;
}

export type DocxImageReadErrorCode =
  | "stale-revision"
  | "paragraph-not-found"
  | "object-not-found"
  | "not-image"
  | "relationship-missing"
  | "external-image"
  | "media-missing"
  | "unsupported-media";

export class DocxImageReadError extends Error {
  constructor(
    readonly code: DocxImageReadErrorCode,
    readonly revision: number,
    message: string,
  ) {
    super(message);
    this.name = "DocxImageReadError";
  }
}

export interface DocxImageAtomProjection {
  readonly readable: boolean;
  readonly complete: false;
  readonly payload: Record<string, unknown>;
}

interface ImageReference {
  readonly relationshipId?: string;
  readonly external: boolean;
  readonly description?: string;
  readonly widthEmu?: number;
  readonly heightEmu?: number;
}

interface ImageMetadata {
  readonly relationshipId: string;
  readonly mediaPart: string;
  readonly contentType: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly description?: string;
  readonly widthEmu?: number;
  readonly heightEmu?: number;
}

function attribute(
  node: OoxmlElement,
  namespaceUri: string,
  localName: string,
): string | undefined {
  return node.attributes.find(
    (candidate) =>
      candidate.namespaceUri === namespaceUri &&
      candidate.localName === localName,
  )?.value;
}

function descendant(
  node: OoxmlNode,
  predicate: (candidate: OoxmlElement) => boolean,
): OoxmlElement | undefined {
  if (node.kind === "textValue") return undefined;
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = descendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function descendants(
  nodes: readonly OoxmlNode[],
  predicate: (candidate: OoxmlElement) => boolean,
): readonly OoxmlElement[] {
  const found: OoxmlElement[] = [];
  const seen = new Set<string>();
  const visit = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    if (predicate(node) && !seen.has(node.id)) {
      seen.add(node.id);
      found.push(node);
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return found;
}

function imageRoots(nodes: readonly OoxmlNode[]): readonly OoxmlElement[] {
  const roots: OoxmlElement[] = [];
  const seen = new Set<string>();
  const visit = (node: OoxmlNode) => {
    if (node.kind === "textValue") return;
    if (
      node.namespaceUri === W &&
      (node.localName === "drawing" || node.localName === "pict")
    ) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        roots.push(node);
      }
      return;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return roots;
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function vmlLength(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(pt|in|cm|mm|px)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  const emuPerUnit: Record<string, number> = {
    pt: 12_700,
    in: 914_400,
    cm: 360_000,
    mm: 36_000,
    px: 9_525,
  };
  return Math.round(amount * emuPerUnit[unit]!);
}

function vmlExtent(shape: OoxmlElement): {
  readonly widthEmu?: number;
  readonly heightEmu?: number;
} {
  const dimensions = new Map<string, number>();
  for (const declaration of (attribute(shape, "", "style") ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim().toLowerCase();
    const value = vmlLength(declaration.slice(separator + 1));
    if ((key === "width" || key === "height") && value !== undefined) {
      dimensions.set(key, value);
    }
  }
  return {
    ...(dimensions.has("width") ? { widthEmu: dimensions.get("width") } : {}),
    ...(dimensions.has("height")
      ? { heightEmu: dimensions.get("height") }
      : {}),
  };
}

function imageReference(node: OoxmlNode): ImageReference | null {
  if (
    node.kind === "textValue" ||
    node.namespaceUri !== W ||
    (node.localName !== "drawing" && node.localName !== "pict")
  ) {
    return null;
  }

  if (node.localName === "drawing") {
    const blips = descendants(
      [node],
      (candidate) => candidate.namespaceUri === A && candidate.localName === "blip",
    );
    if (blips.length !== 1) return null;
    const blip = blips[0]!;
    const docPr = descendant(
      node,
      (candidate) => candidate.namespaceUri === WP && candidate.localName === "docPr",
    );
    const extent = descendant(
      node,
      (candidate) => candidate.namespaceUri === WP && candidate.localName === "extent",
    );
    const linked = attribute(blip, R, "link");
    const relationshipId = linked ?? attribute(blip, R, "embed");
    return {
      ...(relationshipId === undefined ? {} : { relationshipId }),
      external: linked !== undefined || relationshipId === undefined,
      ...(docPr
        ? {
            ...(attribute(docPr, "", "descr") ?? attribute(docPr, "", "title")
              ? {
                  description:
                    attribute(docPr, "", "descr") ??
                    attribute(docPr, "", "title"),
                }
              : {}),
          }
        : {}),
      ...(extent
        ? {
            ...(positive(attribute(extent, "", "cx")) === undefined
              ? {}
              : { widthEmu: positive(attribute(extent, "", "cx")) }),
            ...(positive(attribute(extent, "", "cy")) === undefined
              ? {}
              : { heightEmu: positive(attribute(extent, "", "cy")) }),
          }
        : {}),
    };
  }

  const imageData = descendants(
    [node],
    (candidate) => candidate.namespaceUri === V && candidate.localName === "imagedata",
  );
  if (imageData.length !== 1) return null;
  const image = imageData[0]!;
  const relationshipId =
    attribute(image, R, "id") ?? attribute(image, O, "relid");
  const externalSource =
    attribute(image, "", "src") ?? attribute(image, O, "src");
  const shape = descendant(
    node,
    (candidate) => candidate.namespaceUri === V && candidate.localName === "shape",
  );
  const description =
    attribute(image, O, "title") ??
    (shape ? attribute(shape, O, "title") : undefined);
  return {
    ...(relationshipId === undefined ? {} : { relationshipId }),
    external: externalSource !== undefined || relationshipId === undefined,
    ...(description ? { description } : {}),
    ...(shape ? vmlExtent(shape) : {}),
  };
}

function resolveMetadata(
  nodes: readonly OoxmlNode[],
  source: OoxmlPackage,
  ownerPart: string,
): ImageMetadata {
  const roots = imageRoots(nodes);
  if (roots.length !== 1) {
    throw new DocxImageReadError(
      "not-image",
      -1,
      roots.length === 0
        ? "The object does not contain a DrawingML or VML image reference."
        : "The object contains more than one image and cannot be read as one image.",
    );
  }
  const reference = imageReference(roots[0]!);
  if (!reference) {
    throw new DocxImageReadError(
      "not-image",
      -1,
      "The object does not contain a DrawingML or VML image reference.",
    );
  }
  if (reference.external || reference.relationshipId === undefined) {
    throw new DocxImageReadError(
      "external-image",
      -1,
      "External image targets are not read from this document.",
    );
  }
  const resolved = resolveImageRelationship(
    source.relationships.get(ownerPart),
    ownerPart,
    reference.relationshipId,
  );
  if (resolved.mode === "missing") {
    throw new DocxImageReadError(
      "relationship-missing",
      -1,
      `The image relationship ${reference.relationshipId} is missing or is not an image relationship.`,
    );
  }
  if (resolved.mode === "external") {
    throw new DocxImageReadError(
      "external-image",
      -1,
      "External image targets are not read from this document.",
    );
  }
  const bytes = source.partBytes.get(resolved.partName);
  if (!bytes) {
    throw new DocxImageReadError(
      "media-missing",
      -1,
      `The image media part ${resolved.partName} is missing.`,
    );
  }
  const mimeType = sniffImageMime(bytes);
  if (mimeType === "unknown") {
    throw new DocxImageReadError(
      "unsupported-media",
      -1,
      `The image media part ${resolved.partName} has an unsupported binary format.`,
    );
  }
  return {
    relationshipId: reference.relationshipId,
    mediaPart: resolved.partName,
    contentType: resolveContentTypeOf(source, resolved.partName) ?? mimeType,
    mimeType,
    byteLength: bytes.byteLength,
    ...(reference.description === undefined
      ? {}
      : { description: reference.description }),
    ...(reference.widthEmu === undefined
      ? {}
      : { widthEmu: reference.widthEmu }),
    ...(reference.heightEmu === undefined
      ? {}
      : { heightEmu: reference.heightEmu }),
  };
}

export function imageAtomPayload(input: {
  readonly nodes: readonly OoxmlNode[];
  readonly source: OoxmlPackage;
  readonly ownerPart: string;
  readonly paragraphRef: string;
  readonly objectRef: string;
  readonly revision: number;
}): DocxImageAtomProjection {
  const route = {
    tool: "read_docx_image",
    arguments: {
      paragraph_ref: input.paragraphRef,
      object_ref: input.objectRef,
      expected_revision: input.revision,
    },
  } as const;
  try {
    const metadata = resolveMetadata(input.nodes, input.source, input.ownerPart);
    return {
      readable: true,
      complete: false,
      payload: {
        contentStatus: "not_inspected",
        relationshipId: metadata.relationshipId,
        mediaPart: metadata.mediaPart,
        contentType: metadata.contentType,
        byteLength: metadata.byteLength,
        ...(metadata.description === undefined
          ? {}
          : { description: metadata.description }),
        ...(metadata.widthEmu === undefined
          ? {}
          : { widthEmu: metadata.widthEmu }),
        ...(metadata.heightEmu === undefined
          ? {}
          : { heightEmu: metadata.heightEmu }),
        next: route,
      },
    };
  } catch (error) {
    if (!(error instanceof DocxImageReadError)) throw error;
    return {
      readable: false,
      complete: false,
      payload: {
        contentStatus: "not_inspected",
        error: { code: error.code, message: error.message },
        next: route,
      },
    };
  }
}

export function readDocxImageObject(input: {
  readonly nodes: readonly OoxmlNode[];
  readonly source: OoxmlPackage;
  readonly ownerPart: string;
  readonly objectRef: string;
  readonly revision: number;
}): DocxImageReadResult {
  try {
    const metadata = resolveMetadata(input.nodes, input.source, input.ownerPart);
    const bytes = input.source.partBytes.get(metadata.mediaPart)!;
    return {
      revision: input.revision,
      objectRef: input.objectRef,
      part: input.ownerPart,
      relationshipId: metadata.relationshipId,
      mediaPart: metadata.mediaPart,
      mimeType: metadata.mimeType,
      bytes: new Uint8Array(bytes),
      ...(metadata.description === undefined
        ? {}
        : { description: metadata.description }),
      ...(metadata.widthEmu === undefined
        ? {}
        : { widthEmu: metadata.widthEmu }),
      ...(metadata.heightEmu === undefined
        ? {}
        : { heightEmu: metadata.heightEmu }),
    };
  } catch (error) {
    if (error instanceof DocxImageReadError) {
      throw new DocxImageReadError(
        error.code,
        input.revision,
        error.message,
      );
    }
    throw error;
  }
}
