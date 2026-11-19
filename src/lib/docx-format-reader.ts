import { DOCX_READ_MAX_CHARS, type DocxFormatReadQuery, type DocxFormatReadResult } from "@oleafly/ai-tools";
import type { DocxParagraph, DocxSession } from "./docx-session";
import { openDocxFormatFacts } from "./docx-format";
import type { DocxFormatFacts, DocxFormatObject, DocxFormatStyleDefinition } from "./docx-format-types";

interface ReaderOptions {
  session: DocxSession;
  exportBytes(): Promise<ArrayBuffer | Uint8Array | null | undefined>;
  document(): Omit<DocxFormatReadResult["document"], "sessionRevision" | "dirty">;
  openFacts?: typeof openDocxFormatFacts;
}

type VersionedReadQuery = Record<string, unknown> & { expected_revision: number };
type VersionedReadResult = DocxFormatReadResult & { nextQuery: VersionedReadQuery | null };

const withinPath = (path: readonly number[], prefix?: readonly number[]) =>
  !prefix || prefix.every((value, index) => path[index] === value);
const locatorKey = (part: string, path: readonly number[]) => `${part}#${path.join(".")}`;
// The Agent packs JSON by serialized character count, including escaped text.
// Leave room for identity, selectors and continuation metadata around each record.
const jsonSize = (value: unknown) => JSON.stringify(value).length;
const RECORD_CHARS = 6000;
const FRAGMENT_CHARS = 4000;
function textSlice(text: string, offset: number, limit: number) {
  let start = Math.min(offset, text.length);
  let end = Math.min(start + limit, text.length);
  const low = (index: number) => text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (start > 0 && low(start)) start -= 1;
  if (end < text.length && low(end)) end = end - 1 === start ? end + 1 : end - 1;
  return { text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null };
}

/** Reuses exported facts and live paragraph addresses within one session revision. */
export function createDocxFormatReader({ session, exportBytes, document, openFacts = openDocxFormatFacts }: ReaderOptions) {
  let cache: {
    revision: number;
    promise: Promise<DocxFormatFacts>;
    live?: {
      paragraphs: readonly DocxParagraph[];
      factParagraphs: DocxFormatObject[];
      liveByLocator: Map<string, DocxParagraph>;
      liveIndexByRef: Map<string, number>;
      objectById: Map<string, DocxFormatObject>;
    };
  } | undefined;
  const assertRevision = (revision: number) => {
    if (session.revision() !== revision) throw new Error("The DOCX session changed while its formatting was read. Read it again.");
  };
  return async (query: DocxFormatReadQuery = {}): Promise<VersionedReadResult> => {
    const atRevision = session.revision();
    const expectedRevision = query.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0))
      throw new Error("DOCX expectedRevision must be a nonnegative integer.");
    if (expectedRevision !== undefined && expectedRevision !== atRevision)
      throw new Error(`The DOCX format continuation is stale: it was created for revision ${expectedRevision}, but the document is now at revision ${atRevision}. Read the document again.`);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 20;
    const textOffset = query.textOffset ?? 0;
    const textLimit = query.textLimit ?? 4000;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("DOCX read offset must be a nonnegative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("DOCX read limit must be an integer from 1 to 50.");
    if (!Number.isInteger(textOffset) || textOffset < 0) throw new Error("DOCX textOffset must be a nonnegative UTF-16 offset.");
    if (!Number.isInteger(textLimit) || textLimit < 1 || textLimit > 16000) throw new Error("DOCX textLimit must be an integer from 1 to 16000.");
    if (!cache || cache.revision !== atRevision) {
      const pending = (async () => {
        const bytes = await exportBytes();
        assertRevision(atRevision);
        if (!bytes) throw new Error("The DOCX editor did not export its live content.");
        const facts = await openFacts(new Uint8Array(bytes));
        assertRevision(atRevision);
        return facts;
      })();
      cache = { revision: atRevision, promise: pending };
      void pending.catch(() => { if (cache?.promise === pending) cache = undefined; });
    }
    const currentCache = cache;
    const facts = await currentCache.promise;
    assertRevision(atRevision);
    const identity = document();
    const state = { ...identity, sessionRevision: atRevision, dirty: atRevision !== identity.savedRevision };
    const bound = { document: state, sourceSha256: facts.snapshot.source_sha256, revision: atRevision };
    const kind = query.kind ?? "objects";
    const continuationQuery = (nextOffset: number): VersionedReadQuery => ({
      kind,
      ...(query.part !== undefined ? { part: query.part } : {}),
      ...(query.path !== undefined ? { path: query.path } : {}),
      ...(query.paragraphRef !== undefined ? { paragraph_ref: query.paragraphRef } : {}),
      ...(query.objectKind !== undefined ? { object_kind: query.objectKind } : {}),
      ...(query.objectId !== undefined ? { object_id: query.objectId } : {}),
      ...(query.styleId !== undefined ? { style_id: query.styleId } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.text !== undefined ? { text: query.text } : {}),
      ...(query.namespaceUri !== undefined ? { namespace_uri: query.namespaceUri } : {}),
      ...(query.localName !== undefined ? { local_name: query.localName } : {}),
      ...(query.attribute !== undefined ? { attribute: {
        ...(query.attribute.namespaceUri !== undefined ? { namespace_uri: query.attribute.namespaceUri } : {}),
        local_name: query.attribute.localName,
        ...(query.attribute.value !== undefined ? { value: query.attribute.value } : {}),
      } } : {}),
      ...(query.textOffset !== undefined ? { text_offset: query.textOffset } : {}),
      ...(query.textLimit !== undefined ? { text_limit: query.textLimit } : {}),
      offset: nextOffset,
      limit,
      expected_revision: atRevision,
    });
    const boundedRecord = <T extends Record<string, unknown>>(record: T, read: Record<string, unknown>): T | Record<string, unknown> => {
      if (jsonSize(record) <= RECORD_CHARS) return record;
      const serialized = JSON.stringify(record);
      let length = Math.min(textLimit, 4000);
      let slice = textSlice(serialized, textOffset, length);
      while (jsonSize(slice.text) > FRAGMENT_CHARS && length > 1) { length = Math.max(1, Math.floor(length / 2)); slice = textSlice(serialized, textOffset, length); }
      return { object_id: record.object_id, recordJson: slice.text, recordJsonOffset: slice.offset, recordJsonLength: serialized.length,
        recordJsonContinuation: slice.nextOffset === null ? null : { ...read, offset: 0, limit: 1, text_offset: slice.nextOffset,
          text_limit: textLimit, expected_revision: atRevision } };
    };
    const page = <T,>(
      items: T[],
      start: number,
      total: number,
      position: number,
      render: (values: T[], nextOffset: number | null) => unknown,
    ) => {
      const values: T[] = [];
      for (const item of items.slice(start, start + limit)) {
        const candidate = [...values, item];
        const nextOffset = position + candidate.length < total ? position + candidate.length : null;
        if (values.length && jsonSize(render(candidate, nextOffset)) > DOCX_READ_MAX_CHARS) break;
        values.push(item);
      }
      return { values, total, nextOffset: position + values.length < total ? position + values.length : null };
    };
    const matchesFacts = (object: DocxFormatObject | DocxFormatStyleDefinition) =>
      (!query.part || object.part === query.part) && withinPath(object.path, query.path) &&
      (!query.role || object.role === query.role) && (!query.styleId || object.style_id === query.styleId) &&
      (!query.objectId || object.object_id === query.objectId) &&
      (!query.objectKind || ("kind" in object ? object.kind : "style") === query.objectKind) &&
      (query.text === undefined || ("name" in object ? `${object.style_id} ${object.name ?? ""}` : object.text ?? "").includes(query.text));
    if (kind === "nodes") {
      // Package selectors do not need live paragraph handles.
      const selected = facts.query({ kind: "nodes", part: query.part, path: query.path, namespace_uri: query.namespaceUri,
        local_name: query.localName, attribute: query.attribute && { namespace_uri: query.attribute.namespaceUri, local_name: query.attribute.localName, value: query.attribute.value }, offset, limit });
      if (selected.kind !== "nodes") throw new Error("The format reader did not return nodes.");
      const projected = selected.nodes.map(({ node, ...locator }) => {
        const { children, ...properties } = node;
        const textValues = Array.isArray(children) ? children.filter((child) => child && typeof child === "object" && !Array.isArray(child) && child.kind === "textValue") : [];
        const shallow = { ...properties, ...(textValues.length ? { textValues } : {}) };
        const serialized = JSON.stringify(shallow);
        if (jsonSize(shallow) > FRAGMENT_CHARS) {
          let length = Math.min(textLimit, 4000);
          let slice = textSlice(serialized, textOffset, length);
          while (jsonSize(slice.text) > FRAGMENT_CHARS && length > 1) { length = Math.max(1, Math.floor(length / 2)); slice = textSlice(serialized, textOffset, length); }
          return { ...locator, nodeJson: slice.text, nodeJsonOffset: slice.offset, nodeJsonLength: serialized.length,
            nodeJsonContinuation: slice.nextOffset === null ? null : { kind: "nodes", part: locator.part, path: locator.path,
              offset: 0, limit: 1, text_offset: slice.nextOffset, text_limit: textLimit, expected_revision: atRevision },
            childCount: Array.isArray(children) ? children.length : 0, childrenOmitted: true, addressing: "export_evidence_only" };
        }
        return { ...locator, node: shallow, childCount: Array.isArray(children) ? children.length : 0,
          childrenOmitted: true, addressing: "export_evidence_only",
          readPartNodes: { kind: "nodes", part: locator.part, offset: 0, limit, expected_revision: atRevision } };
      });
      // selected already begins at the requested offset; bound its projected bytes without applying offset twice.
      const selectedValues = page(projected, 0, selected.total, offset, (values, nextOffset) => ({
        ...bound, nodes: values, total: selected.total, nextOffset,
        nextQuery: nextOffset === null ? null : continuationQuery(nextOffset),
      }));
      return { ...bound, nodes: selectedValues.values, total: selectedValues.total, nextOffset: selectedValues.nextOffset,
        nextQuery: selectedValues.nextOffset === null ? null : continuationQuery(selectedValues.nextOffset) };
    }
    if (kind === "styles") {
      const candidates = (facts.snapshot.style_definitions ?? []).filter((style) => matchesFacts(style) && !query.paragraphRef).map((style) => boundedRecord({ ...style,
        declared: jsonSize(style.declared ?? {}) > 2000 ? { omitted: true,
          read: { kind: "nodes", part: style.part, path: style.path, offset: 0, limit: 1, expected_revision: atRevision } } : style.declared,
        source: { part: style.part, path: style.path, objectId: style.object_id, addressing: "export_evidence_only" } },
      { kind: "styles", object_id: style.object_id }));
      const selected = page(candidates, offset, candidates.length, offset, (values, nextOffset) => ({
        ...bound, styles: values, total: candidates.length, nextOffset,
        nextQuery: nextOffset === null ? null : continuationQuery(nextOffset),
      }));
      return { ...bound, styles: selected.values,
        total: selected.total, nextOffset: selected.nextOffset,
        nextQuery: selected.nextOffset === null ? null : continuationQuery(selected.nextOffset) };
    }
    if (!currentCache.live) {
      const paragraphs = session.listParagraphs();
      const factParagraphs = facts.snapshot.objects.filter((object) => object.kind === "paragraph");
      const factParagraphsByPart = new Map<string, DocxFormatObject[]>();
      for (const object of factParagraphs) {
        const entries = factParagraphsByPart.get(object.part) ?? [];
        entries.push(object);
        factParagraphsByPart.set(object.part, entries);
      }
      const liveByLocator = new Map(paragraphs.flatMap((paragraph) => {
        const locator = session.paragraphLocator?.(paragraph.handle);
        if (!locator) return [];
        const object = locator.paragraphIndex === undefined ? undefined :
          factParagraphsByPart.get(locator.part)?.[locator.paragraphIndex];
        return [[locatorKey(locator.part, object?.path ?? locator.path), paragraph] as const];
      }));
      assertRevision(atRevision);
      currentCache.live = { paragraphs, factParagraphs, liveByLocator,
        liveIndexByRef: new Map(paragraphs.map((paragraph, index) => [paragraph.handle.ref, index])),
        objectById: new Map(facts.snapshot.objects.map((object) => [object.object_id, object])) };
    }
    const { paragraphs, factParagraphs, liveByLocator, liveIndexByRef, objectById } = currentCache.live;
    const ownerParagraph = (object: DocxFormatObject) => {
      if (object.kind === "paragraph") return object;
      const id = object.evidence.paragraph_object_id;
      if (typeof id === "string") return objectById.get(id);
      return facts.snapshot.objects.find((candidate) => candidate.kind === "paragraph" && candidate.part === object.part &&
        withinPath(object.path, candidate.path));
    };
    const liveParagraph = (object: DocxFormatObject) => {
      const owner = ownerParagraph(object);
      return owner ? liveByLocator.get(locatorKey(owner.part, owner.path)) : undefined;
    };
    const selectedParagraph = query.paragraphRef ? paragraphs.find((paragraph) => paragraph.handle.ref === query.paragraphRef) : undefined;
    if (query.paragraphRef && !selectedParagraph) throw new Error("The DOCX paragraph is no longer present.");
    const selectedObject = selectedParagraph && factParagraphs.find((object) => liveParagraph(object)?.handle.ref === selectedParagraph.handle.ref);
    if (selectedParagraph && !selectedObject) throw new Error("The live paragraph could not be located in its exported format facts. Read the document objects instead.");
    const matches = (object: DocxFormatObject | DocxFormatStyleDefinition) => matchesFacts(object) &&
      (!selectedObject || object.object_id === selectedObject.object_id ||
        ("evidence" in object && object.evidence.paragraph_object_id === selectedObject.object_id));
    const linkedObject = (object: DocxFormatObject) => {
      const live = liveParagraph(object);
      const declared = jsonSize(object.declared) <= 2000 ? object.declared : {
        omitted: true, reason: "Declaration exceeds the live read window; read shallow source nodes.",
        read: { kind: "nodes", part: object.part, path: object.path, offset: 0, limit: 1, expected_revision: atRevision },
      };
      return { ...object, declared, ...(live ? { paragraphRef: live.handle.ref } : {}),
        ...(object.text && object.text.length > textLimit ? { text: textSlice(object.text, 0, textLimit).text,
          textTruncated: true, textLength: object.text.length,
          readText: { kind: "paragraphs", object_id: ownerParagraph(object)?.object_id, text_offset: 0, text_limit: textLimit, limit: 1,
            expected_revision: atRevision } } : {}),
        source: { part: object.part, path: object.path, objectId: object.object_id, addressing: "export_evidence_only" },
        liveAddressing: live ? "paragraphRef" : "unavailable" };
    };
    if (kind === "paragraphs") {
      const candidates = facts.snapshot.objects.filter((object) => object.kind === "paragraph" && matches(object));
      const projected = candidates.slice(offset, offset + limit).map((object) => {
        const live = liveParagraph(object);
        const modelText = live && session.readParagraphModelText?.(live.handle);
        const text = modelText ?? object.text ?? "";
        const { declared: _declared, ...linked } = linkedObject(object);
        const contentRead = live ? { tool: "read_docx_document", arguments: {
          offset: liveIndexByRef.get(live.handle.ref), limit: 1, expected_revision: atRevision,
        } } : undefined;
        const contentCoverage = { projection: "addressing_text", semanticAtomsIncluded: false,
          detail: "Object placeholders are edit coordinates. Read the document's inline atoms for fields, formula structures and image reading routes." };
        // A record page and a paragraph text page use the same public text_offset field.
        // Choose the record representation from stable metadata before slicing any text.
        if (jsonSize({ ...linked, text: "" }) > FRAGMENT_CHARS) {
          return boundedRecord({ ...linked, text, textOffset: 0, textLength: text.length, textTruncated: false,
            contentCoverage, ...(contentRead ? { contentRead } : {}),
            declared: { omitted: true, read: { kind: "nodes", part: object.part, path: object.path, limit: 1, expected_revision: atRevision } },
            ...(modelText !== undefined ? { modelText, modelTextOffset: 0, modelTextLength: text.length,
              offsets: { unit: "utf16", interval: "half_open", projection: "model", origin: "complete_paragraph", revision: atRevision } } : {}),
            textContinuation: null, textProjection: modelText !== undefined ? "model" : "export_text", modelTextAddressable: modelText !== undefined,
            ...(modelText !== undefined ? { rangeWritePolicy: "protected_plain_text" } : {}),
          }, { kind: "paragraphs", object_id: object.object_id });
        }
        let length = textLimit;
        let slice = textSlice(text, textOffset, length);
        const project = () => ({ ...linked, declared: { omitted: true,
          read: { kind: "nodes", part: object.part, path: object.path, limit: 1, expected_revision: atRevision } },
          text: slice.text, textOffset: slice.offset, textLength: text.length,
          contentCoverage, ...(contentRead ? { contentRead } : {}),
          textTruncated: slice.offset > 0 || slice.nextOffset !== null,
          ...(modelText !== undefined ? { modelText: slice.text, modelTextOffset: slice.offset, modelTextLength: text.length,
            offsets: { unit: "utf16", interval: "half_open", projection: "model", origin: "complete_paragraph", revision: atRevision } } : {}),
          textContinuation: slice.nextOffset === null ? null : { kind: "paragraphs", object_id: object.object_id,
            offset: 0, limit: 1, text_offset: slice.nextOffset, text_limit: textLimit, expected_revision: atRevision },
          textProjection: modelText !== undefined ? "model" : "export_text", modelTextAddressable: modelText !== undefined,
          ...(modelText !== undefined ? { rangeWritePolicy: "protected_plain_text" } : {}) });
        while (jsonSize({ ...bound, paragraphs: [project()], nextQuery: continuationQuery(offset + 1) }) > DOCX_READ_MAX_CHARS && length > 1) {
          length = Math.max(1, Math.floor(length / 2)); slice = textSlice(text, textOffset, length);
        }
        return project();
      });
      const selected = page(projected, 0, candidates.length, offset, (values, nextOffset) => ({
        ...bound, paragraphs: values, total: candidates.length, nextOffset,
        nextQuery: nextOffset === null ? null : continuationQuery(nextOffset),
      }));
      return { ...bound, paragraphs: selected.values, total: selected.total, nextOffset: selected.nextOffset,
        nextQuery: selected.nextOffset === null ? null : continuationQuery(selected.nextOffset) };
    }
    if (kind === "overview") {
      const directory = facts.snapshot.objects.filter((object) => ["story", "section", "table"].includes(object.kind) ||
        object.kind === "paragraph" && object.properties.paragraph &&
        (object.properties.paragraph as Record<string, unknown>).outlineLevel !== null &&
        (object.properties.paragraph as Record<string, unknown>).outlineLevel !== undefined).filter(matches);
      const directoryItems = directory.map((object) => ({ objectId: object.object_id, kind: object.kind, role: object.role,
        part: object.part, path: object.path, text: object.text?.slice(0, 160),
        read: { kind: "objects", object_id: object.object_id, offset: 0, limit, expected_revision: atRevision } }));
      const countBy = (field: "kind" | "part") => Object.fromEntries([...new Set(facts.snapshot.objects.map((object) => object[field]))]
        .map((value) => [value, facts.snapshot.objects.filter((object) => object[field] === value).length]));
      const byPart = new Map<string, { total: number; live: number; exportOnly: number; table: number; tableLive: number; unknown: number }>();
      const exportOnlyByPart = new Map<string, number>();
      const byRole: Record<string, number> = {};
      let liveCount = 0;
      let tableCount = 0;
      let tableLiveCount = 0;
      for (const paragraph of factParagraphs) {
        const part = byPart.get(paragraph.part) ?? { total: 0, live: 0, exportOnly: 0, table: 0, tableLive: 0, unknown: 0 };
        const live = liveParagraph(paragraph) !== undefined;
        const table = paragraph.evidence.in_table_cell === true;
        part.total += 1;
        if (live) {
          part.live += 1;
          liveCount += 1;
        } else {
          part.exportOnly += 1;
          exportOnlyByPart.set(paragraph.part, (exportOnlyByPart.get(paragraph.part) ?? 0) + 1);
        }
        if (table) {
          part.table += 1;
          tableCount += 1;
          if (live) {
            part.tableLive += 1;
            tableLiveCount += 1;
          }
        }
        if (paragraph.role === "unknown") part.unknown += 1;
        byPart.set(paragraph.part, part);
        byRole[paragraph.role] = (byRole[paragraph.role] ?? 0) + 1;
      }
      const exportOnly = factParagraphs.filter((paragraph) => !liveParagraph(paragraph));
      const counts = { objects: facts.snapshot.objects.length, paragraphs: facts.snapshot.objects.filter((object) => object.kind === "paragraph").length,
        liveParagraphs: paragraphs.length, styles: facts.snapshot.style_definitions?.length ?? 0, parts: facts.snapshot.parts.length,
        byKind: countBy("kind"), byPart: countBy("part") };
      const countUnits = { unsupported_node: "xml_node",
        detail: "unsupported_node and structural_only count retained XML nodes, including descendants of formulas and drawings. They do not count failed semantic objects or lost content." };
      const coverage = { paragraphs: {
        total: factParagraphs.length, live: liveCount, exportOnly: exportOnly.length,
        table: tableCount, tableLive: tableLiveCount,
        byRole: Object.fromEntries(Object.entries(byRole).sort(([left], [right]) => left.localeCompare(right))),
        byPart: Object.fromEntries([...byPart].sort(([left], [right]) => left.localeCompare(right))),
      } };
      const capabilities = { ...facts.snapshot.capabilities, liveParagraphRefs: true, modelTextOffsets: "utf16_half_open", rawPathsWritable: false };
      const gaps = [...facts.snapshot.unsupported.map((gap) => ({ code: gap.code, detail: gap.detail, count: gap.object_ids.length,
          ...(gap.code === "structural_only" ? { unit: "xml_node", semanticReading: "read_docx_document" } : {}),
          exampleObjectIds: gap.object_ids.slice(0, 5),
          read: { kind: "objects", object_id: gap.object_ids[0], offset: 0, limit, expected_revision: atRevision } })),
          ...(exportOnly.length ? [{ code: "live_handle_coverage", detail: "Exported stories without a live paragraphRef are readable; their raw paths are not write addresses.",
            count: exportOnly.length, byPart: Object.fromEntries([...exportOnlyByPart].sort(([left], [right]) => left.localeCompare(right))),
            exampleObjectIds: exportOnly.slice(0, 5).map((paragraph) => paragraph.object_id),
            read: { kind: "paragraphs", object_id: exportOnly[0].object_id, offset: 0, limit, expected_revision: atRevision } }] : []),
          { code: "rendered_pagination", detail: "No Word/WPS page equivalence or rendered page mapping is computed." }];
      const read = { paragraphs: { kind: "paragraphs", offset: 0, limit, expected_revision: atRevision },
        styles: { kind: "styles", offset: 0, limit, expected_revision: atRevision },
        objects: { kind: "objects", offset: 0, limit, expected_revision: atRevision },
        nodes: { kind: "nodes", offset: 0, limit, expected_revision: atRevision },
        content: { tool: "read_docx_document", arguments: { offset: 0, limit, expected_revision: atRevision } } };
      const render = (structure: typeof directoryItems, nextOffset: number | null) => {
        const nextQuery = nextOffset === null ? null : continuationQuery(nextOffset);
        return { ...bound, overview: { counts, countUnits, coverage, structure, capabilities, gaps, read, continuation: nextQuery },
          total: directoryItems.length, nextOffset, nextQuery };
      };
      const selected = page(directoryItems, offset, directoryItems.length, offset, render);
      return render(selected.values, selected.nextOffset);
    }
    const candidates = facts.snapshot.objects.filter(matches)
      .map((object) => boundedRecord(linkedObject(object), { kind: "objects", object_id: object.object_id }));
    const direct = selectedParagraph && session.readParagraphFormatting?.(selectedParagraph.handle);
    const directRead = direct && { ...direct, text: textSlice(direct.text, 0, 1000).text,
      ...(direct.text.length > 1000 ? { textTruncated: true, textLength: direct.text.length,
        readText: { kind: "paragraphs", paragraph_ref: direct.paragraphRef, text_offset: 0, limit: 1,
          expected_revision: atRevision } } : {}) };
    assertRevision(atRevision);
    const render = (objects: typeof candidates, nextOffset: number | null) => ({
      ...bound, ...(directRead ? { paragraph: directRead } : {}), objects, total: candidates.length, nextOffset,
      nextQuery: nextOffset === null ? null : continuationQuery(nextOffset),
    });
    const selected = page(candidates, offset, candidates.length, offset, render);
    return render(selected.values, selected.nextOffset);
  };
}
