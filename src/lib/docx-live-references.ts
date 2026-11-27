import {
  bodyStoryRoot,
  commentAnchorsOfStory,
  commentBodyText,
  commentsOfPart,
  commentsPartNameForStory,
  findNoteById,
  noteIdOf,
  noteReferenceKindOf,
  paragraphOffsetIndex,
  paragraphTextOf,
  resolveNotesPart,
  storyParagraphs,
  textboxStoriesInPart,
  type OoxmlNode,
  type OoxmlPackage,
  type OoxmlPart,
} from "@docx-editor.dev/core/store";
import type { DocxLiveReference } from "@oleafly/ai-tools";
import { projectDocxLiveBranches } from "./docx-markup-compatibility";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

type Position = { paragraphId: string; offset: number };
type Marker = Position & { nodeId: string; kind: "start" | "end" | "point" };
type Comment = {
  nodeId: string;
  start: Position;
  end?: Position;
  kind: "point" | "range" | "incomplete_range";
  payload: unknown;
  readable: boolean;
};

function projectedPart(part: OoxmlPart): OoxmlPart {
  const root = projectDocxLiveBranches(part.root);
  return root === part.root ? part : { ...part, root };
}

function storyText(part: OoxmlPart, root: OoxmlNode): string[] {
  return storyParagraphs(root).map((node) => paragraphTextOf(part, node.id, { fieldResults: "editable" }) ?? "");
}

function commentsByParagraph(part: OoxmlPart, selected: OoxmlPart, commentsPart: OoxmlPart | undefined) {
  const result = new Map<string, Comment[]>();
  const body = bodyStoryRoot(part);
  const selectedBody = bodyStoryRoot(selected);
  if (!body || !selectedBody) return result;

  const rawParagraphs = new Map(storyParagraphs(body).map((node) => [node.id, node]));
  const markers = new Map<string, Marker[]>();
  for (const paragraph of storyParagraphs(selectedBody)) {
    const raw = rawParagraphs.get(paragraph.id);
    if (paragraph.kind !== "paragraph" || raw?.kind !== "paragraph") continue;
    const visit = (node: OoxmlNode) => {
      if (node.kind === "textValue" || node.kind === "paragraph") return;
      const kind = node.kind === "commentRangeStart" ? "start" : node.kind === "commentRangeEnd" ? "end"
        : node.kind === "commentReference" ? "point" : null;
      if (!kind) {
        node.children.forEach(visit);
        return;
      }
      const id = node.attributes.find((attribute) => attribute.namespaceUri === W && attribute.localName === "id")?.value;
      const span = paragraphOffsetIndex(raw).spanOf(node.id);
      if (id === undefined || !span) return;
      const marker: Marker = { nodeId: node.id, paragraphId: raw.id, offset: span.start, kind };
      const existing = markers.get(id);
      if (existing) existing.push(marker);
      else markers.set(id, [marker]);
    };
    paragraph.children.forEach(visit);
  }
  if (markers.size === 0) return result;

  const anchors = new Map(commentAnchorsOfStory(part).map((anchor) => [anchor.commentId, anchor]));
  const records = new Map(commentsPart ? commentsOfPart(commentsPart).map((record) => [record.id, record]) : []);
  const samePosition = (marker: Position, position: Position) =>
    marker.paragraphId === position.paragraphId && marker.offset === position.offset;
  for (const [id, entries] of markers) {
    const starts = entries.filter((marker) => marker.kind === "start");
    const ends = entries.filter((marker) => marker.kind === "end");
    const start = starts[0] ?? entries.find((marker) => marker.kind === "point") ?? ends[0];
    const anchor = anchors.get(id);
    const end = starts.length === 1 && ends.length === 1 && anchor && !anchor.orphaned &&
      samePosition(start, anchor.start) && samePosition(ends[0], anchor.end) ? ends[0] : undefined;
    const record = records.get(id);
    const comment: Comment = {
      nodeId: start.nodeId,
      start,
      end,
      kind: end ? "range" : anchor || starts.length || ends.length ? "incomplete_range" : "point",
      readable: record !== undefined,
      payload: record
        ? { id, bodyPart: commentsPart?.name, text: commentBodyText(record), author: record.author, initials: record.initials, date: record.date }
        : { id, bodyPart: commentsPart?.name, reason: "No comment with this ID was found in the document's comments part." },
    };
    const existing = result.get(start.paragraphId);
    if (existing) existing.push(comment);
    else result.set(start.paragraphId, [comment]);
  }
  return result;
}

export function createDocxReferenceReader(pkg: OoxmlPackage, part: OoxmlPart) {
  const selected = projectedPart(part);
  const boxes = new Map<string, ReturnType<typeof textboxStoriesInPart>[number]["root"][]>();
  for (const { drawingNodeId, root } of textboxStoriesInPart(selected)) {
    const existing = boxes.get(drawingNodeId);
    if (existing) existing.push(root);
    else boxes.set(drawingNodeId, [root]);
  }
  const commentsPart = pkg.parts.get(commentsPartNameForStory(pkg, part.name) ?? "");
  const comments = commentsByParagraph(part, selected, commentsPart && projectedPart(commentsPart));
  const notes = new Map<"footnote" | "endnote", OoxmlPart | undefined>();

  return {
    comments,
    textboxesOf(nodeId: string) {
      return boxes.get(nodeId)?.map((root) => ({ paragraphs: storyText(selected, root) }));
    },
    noteOf(node: OoxmlNode) {
      const kind = noteReferenceKindOf(node);
      const id = noteIdOf(node);
      if (kind === null || id === null) return undefined;
      if (!notes.has(kind)) {
        const related = resolveNotesPart(pkg, kind);
        notes.set(kind, related ? projectedPart(related) : undefined);
      }
      const related = notes.get(kind);
      const note = related && findNoteById(related.root, id);
      if (!note || !related) return {
        readable: false, complete: false,
        payload: { kind, id, bodyPart: related?.name, reason: `No ${kind} with this ID was found in the related part.` },
      };
      const paragraphs = storyText(related, note);
      return {
        readable: true, complete: paragraphs.every((text) => !text.includes("\uFFFC")),
        payload: { kind, id, bodyPart: related.name, paragraphs },
      };
    },
    reference(kind: DocxLiveReference["kind"], start: DocxLiveReference["start"], end?: DocxLiveReference["end"]): DocxLiveReference {
      return { part: part.name, kind, start, ...(end ? { end } : {}) };
    },
  };
}
