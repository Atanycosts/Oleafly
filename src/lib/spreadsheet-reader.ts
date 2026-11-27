import { parseDelimited } from "@oleafly/conversion-registry/table";
import type { CellObject, ParsingOptions, WorkSheet } from "xlsx";

export type SpreadsheetFormat = "xlsx" | "xls" | "csv" | "tsv";
export type SpreadsheetTextDecoder = "utf-8" | "utf-16le" | "utf-16be";
export type SpreadsheetEncoding = SpreadsheetTextDecoder | "unknown";
export type SpreadsheetDelimiter = "," | "\t";

export const MAX_SPREADSHEET_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_SPREADSHEET_RANGE_ROWS = 10_000;
export const MAX_SPREADSHEET_RANGE_COLUMNS = 100;
export const MAX_SPREADSHEET_CELL_UTF16_UNITS = 32_767;
export const MAX_SPREADSHEET_RANGE_CELLS = 50_000;
export const MAX_SPREADSHEET_RANGE_TEXT_UNITS = 2 * 1024 * 1024;

export interface SpreadsheetDecodeInfo {
  readonly encoding: SpreadsheetEncoding | null;
  readonly decoder: SpreadsheetTextDecoder | null;
  readonly bom: SpreadsheetTextDecoder | null;
  readonly quality: "exact" | "lossy" | "not_applicable";
  readonly replacementCharacters: number;
}

export interface SpreadsheetBounds {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface SpreadsheetSheetInfo {
  readonly position: number;
  readonly name: string;
  readonly bounds: SpreadsheetBounds | null;
}

export type SpreadsheetTruncationReason =
  | "row_limit"
  | "column_limit"
  | "cell_limit"
  | "cell_text_limit"
  | "range_text_limit";

export interface SpreadsheetTruncation {
  readonly reason: SpreadsheetTruncationReason;
  readonly limit: number;
}

export interface SpreadsheetHeaderCell extends SpreadsheetRangeCell {
  readonly column: number;
}

export interface SpreadsheetHeaderOptions {
  readonly sheet?: string;
  readonly row?: number;
  readonly startColumn?: number;
  readonly endColumn?: number;
}

export interface SpreadsheetHeaderResult extends Omit<SpreadsheetRangeResult, "rows"> {
  readonly rowSource: "requested" | "default";
  readonly cells: readonly SpreadsheetHeaderCell[];
}

export interface SpreadsheetRangeOptions {
  readonly sheet?: string;
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface SpreadsheetRangeCell {
  readonly text: string;
  readonly truncated: boolean;
}

export interface SpreadsheetRangeRow {
  readonly row: number;
  readonly cells: readonly SpreadsheetRangeCell[];
}

export interface SpreadsheetRangeResult {
  readonly sheet: SpreadsheetSheetInfo;
  readonly requested: SpreadsheetBounds;
  readonly available: SpreadsheetBounds | null;
  readonly returned: SpreadsheetBounds | null;
  readonly outOfBounds: boolean;
  readonly truncation: readonly SpreadsheetTruncation[];
  readonly rows: readonly SpreadsheetRangeRow[];
}

export interface SpreadsheetReader {
  readonly fileName: string;
  readonly format: SpreadsheetFormat;
  readonly byteLength: number;
  readonly delimiter: SpreadsheetDelimiter | null;
  readonly encoding: SpreadsheetDecodeInfo;
  listSheets(): readonly SpreadsheetSheetInfo[];
  readHeader(options?: SpreadsheetHeaderOptions): SpreadsheetHeaderResult;
  readRange(options: SpreadsheetRangeOptions): SpreadsheetRangeResult;
}

export type SpreadsheetReadErrorCode =
  | "unsupported_format"
  | "source_too_large"
  | "invalid_workbook"
  | "no_sheets"
  | "unknown_sheet"
  | "invalid_range";

export class SpreadsheetReadError extends Error {
  readonly code: SpreadsheetReadErrorCode;

  constructor(code: SpreadsheetReadErrorCode, message: string) {
    super(message);
    this.name = "SpreadsheetReadError";
    this.code = code;
  }
}

type XlsxModule = typeof import("xlsx");

interface ExcelSheet {
  readonly kind: "excel";
  readonly info: SpreadsheetSheetInfo;
  readonly worksheet: WorkSheet;
  readonly xlsx: XlsxModule;
}

interface DelimitedSheet {
  readonly kind: "delimited";
  readonly info: SpreadsheetSheetInfo;
  readonly rows: readonly (readonly string[])[];
}

type ParsedSheet = ExcelSheet | DelimitedSheet;

interface BomMatch {
  readonly encoding: SpreadsheetTextDecoder;
  readonly length: number;
}

function spreadsheetFormat(fileName: string): SpreadsheetFormat {
  const extension = /\.([^.]+)$/u.exec(fileName)?.[1]?.toLowerCase();
  if (extension === "xlsx" || extension === "xls" || extension === "csv" || extension === "tsv") {
    return extension;
  }
  throw new SpreadsheetReadError(
    "unsupported_format",
    `Cannot read ${fileName}: expected .xlsx, .xls, .csv or .tsv.`,
  );
}

function emptyDecodeInfo(): SpreadsheetDecodeInfo {
  return {
    encoding: null,
    decoder: null,
    bom: null,
    quality: "not_applicable",
    replacementCharacters: 0,
  };
}

function bomAt(bytes: Uint8Array): BomMatch | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", length: 3 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", length: 2 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", length: 2 };
  }
  return null;
}

function replacementCount(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\uFFFD") count += 1;
  }
  return count;
}

function decodeDelimitedText(bytes: Uint8Array): {
  readonly text: string;
  readonly info: SpreadsheetDecodeInfo;
} {
  const bom = bomAt(bytes);
  const decoder = bom?.encoding ?? "utf-8";
  const body = bytes.subarray(bom?.length ?? 0);
  try {
    const text = new TextDecoder(decoder, { fatal: true, ignoreBOM: true }).decode(body);
    return {
      text,
      info: {
        encoding: bom?.encoding ?? "utf-8",
        decoder,
        bom: bom?.encoding ?? null,
        quality: "exact",
        replacementCharacters: replacementCount(text),
      },
    };
  } catch {
    const text = new TextDecoder(decoder, { ignoreBOM: true }).decode(body);
    return {
      text,
      info: {
        encoding: bom?.encoding ?? "unknown",
        decoder,
        bom: bom?.encoding ?? null,
        quality: "lossy",
        replacementCharacters: replacementCount(text),
      },
    };
  }
}

function sheetNameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/u, "");
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base) || "Data";
}

function intersectBounds(
  requested: SpreadsheetBounds,
  available: SpreadsheetBounds | null,
): SpreadsheetBounds | null {
  if (!available) return null;
  const bounds = {
    startRow: Math.max(requested.startRow, available.startRow),
    endRow: Math.min(requested.endRow, available.endRow),
    startColumn: Math.max(requested.startColumn, available.startColumn),
    endColumn: Math.min(requested.endColumn, available.endColumn),
  };
  return bounds.startRow <= bounds.endRow && bounds.startColumn <= bounds.endColumn ? bounds : null;
}

function sameBounds(left: SpreadsheetBounds | null, right: SpreadsheetBounds | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.startRow === right.startRow &&
    left.endRow === right.endRow &&
    left.startColumn === right.startColumn &&
    left.endColumn === right.endColumn
  );
}

function boundedText(text: string): SpreadsheetRangeCell {
  if (text.length <= MAX_SPREADSHEET_CELL_UTF16_UNITS) return { text, truncated: false };
  let end = MAX_SPREADSHEET_CELL_UTF16_UNITS;
  const finalUnit = text.charCodeAt(end);
  if (finalUnit >= 0xdc00 && finalUnit <= 0xdfff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function worksheetBounds(xlsx: XlsxModule, worksheet: WorkSheet): SpreadsheetBounds | null {
  const reference = worksheet["!ref"];
  if (!reference) return null;
  const range = xlsx.utils.decode_range(reference);
  return {
    startRow: range.s.r + 1,
    endRow: range.e.r + 1,
    startColumn: range.s.c + 1,
    endColumn: range.e.c + 1,
  };
}

function delimitedBounds(rows: readonly (readonly string[])[]): SpreadsheetBounds | null {
  if (rows.length === 0) return null;
  let endColumn = 0;
  for (const row of rows) endColumn = Math.max(endColumn, row.length);
  return {
    startRow: 1,
    endRow: rows.length,
    startColumn: 1,
    endColumn: Math.max(1, endColumn),
  };
}

function excelCellText(cell: CellObject | undefined): string {
  if (!cell || cell.t === "z") return "";
  if (typeof cell.w === "string") return cell.w;
  if (cell.v === undefined || cell.v === null) return "";
  if (cell.v instanceof Date) return cell.v.toISOString();
  return String(cell.v);
}

function cellText(sheet: ParsedSheet, row: number, column: number): string {
  if (sheet.kind === "delimited") return sheet.rows[row - 1]?.[column - 1] ?? "";
  const address = sheet.xlsx.utils.encode_cell({ r: row - 1, c: column - 1 });
  return excelCellText(sheet.worksheet[address] as CellObject | undefined);
}

function selectedSheet(sheets: readonly ParsedSheet[], name: string | undefined): ParsedSheet {
  if (name === undefined) return sheets[0];
  const sheet = sheets.find((candidate) => candidate.info.name === name);
  if (!sheet) throw new SpreadsheetReadError("unknown_sheet", `The spreadsheet has no worksheet named ${name}.`);
  return sheet;
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SpreadsheetReadError("invalid_range", `${name} must be a positive integer.`);
  }
}

function readSheetRange(sheet: ParsedSheet, requested: SpreadsheetBounds): SpreadsheetRangeResult {
  for (const [name, value] of Object.entries(requested)) validatePositiveInteger(value, name);
  if (requested.startRow > requested.endRow || requested.startColumn > requested.endColumn) {
    throw new SpreadsheetReadError("invalid_range", "Range start must not be after its end.");
  }
  const available = intersectBounds(requested, sheet.info.bounds);
  const result = {
    sheet: sheet.info,
    requested,
    available,
    outOfBounds: !sameBounds(requested, available),
  };
  if (!available) return { ...result, returned: null, truncation: [], rows: [] };

  const truncation: SpreadsheetTruncation[] = [];
  const endColumn = Math.min(available.endColumn, available.startColumn + MAX_SPREADSHEET_RANGE_COLUMNS - 1);
  const width = endColumn - available.startColumn + 1;
  let endRow = Math.min(available.endRow, available.startRow + MAX_SPREADSHEET_RANGE_ROWS - 1);
  if (endRow < available.endRow) truncation.push({ reason: "row_limit", limit: MAX_SPREADSHEET_RANGE_ROWS });
  if (endColumn < available.endColumn) truncation.push({ reason: "column_limit", limit: MAX_SPREADSHEET_RANGE_COLUMNS });
  const rowsByCellLimit = Math.floor(MAX_SPREADSHEET_RANGE_CELLS / width);
  if (endRow - available.startRow + 1 > rowsByCellLimit) {
    endRow = available.startRow + rowsByCellLimit - 1;
    truncation.push({ reason: "cell_limit", limit: MAX_SPREADSHEET_RANGE_CELLS });
  }

  const rows: SpreadsheetRangeRow[] = [];
  let textUnits = 0;
  let hasTruncatedCell = false;
  for (let row = available.startRow; row <= endRow; row += 1) {
    const cells: SpreadsheetRangeCell[] = [];
    for (let column = available.startColumn; column <= endColumn; column += 1) {
      const cell = boundedText(cellText(sheet, row, column));
      textUnits += cell.text.length;
      if (textUnits > MAX_SPREADSHEET_RANGE_TEXT_UNITS) break;
      cells.push(cell);
    }
    if (cells.length < width) {
      truncation.push({ reason: "range_text_limit", limit: MAX_SPREADSHEET_RANGE_TEXT_UNITS });
      break;
    }
    hasTruncatedCell ||= cells.some((cell) => cell.truncated);
    rows.push({ row, cells });
  }
  if (hasTruncatedCell) truncation.push({ reason: "cell_text_limit", limit: MAX_SPREADSHEET_CELL_UTF16_UNITS });
  const returned = rows.length > 0
    ? { ...available, endColumn, endRow: available.startRow + rows.length - 1 }
    : null;
  return { ...result, returned, truncation, rows };
}

function createReader(
  fileName: string,
  format: SpreadsheetFormat,
  byteLength: number,
  delimiter: SpreadsheetDelimiter | null,
  encoding: SpreadsheetDecodeInfo,
  sheets: readonly ParsedSheet[],
): SpreadsheetReader {
  return {
    fileName,
    format,
    byteLength,
    delimiter,
    encoding,
    listSheets: () => sheets.map((sheet) => sheet.info),
    readHeader: (options = {}) => {
      const sheet = selectedSheet(sheets, options.sheet);
      const { row = sheet.info.bounds?.startRow ?? 1 } = options;
      const requested = {
        startRow: row,
        endRow: row,
        startColumn: options.startColumn ?? sheet.info.bounds?.startColumn ?? 1,
        endColumn: options.endColumn ?? sheet.info.bounds?.endColumn ?? 1,
      };
      const { rows, ...range } = readSheetRange(sheet, requested);
      const startColumn = range.returned?.startColumn ?? requested.startColumn;
      return {
        ...range,
        rowSource: options.row === undefined ? "default" : "requested",
        cells: rows[0]?.cells.map((cell, index) => ({ ...cell, column: startColumn + index })) ?? [],
      };
    },
    readRange: ({ sheet, ...requested }) => readSheetRange(selectedSheet(sheets, sheet), requested),
  };
}

export async function readExcelWorkbook(bytes: Uint8Array, options?: ParsingOptions) {
  const xlsx = await import("xlsx");
  return { xlsx, workbook: xlsx.read(bytes, { ...options, type: "array" }) };
}

function hasLegacyExcelSignature(bytes: Uint8Array): boolean {
  const compound = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return compound.every((byte, index) => bytes[index] === byte)
    || (bytes[0] === 0x09 && [0, 2, 4, 8].includes(bytes[1]));
}

export async function openSpreadsheet(fileName: string, bytes: Uint8Array): Promise<SpreadsheetReader> {
  if (bytes.byteLength > MAX_SPREADSHEET_SOURCE_BYTES) {
    throw new SpreadsheetReadError(
      "source_too_large",
      `Cannot read ${fileName}: the source exceeds the 16 MB spreadsheet limit.`,
    );
  }
  const format = spreadsheetFormat(fileName);
  if (format === "csv" || format === "tsv") {
    const decoded = decodeDelimitedText(bytes);
    const delimiter = format === "tsv" ? "\t" : ",";
    const rows = parseDelimited(decoded.text, {
      delimiter,
      trim: false,
      preserveEmptyRecords: true,
    });
    const info: SpreadsheetSheetInfo = {
      position: 1,
      name: sheetNameFromFile(fileName),
      bounds: delimitedBounds(rows),
    };
    return createReader(fileName, format, bytes.byteLength, delimiter, decoded.info, [
      { kind: "delimited", info, rows },
    ]);
  }

  if (format === "xls" && !hasLegacyExcelSignature(bytes)) {
    throw new SpreadsheetReadError("invalid_workbook", `Cannot read ${fileName}: expected an XLS workbook.`);
  }
  let parsed: Awaited<ReturnType<typeof readExcelWorkbook>>;
  try {
    parsed = await readExcelWorkbook(bytes, {
      cellFormula: false,
      cellHTML: false,
      cellText: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SpreadsheetReadError("invalid_workbook", `Cannot read ${fileName}: ${detail}`);
  }
  const { xlsx, workbook } = parsed;
  if (!workbook.SheetNames.length) {
    throw new SpreadsheetReadError("no_sheets", "The spreadsheet has no readable worksheets.");
  }
  if (format === "xlsx" && workbook.bookType !== "xlsx") {
    throw new SpreadsheetReadError("invalid_workbook", `Cannot read ${fileName}: expected an XLSX workbook.`);
  }
  const sheets: ParsedSheet[] = workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) throw new SpreadsheetReadError("invalid_workbook", `Cannot read worksheet ${name}.`);
    return {
      kind: "excel",
      info: {
        position: index + 1,
        name,
        bounds: worksheetBounds(xlsx, worksheet),
      },
      worksheet,
      xlsx,
    };
  });
  return createReader(fileName, format, bytes.byteLength, null, emptyDecodeInfo(), sheets);
}
