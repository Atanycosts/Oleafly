import type { DocxObjectFormatMutation } from "@oleafly/ai-tools";
import type {
  AutomationHandle,
  AutomationHost,
} from "@docx-editor.dev/core/automation";
import type {
  PaginatedSurface,
  TreeDocxSessionView,
} from "@docx-editor.dev/core/editor";
import type {
  OoxmlElement,
  OoxmlProperty,
  OoxmlNode,
  TreeDocOp,
} from "@docx-editor.dev/core/store";
import {
  directParagraphProperties,
  mergedProperties,
} from "@docx-editor.dev/core/store";
import type { DocxApplyResult } from "./docx-session";

interface ObjectAnchor {
  readonly tableId: string;
  readonly rowId?: string;
  readonly cellId?: string;
}

function failure(
  code: Extract<DocxApplyResult, { ok: false }>["code"],
  message: string,
  revision: number,
): DocxApplyResult {
  return { ok: false, code, message, revision, changed: false };
}

function staleTarget(revision: number): DocxApplyResult {
  return failure(
    "stale-target",
    "The target paragraph changed or was deleted since it was read.",
    revision,
  );
}

function unsupportedObject(
  revision: number,
  kind: "table" | "row" | "cell",
): DocxApplyResult {
  return failure(
    "unsupported-target",
    `The target paragraph is not inside a ${kind}.`,
    revision,
  );
}

function invalidFormat(revision: number, message: string): DocxApplyResult {
  return failure("invalid-format", message, revision);
}

function paragraphIdForHandle(
  host: AutomationHost,
  tree: TreeDocxSessionView,
  paragraph: AutomationHandle<"paragraph">,
): string | DocxApplyResult {
  const response = host.execute({
    operations: [{ op: "getParagraphId", paragraph }],
  });
  if (!response.ok) {
    const error = response.results.find(
      (result): result is Extract<typeof result, { status: "error" }> =>
        result.status === "error",
    )?.error;
    if (!error) {
      throw new Error(
        "The DOCX host refused a paragraph identity without an error.",
      );
    }
    if (error.code === "invalid-handle" || error.code === "stale-revision") {
      return staleTarget(response.revision);
    }
    return failure(error.code, error.message, response.revision);
  }
  const value = response.results[0];
  if (value?.status !== "ok" || value.value.kind !== "text") {
    throw new Error("The DOCX host did not answer paragraph identity text.");
  }
  const paragraphId =
    value.value.text === "" ? null : tree.nodeIdOf(value.value.text);
  return paragraphId ?? staleTarget(response.revision);
}

function ancestorPath(
  node: OoxmlNode,
  nodeId: string,
  path: readonly OoxmlElement[],
): readonly OoxmlElement[] | null {
  if (node.id === nodeId) return path;
  if (node.kind === "textValue") return null;
  const nextPath = node.kind === "document" ? path : [...path, node];
  for (const child of node.children) {
    const found = ancestorPath(child, nodeId, nextPath);
    if (found) return found;
  }
  return null;
}

function objectAnchor(
  tree: TreeDocxSessionView,
  paragraphId: string,
  kind: "table" | "row" | "cell",
): ObjectAnchor | null {
  const path = ancestorPath(tree.part().root, paragraphId, []);
  if (!path) return null;
  const nearest = [...path].reverse();
  const table = nearest.find((node) => node.kind === "table");
  if (!table) return null;
  if (kind === "table") return { tableId: table.id };

  const row = nearest.find((node) => node.kind === "tableRow");
  if (!row) return null;
  if (kind === "row") return { tableId: table.id, rowId: row.id };

  const cell = nearest.find((node) => node.kind === "tableCell");
  return cell ? { tableId: table.id, cellId: cell.id } : null;
}

function validInteger(value: number, minimum: number): boolean {
  return Number.isInteger(value) && value >= minimum;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FRAME_ATTRIBUTES = {
  widthTwips: "w",
  heightTwips: "h",
  xTwips: "x",
  yTwips: "y",
  horizontalAnchor: "hAnchor",
  verticalAnchor: "vAnchor",
  horizontalAlignment: "xAlign",
  verticalAlignment: "yAlign",
  wrap: "wrap",
  horizontalSpaceTwips: "hSpace",
  verticalSpaceTwips: "vSpace",
  heightRule: "hRule",
} as const;

function validateMutation(
  tree: TreeDocxSessionView,
  mutation: DocxObjectFormatMutation,
): string | null {
  if (mutation.kind === "frame") {
    if (mutation.frame === null) return null;
    if (!hasOnlyKeys(mutation.frame, Object.keys(FRAME_ATTRIBUTES)))
      return "frame contains an unsupported format field.";
    if (
      !validInteger(mutation.frame.widthTwips, 1) ||
      mutation.frame.widthTwips > 63360
    )
      return "widthTwips must be between 1 and 63360.";
    for (const name of [
      "heightTwips",
      "horizontalSpaceTwips",
      "verticalSpaceTwips",
    ] as const) {
      const value = mutation.frame[name];
      if (value !== undefined && (!validInteger(value, 0) || value > 63360))
        return `${name} must be between 0 and 63360.`;
    }
    for (const name of ["xTwips", "yTwips"] as const)
      if (
        mutation.frame[name] !== undefined &&
        !Number.isInteger(mutation.frame[name])
      )
        return `${name} must be an integer.`;
    const enums = {
      horizontalAnchor: ["page", "margin", "text"],
      verticalAnchor: ["page", "margin", "text"],
      horizontalAlignment: ["left", "center", "right", "inside", "outside"],
      verticalAlignment: ["top", "center", "bottom", "inside", "outside"],
      wrap: ["auto", "around", "none", "notBeside", "through", "tight"],
      heightRule: ["auto", "atLeast", "exact"],
    };
    for (const [name, values] of Object.entries(enums)) {
      const value = mutation.frame[name as keyof typeof mutation.frame];
      if (value !== undefined && !values.includes(String(value)))
        return `${name} is unsupported.`;
    }
    return null;
  }
  if (mutation.kind === "section") {
    if (
      !hasOnlyKeys(mutation.section, [
        "pageWidthTwips",
        "pageHeightTwips",
        "orientation",
        "marginTopTwips",
        "marginRightTwips",
        "marginBottomTwips",
        "marginLeftTwips",
        "columns",
      ])
    )
      return "section contains an unsupported format field.";
    if (Object.values(mutation.section).every((value) => value === undefined)) {
      return "Supply at least one section format field.";
    }
    for (const field of ["pageWidthTwips", "pageHeightTwips"] as const) {
      const value = mutation.section[field];
      if (value !== undefined && !validInteger(value, 1)) {
        return `${field} must be a positive integer.`;
      }
    }
    for (const field of [
      "marginTopTwips",
      "marginRightTwips",
      "marginBottomTwips",
      "marginLeftTwips",
    ] as const) {
      const value = mutation.section[field];
      if (value !== undefined && !validInteger(value, 0)) {
        return `${field} must be a non-negative integer.`;
      }
    }
    if (
      mutation.section.orientation !== undefined &&
      mutation.section.orientation !== "portrait" &&
      mutation.section.orientation !== "landscape"
    ) {
      return "orientation must be portrait or landscape.";
    }
    const columns = mutation.section.columns;
    if (
      columns !== undefined &&
      (!isRecord(columns) ||
        !hasOnlyKeys(columns, ["count", "spaceTwips", "separator"]) ||
        !validInteger(columns.count, 1) ||
        columns.count > 45 ||
        (columns.spaceTwips !== undefined &&
          (!validInteger(columns.spaceTwips, 0) ||
            columns.spaceTwips > 31680)) ||
        (columns.separator !== undefined &&
          typeof columns.separator !== "boolean"))
    )
      return "columns must specify 1 to 45 equal-width columns with valid spacing.";
    return null;
  }

  if (mutation.kind === "table") {
    if (
      !hasOnlyKeys(mutation.table, [
        "styleId",
        "headerRowCount",
        "columnWidthsTwips",
      ])
    )
      return "table contains an unsupported format field.";
    if (Object.values(mutation.table).every((value) => value === undefined)) {
      return "Supply at least one table format field.";
    }
    if (
      mutation.table.styleId !== undefined &&
      (typeof mutation.table.styleId !== "string" ||
        mutation.table.styleId.trim().length === 0)
    ) {
      return "styleId must name an existing table style.";
    }
    if (
      mutation.table.headerRowCount !== undefined &&
      !validInteger(mutation.table.headerRowCount, 0)
    ) {
      return "headerRowCount must be a non-negative integer.";
    }
    if (
      mutation.table.columnWidthsTwips !== undefined &&
      (!Array.isArray(mutation.table.columnWidthsTwips) ||
        mutation.table.columnWidthsTwips.length === 0 ||
        mutation.table.columnWidthsTwips.some(
          (width) => !validInteger(width, 1),
        ))
    ) {
      return "columnWidthsTwips must contain positive integers.";
    }
    if (
      mutation.table.styleId !== undefined &&
      !tree
        .documentStyles()
        .some(
          (style) =>
            style.type === "table" && style.styleId === mutation.table.styleId,
        )
    ) {
      return `Table style ${mutation.table.styleId} is not available in this document.`;
    }
    return null;
  }

  if (mutation.kind === "row") {
    if (!hasOnlyKeys(mutation.row, ["heightTwips"])) {
      return "row contains an unsupported format field.";
    }
    return validInteger(mutation.row.heightTwips, 1)
      ? null
      : "heightTwips must be a positive integer.";
  }

  if (!hasOnlyKeys(mutation.cell, ["fill", "verticalAlignment"])) {
    return "cell contains an unsupported format field.";
  }
  if (Object.values(mutation.cell).every((value) => value === undefined)) {
    return "Supply at least one cell format field.";
  }
  if (
    mutation.cell.fill !== undefined &&
    mutation.cell.fill !== null &&
    (typeof mutation.cell.fill !== "string" ||
      !/^#?[0-9A-Fa-f]{6}$/.test(mutation.cell.fill))
  ) {
    return "fill must be a six-digit hexadecimal color or null.";
  }
  if (
    mutation.cell.verticalAlignment !== undefined &&
    !["top", "center", "bottom"].includes(mutation.cell.verticalAlignment)
  ) {
    return "verticalAlignment must be top, center or bottom.";
  }
  return null;
}

function treeOps(
  mutation: DocxObjectFormatMutation,
  paragraphId: string,
  anchor: ObjectAnchor | null,
): readonly TreeDocOp[] {
  if (mutation.kind === "frame") return [];
  if (mutation.kind === "section") {
    const {
      pageWidthTwips,
      pageHeightTwips,
      orientation,
      marginTopTwips,
      marginRightTwips,
      marginBottomTwips,
      marginLeftTwips,
      columns,
    } = mutation.section;
    return [
      {
        op: "setSectionProperties",
        anchorParagraphId: paragraphId,
        ...(pageWidthTwips === undefined ? {} : { pageWidthTwips }),
        ...(pageHeightTwips === undefined ? {} : { pageHeightTwips }),
        ...(orientation === undefined ? {} : { orientation }),
        ...(marginTopTwips === undefined ? {} : { marginTopTwips }),
        ...(marginRightTwips === undefined ? {} : { marginRightTwips }),
        ...(marginBottomTwips === undefined ? {} : { marginBottomTwips }),
        ...(marginLeftTwips === undefined ? {} : { marginLeftTwips }),
        ...(columns === undefined ? {} : { columns }),
      },
    ];
  }
  if (!anchor) return [];
  if (mutation.kind === "table") {
    const { styleId, headerRowCount, columnWidthsTwips } = mutation.table;
    return [
      {
        op: "setTableProperties",
        tableId: anchor.tableId,
        ...(styleId === undefined ? {} : { styleId }),
        ...(headerRowCount === undefined ? {} : { headerRowCount }),
        ...(columnWidthsTwips === undefined ? {} : { columnWidthsTwips }),
      },
    ];
  }
  if (mutation.kind === "row") {
    if (!anchor.rowId) return [];
    return [
      {
        op: "setTableRowHeight",
        tableId: anchor.tableId,
        rowId: anchor.rowId,
        heightTwips: mutation.row.heightTwips,
      },
    ];
  }
  if (!anchor.cellId) return [];
  const fill = mutation.cell.fill;
  return [
    ...(fill === undefined
      ? []
      : [
          {
            op: "setTableCellFill" as const,
            tableId: anchor.tableId,
            cellIds: [anchor.cellId],
            color:
              fill === null
                ? null
                : {
                    kind: "hex" as const,
                    value: fill.replace(/^#/, "").toUpperCase(),
                  },
          },
        ]),
    ...(mutation.cell.verticalAlignment === undefined
      ? []
      : [
          {
            op: "setTableCellVerticalAlignment" as const,
            tableId: anchor.tableId,
            cellIds: [anchor.cellId],
            alignment: mutation.cell.verticalAlignment,
          },
        ]),
  ];
}

export function planDocxObjectFormat(
  host: AutomationHost,
  surface: Pick<PaginatedSurface, "session" | "editingMode"> | null,
  paragraph: AutomationHandle<"paragraph">,
  expectedRevision: number,
  input: unknown,
): readonly TreeDocOp[] | DocxApplyResult {
  if (host.revision() !== expectedRevision) return staleTarget(host.revision());
  if (!surface) {
    return failure(
      "unsupported-target",
      "Section and table formatting require a live editor tree session.",
      host.revision(),
    );
  }
  const tree = surface.session;
  if (!isRecord(input)) {
    return invalidFormat(
      host.revision(),
      "Choose section, table, row or cell formatting.",
    );
  }
  const kind = input.kind;
  if (
    kind !== "frame" &&
    kind !== "section" &&
    kind !== "table" &&
    kind !== "row" &&
    kind !== "cell"
  ) {
    return invalidFormat(
      host.revision(),
      "Choose section, table, row or cell formatting.",
    );
  }
  if (!hasOnlyKeys(input, ["kind", kind])) {
    return invalidFormat(
      host.revision(),
      "The format contains an unsupported top-level field.",
    );
  }
  if (!(kind === "frame" && input.frame === null) && !isRecord(input[kind])) {
    return invalidFormat(
      host.revision(),
      `${kind} formatting must be an object.`,
    );
  }
  const paragraphId = paragraphIdForHandle(host, tree, paragraph);
  if (typeof paragraphId !== "string") return paragraphId;
  const mutation = input as DocxObjectFormatMutation;
  const anchor =
    kind === "section" || kind === "frame"
      ? null
      : objectAnchor(tree, paragraphId, kind);
  if (kind !== "section" && kind !== "frame" && !anchor) {
    return unsupportedObject(host.revision(), kind);
  }
  const invalid = validateMutation(tree, mutation);
  if (invalid) return invalidFormat(host.revision(), invalid);
  if (kind !== "frame" && surface.editingMode() === "suggest") {
    return failure(
      "unsupported-target",
      "Section and table object formatting cannot be recorded as a suggested revision. Switch to editing mode to apply it.",
      host.revision(),
    );
  }

  if (mutation.kind === "frame") {
    const direct = directParagraphProperties(tree.part(), paragraphId);
    const existing = direct.filter(
      (property) => property.localName === "framePr",
    );
    const properties = direct.filter(
      (property) => property.localName !== "framePr",
    );
    const frame: readonly OoxmlProperty[] =
      mutation.frame === null
        ? []
        : [
            {
              localName: "framePr",
              attributes: {
                ...Object.assign(
                  {},
                  ...existing.map((property) => property.attributes),
                ),
                ...Object.fromEntries(
                  Object.entries(mutation.frame)
                    .filter(([, value]) => value !== undefined)
                    .map(([name, value]) => [
                      FRAME_ATTRIBUTES[name as keyof typeof FRAME_ATTRIBUTES],
                      String(value),
                    ]),
                ),
              },
            },
          ];
    return [
      {
        op: "setParagraphProperties",
        paragraphId,
        properties: mergedProperties(properties, frame),
      },
    ];
  }
  return treeOps(mutation, paragraphId, anchor);
}

export function formatDocxObject(
  host: AutomationHost,
  surface: PaginatedSurface | null,
  paragraph: AutomationHandle<"paragraph">,
  expectedRevision: number,
  input: unknown,
): DocxApplyResult {
  const operations = planDocxObjectFormat(
    host,
    surface,
    paragraph,
    expectedRevision,
    input,
  );
  if (!Array.isArray(operations)) return operations as DocxApplyResult;
  const result = surface!.applyAutomationOps(() => operations);
  if (result.rejected) {
    return failure(
      "transaction-refused",
      result.reason ??
        "The DOCX tree refused the object formatting transaction.",
      host.revision(),
    );
  }
  return { ok: true, revision: host.revision(), changed: result.committed };
}
