import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  CONTENT_TYPES_NAMESPACE,
  DOCX_MAIN_CONTENT_TYPE,
  STRICT_WORD_NAMESPACE,
  TRANSITIONAL_WORD_NAMESPACE,
  strictIeeePackageFacts,
} from "./strict-ieee-package";

const packageBytes = ({
  documentRoot = "w:document",
  wordNamespace = STRICT_WORD_NAMESPACE,
  contentTypesRoot = `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`,
  override =
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_CONTENT_TYPE}"/>`,
} = {}) => {
  const contentTypesName = contentTypesRoot.match(/^<([^\s>]+)/u)?.[1] ?? "Types";
  return zipSync({
    "word/document.xml": strToU8(
      `<${documentRoot} xmlns:w="${wordNamespace}"><w:body/></${documentRoot}>`,
    ),
    "[Content_Types].xml": strToU8(
      `${contentTypesRoot}${override}</${contentTypesName}>`,
    ),
  });
};

describe("strict IEEE package facts", () => {
  it("reads the Strict Word root and document override exactly", () => {
    expect(strictIeeePackageFacts(packageBytes())).toEqual({
      strict: true,
      namespace: STRICT_WORD_NAMESPACE,
      mainContentType: true,
    });
  });

  it("distinguishes Transitional Word from Strict", () => {
    const facts = strictIeeePackageFacts(
      packageBytes({ wordNamespace: TRANSITIONAL_WORD_NAMESPACE }),
    );
    expect(facts.strict).toBe(false);
    expect(facts.namespace).toBe(TRANSITIONAL_WORD_NAMESPACE);
  });

  it("does not accept a lookalike Word namespace or non-document root", () => {
    expect(
      strictIeeePackageFacts(
        packageBytes({
          wordNamespace: `https://example.invalid/?next=${STRICT_WORD_NAMESPACE}`,
        }),
      ).strict,
    ).toBe(false);
    expect(() =>
      strictIeeePackageFacts(packageBytes({ documentRoot: "w:notDocument" })),
    ).toThrow("document root");
  });

  it("requires the content-types root namespace and exact document override", () => {
    expect(() =>
      strictIeeePackageFacts(
        packageBytes({
          contentTypesRoot: '<Types xmlns="https://example.invalid/content-types">',
        }),
      ),
    ).toThrow("content-types Types root");
    expect(() =>
      strictIeeePackageFacts(
        packageBytes({
          contentTypesRoot: `<NotTypes xmlns="${CONTENT_TYPES_NAMESPACE}">`,
        }),
      ),
    ).toThrow("content-types Types root");

    for (const override of [
      `<Override PartName="/word/document.xml.bak" ContentType="${DOCX_MAIN_CONTENT_TYPE}"/>`,
      '<Override PartName="/word/document.xml" ContentType="text/xml"/>',
    ]) {
      expect(
        strictIeeePackageFacts(packageBytes({ override })).mainContentType,
      ).toBe(false);
    }
  });
});
