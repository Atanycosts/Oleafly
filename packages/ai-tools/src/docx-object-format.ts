export interface DocxSectionFormatWrite {
  pageWidthTwips?: number;
  pageHeightTwips?: number;
  orientation?: "portrait" | "landscape";
  marginTopTwips?: number;
  marginRightTwips?: number;
  marginBottomTwips?: number;
  marginLeftTwips?: number;
  columns?: { count: number; spaceTwips?: number; separator?: boolean };
}

export interface DocxParagraphFrameWrite {
  widthTwips: number;
  heightTwips?: number;
  xTwips?: number;
  yTwips?: number;
  horizontalAnchor?: "page" | "margin" | "text";
  verticalAnchor?: "page" | "margin" | "text";
  horizontalAlignment?: "left" | "center" | "right" | "inside" | "outside";
  verticalAlignment?: "top" | "center" | "bottom" | "inside" | "outside";
  wrap?: "auto" | "around" | "none" | "notBeside" | "through" | "tight";
  horizontalSpaceTwips?: number;
  verticalSpaceTwips?: number;
  heightRule?: "auto" | "atLeast" | "exact";
}

export interface DocxTableFormatWrite {
  styleId?: string;
  headerRowCount?: number;
  columnWidthsTwips?: number[];
}

export interface DocxRowFormatWrite {
  heightTwips: number;
}

export interface DocxCellFormatWrite {
  fill?: string | null;
  verticalAlignment?: "top" | "center" | "bottom";
}

export type DocxObjectFormatMutation =
  | { kind: "frame"; frame: DocxParagraphFrameWrite | null }
  | { kind: "section"; section: DocxSectionFormatWrite }
  | { kind: "table"; table: DocxTableFormatWrite }
  | { kind: "row"; row: DocxRowFormatWrite }
  | { kind: "cell"; cell: DocxCellFormatWrite };

export const DOCX_OBJECT_FORMAT_SCHEMAS = {
  scope: { enum: ["paragraph", "frame", "section", "table", "row", "cell"] },
  section: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      pageWidthTwips: { type: "integer", minimum: 1 },
      pageHeightTwips: { type: "integer", minimum: 1 },
      orientation: { enum: ["portrait", "landscape"] },
      marginTopTwips: { type: "integer", minimum: 0 },
      marginRightTwips: { type: "integer", minimum: 0 },
      marginBottomTwips: { type: "integer", minimum: 0 },
      marginLeftTwips: { type: "integer", minimum: 0 },
      columns: {
        type: "object",
        additionalProperties: false,
        required: ["count"],
        properties: {
          count: { type: "integer", minimum: 1, maximum: 45 },
          spaceTwips: { type: "integer", minimum: 0, maximum: 31680 },
          separator: { type: "boolean" },
        },
      },
    },
  },
  frame: {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["widthTwips"],
    description: "Paragraph positioning frame. Null removes the direct frame.",
    properties: {
      widthTwips: { type: "integer", minimum: 1, maximum: 63360 },
      heightTwips: { type: "integer", minimum: 0, maximum: 63360 },
      xTwips: { type: "integer" },
      yTwips: { type: "integer" },
      horizontalAnchor: { enum: ["page", "margin", "text"] },
      verticalAnchor: { enum: ["page", "margin", "text"] },
      horizontalAlignment: {
        enum: ["left", "center", "right", "inside", "outside"],
      },
      verticalAlignment: {
        enum: ["top", "center", "bottom", "inside", "outside"],
      },
      wrap: {
        enum: ["auto", "around", "none", "notBeside", "through", "tight"],
      },
      horizontalSpaceTwips: { type: "integer", minimum: 0 },
      verticalSpaceTwips: { type: "integer", minimum: 0 },
      heightRule: { enum: ["auto", "atLeast", "exact"] },
    },
  },
  table: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      styleId: {
        type: "string",
        minLength: 1,
        description: "Existing table style ID in the current document.",
      },
      headerRowCount: { type: "integer", minimum: 0 },
      columnWidthsTwips: {
        type: "array",
        minItems: 1,
        items: { type: "integer", minimum: 1 },
      },
    },
  },
  row: {
    type: "object",
    additionalProperties: false,
    required: ["heightTwips"],
    properties: { heightTwips: { type: "integer", minimum: 1 } },
  },
  cell: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      fill: {
        type: ["string", "null"],
        pattern: "^#?[0-9A-Fa-f]{6}$",
        description: "Direct cell shading. Null removes the direct override.",
      },
      verticalAlignment: { enum: ["top", "center", "bottom"] },
    },
  },
} as const;

export function docxObjectFormatMutation(
  input: Record<string, unknown>,
): DocxObjectFormatMutation | null {
  const kind = input.scope ?? "paragraph";
  const fields = [
    "font",
    "paragraph",
    "section",
    "table",
    "row",
    "cell",
    "frame",
  ];
  if (kind === "paragraph") {
    if (fields.slice(2).some((field) => input[field] !== undefined)) {
      throw new Error(
        "Section, table, row and cell formats require their matching scope.",
      );
    }
    return null;
  }
  if (
    kind !== "frame" &&
    kind !== "section" &&
    kind !== "table" &&
    kind !== "row" &&
    kind !== "cell"
  ) {
    throw new Error(
      "Choose paragraph, section, table, row or cell formatting scope.",
    );
  }
  if (fields.some((field) => field !== kind && input[field] !== undefined)) {
    throw new Error("Supply format fields only for the selected scope.");
  }
  const value = input[kind];
  if (kind === "frame" && value === null) return { kind, frame: null };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error(`Supply at least one ${kind} format field.`);
  }
  return { kind, [kind]: value } as DocxObjectFormatMutation;
}
