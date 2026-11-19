import { canonicalOoxmlFingerprint, readOoxmlPart, type OoxmlNode } from "@docx-editor.dev/core/store";
import { expect, it } from "vitest";
import { readDocxMathPayload } from "./docx-math";

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const run = (text: string) => `<m:r><m:t>${text}</m:t></m:r>`;
function equation(content: string): OoxmlNode {
  const opened = readOoxmlPart(`<m:oMath xmlns:m="${M}" xmlns:w="${W}">${content}</m:oMath>`, { name: "/word/document.xml", contentType: "application/xml" });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.part.root;
}

it("reads a source-preserving matrix with row and cell boundaries without offering compact replacement", () => {
  const source = equation(`<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e><m:m><m:mr><m:e>${run("x")}</m:e><m:e>${run("=")}</m:e><m:e>${run("1")}</m:e></m:mr><m:mr><m:e>${run("y")}</m:e><m:e>${run("=")}</m:e><m:e>${run("2")}</m:e></m:mr></m:m></m:e></m:d>`);
  const before = canonicalOoxmlFingerprint(source);
  const result = readDocxMathPayload(source);
  expect(result).toMatchObject({ readable: true, complete: true, payload: { readableMath: "{matrix([x | = | 1]; [y | = | 2])", diagnostics: [] } });
  expect(result.payload).not.toHaveProperty("linear");
  expect(canonicalOoxmlFingerprint(source)).toBe(before);
});

it.each([
  { content: `<m:f><m:num>${run("x")}</m:num><m:den><m:unknown>${run("y")}</m:unknown></m:den></m:f>`, path: "/m:oMath/m:f[1]", reason: "unsupported-omml-property" },
  { content: `<m:groupChr><m:e>${run("y")}</m:e></m:groupChr>`, path: "/m:oMath/m:groupChr[1]", reason: "unsupported-math-node" },
])("keeps unsupported mathematical fragments visible with their projection location ($reason)", ({ content, path, reason }) => {
  const result = readDocxMathPayload(equation(content));
  expect(result.readable).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.payload.readableMath).toContain("unsupported(");
  expect(result.payload.diagnostics).toEqual([{ path, reason, expressionPath: "expression" }]);
});

it("keeps hidden source limits separate from the visible reading view", () => {
  const result = readDocxMathPayload(equation(`<m:nary><m:naryPr><m:chr m:val="∑"/><m:supHide m:val="1"/></m:naryPr><m:sub>${run("i=1")}</m:sub><m:sup>${run("n")}</m:sup><m:e>${run("x")}</m:e></m:nary>`));
  expect(result).toMatchObject({ complete: true, payload: { readableMath: "∑_{i=1}(x)", hiddenLimits: [{ position: "upper", text: "n" }], diagnostics: [] } });
});

it("provides ordinary equations through both the reading and compact grammar views", () => {
  expect(readDocxMathPayload(equation(run("x+1")))).toMatchObject({ readable: true, complete: true, payload: { linear: "x+1", readableMath: "x+1", diagnostics: [] } });
});

it("distinguishes struck and partially hidden equation boxes", () => {
  const result = readDocxMathPayload(equation(`<m:borderBox><m:borderBoxPr><m:hideTop m:val="1"/><m:strikeH m:val="1"/></m:borderBoxPr><m:e>${run("x")}</m:e></m:borderBox>`));
  expect(result).toMatchObject({ complete: true, payload: { readableMath: "box[hidden=top; strikes=horizontal](x)" } });
});

it("reads display arrays and function application with alignment boundaries", () => {
  const source = equation(`<m:eqArr><m:e>${run("x&amp;=1")}</m:e><m:e>${run("y&amp;=2")}</m:e></m:eqArr>`);
  const wrapped = readOoxmlPart(`<m:oMathPara xmlns:m="${M}" xmlns:w="${W}"><m:oMath><m:func><m:fName>${run("Law")}</m:fName><m:e>${run("x")}</m:e></m:func></m:oMath></m:oMathPara>`, { name: "/word/document.xml", contentType: "application/xml" });
  if (!wrapped.ok) throw new Error(wrapped.reason);
  expect(readDocxMathPayload(source)).toMatchObject({ complete: true, payload: { readableMath: "matrix([x | =1]; [y | =2])", diagnostics: [] } });
  expect(readDocxMathPayload(wrapped.part.root)).toMatchObject({ complete: true, payload: { readableMath: "Law\u2009x", diagnostics: [] } });
});

it("makes mathematical alphabets explicit in the reading view while retaining the source", () => {
  const source = equation('<m:sSup><m:e><m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>R</m:t></m:r></m:e><m:sup><m:r><m:rPr><m:scr m:val="sans-serif"/><m:sty m:val="p"/></m:rPr><m:t>T</m:t></m:r></m:sup></m:sSup>');
  expect(readDocxMathPayload(source)).toMatchObject({ complete: true, payload: { readableMath: "double-struck(R)^{sans-serif(T)}", diagnostics: [] } });
});

it("reports a non-mathematical atom without inventing readable math", () => {
  const opened = readOoxmlPart(`<w:r xmlns:w="${W}"><w:t>x</w:t></w:r>`, {
    name: "/word/document.xml",
    contentType: "application/xml",
  });
  if (!opened.ok) throw new Error(opened.reason);
  expect(readDocxMathPayload(opened.part.root)).toEqual({
    readable: false,
    complete: false,
    payload: {
      fallbackText: "",
      truncated: false,
      readableMath: "",
      readingFormat: "structured_math_text",
      diagnostics: [{ path: "expression", reason: "No OMML projection is available." }],
    },
  });
});

it("distinguishes top overlines from bottom underlines", () => {
  const top = readDocxMathPayload(equation(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${run("x")}</m:e></m:bar>`));
  const bottom = readDocxMathPayload(equation(`<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${run("y")}</m:e></m:bar>`));
  expect(top).toMatchObject({ complete: true, payload: { readableMath: "overline(x)" } });
  expect(bottom).toMatchObject({ complete: true, payload: { readableMath: "underline(y)" } });
});

it("reads fractions and square or indexed radicals as distinct mathematical operations", () => {
  const result = readDocxMathPayload(equation(
    `<m:f><m:num>${run("a")}</m:num><m:den>${run("b")}</m:den></m:f>` +
    `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${run("x")}</m:e></m:rad>` +
    `<m:rad><m:deg>${run("3")}</m:deg><m:e>${run("y")}</m:e></m:rad>`,
  ));
  expect(result).toMatchObject({
    readable: true,
    complete: true,
    payload: { readableMath: "(a)/(b)sqrt(x)root(3; y)", diagnostics: [] },
  });
});

it("reads subscripts, superscripts and combined scripts without dropping their bases", () => {
  const result = readDocxMathPayload(equation(
    `<m:sSub><m:e>${run("a")}</m:e><m:sub>${run("i")}</m:sub></m:sSub>` +
    `<m:sSup><m:e>${run("b")}</m:e><m:sup>${run("2")}</m:sup></m:sSup>` +
    `<m:sSubSup><m:e>${run("c")}</m:e><m:sub>${run("j")}</m:sub><m:sup>${run("3")}</m:sup></m:sSubSup>`,
  ));
  expect(result.payload.readableMath).toBe("a_{i}b^{2}c_{j}^{3}");
});

it("retains both hidden n-ary limits while omitting them from the visible reading", () => {
  const result = readDocxMathPayload(equation(
    `<m:nary><m:naryPr><m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr>` +
    `<m:sub>${run("i=1")}</m:sub><m:sup>${run("n")}</m:sup><m:e>${run("x")}</m:e></m:nary>`,
  ));
  expect(result.payload).toMatchObject({
    readableMath: "∑(x)",
    hiddenLimits: [
      { path: "expression", position: "lower", text: "i=1" },
      { path: "expression", position: "upper", text: "n" },
    ],
  });
});

it("retains matrix alignment and hidden-placeholder intent in source details", () => {
  const result = readDocxMathPayload(equation(
    `<m:m><m:mPr><m:baseJc m:val="bottom"/><m:plcHide m:val="1"/></m:mPr>` +
    `<m:mr><m:e>${run("x")}</m:e><m:e>${run("1")}</m:e></m:mr>` +
    `<m:mr><m:e>${run("y")}</m:e><m:e>${run("2")}</m:e></m:mr></m:m>`,
  ));
  expect(result.payload).toMatchObject({
    readableMath: "matrix([x | 1]; [y | 2])",
    sourceDetails: [expect.objectContaining({
      path: "expression",
      columns: expect.any(Array),
      baseJustification: "bottom",
      hidePlaceholders: true,
    })],
  });
});

it("keeps authored text formatting and normal-text intent in source details", () => {
  const result = readDocxMathPayload(equation(
    `<m:r><m:rPr><m:nor/><m:scr m:val="sans-serif"/><m:sty m:val="b"/></m:rPr><w:rPr><w:sz w:val="24"/></w:rPr><m:t>Label</m:t></m:r>`,
  ));
  expect(result).toMatchObject({
    readable: true,
    complete: true,
    payload: {
      readableMath: "Label",
      sourceDetails: [expect.objectContaining({
        path: "expression",
        format: expect.objectContaining({
          normalText: true,
          fontSizePt: 12,
          mathScript: "sans-serif",
          mathStyle: "b",
        }),
      })],
    },
  });
});
