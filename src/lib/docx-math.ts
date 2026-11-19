import {
  equationExpressionToLinearMath,
  projectOmmlAtom,
  type EquationExpression,
  type OoxmlNode,
} from "@docx-editor.dev/core/store";

interface MathDiagnostic {
  path: string;
  reason: string;
  expressionPath?: string;
}

interface HiddenLimit {
  path: string;
  position: "lower" | "upper";
  text: string;
}

/** A derived reading view. It is not the editor's compact replacement grammar. */
export function readDocxMathPayload(node: OoxmlNode): {
  readable: boolean;
  complete: boolean;
  payload: {
    fallbackText: string;
    truncated: boolean;
    linear?: string;
    readableMath: string;
    readingFormat: "structured_math_text";
    diagnostics: MathDiagnostic[];
    hiddenLimits?: HiddenLimit[];
    sourceDetails?: Record<string, unknown>[];
  };
} {
  const projection = projectOmmlAtom(node);
  if (!projection) {
    return {
      readable: false,
      complete: false,
      payload: {
        fallbackText: "",
        truncated: false,
        readableMath: "",
        readingFormat: "structured_math_text",
        diagnostics: [{ path: "expression", reason: "No OMML projection is available." }],
      },
    };
  }
  const diagnostics: MathDiagnostic[] = [];
  const hiddenLimits: HiddenLimit[] = [];
  const sourceDetails: Record<string, unknown>[] = [];
  const render = (expression: EquationExpression, path: string): string => {
    const child = (value: EquationExpression, key: string) => render(value, `${path}.${key}`);
    if (expression.kind !== "fallback") {
      const { preserveSource, ...details } = expression;
      const detail = {
        ...(preserveSource ? { preserveSource } : {}),
        ...("controlProperties" in details && details.controlProperties ? { controlProperties: true } : {}),
        ...(expression.kind === "text" && expression.format ? { format: expression.format } : {}),
        ...(expression.kind === "text" && expression.fontSizePt !== undefined ? { fontSizePt: expression.fontSizePt } : {}),
        ...(expression.kind === "text" && expression.appearance ? { appearance: expression.appearance } : {}),
        ...(expression.kind === "matrix" ? { columns: expression.columns,
          ...(expression.baseJustification ? { baseJustification: expression.baseJustification } : {}),
          ...(expression.hidePlaceholders ? { hidePlaceholders: true } : {}) } : {}),
      };
      if (Object.keys(detail).length) sourceDetails.push({ path, ...detail });
    }
    switch (expression.kind) {
      case "text": {
        const script = expression.format?.normalText ? undefined : expression.format?.mathScript;
        return script && script !== "roman" ? `${script}(${expression.value})` : expression.value;
      }
      case "fallback":
        diagnostics.push({ path: expression.sourcePath, reason: expression.reason, expressionPath: path });
        return `unsupported(${expression.text})`;
      case "row":
        return expression.items.map((item, index) => child(item, `items[${index}]`)).join("");
      case "bar":
        return `${expression.position === "top" ? "overline" : "underline"}(${child(expression.body, "body")})`;
      case "borderBox": {
        const hidden = Object.entries(expression.hidden).filter(([, value]) => value).map(([key]) => key);
        const strikes = Object.entries(expression.strikes).filter(([, value]) => value).map(([key]) => key);
        const properties = [hidden.length ? `hidden=${hidden.join(",")}` : "", strikes.length ? `strikes=${strikes.join(",")}` : ""].filter(Boolean);
        return `box${properties.length ? `[${properties.join("; ")}]` : ""}(${child(expression.body, "body")})`;
      }
      case "fraction":
        return `(${child(expression.numerator, "numerator")})/(${child(expression.denominator, "denominator")})`;
      case "radical":
        return expression.degree === undefined
          ? `sqrt(${child(expression.radicand, "radicand")})`
          : `root(${child(expression.degree, "degree")}; ${child(expression.radicand, "radicand")})`;
      case "script":
        return `${child(expression.base, "base")}${expression.subscript === undefined ? "" : `_{${child(expression.subscript, "subscript")}}`}${expression.superscript === undefined ? "" : `^{${child(expression.superscript, "superscript")}}`}`;
      case "nary": {
        const lower = expression.lowerLimit === undefined ? undefined : child(expression.lowerLimit, "lowerLimit");
        const upper = expression.upperLimit === undefined ? undefined : child(expression.upperLimit, "upperLimit");
        if (lower !== undefined && expression.hideLowerLimit) hiddenLimits.push({ path, position: "lower", text: lower });
        if (upper !== undefined && expression.hideUpperLimit) hiddenLimits.push({ path, position: "upper", text: upper });
        return `${expression.operator}${lower === undefined || expression.hideLowerLimit ? "" : `_{${lower}}`}${upper === undefined || expression.hideUpperLimit ? "" : `^{${upper}}`}(${child(expression.body, "body")})`;
      }
      case "matrix":
        return `matrix(${expression.rows.map((row, rowIndex) => `[${row.cells.map((cell, columnIndex) => child(cell, `rows[${rowIndex}].cells[${columnIndex}]`)).join(" | ")}]`).join("; ")})`;
      case "delimiter":
        return `${expression.begin}${expression.items.map((item, index) => child(item, `items[${index}]`)).join(expression.separator)}${expression.end}`;
    }
  };
  const readableMath = render(projection.expression, "expression");
  if (projection.truncated) diagnostics.push({ path: "expression", reason: "The bounded OMML projection was truncated." });
  const linear = equationExpressionToLinearMath(projection.expression);
  return {
    readable: readableMath !== "",
    complete: diagnostics.length === 0,
    payload: {
      fallbackText: projection.fallbackText,
      truncated: projection.truncated,
      ...(linear === "" ? {} : { linear }),
      readableMath,
      readingFormat: "structured_math_text",
      diagnostics,
      ...(hiddenLimits.length ? { hiddenLimits } : {}),
      ...(sourceDetails.length ? { sourceDetails } : {}),
    },
  };
}
