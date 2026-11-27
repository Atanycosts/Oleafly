import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDocxFormatFacts } from "../../src/lib/docx-format";
import {
  MARKUP_COMPATIBILITY_NAMESPACE,
  WORD_NAMESPACE,
  markupCompatibilitySelectionFixture,
  nodeAddressFixture,
  runWorkbenchNodeAddressOracle,
  type NodeAddress,
  type WorkbenchNodeQuery,
  type WorkbenchNodeRecord,
} from "./docx-node-address-regression";

const DOCUMENT_PART = "/word/document.xml";
const NEW_VERSION = "xml-element-path-1";
const OLD_WORKBENCH_VERSION = "workbench-xml-child-path-1";
const NO_SUPPORTED_BRANCH = "alternate_content_no_supported_branch";
type FormatFacts = Awaited<ReturnType<typeof openDocxFormatFacts>>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function addressOf(object: { object_id: string; node_address?: NodeAddress }): NodeAddress {
  const address = object.node_address;
  if (!address) {
    throw new Error(
      `The TS snapshot object ${object.object_id} has no node_address. ` +
        "This regression requires the new address to come from the TS snapshot, not test-side path construction.",
    );
  }
  return address;
}

function nodesOf(
  oracle: ReturnType<typeof runWorkbenchNodeAddressOracle>,
  label: string,
): WorkbenchNodeRecord[] {
  const outcome = oracle.queries[label];
  if (!outcome?.ok) {
    throw new Error(`${label} was refused: ${outcome?.ok === false ? outcome.error : "missing outcome"}`);
  }
  return outcome.result.nodes;
}

function nodeOf(
  oracle: ReturnType<typeof runWorkbenchNodeAddressOracle>,
  label: string,
): WorkbenchNodeRecord {
  const node = nodesOf(oracle, label)[0];
  if (!node) throw new Error(`${label} returned no node.`);
  return node;
}

function rejected(oracle: ReturnType<typeof runWorkbenchNodeAddressOracle>, label: string): string {
  const outcome = oracle.queries[label];
  if (!outcome || outcome.ok) throw new Error(`${label} unexpectedly succeeded.`);
  expect(outcome.status).toBe(400);
  return outcome.error;
}

function withPath(address: NodeAddress, suffix: number[]): NodeAddress {
  return { ...address, path: [...address.path, ...suffix] };
}

function addressWithPath(version: string, sourceSha256: string, path: number[]): NodeAddress {
  return { version, source_sha256: sourceSha256, part: DOCUMENT_PART, path };
}

function physicalNodes(facts: FormatFacts, localName: string) {
  const result = facts.query({
    kind: "nodes",
    part: DOCUMENT_PART,
    namespace_uri: MARKUP_COMPATIBILITY_NAMESPACE,
    local_name: localName,
    limit: 1000,
  });
  if (result.kind !== "nodes") throw new Error(`Expected node results for mc:${localName}.`);
  return result.nodes;
}

function selectedParagraphTexts(facts: FormatFacts): string[] {
  return facts.snapshot.objects
    .filter((object) => object.kind === "paragraph" && object.part === DOCUMENT_PART)
    .map((object) => object.text ?? "");
}

describe("DOCX node-address cross-runtime regression", () => {
  it("uses TS addresses, keeps old mixed paths, and never turns a canonical path into a false physical address", async () => {
    const bytes = nodeAddressFixture();
    const sourceSha256 = sha256(bytes);
    const facts = await openDocxFormatFacts(bytes);
    expect(facts.snapshot.source_sha256).toBe(sourceSha256);

    const paragraphs = facts.snapshot.objects.filter(
      (object) => object.kind === "paragraph" && object.part === DOCUMENT_PART,
    );
    const first = paragraphs.find((object) => object.text === "First");
    const second = paragraphs.find((object) => object.text === "Second");
    expect(first, "Expected the First paragraph in the real TS snapshot.").toBeDefined();
    expect(second, "Expected the Second paragraph in the real TS snapshot.").toBeDefined();
    if (!first || !second) return;

    // The legacy TS paths remain canonical-tree paths and are not physical addresses.
    expect(first.path).toEqual([0, 0, 0]);
    expect(second.path).toEqual([0, 0, 1]);
    const scan = runWorkbenchNodeAddressOracle(bytes, {
      scanParagraphs: {
        operation: "nodes",
        part: DOCUMENT_PART,
        namespace_uri: WORD_NAMESPACE,
        local_name: "p",
        limit: 10,
      },
    });
    const paragraphNodes = nodesOf(scan, "scanParagraphs");
    expect(paragraphNodes).toHaveLength(3);
    const firstAddress = paragraphNodes[0]?.node_address;
    const secondAddress = paragraphNodes[1]?.node_address;
    if (!firstAddress || !secondAddress) {
      throw new Error("Expected physical addresses for the First and Second paragraphs.");
    }
    expect(firstAddress).toMatchObject({
      version: NEW_VERSION,
      source_sha256: sourceSha256,
      part: DOCUMENT_PART,
      path: [0, 0, 0],
    });
    expect(secondAddress).toMatchObject({
      version: NEW_VERSION,
      source_sha256: sourceSha256,
      part: DOCUMENT_PART,
      path: [0, 0, 1],
    });

    const secondRun = facts.snapshot.objects.find(
      (object) =>
        object.kind === "run" &&
        object.part === DOCUMENT_PART &&
        object.text === "Second",
    );
    if (!secondRun) throw new Error("Expected the real TS snapshot to contain the Second run.");
    const secondRunAddress = addressOf(secondRun);
    const bodyStyle = facts.snapshot.style_definitions.find((style) => style.style_id === "FixtureBody");
    if (!bodyStyle) throw new Error("Expected the FixtureBody style in the real TS snapshot.");
    const canonicalSecondRunAddress = addressWithPath(
      NEW_VERSION,
      sourceSha256,
      secondRun.path,
    );

    const queries: Record<string, WorkbenchNodeQuery> = {
      first: { operation: "nodes", node_address: addressOf(first) },
      second: { operation: "nodes", node_address: addressOf(second) },
      barePath: { operation: "nodes", part: second.part, path: second.path },
      bodyStyle: { operation: "nodes", node_address: addressOf(bodyStyle) },
      oldFirst: {
        operation: "nodes",
        node_address: addressWithPath(OLD_WORKBENCH_VERSION, sourceSha256, [0, 0, 1]),
      },
      oldSecond: {
        operation: "nodes",
        node_address: addressWithPath(OLD_WORKBENCH_VERSION, sourceSha256, [0, 0, 3]),
      },
      // This legacy path lands on the preserved body whitespace, not an element.
      legacyWhitespace: {
        operation: "nodes",
        node_address: addressWithPath(OLD_WORKBENCH_VERSION, sourceSha256, [0, 0, 0]),
      },
      body: { operation: "nodes", node_address: addressWithPath(NEW_VERSION, sourceSha256, [0, 0]) },
      firstText: { operation: "nodes", node_address: withPath(addressOf(first), [0, 0]) },
      secondText: { operation: "nodes", node_address: withPath(addressOf(second), [0, 0]) },
      physicalSecondRun: { operation: "nodes", node_address: withPath(secondAddress, [0]) },
      secondRunFromTs: { operation: "nodes", node_address: secondRunAddress },
      canonicalSecondRun: {
        operation: "nodes",
        node_address: canonicalSecondRunAddress,
      },
    };
    const oracle = runWorkbenchNodeAddressOracle(bytes, queries, facts.snapshot);
    expect(oracle.retainedSnapshot).toEqual(facts.snapshot);
    expect(rejected(oracle, "barePath")).toContain("Top-level path has no declared address source");
    expect(nodeOf(oracle, "bodyStyle")).toMatchObject({
      local_name: "style",
      attributes: expect.arrayContaining([expect.objectContaining({ local_name: "styleId", value: "FixtureBody" })]),
    });

    expect(nodeOf(oracle, "first")).toMatchObject({
      node_address: firstAddress,
      path: [0, 0, 1],
      local_name: "p",
    });
    expect(nodeOf(oracle, "second")).toMatchObject({
      node_address: secondAddress,
      path: [0, 0, 3],
      local_name: "p",
    });

    // The old mixed-child address [0,0,1] means First, not Second.
    expect(nodeOf(oracle, "oldFirst")).toMatchObject({
      node_address: firstAddress,
      path: [0, 0, 1],
      local_name: "p",
    });
    // The old mixed-child address [0,0,3] independently resolves Second.
    expect(nodeOf(oracle, "oldSecond")).toMatchObject({
      node_address: secondAddress,
      path: [0, 0, 3],
      local_name: "p",
    });
    expect(rejected(oracle, "legacyWhitespace")).toContain("text");
    expect(nodeOf(oracle, "firstText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "First" }),
    ]);
    expect(nodeOf(oracle, "secondText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "Second" }),
    ]);

    // A scan still exposes the physical address alongside the unchanged mixed path.
    expect(paragraphNodes.map((node) => node.path)).toEqual([
      [0, 0, 1],
      [0, 0, 3],
      [0, 0, 5],
    ]);
    expect(paragraphNodes.map((node) => node.node_address.path)).toEqual([
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 2],
    ]);
    expect(paragraphNodes.every((node) => node.node_address.version === NEW_VERSION)).toBe(true);

    // The non-canonical pPr after the Second run is reordered by the core. The
    // canonical run path therefore resolves to pPr, not to the run.
    const physicalSecondRun = nodeOf(oracle, "physicalSecondRun");
    expect(physicalSecondRun.node_address.path).toEqual([0, 0, 1, 0]);
    expect(secondRun.path).not.toEqual(physicalSecondRun.node_address.path);
    expect(nodeOf(oracle, "canonicalSecondRun").local_name).toBe("pPr");
    const fromTs = nodeOf(oracle, "secondRunFromTs");
    expect(fromTs.local_name).toBe("r");
    expect(fromTs.node_address).toEqual(secondRunAddress);
    expect(fromTs.children).toEqual([
      expect.objectContaining({
        kind: "element",
        local_name: "t",
        path: [0, 0, 3, 0, 0],
      }),
    ]);

    const body = nodeOf(oracle, "body");
    expect(body.children.map(({ kind, index, path }) => ({ kind, index, path }))).toEqual([
      { kind: "text_value", index: 0, path: [0, 0, 0] },
      { kind: "element", index: 1, path: [0, 0, 1] },
      { kind: "text_value", index: 2, path: [0, 0, 2] },
      { kind: "element", index: 3, path: [0, 0, 3] },
      { kind: "text_value", index: 4, path: [0, 0, 4] },
      { kind: "element", index: 5, path: [0, 0, 5] },
      { kind: "text_value", index: 6, path: [0, 0, 6] },
    ]);

    // The new address is accepted only when it is the one exported by TS.
    expect(addressOf(first)).toEqual(firstAddress);
    expect(addressOf(second)).toEqual(secondAddress);
  });

  it("rejects mixed, wrong-source, unknown-version and missing addresses", () => {
    const bytes = nodeAddressFixture();
    const sourceSha256 = sha256(bytes);
    const scan = runWorkbenchNodeAddressOracle(bytes, {
      paragraphs: {
        operation: "nodes",
        part: DOCUMENT_PART,
        namespace_uri: WORD_NAMESPACE,
        local_name: "p",
        limit: 10,
      },
    });
    const secondAddress = nodesOf(scan, "paragraphs")[1]?.node_address;
    if (!secondAddress) throw new Error("Expected a physical address for Second.");

    const oracle = runWorkbenchNodeAddressOracle(bytes, {
      mixedPart: { operation: "nodes", node_address: secondAddress, part: DOCUMENT_PART },
      mixedPath: { operation: "nodes", node_address: secondAddress, path: [0, 0, 1] },
      wrongSource: {
        operation: "nodes",
        node_address: { ...secondAddress, source_sha256: "f".repeat(64) },
      },
      unknownVersion: {
        operation: "nodes",
        node_address: { ...secondAddress, version: "xml-element-path-999" },
      },
      noHit: {
        operation: "nodes",
        node_address: { ...secondAddress, path: [0, 0, 99] },
      },
      barePath: { operation: "nodes", part: DOCUMENT_PART, path: [0, 0, 1] },
    });

    expect(rejected(oracle, "mixedPart")).toContain("cannot be combined with top-level part or path");
    expect(rejected(oracle, "mixedPath")).toContain("cannot be combined with top-level part or path");
    expect(rejected(oracle, "wrongSource")).toContain("different DOCX bytes");
    expect(rejected(oracle, "unknownVersion")).toContain("Unsupported node_address version");
    expect(rejected(oracle, "noHit")).toContain("does not exist");
    expect(rejected(oracle, "barePath")).toContain("Top-level path has no declared address source");
    expect(secondAddress.source_sha256).toBe(sourceSha256);
  });

  it("selects the supported markup-compatibility Choice while retaining both physical branches", async () => {
    const bytes = nodeAddressFixture();
    const sourceSha256 = sha256(bytes);
    const facts = await openDocxFormatFacts(bytes);
    const oracle = runWorkbenchNodeAddressOracle(bytes, {
      choice: {
        operation: "nodes",
        part: DOCUMENT_PART,
        namespace_uri: MARKUP_COMPATIBILITY_NAMESPACE,
        local_name: "Choice",
      },
      fallback: {
        operation: "nodes",
        part: DOCUMENT_PART,
        namespace_uri: MARKUP_COMPATIBILITY_NAMESPACE,
        local_name: "Fallback",
      },
    });
    const choice = nodeOf(oracle, "choice");
    const fallback = nodeOf(oracle, "fallback");
    expect(choice).toMatchObject({
      local_name: "Choice",
      path: [0, 0, 5, 0, 0],
      node_address: {
        version: NEW_VERSION,
        source_sha256: sourceSha256,
        part: DOCUMENT_PART,
        path: [0, 0, 2, 0, 0],
      },
    });
    expect(fallback).toMatchObject({
      local_name: "Fallback",
      path: [0, 0, 5, 0, 1],
      node_address: {
        version: NEW_VERSION,
        source_sha256: sourceSha256,
        part: DOCUMENT_PART,
        path: [0, 0, 2, 0, 1],
      },
    });

    const textOracle = runWorkbenchNodeAddressOracle(bytes, {
      choiceText: { operation: "nodes", node_address: withPath(choice.node_address, [0, 0]) },
      fallbackText: { operation: "nodes", node_address: withPath(fallback.node_address, [0, 0]) },
    });
    expect(nodeOf(textOracle, "choiceText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "ChoiceMarker" }),
    ]);
    expect(nodeOf(textOracle, "fallbackText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "FallbackMarker" }),
    ]);

    expect(
      ["Choice", "Fallback"].flatMap((name) => physicalNodes(facts, name).map((node) => ({
        localName: name, path: node.path, physicalPath: node.node_address?.path,
      }))),
    ).toEqual([
      { localName: "Choice", path: [0, 0, 2, 0, 0], physicalPath: [0, 0, 2, 0, 0] },
      { localName: "Fallback", path: [0, 0, 2, 0, 1], physicalPath: [0, 0, 2, 0, 1] },
    ]);
    const alternateParagraph = facts.snapshot.objects.find(
      (object) =>
        object.kind === "paragraph" &&
        object.part === DOCUMENT_PART &&
        object.path[0] === 0 &&
        object.path[1] === 0 &&
        object.path[2] === 2,
    );
    expect(alternateParagraph).toMatchObject({
      text: "ChoiceMarker",
      path: [0, 0, 2],
      node_address: {
        version: NEW_VERSION,
        source_sha256: sourceSha256,
        part: DOCUMENT_PART,
        path: [0, 0, 2],
      },
    });
    expect(oracle.textBlocks.map((block) => block.text)).toEqual([
      "First",
      "Second",
      "ChoiceMarker",
    ]);
  });

  it("selects markup-compatibility branches consistently across TS and Workbench", async () => {
    const bytes = markupCompatibilitySelectionFixture();
    const sourceSha256 = sha256(bytes);
    const facts = await openDocxFormatFacts(bytes);
    expect(facts.snapshot.source_sha256).toBe(sourceSha256);

    const expectedParagraphs = [
      "BasicChoice",
      "WordChoice",
      "MathChoice",
      "WordprocessingDrawingChoice",
      "DrawingMainChoice",
      "WordprocessingGroupChoice",
      "MultipleRequiresChoice",
      "AfterMissingRequiresChoice",
      "PartialUnsupportedFallback",
      "LocalAliasChoice",
      "ChoiceTable",
      "BeforeDecoyWrongNamespaceChoiceWrongNamespaceFallbackAfterDecoy",
      "FallbackOnly",
      "UnknownNamespaceFallback",
      "QualifiedRequiresFallback",
    ];
    expect(selectedParagraphTexts(facts)).toEqual(expectedParagraphs);
    expect(
      facts.snapshot.objects
        .filter((object) => object.kind === "table" && object.part === DOCUMENT_PART)
        .map((object) => ({ object_id: object.object_id, path: object.path })),
    ).toEqual([
      { object_id: "/word/document.xml#0.0.10.0.0", path: [0, 0, 10, 0, 0] },
    ]);

    const choiceNodes = physicalNodes(facts, "Choice");
    const fallbackNodes = physicalNodes(facts, "Fallback");
    // These are raw package paths: every Choice and Fallback stays queryable.
    expect(choiceNodes.map((node) => node.path)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 2, 0],
      [0, 0, 3, 0],
      [0, 0, 4, 0],
      [0, 0, 5, 0],
      [0, 0, 6, 0],
      [0, 0, 6, 1],
      [0, 0, 7, 0],
      [0, 0, 7, 1],
      [0, 0, 7, 2],
      [0, 0, 8, 0],
      [0, 0, 9, 0],
      [0, 0, 10, 0],
      [0, 0, 11, 0],
      [0, 0, 14, 0],
      [0, 0, 15, 0],
    ]);
    expect(fallbackNodes.map((node) => node.path)).toEqual([
      [0, 0, 0, 1],
      [0, 0, 1, 1],
      [0, 0, 2, 1],
      [0, 0, 3, 1],
      [0, 0, 4, 1],
      [0, 0, 5, 1],
      [0, 0, 6, 2],
      [0, 0, 7, 3],
      [0, 0, 8, 1],
      [0, 0, 9, 1],
      [0, 0, 10, 1],
      [0, 0, 13, 0],
      [0, 0, 14, 1],
      [0, 0, 15, 1],
    ]);
    const physicalTables = facts.query({
      kind: "nodes",
      part: DOCUMENT_PART,
      namespace_uri: WORD_NAMESPACE,
      local_name: "tbl",
      limit: 1000,
    });
    if (physicalTables.kind !== "nodes") throw new Error("Expected physical table nodes.");
    expect(physicalTables.nodes.map((node) => node.path)).toEqual([
      [0, 0, 10, 0, 0],
      [0, 0, 10, 1, 0],
    ]);

    const branchQueries: Record<string, WorkbenchNodeQuery> = {};
    const expectedBranches = new Map<string, { address: NodeAddress; localName: string }>();
    for (const [localName, nodes] of [
      ["Choice", choiceNodes],
      ["Fallback", fallbackNodes],
    ] as const) {
      for (const [index, node] of nodes.entries()) {
        if (!node.node_address) throw new Error(`Expected a physical address for ${localName} ${index}.`);
        const label = `${localName.toLowerCase()}${index}`;
        branchQueries[label] = { operation: "nodes", node_address: node.node_address };
        expectedBranches.set(label, { address: node.node_address, localName });
      }
    }
    const oracle = runWorkbenchNodeAddressOracle(bytes, branchQueries);
    for (const [label, expected] of expectedBranches) {
      expect(nodeOf(oracle, label), label).toMatchObject({
        local_name: expected.localName,
        node_address: expected.address,
      });
    }

    const branchText = runWorkbenchNodeAddressOracle(bytes, {
      basicChoiceText: { operation: "nodes", node_address: withPath(choiceNodes[0]!.node_address!, [0, 0, 0]) },
      basicFallbackText: { operation: "nodes", node_address: withPath(fallbackNodes[0]!.node_address!, [0, 0, 0]) },
    });
    expect(nodeOf(branchText, "basicChoiceText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "BasicChoice" }),
    ]);
    expect(nodeOf(branchText, "basicFallbackText").children).toEqual([
      expect.objectContaining({ kind: "text_value", value: "BasicFallback" }),
    ]);

    expect(oracle.textBlocks.map((block) => block.text)).toEqual(expectedParagraphs);
    expect(oracle.tables.map((table) => table.rows.map((row) => row.map((cell) => cell.text)))).toEqual([
      [["ChoiceTable"]],
    ]);

    const afterMissing = oracle.textBlocks.find((block) => block.text === "AfterMissingRequiresChoice");
    if (afterMissing?.byte_start == null || afterMissing.byte_end == null) {
      throw new Error("Expected a real byte interval for AfterMissingRequiresChoice.");
    }
    expect(afterMissing.part_path).toBe("word/document.xml");
    const documentXml = unzipSync(bytes)["word/document.xml"];
    if (!documentXml) throw new Error("Expected word/document.xml in the fixture package.");
    const selectedBytes = new TextDecoder()
      .decode(documentXml.subarray(afterMissing.byte_start, afterMissing.byte_end));
    expect(selectedBytes).toBe(
      '<w:p><w:r><w:t>AfterMissingRequiresChoice</w:t></w:r></w:p>',
    );
    expect(selectedBytes).not.toContain("MissingRequiresFallback");
  });

  it("reports a no-supported-branch gap with the physical AlternateContent identity", async () => {
    const bytes = markupCompatibilitySelectionFixture();
    const facts = await openDocxFormatFacts(bytes);
    const reportsGap = (issue: string) => issue.includes(NO_SUPPORTED_BRANCH);
    const oracle = runWorkbenchNodeAddressOracle(bytes, {});

    expect(selectedParagraphTexts(facts)).not.toContain("NoBranchChoice");
    expect(oracle.textBlocks.map((block) => block.text)).not.toContain("NoBranchChoice");

    const expectedObjectId = "/word/document.xml#0.0.11";
    const unsupported = facts.snapshot.unsupported.find((entry) =>
      entry.code === NO_SUPPORTED_BRANCH
    );
    expect(unsupported, "Expected the TS snapshot to report the unselected AlternateContent.").toBeDefined();
    expect(unsupported?.object_ids).toEqual([expectedObjectId]);

    const sourceObject = facts.snapshot.objects.find((object) => object.object_id === expectedObjectId);
    expect(sourceObject).toMatchObject({
      declared: {
        namespace_uri: MARKUP_COMPATIBILITY_NAMESPACE,
        local_name: "AlternateContent",
      },
      node_address: {
        version: NEW_VERSION,
        source_sha256: facts.snapshot.source_sha256,
        part: DOCUMENT_PART,
        path: [0, 0, 11],
      },
    });

    const gap = oracle.unsupportedRecords.find(
      (record) => record.kind === NO_SUPPORTED_BRANCH,
    );
    expect(gap, "Expected the Workbench reader to retain the no-branch gap.").toBeDefined();
    expect(gap?.source_location).toBe("word/document.xml#0.0.11");
    expect(oracle.issues.some(reportsGap), JSON.stringify(oracle.issues)).toBe(true);
    expect(oracle.issues.find(reportsGap)).toMatch(
      /alternate_content_no_supported_branch.*word\/document\.xml#0\.0\.11/,
    );
  });
});
