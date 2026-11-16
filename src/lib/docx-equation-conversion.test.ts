// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "./base64";
import { compileDocxEquation, DocxEquationConversionError } from "./docx-equation-conversion";
import { convertAdHoc } from "./tauri";

vi.mock("./tauri", () => ({ convertAdHoc: vi.fn() }));

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const pandoc = resolve("src-tauri/binaries/pandoc-aarch64-apple-darwin");
const run = (text: string, properties = "") => `<m:r>${properties ? `<m:rPr>${properties}</m:rPr>` : ""}<m:t>${text}</m:t></m:r>`;

function conversion(body: string, report: string[] = []) {
  return {
    kind: "binary" as const, text: null,
    dataBase64: bytesToBase64(zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${body}</w:body></w:document>`) })),
    fileName: "converted.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    files: [], report,
  };
}

function equation(content: string) {
  return conversion(`<w:p><m:oMathPara><m:oMath>${content}</m:oMath></m:oMathPara></w:p>`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
});

it("preserves the exact source context and emits one inline Flat OPC equation", async () => {
  vi.mocked(convertAdHoc).mockResolvedValue(equation(run("x")));
  const input = { latex: "\\vr{x}", macros: "\\newcommand{\\vr}[1]{\\mathit{#1}}", display: false };
  const result = await compileDocxEquation(input);
  expect(convertAdHoc).toHaveBeenCalledWith({ source: "latex", target: "docx", report: true, text: `${input.macros}\n\\(\n${input.latex}\n\\)` });
  expect(result).toMatchObject({ latex: input.latex, macros: input.macros, warnings: [], shape: { expectedMathObjects: 1, actualMathObjects: 1, display: false } });
  expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.snippet).toContain('pkg:name="/word/document.xml"');
  expect(result.snippet).not.toContain("oMathPara");
  expect(new DOMParser().parseFromString(result.snippet, "application/xml").getElementsByTagNameNS(M, "oMath")).toHaveLength(1);
  const another = await compileDocxEquation({ ...input, macros: "\\newcommand{\\vr}[1]{#1}" });
  expect(another.sourceHash).not.toBe(result.sourceHash);
});

it.each([
  "", "$x$", "\\[x\\]", "x\\(y\\)", "{x", "\\label{eq:1}x", "x\\tag{1}",
  "\\begin{equation}x\\end{equation}", "\\documentclass{article}x",
  "\\begin{algorithm}\\KwIn{$x$}\\end{algorithm}", "\\input{paper.tex}",
  "\\newcommand{\\x}{x}\\x", "\\text{\\label{x}}", "x".repeat(16_385),
])("rejects a document, algorithm, delimiter or numbering command before conversion (%s)", async (latex) => {
  await expect(compileDocxEquation({ latex })).rejects.toBeInstanceOf(DocxEquationConversionError);
  expect(convertAdHoc).not.toHaveBeenCalled();
});

it.each([
  "\\input{macros.tex}", "\\def\\x{x}", "\\newcommand{\\x}{x}unexpected",
  "\\newcommand{\\x}{\\label{eq:1}}", "\\newcommand{\\end}{x}",
  "\\newcommand{\\x}{\\begin{algorithm}x\\end{algorithm}}",
])("limits macro context to explicit math declarations (%s)", async (macros) => {
  await expect(compileDocxEquation({ latex: "x", macros })).rejects.toMatchObject({ code: "invalid-macros" });
  expect(convertAdHoc).not.toHaveBeenCalled();
});

it("reports a real undefined macro from the independent math parser", async () => {
  await expect(compileDocxEquation({ latex: "\\UnknownMath{x}+y" })).rejects.toMatchObject({ code: "math-parse", diagnostics: [expect.stringContaining("UnknownMath")] });
  expect(convertAdHoc).not.toHaveBeenCalled();
});

it("keeps actual Pandoc warnings visible instead of claiming a converted equation", async () => {
  const report = ["Could not convert TeX math x, rendering as TeX:"];
  vi.mocked(convertAdHoc).mockResolvedValue(conversion("<w:p><w:r><w:t>$x$</w:t></w:r></w:p>", report));
  await expect(compileDocxEquation({ latex: "x" })).rejects.toMatchObject({ code: "conversion-loss", diagnostics: report });
});

it.each([
  "<w:p><w:r><w:t>$x$</w:t></w:r></w:p>",
  `<w:p><m:oMath>${run("x")}</m:oMath><m:oMath>${run("y")}</m:oMath></w:p>`,
  `<w:p><m:oMath>${run("x")}</m:oMath><w:r><w:t>lost prose</w:t></w:r></w:p>`,
  `<w:p><m:oMath>${run("x")}</m:oMath><w:r><w:drawing/></w:r></w:p>`,
  "<w:p><m:oMath/></w:p>",
])("refuses missing math, extra objects and non-math text (%s)", async (body) => {
  vi.mocked(convertAdHoc).mockResolvedValue(conversion(body));
  await expect(compileDocxEquation({ latex: "x" })).rejects.toMatchObject({ code: "conversion-loss" });
});

it("corrects only source-aligned bold tokens and preserves boldsymbol", async () => {
  vi.mocked(convertAdHoc).mockResolvedValue(equation(run("x", '<m:sty m:val="bi"/>') + run("+") + run("y", '<m:sty m:val="bi"/>') + run("+") + run("1", '<m:sty m:val="b"/>')));
  const result = await compileDocxEquation({ latex: "\\mathbf{x}+\\boldsymbol{y}+\\mathbf{1}" });
  const root = new DOMParser().parseFromString(result.omml, "application/xml");
  expect(Array.from(root.getElementsByTagNameNS(M, "sty")).map((element) => element.getAttributeNS(M, "val"))).toEqual(["b", "bi", "b"]);
  expect(result.shape.variantCorrections).toEqual([{ sourceTokenIndex: 0, text: "x", expectedVariant: "bold", originalStyle: "bi", correctedStyle: "b" }]);
  expect(result.warnings).toHaveLength(1);
});

it("does not correct bold when the independent source tokens cannot be aligned exactly", async () => {
  vi.mocked(convertAdHoc).mockResolvedValue(equation(run("y", '<m:sty m:val="bi"/>')));
  await expect(compileDocxEquation({ latex: "\\mathbf{x}" })).rejects.toMatchObject({ code: "conversion-loss" });
});

it("detects partial mathematical text loss even when one OMML object remains", async () => {
  vi.mocked(convertAdHoc).mockResolvedValue(equation(run("x")));
  await expect(compileDocxEquation({ latex: "x+y" })).rejects.toMatchObject({ code: "conversion-loss" });
});

it("refuses lost mathematical alphabets instead of deleting their meaning", async () => {
  vi.mocked(convertAdHoc).mockResolvedValue(equation(run("R")));
  await expect(compileDocxEquation({ latex: "\\mathbb{R}" })).rejects.toMatchObject({ code: "style-fidelity" });
});

describe.skipIf(!existsSync(pandoc))("native Pandoc equation conversion", () => {
  beforeEach(() => {
    vi.mocked(convertAdHoc).mockImplementation(async (request) => {
      const bytes = execFileSync(pandoc, ["--from=latex", "--to=docx", "--sandbox"], { input: request.text, maxBuffer: 1024 * 1024 });
      return { kind: "binary", text: null, dataBase64: bytesToBase64(bytes), fileName: "converted.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", files: [], report: [] };
    });
  });

  it.each([
    ["\\frac{x_i^2+1}{\\sqrt{y}}", "f"],
    ["\\sum_{i=1}^n x_i", "nary"],
    ["\\mathbb{R}^d", "scr"],
    ["U^{\\mathsf{T}}", "scr"],
    ["\\begin{aligned}a&=b+c\\\\d&=e-f\\end{aligned}", "eqArr"],
    ["\\begin{split}a&=b\\\\&=c\\end{split}", "eqArr"],
    ["f(x)=\\begin{cases}x&x>0\\\\0&x<0\\end{cases}", "m"],
    ["\\operatorname{Law}(X)", "r"],
    ["\\mathbf{x}+\\boldsymbol{y}", "sty"],
  ])("converts %s into one OMML equation containing %s", async (latex, structure) => {
    const result = await compileDocxEquation({ latex });
    expect(result.shape.structures).toContain(structure);
    expect(result.shape.actualMathObjects).toBe(1);
  });

  it("converts explicit macro context without importing a source document", async () => {
    const result = await compileDocxEquation({ latex: "\\vect{x}+\\Law(X)", macros: "\\newcommand{\\vect}[1]{\\mathbf{#1}}\n\\DeclareMathOperator{\\Law}{Law}" });
    expect(result.omml).toContain('m:val="b"');
    expect(result.shape.variantCorrections[0]).toMatchObject({ text: "x", expectedVariant: "bold" });
  });
});
