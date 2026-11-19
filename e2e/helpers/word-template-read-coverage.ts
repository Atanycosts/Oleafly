import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface TemplateReadPage {
  request: Record<string, unknown>;
  data: Record<string, unknown>;
  callIds: string[];
}

export interface TemplateReadInventory {
  source_sha256: string;
  objects: readonly unknown[];
  style_definitions?: readonly unknown[];
  [key: string]: unknown;
}

// Acceptance's independent statement of the effective-v1 omission boundary.
const omittedPointers = [
  "/declared",
  "/properties/paragraph/props",
  "/properties/paragraph/inheritedRunProperties",
  "/properties/paragraph/markRunProperties",
  "/properties/paragraph/tabStopsCacheToken",
  "/properties/run_properties",
] as const;
const sharedFields = ["properties", "region", "evidence", "role_basis"] as const;
const collections = ["objects", "style_definitions"] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function requireEqual(actual: unknown, expected: unknown, message: string) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
}

function effectiveExpected(item: unknown) {
  const expected = structuredClone(object(item));
  for (const pointer of omittedPointers) {
    const path = pointer.slice(1).split("/");
    let parent: Record<string, unknown> | undefined = expected;
    for (const key of path.slice(0, -1)) {
      const next: unknown = parent?.[key];
      parent = next && typeof next === "object" && !Array.isArray(next)
        ? next as Record<string, unknown> : undefined;
    }
    if (parent) delete parent[path[path.length - 1]];
  }
  return expected;
}

function metadata(snapshot: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) =>
    key !== "objects" && key !== "style_definitions" && key !== "shared"));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function checkReadPointer(
  value: unknown,
  expected: { world: string; source: string; collection: string; offset: number; detail: string },
) {
  const pointer = object(value);
  const args = object(pointer.arguments);
  requireEqual(pointer.tool, "journal_read", "Read pointer has another tool");
  for (const [key, wanted] of Object.entries({ operation: "format", format_operation: "snapshot",
    world_version_id: expected.world, collection: expected.collection, offset: expected.offset,
    detail: expected.detail, expected_source_sha256: expected.source })) {
    requireEqual(args[key], wanted, `Read pointer ${key} differs`);
  }
  for (const key of ["json_offset", "json_limit", "expected_json_sha256"]) {
    if (Object.hasOwn(args, key)) throw new Error(`Read pointer retains page-specific ${key}`);
  }
  return args;
}

export function collectTemplateReadCoverage(
  pages: readonly TemplateReadPage[],
  inventory: TemplateReadInventory,
  worldVersionId: string,
) {
  const expectedMetadata = metadata(inventory);
  const expectedMetadataSha256 = createHash("sha256").update(canonical(expectedMetadata)).digest("hex");
  const groups = new Map(collections.map(collection => [collection, {
    expected: inventory[collection] ?? [],
    indexes: new Set<number>(),
    metadataRead: false,
    closed: false,
    pageReceipts: [] as { offset: number; delivered: number; projection: string; callIds: string[] }[],
  }]));
  const rejectedPages: { callIds: string[]; reason: string }[] = [];

  for (const page of pages) {
    try {
      const { data, request } = page;
      requireEqual(request.world_version_id, worldVersionId, "Template world differs");
      requireEqual(data.source_sha256, inventory.source_sha256, "Template source differs");
      const collection = data.collection ?? request.collection ?? "objects";
      if (collection !== "objects" && collection !== "style_definitions") throw new Error("Unknown template collection");
      requireEqual(request.collection ?? "objects", collection, "Requested and delivered collections differ");
      const group = groups.get(collection)!;
      const snapshot = object(data.snapshot);
      const rows = snapshot[collection];
      if (!Array.isArray(rows)) throw new Error("Template collection is missing");
      const effective = data.projection === "effective";
      const offset = effective ? data.offset : request.offset ?? 0;
      if (!Number.isInteger(offset) || typeof offset !== "number" || offset < 0) throw new Error("Invalid page offset");
      requireEqual(request.offset ?? 0, offset, "Requested and delivered page offsets differ");
      requireEqual(data.total, group.expected.length, "Page total differs from the independent inventory");
      if (offset + rows.length > group.expected.length) throw new Error("Page extends beyond the independent inventory");

      if (effective) {
        requireEqual(request.detail, "effective", "Effective projection was not explicitly selected");
        requireEqual(data.projection_version, 1, "Unknown effective projection version");
        requireEqual(data.delivered, rows.length, "Delivered count differs from actual records");
        requireEqual(data.omitted_fields, [...omittedPointers], "Omission boundary differs from effective-v1");
        requireEqual(data.metadata_sha256, expectedMetadataSha256, "Metadata digest differs from the independent inventory");
        if (offset === 0) {
          requireEqual(metadata(snapshot), expectedMetadata, "First-page metadata differs or is incomplete");
        } else {
          if (!group.metadataRead) throw new Error("Referenced first-page metadata was not read");
          requireEqual(metadata(snapshot), {}, "Later page unexpectedly embeds different metadata");
          const reference = object(data.metadata_ref);
          for (const [key, wanted] of Object.entries({ source_sha256: inventory.source_sha256,
            projection: "effective", projection_version: 1, metadata_sha256: expectedMetadataSha256 })) {
            requireEqual(reference[key], wanted, `Metadata reference ${key} differs`);
          }
          const metadataArgs = checkReadPointer(reference.read, { world: worldVersionId,
            source: inventory.source_sha256, collection, offset: 0, detail: "effective" });
          requireEqual(metadataArgs.limit, 50, "Metadata read pointer has another page limit");
        }
        const fullArgs = checkReadPointer(data.full_read, { world: worldVersionId,
          source: inventory.source_sha256, collection, offset, detail: "full" });
        requireEqual(fullArgs.limit, 1, "Full-read pointer is not an individual record read");
        requireEqual(object(data.full_read).end_offset, offset + rows.length, "Full-read range differs");
      } else {
        requireEqual(metadata(snapshot), expectedMetadata, "Full snapshot metadata differs");
      }

      const shared = effective ? object(snapshot.shared) : undefined;
      if (shared) for (const field of sharedFields) {
        if (!Array.isArray(shared[field])) throw new Error(`Missing ${field} dictionary`);
      }
      const delivered: number[] = [];
      for (const [index, row] of rows.entries()) {
        const decoded = { ...object(row) };
        if (shared) for (const field of sharedFields) {
          const key = `${field}_ref`;
          if (!Object.hasOwn(decoded, key)) continue;
          const dictionary = shared[field];
          const reference = decoded[key];
          if (!Array.isArray(dictionary) || typeof reference !== "number"
            || !Number.isInteger(reference) || reference < 0 || reference >= dictionary.length) {
            throw new Error(`Invalid ${key}; missing dictionaries never denote empty facts`);
          }
          if (Object.hasOwn(decoded, field)) throw new Error(`Both ${field} and its reference were delivered`);
          decoded[field] = dictionary[reference];
          delete decoded[key];
        }
        requireEqual(decoded, effective ? effectiveExpected(group.expected[offset + index]) : group.expected[offset + index],
          `Record ${collection}[${offset + index}] identity, text or effective facts differ`);
        delivered.push(offset + index);
      }
      const end = offset + rows.length;
      requireEqual(data.next_offset, end < group.expected.length ? end : null, "Page next_offset does not describe the delivered records");
      requireEqual(data.has_more, end < group.expected.length, "Page has_more differs from actual delivered range");
      if (offset === 0) group.metadataRead = true;
      for (const index of delivered) group.indexes.add(index);
      if (data.next_offset === null) group.closed = true;
      group.pageReceipts.push({ offset, delivered: rows.length, projection: effective ? "effective" : "full", callIds: page.callIds });
    } catch (error) {
      rejectedPages.push({ callIds: page.callIds, reason: String(error) });
    }
  }
  const result = collections.map(collection => {
    const group = groups.get(collection)!;
    const missingObjectIds = group.expected.flatMap((value, index) => group.indexes.has(index)
      ? [] : [String(object(value).object_id)]);
    return { collection, expected: group.expected.length, observed: group.indexes.size,
      metadataRead: group.metadataRead, closed: group.closed, missingObjectIds, pages: group.pageReceipts };
  });
  const gaps = result.flatMap(group => [
    ...(!group.metadataRead ? [`Template ${group.collection} first-page metadata was not read`] : []),
    ...(!group.closed ? [`Template ${group.collection} pagination did not close`] : []),
    ...(group.observed !== group.expected ? [`Template ${group.collection} inventory coverage ${group.observed}/${group.expected}`] : []),
  ]);
  return { complete: gaps.length === 0, gaps, rejectedPages, sourceSha256: inventory.source_sha256,
    metadataSha256: expectedMetadataSha256, collections: result };
}
