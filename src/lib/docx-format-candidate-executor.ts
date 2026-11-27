import type { TreeDocxSessionView } from "@docx-editor.dev/core/editor";
import {
  formsProtectionEnabled,
  runAddressRanges,
  withPart,
  writeOoxmlPackage,
  type OoxmlNode,
  type OoxmlParagraphNode,
} from "@docx-editor.dev/core/store";
import {
  openDocxFormatFacts,
  type DocxFormatFacts,
  type DocxFormatObject,
} from "./docx-format";
import {
  planDocxFormatCandidates,
  requiresDocxLayoutReview,
  type DocxFormatCandidateAddress,
  type DocxFormatCandidatePlan,
  type DocxFormatTemplateFinding,
  type PlanDocxFormatCandidatesInput,
  type ReadyDocxFormatCandidate,
} from "./docx-format-candidate-plan";
import {
  openDocxFormatSession,
  type DocxParagraph,
  type DocxSession,
} from "./docx-session";
import { applyDocxTablePagination, type DocxTablePaginationChange } from "./docx-table-pagination";

export type DocxFormatCandidateCheck = PlanDocxFormatCandidatesInput["check"];

export interface ApplyDocxFormatCandidatesInput {
  bytes: Uint8Array;
  facts?: DocxFormatFacts;
  check: DocxFormatCandidateCheck;
  findings: readonly DocxFormatTemplateFinding[];
  baselineId: string;
  tablePagination?: readonly DocxTablePaginationChange[];
}

export interface DocxFormatCandidateApplication {
  plan: DocxFormatCandidatePlan;
  candidateBytes: Uint8Array;
  appliedCandidateIds: readonly string[];
  appliedTablePagination: readonly DocxTablePaginationChange[];
}

function nodeAtPath(node: OoxmlNode, path: readonly number[]): OoxmlNode | null {
  for (const index of path) {
    if (node.kind === "textValue") return null;
    const child = node.children[index];
    if (!child) return null;
    node = child;
  }
  return node;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function anchorParagraph(
  object: DocxFormatObject,
  objectsById: ReadonlyMap<string, DocxFormatObject>,
): DocxFormatObject | undefined {
  if (object.kind === "paragraph") return object;
  const paragraphObjectId = object.evidence.paragraph_object_id;
  if (typeof paragraphObjectId === "string") return objectsById.get(paragraphObjectId);
}

function resolveAddresses(
  paragraphs: readonly DocxParagraph[],
  tree: TreeDocxSessionView,
  facts: DocxFormatFacts,
  findings: readonly DocxFormatTemplateFinding[],
): Map<string, DocxFormatCandidateAddress> {
  const objectsById = new Map(facts.snapshot.objects.map((object) => [object.object_id, object]));
  const byParaId = new Map(paragraphs.map((paragraph) => [paragraph.paraId, paragraph]));
  const { name, root } = tree.part();
  const rangesByParagraph = new Map<string, ReturnType<typeof runAddressRanges>>();
  const addresses = new Map<string, DocxFormatCandidateAddress>();
  for (const finding of findings) {
    const object_id = finding.object_id;
    if (addresses.has(object_id) || requiresDocxLayoutReview(finding)) continue;
    const object = objectsById.get(object_id);
    if (!object || object.part !== name) continue;
    const anchor = anchorParagraph(object, objectsById);
    if (!anchor || anchor.part !== name) continue;
    const paraId = facts.addressableParagraphIds.get(anchor.object_id);
    if (!paraId) continue;
    const paragraphNode = nodeAtPath(root, anchor.path.slice(1));
    if (paragraphNode?.kind !== "paragraph" || tree.paraIdOf(paragraphNode.id) !== paraId) continue;
    const live = byParaId.get(paraId);
    if (!live) continue;
    let range: { start: number; end: number } | undefined;
    if (object.kind === "run") {
      const runNode = nodeAtPath(root, object.path.slice(1));
      if (runNode?.kind !== "run") continue;
      let ranges = rangesByParagraph.get(paragraphNode.id);
      if (!ranges) {
        ranges = runAddressRanges(paragraphNode as OoxmlParagraphNode);
        rangesByParagraph.set(paragraphNode.id, ranges);
      }
      const span = ranges.get(runNode.id);
      if (span && span.start < span.end) range = span;
    }
    addresses.set(object_id, {
      paragraphRef: live.handle.ref,
      ...(live.paraId === undefined ? {} : { paraId: live.paraId }),
      ...(live.text === "" ? {} : { text: live.text }),
      ...(range ? { range } : {}),
    });
  }
  return addresses;
}

/**
 * Applies ready candidates in bounded batches. A rejected batch is split until
 * one unsupported object can no longer block independent candidates.
 */
export async function applyReadyDocxFormatCandidates(
  session: Pick<DocxSession, "listParagraphs" | "formatBatch" | "revision">,
  candidates: readonly ReadyDocxFormatCandidate[],
  batchSize = 32,
  signal?: AbortSignal,
  paragraphs = session.listParagraphs(),
): Promise<string[]> {
  signal?.throwIfAborted();
  const formatBatch = session.formatBatch;
  if (!formatBatch) throw new Error("This Word session does not support formatting batches.");
  const paragraphsByRef = new Map<string, DocxParagraph>(
    paragraphs.map((paragraph) => [paragraph.handle.ref, paragraph]),
  );
  const prepared = candidates.flatMap(({ candidateId, operation: { paragraphRef, ...format } }) => {
    const paragraph = paragraphsByRef.get(paragraphRef);
    return paragraph ? [{ candidateId, operation: { target: paragraph.handle, ...format } }] : [];
  });
  const applied: string[] = [];
  const applyGroup = async (group: typeof prepared): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const result = formatBatch(group.map(({ operation }) => operation), session.revision());
    if (result.ok) {
      if (result.changed) applied.push(...group.map(({ candidateId }) => candidateId));
    } else if (group.length > 1) {
      const middle = Math.ceil(group.length / 2);
      await applyGroup(group.slice(0, middle));
      await applyGroup(group.slice(middle));
    }
  };
  for (let index = 0; index < prepared.length; index += batchSize) {
    await applyGroup(prepared.slice(index, index + batchSize));
  }
  return applied;
}

export async function applyDocxFormatCandidates(
  input: ApplyDocxFormatCandidatesInput,
  signal?: AbortSignal,
): Promise<DocxFormatCandidateApplication> {
  signal?.throwIfAborted();
  const sourceSha256 = await sha256Hex(input.bytes);
  signal?.throwIfAborted();
  const facts = input.facts ?? await openDocxFormatFacts(input.bytes);
  if (facts.snapshot.source_sha256 !== sourceSha256) throw new Error("The format facts belong to different candidate bytes.");
  signal?.throwIfAborted();
  const { tree, session } = openDocxFormatSession(input.bytes);
  try {
    const paragraphs = session.listParagraphs();
    const plan = planDocxFormatCandidates({
      check: input.check,
      document: {
        revision: session.revision(),
        baselineId: input.baselineId,
        sourceSha256,
      },
      findings: input.findings,
      addresses: resolveAddresses(paragraphs, tree, facts, input.findings),
    });
    if (plan.status === "blocked") throw new Error(plan.blockers.map(({ message }) => message).join(" "));
    const appliedCandidateIds = await applyReadyDocxFormatCandidates(session, plan.readyCandidates, 32, signal, paragraphs);
    signal?.throwIfAborted();
    const appliedTablePagination = formsProtectionEnabled(tree.settingsRoot()) ? [] : input.tablePagination ?? [];
    const candidateBytes = appliedTablePagination.length
      ? writeOoxmlPackage(withPart(tree.currentPackage(), applyDocxTablePagination(tree.part(), appliedTablePagination)))
      : appliedCandidateIds.length ? tree.save() : input.bytes;
    return {
      plan,
      candidateBytes,
      appliedCandidateIds,
      appliedTablePagination,
    };
  } finally {
    session.dispose();
  }
}
