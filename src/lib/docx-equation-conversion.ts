import type * as Latex from "@unified-latex/unified-latex-types";
import { parse, parseMathMinimal } from "@unified-latex/unified-latex-util-parse";
import { strFromU8, unzipSync } from "fflate";
import { textSha256 } from "./assistant-delegation";
import { base64ToBytes } from "./base64";
import { convertAdHoc } from "./tauri";

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MML = "http://www.w3.org/1998/Math/MathML";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DECLARATIONS = new Set(["newcommand", "renewcommand", "DeclareMathOperator"]);
const ENVIRONMENTS = new Set([
  "aligned", "alignedat", "gathered", "split", "cases", "dcases", "matrix",
  "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "array",
]);
const DOCUMENT_COMMANDS = new Set([
  ...DECLARATIONS, "providecommand", "def", "gdef", "edef", "xdef", "let", "csname",
  "endcsname", "catcode", "input", "include", "includeonly", "usepackage", "RequirePackage",
  "documentclass", "begin", "end", "newenvironment", "renewenvironment", "section",
  "subsection", "chapter", "caption", "label", "ref", "eqref", "cref", "Cref", "autoref",
  "tag", "notag", "nonumber", "numberwithin", "bibliography", "cite", "write", "read",
]);

export interface DocxEquationInput {
  latex: string;
  macros?: string;
  display?: boolean;
}

export interface DocxEquationVariantCorrection {
  sourceTokenIndex: number;
  text: string;
  expectedVariant: "bold";
  originalStyle: "bi";
  correctedStyle: "b";
}

export interface CompiledDocxEquation {
  latex: string;
  macros: string;
  omml: string;
  snippet: string;
  warnings: string[];
  sourceHash: string;
  shape: {
    expectedMathObjects: 1;
    actualMathObjects: 1;
    display: boolean;
    structures: string[];
    mathVariants: string[];
    variantCorrections: DocxEquationVariantCorrection[];
  };
}

export class DocxEquationConversionError extends Error {
  constructor(
    public readonly code: "invalid-source" | "invalid-macros" | "math-parse" | "conversion" | "conversion-loss" | "style-fidelity",
    message: string,
    public readonly diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = "DocxEquationConversionError";
  }
}

function validateNodes(nodes: readonly Latex.Node[], code: "invalid-source" | "invalid-macros"): void {
  for (const node of nodes) {
    if (node.type === "macro") {
      if (DOCUMENT_COMMANDS.has(node.content)) {
        throw new DocxEquationConversionError(code, `\\${node.content} is outside a single equation body.`);
      }
      for (const argument of node.args ?? []) validateNodes(argument.content, code);
    } else if (node.type === "environment" || node.type === "mathenv") {
      const parsedEnvironment = node.env as string | Latex.String;
      const environment = typeof parsedEnvironment === "string" ? parsedEnvironment : parsedEnvironment.content;
      if (!ENVIRONMENTS.has(environment)) {
        throw new DocxEquationConversionError(code, `The ${environment} environment is outside a single equation body.`);
      }
      validateNodes(node.content, code);
      for (const argument of node.args ?? []) validateNodes(argument.content, code);
    } else if (node.type === "group" || node.type === "root") {
      validateNodes(node.content, code);
    } else if (node.type === "inlinemath" || node.type === "displaymath" || node.type === "verb" || node.type === "verbatim") {
      throw new DocxEquationConversionError(code, "Enter one equation body without math delimiters or verbatim content.");
    } else if (node.type === "string" && /^[${}]$/.test(node.content)) {
      throw new DocxEquationConversionError(code, "The equation contains a math delimiter or an unmatched brace.");
    }
  }
}

function validateSource(latex: string, macros: string): void {
  if (!latex.trim() || latex.length + macros.length > 16_384) {
    throw new DocxEquationConversionError("invalid-source", "Enter a nonempty equation and macro context of at most 16,384 characters.");
  }
  try {
    validateNodes(parseMathMinimal(latex), "invalid-source");
    for (const node of parse(macros).content) {
      if (node.type === "whitespace" || node.type === "parbreak" || node.type === "comment") continue;
      if (node.type !== "macro" || !DECLARATIONS.has(node.content)) {
        throw new DocxEquationConversionError("invalid-macros", "The macro context accepts only newcommand, renewcommand and DeclareMathOperator declarations.");
      }
      const args = node.args ?? [];
      const name = args[node.content === "DeclareMathOperator" ? 1 : 2]?.content;
      const body = args.at(-1);
      if (name?.length !== 1 || name[0]?.type !== "macro" || DOCUMENT_COMMANDS.has(name[0].content) || body?.openMark !== "{") {
        throw new DocxEquationConversionError("invalid-macros", "Each declaration needs a math macro name and a braced replacement body.");
      }
      for (const argument of args.slice(node.content === "DeclareMathOperator" ? 2 : 3)) {
        validateNodes(argument.content, "invalid-macros");
      }
    }
  } catch (error) {
    if (error instanceof DocxEquationConversionError) throw error;
    throw new DocxEquationConversionError("invalid-source", `Could not parse the equation source: ${String(error)}`);
  }
}

let mathmlCompiler: Promise<(source: string, display: boolean) => string> | undefined;

function loadMathmlCompiler(): Promise<(source: string, display: boolean) => string> {
  mathmlCompiler ??= (async () => {
    const [{ mathjax }, { TeX }, { liteAdaptor }, { RegisterHTMLHandler }, { SerializedMmlVisitor }, { STATE }] = await Promise.all([
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/adaptors/liteAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
      import("mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js"),
      import("mathjax-full/js/core/MathItem.js"),
    ]);
    await import("mathjax-full/js/input/tex/AllPackages.js");
    RegisterHTMLHandler(liteAdaptor());
    return (source: string, display: boolean) => {
      const tex = new TeX({ packages: ["base", "ams", "boldsymbol", "newcommand", "mathtools", "textmacros"], maxMacros: 1000, maxBuffer: 16_384 });
      const document = mathjax.document("", { InputJax: tex });
      return new SerializedMmlVisitor().visitTree(document.convert(source, { display, end: STATE.CONVERT }));
    };
  })();
  return mathmlCompiler;
}

function parseXml(source: string, code: "math-parse" | "conversion-loss"): Document {
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.getElementsByTagName("parsererror").length) {
    throw new DocxEquationConversionError(code, "The equation converter returned invalid XML.");
  }
  return document;
}

interface VariantToken {
  text: string;
  variant?: string;
  run?: Element;
}

function lettersAndNumbers(text: string): string[] {
  return Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character));
}

function expectedVariantTokens(root: Element): VariantToken[] {
  const tokens: VariantToken[] = [];
  const visit = (element: Element, inherited?: string) => {
    const variant = element.getAttribute("mathvariant") ?? inherited;
    if (["mi", "mn", "mtext", "ms"].includes(element.localName)) {
      tokens.push(...lettersAndNumbers(element.textContent ?? "").map((text) => ({ text, variant })));
      return;
    }
    const children = Array.from(element.children);
    if (element.localName === "mroot") children.reverse();
    for (const child of children) visit(child, variant);
  };
  visit(root);
  return tokens;
}

function actualVariant(run: Element, text: string): string {
  const properties = Array.from(run.children).find((element) => element.namespaceURI === M && element.localName === "rPr");
  const property = (name: string) => properties?.getElementsByTagNameNS(M, name)[0]?.getAttributeNS(M, "val");
  const alphabet = property("scr");
  const style = property("sty");
  if (alphabet && alphabet !== "roman") return alphabet;
  if (style === "b") return "bold";
  if (style === "bi") return "bold-italic";
  if (style === "p" || properties?.getElementsByTagNameNS(M, "nor").length) return "normal";
  return /\p{N}/u.test(text) ? "normal" : "italic";
}

function checkVariants(mathml: Element, equation: Element): { variants: string[]; corrections: DocxEquationVariantCorrection[] } {
  const expected = expectedVariantTokens(mathml);
  const variants = [...new Set(expected.flatMap((token) => token.variant ? [token.variant] : []))].sort();
  const actual: VariantToken[] = Array.from(equation.getElementsByTagNameNS(M, "r")).flatMap((run) =>
    lettersAndNumbers(Array.from(run.getElementsByTagNameNS(M, "t")).map((text) => text.textContent ?? "").join(""))
      .map((text) => ({ text, variant: actualVariant(run, text), run })),
  );
  if (expected.map((token) => token.text).join("") !== actual.map((token) => token.text).join("")) {
    throw new DocxEquationConversionError("conversion-loss", "The mathematical letter and number tokens do not have an exact ordered correspondence between LaTeX and OMML.");
  }
  const corrections: DocxEquationVariantCorrection[] = [];
  const correctedRuns = new Set<Element>();
  for (const [index, token] of expected.entries()) {
    const converted = actual[index];
    if (!token.variant || token.variant === converted?.variant) continue;
    if (token.variant !== "bold" || converted?.variant !== "bold-italic" || !converted.run || actual.some((other, otherIndex) => other.run === converted.run && expected[otherIndex]?.variant !== "bold")) {
      throw new DocxEquationConversionError("style-fidelity", `The mathematical alphabet changed for token ${index + 1} (${token.text}): ${token.variant} became ${converted?.variant}.`);
    }
    if (!correctedRuns.has(converted.run)) {
      const style = converted.run.getElementsByTagNameNS(M, "sty")[0];
      if (!style) throw new DocxEquationConversionError("style-fidelity", "The bold mathematical run has no explicit OMML style to correct.");
      style.setAttributeNS(M, "m:val", "b");
      correctedRuns.add(converted.run);
    }
    corrections.push({ sourceTokenIndex: index, text: token.text, expectedVariant: "bold", originalStyle: "bi", correctedStyle: "b" });
  }
  return { variants, corrections };
}

function extractEquation(dataBase64: string): Element {
  let source: string;
  try {
    const entry = unzipSync(base64ToBytes(dataBase64), { filter: (file) => file.name === "word/document.xml" && file.originalSize <= 256 * 1024 })["word/document.xml"];
    if (!entry) throw new Error("word/document.xml is absent or exceeds 256 KB");
    source = strFromU8(entry);
  } catch (error) {
    throw new DocxEquationConversionError("conversion-loss", `Could not read the equation DOCX: ${String(error)}`);
  }
  const document = parseXml(source, "conversion-loss");
  const equations = Array.from(document.getElementsByTagNameNS(M, "oMath"));
  if (equations.length !== 1) {
    throw new DocxEquationConversionError("conversion-loss", `Expected one OMML equation, received ${equations.length}.`);
  }
  const equation = equations[0] as Element;
  const textOutsideMath = Array.from(document.getElementsByTagNameNS(W, "t")).some((text) => !equation.contains(text) && text.textContent?.trim());
  const otherObjects = ["drawing", "pict", "object", "tbl", "fldSimple", "instrText", "footnoteReference", "endnoteReference"].some((name) => document.getElementsByTagNameNS(W, name).length);
  if (textOutsideMath || otherObjects) {
    throw new DocxEquationConversionError("conversion-loss", "The equation conversion contains non-math text, fields or other document objects.");
  }
  if (!equation.getElementsByTagNameNS(M, "t").length) {
    throw new DocxEquationConversionError("conversion-loss", "The equation conversion contains no mathematical text.");
  }
  return equation;
}

export async function compileDocxEquation(input: DocxEquationInput): Promise<CompiledDocxEquation> {
  const { latex, macros = "", display = true } = input;
  validateSource(latex, macros);
  const compile = await loadMathmlCompiler();
  let mathmlSource: string;
  try {
    mathmlSource = compile(`${macros}\n${latex}`, display);
  } catch (error) {
    throw new DocxEquationConversionError("math-parse", `Could not compile the equation: ${String(error)}`);
  }
  const mathml = parseXml(mathmlSource, "math-parse");
  const errors = Array.from(mathml.getElementsByTagNameNS(MML, "merror")).map((element) => element.getAttribute("data-mjx-error") ?? element.textContent ?? "Invalid math");
  if (errors.length) throw new DocxEquationConversionError("math-parse", errors.join("\n"), errors);
  const delimiter = display ? ["\\[", "\\]"] : ["\\(", "\\)"];
  const converted = await convertAdHoc({ source: "latex", target: "docx", report: true, text: `${macros}\n${delimiter[0]}\n${latex}\n${delimiter[1]}` });
  const report = converted.report ?? [];
  if (report.length) {
    throw new DocxEquationConversionError("conversion-loss", `Pandoc reported equation conversion loss:\n${report.join("\n")}`, report);
  }
  if (converted.kind !== "binary" || !converted.dataBase64) {
    throw new DocxEquationConversionError("conversion", "Pandoc did not return a DOCX equation.");
  }
  const equation = extractEquation(converted.dataBase64);
  const { variants, corrections } = checkVariants(mathml.documentElement, equation);
  equation.setAttributeNS(XMLNS, "xmlns:m", M);
  equation.setAttributeNS(XMLNS, "xmlns:w", W);
  const omml = new XMLSerializer().serializeToString(equation);
  const snippet = `<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"><pkg:part pkg:name="/word/document.xml" pkg:contentType="${MAIN_TYPE}"><pkg:xmlData><w:document xmlns:w="${W}" xmlns:m="${M}"><w:body><w:p>${omml}</w:p></w:body></w:document></pkg:xmlData></pkg:part></pkg:package>`;
  return {
    latex, macros, omml, snippet,
    warnings: corrections.length ? ["Pandoc's bold italic output was corrected to the bold alphabet of the corresponding MathJax source tokens."] : [],
    sourceHash: await textSha256(JSON.stringify({ version: 1, latex, macros, display })),
    shape: {
      expectedMathObjects: 1, actualMathObjects: 1, display,
      structures: [...new Set(Array.from(equation.getElementsByTagNameNS(M, "*")).map((element) => element.localName))].sort(),
      mathVariants: variants, variantCorrections: corrections,
    },
  };
}
