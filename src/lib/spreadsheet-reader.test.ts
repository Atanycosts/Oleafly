import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  MAX_SPREADSHEET_CELL_UTF16_UNITS,
  MAX_SPREADSHEET_RANGE_CELLS,
  MAX_SPREADSHEET_RANGE_COLUMNS,
  MAX_SPREADSHEET_RANGE_ROWS,
  MAX_SPREADSHEET_RANGE_TEXT_UNITS,
  MAX_SPREADSHEET_SOURCE_BYTES,
  openSpreadsheet,
} from "./spreadsheet-reader";

function workbookBytes(
  sheets: readonly { readonly name: string; readonly sheet: XLSX.WorkSheet }[],
  bookType: "xlsx" | "xls" = "xlsx",
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const entry of sheets) XLSX.utils.book_append_sheet(workbook, entry.sheet, entry.name);
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType }) as ArrayBuffer);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function withBom(prefix: readonly number[], body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return bytes;
}

function utf16BomBytes(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
  }
  return bytes;
}

describe("openSpreadsheet Excel reads", () => {
  it("lists sheets and reads headers in original 1-based Excel coordinates", async () => {
    const results: XLSX.WorkSheet = {
      B2: { t: "s", v: "Name" },
      C2: { t: "s", v: "Score" },
      D2: { t: "s", v: "Note" },
      B3: { t: "s", v: "Ada" },
      C3: { t: "n", v: 9.5, w: "9.5" },
      D3: { t: "s", v: "first" },
      B4: { t: "s", v: "Lin" },
      D4: { t: "s", v: "sparse" },
      "!ref": "B2:D4",
    };
    const reader = await openSpreadsheet(
      "book.xlsx",
      workbookBytes([
        { name: "Results", sheet: results },
        { name: "Notes", sheet: XLSX.utils.aoa_to_sheet([["memo"]]) },
      ]),
    );

    expect(reader.listSheets()).toEqual([
      {
        position: 1,
        name: "Results",
        bounds: { startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 },
      },
      {
        position: 2,
        name: "Notes",
        bounds: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 },
      },
    ]);
    expect(reader.readHeader({ sheet: "Notes" }).cells).toEqual([
      { column: 1, text: "memo", truncated: false },
    ]);
    expect(() => reader.readHeader({ sheet: "Missing" })).toThrowError(
      expect.objectContaining({ code: "unknown_sheet" }),
    );
    expect(reader.readHeader()).toMatchObject({
      rowSource: "default",
      requested: { startRow: 2, endRow: 2, startColumn: 2, endColumn: 4 },
      available: { startRow: 2, endRow: 2, startColumn: 2, endColumn: 4 },
      returned: { startRow: 2, endRow: 2, startColumn: 2, endColumn: 4 },
      outOfBounds: false,
      truncation: [],
    });
    expect(reader.readHeader().cells).toEqual([
      { column: 2, text: "Name", truncated: false },
      { column: 3, text: "Score", truncated: false },
      { column: 4, text: "Note", truncated: false },
    ]);
    expect(
      reader.readRange({ startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 }),
    ).toMatchObject({
      returned: { startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 },
      rows: [
        {
          row: 2,
          cells: [
            { text: "Name", truncated: false },
            { text: "Score", truncated: false },
            { text: "Note", truncated: false },
          ],
        },
        {
          row: 3,
          cells: [
            { text: "Ada", truncated: false },
            { text: "9.5", truncated: false },
            { text: "first", truncated: false },
          ],
        },
        {
          row: 4,
          cells: [
            { text: "Lin", truncated: false },
            { text: "", truncated: false },
            { text: "sparse", truncated: false },
          ],
        },
      ],
    });
  });

  it.each(["xlsx", "xls"] as const)(
    "returns Excel's formatted cached value for %s formulas",
    async (bookType) => {
      const sheet: XLSX.WorkSheet = {
        A1: { t: "s", v: "Metric" },
        B1: { t: "s", v: "Value" },
        A2: { t: "s", v: "Mean" },
        B2: { t: "n", v: 2.5, f: "1+1", z: "0.00" },
        "!ref": "A1:B2",
      };
      const reader = await openSpreadsheet(
        `results.${bookType}`,
        workbookBytes([{ name: "Results", sheet }], bookType),
      );

      const result = reader.readRange({
        startRow: 2,
        endRow: 2,
        startColumn: 2,
        endColumn: 2,
      });
      expect(result.rows[0]?.cells).toEqual([{ text: "2.50", truncated: false }]);
    },
  );

  it("distinguishes an uncached formula from a stored zero", async () => {
    const parts = unzipSync(workbookBytes([{
      name: "Formula",
      sheet: {
        A1: { t: "n", v: 4, f: "2+2" },
        B1: { t: "n", v: 0, f: "1-1" },
        "!ref": "A1:B1",
      },
    }]));
    const worksheet = "xl/worksheets/sheet1.xml";
    const xml = strFromU8(parts[worksheet]);
    const withCache = '<c r="A1"><f>2+2</f><v>4</v></c>';
    expect(xml).toContain(withCache);
    parts[worksheet] = strToU8(xml.replace(withCache, '<c r="A1"><f>2+2</f></c>'));
    const reader = await openSpreadsheet("formulas.xlsx", zipSync(parts));

    expect(reader.readHeader().cells).toEqual([
      { column: 1, text: "", truncated: false },
      { column: 2, text: "0", truncated: false },
    ]);
  });

  it.each(["xlsx", "xls"])("does not interpret text renamed to .%s as Excel", async (format) => {
    await expect(openSpreadsheet(`wrong.${format}`, textBytes("a,b\n1,2"))).rejects.toMatchObject({
      code: "invalid_workbook",
    });
  });

  it("distinguishes a request beyond the used range from a read limit", async () => {
    const reader = await openSpreadsheet(
      "book.xlsx",
      workbookBytes([
        {
          name: "Results",
          sheet: {
            B2: { t: "s", v: "Name" },
            D4: { t: "s", v: "last" },
            "!ref": "B2:D4",
          },
        },
      ]),
    );

    expect(
      reader.readRange({ startRow: 2, endRow: 5, startColumn: 2, endColumn: 4 }),
    ).toMatchObject({
      requested: { startRow: 2, endRow: 5, startColumn: 2, endColumn: 4 },
      available: { startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 },
      returned: { startRow: 2, endRow: 4, startColumn: 2, endColumn: 4 },
      outOfBounds: true,
      truncation: [],
    });
  });

  it("reports an empty worksheet without inventing a used range", async () => {
    const reader = await openSpreadsheet(
      "blank.xlsx",
      workbookBytes([{ name: "Blank", sheet: XLSX.utils.aoa_to_sheet([]) }]),
    );

    expect(reader.listSheets()).toEqual([
      { position: 1, name: "Blank", bounds: null },
    ]);
    expect(reader.readHeader()).toMatchObject({
      requested: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 },
      available: null,
      returned: null,
      outOfBounds: true,
      truncation: [],
      cells: [],
    });
  });

  it("returns no rows for a range that does not intersect the used range", async () => {
    const reader = await openSpreadsheet(
      "book.xlsx",
      workbookBytes([
        {
          name: "Results",
          sheet: { B2: { t: "s", v: "Name" }, "!ref": "B2:B2" },
        },
      ]),
    );

    expect(
      reader.readRange({ startRow: 5, endRow: 7, startColumn: 2, endColumn: 3 }),
    ).toMatchObject({
      requested: { startRow: 5, endRow: 7, startColumn: 2, endColumn: 3 },
      available: null,
      returned: null,
      outOfBounds: true,
      truncation: [],
      rows: [],
    });
  });
});

describe("openSpreadsheet delimited reads", () => {
  it("preserves blank records and surrounding whitespace", async () => {
    const reader = await openSpreadsheet(
      "measurements.csv",
      textBytes(' A , B \n\n" C ","line\nbreak"\n'),
    );

    expect(reader.format).toBe("csv");
    expect(reader.delimiter).toBe(",");
    expect(reader.listSheets()).toEqual([
      {
        position: 1,
        name: "measurements",
        bounds: { startRow: 1, endRow: 3, startColumn: 1, endColumn: 2 },
      },
    ]);
    expect(reader.readHeader().cells).toEqual([
      { column: 1, text: " A ", truncated: false },
      { column: 2, text: " B ", truncated: false },
    ]);
    expect(
      reader.readRange({ startRow: 1, endRow: 3, startColumn: 1, endColumn: 2 }).rows,
    ).toEqual([
      {
        row: 1,
        cells: [
          { text: " A ", truncated: false },
          { text: " B ", truncated: false },
        ],
      },
      {
        row: 2,
        cells: [
          { text: "", truncated: false },
          { text: "", truncated: false },
        ],
      },
      {
        row: 3,
        cells: [
          { text: " C ", truncated: false },
          { text: "line\nbreak", truncated: false },
        ],
      },
    ]);
  });

  it("uses an explicit tab delimiter for TSV", async () => {
    const reader = await openSpreadsheet("data.TSV", textBytes("Name\tValue\nAda\t9.5\n"));

    expect(reader.format).toBe("tsv");
    expect(reader.delimiter).toBe("\t");
    expect(reader.readHeader().cells).toEqual([
      { column: 1, text: "Name", truncated: false },
      { column: 2, text: "Value", truncated: false },
    ]);
  });

  it("does not mistake tabs or literal quotes for CSV record boundaries", async () => {
    const reader = await openSpreadsheet("notes.csv", textBytes('a\tb,header\r\n2 inch",plain\r\n"a""b",last\r\n'));
    const result = reader.readRange({ startRow: 1, endRow: 3, startColumn: 1, endColumn: 2 });
    expect(reader.delimiter).toBe(",");
    expect(result.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ["a\tb", "header"], ['2 inch"', "plain"], ['a"b', "last"],
    ]);
  });

  it("uses an explicitly requested header row instead of guessing", async () => {
    const reader = await openSpreadsheet(
      "report.csv",
      textBytes("Quarterly report\nName,Score\nAda,9.5\n"),
    );

    expect(reader.readHeader({ row: 2 })).toMatchObject({
      rowSource: "requested",
      requested: { startRow: 2, endRow: 2, startColumn: 1, endColumn: 2 },
      outOfBounds: false,
    });
    expect(reader.readHeader({ row: 2 }).cells).toEqual([
      { column: 1, text: "Name", truncated: false },
      { column: 2, text: "Score", truncated: false },
    ]);
  });

  it("returns an empty reader for an empty delimited file", async () => {
    const reader = await openSpreadsheet("empty.csv", new Uint8Array());

    expect(reader.listSheets()[0]?.bounds).toBeNull();
    expect(reader.readHeader()).toMatchObject({
      rowSource: "default",
      available: null,
      returned: null,
      outOfBounds: true,
      cells: [],
    });
  });
});

describe("openSpreadsheet encoding metadata", () => {
  it.each([
    {
      label: "UTF-8 BOM",
      bytes: withBom([0xef, 0xbb, 0xbf], textBytes("Name,Score\n张三,9.5\n")),
      encoding: "utf-8",
      bom: "utf-8",
    },
    {
      label: "UTF-16LE BOM",
      bytes: utf16BomBytes("Name,Score\n张三,9.5\n", true),
      encoding: "utf-16le",
      bom: "utf-16le",
    },
    {
      label: "UTF-16BE BOM",
      bytes: utf16BomBytes("Name,Score\n张三,9.5\n", false),
      encoding: "utf-16be",
      bom: "utf-16be",
    },
  ] as const)("decodes $label exactly", async ({ bytes, encoding, bom }) => {
    const reader = await openSpreadsheet("scores.csv", bytes);

    expect(reader.encoding).toEqual({
      encoding,
      decoder: encoding,
      bom,
      quality: "exact",
      replacementCharacters: 0,
    });
    expect(
      reader.readRange({ startRow: 2, endRow: 2, startColumn: 1, endColumn: 2 }).rows[0]?.cells,
    ).toEqual([
      { text: "张三", truncated: false },
      { text: "9.5", truncated: false },
    ]);
  });

  it("reports missing reliable UTF-8 as lossy instead of exact", async () => {
    const reader = await openSpreadsheet(
      "legacy.csv",
      Uint8Array.from([0x4e, 0x61, 0x6d, 0x65, 0x2c, 0x53, 0x63, 0x6f, 0x72, 0x65, 0x0a, 0xff]),
    );

    expect(reader.encoding).toMatchObject({
      encoding: "unknown",
      decoder: "utf-8",
      bom: null,
      quality: "lossy",
    });
    expect(reader.encoding.replacementCharacters).toBeGreaterThan(0);
  });

  it("does not confuse literal replacement characters with decode loss", async () => {
    const reader = await openSpreadsheet("symbol.csv", textBytes("a,�"));
    expect(reader.encoding).toMatchObject({ encoding: "utf-8", quality: "exact", replacementCharacters: 1 });
  });
});

describe("openSpreadsheet limits", () => {
  it("truncates a large row request with a defined reason", async () => {
    const last = XLSX.utils.encode_cell({ r: MAX_SPREADSHEET_RANGE_ROWS, c: 0 });
    const reader = await openSpreadsheet(
      "long.xlsx",
      workbookBytes([
        {
          name: "Long",
          sheet: {
            A1: { t: "s", v: "first" },
            [last]: { t: "s", v: "last" },
            "!ref": `A1:${last}`,
          },
        },
      ]),
    );

    const result = reader.readRange({
      startRow: 1,
      endRow: MAX_SPREADSHEET_RANGE_ROWS + 1,
      startColumn: 1,
      endColumn: 1,
    });
    expect(result.returned?.endRow).toBe(MAX_SPREADSHEET_RANGE_ROWS);
    expect(result.outOfBounds).toBe(false);
    expect(result.truncation).toEqual([
      { reason: "row_limit", limit: MAX_SPREADSHEET_RANGE_ROWS },
    ]);
    expect(result.rows).toHaveLength(MAX_SPREADSHEET_RANGE_ROWS);
  });

  it("truncates a wide request with a defined reason", async () => {
    const last = XLSX.utils.encode_cell({ r: 0, c: MAX_SPREADSHEET_RANGE_COLUMNS });
    const reader = await openSpreadsheet(
      "wide.xlsx",
      workbookBytes([
        {
          name: "Wide",
          sheet: {
            A1: { t: "s", v: "first" },
            [last]: { t: "s", v: "last" },
            "!ref": `A1:${last}`,
          },
        },
      ]),
    );

    const result = reader.readRange({
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: MAX_SPREADSHEET_RANGE_COLUMNS + 1,
    });
    expect(result.returned?.endColumn).toBe(MAX_SPREADSHEET_RANGE_COLUMNS);
    expect(result.outOfBounds).toBe(false);
    expect(result.truncation).toEqual([
      { reason: "column_limit", limit: MAX_SPREADSHEET_RANGE_COLUMNS },
    ]);
    expect(reader.readHeader({ startColumn: MAX_SPREADSHEET_RANGE_COLUMNS + 1 }).cells).toEqual([
      { column: MAX_SPREADSHEET_RANGE_COLUMNS + 1, text: "last", truncated: false },
    ]);
  });

  it("limits the total cells even for very sparse Excel ranges", async () => {
    const width = MAX_SPREADSHEET_RANGE_COLUMNS;
    const height = MAX_SPREADSHEET_RANGE_CELLS / width + 1;
    const last = XLSX.utils.encode_cell({ r: height - 1, c: width - 1 });
    const reader = await openSpreadsheet("sparse.xlsx", workbookBytes([{
      name: "Sparse",
      sheet: { A1: { t: "s", v: "start" }, [last]: { t: "s", v: "end" }, "!ref": `A1:${last}` },
    }]));
    const result = reader.readRange({ startRow: 1, endRow: height, startColumn: 1, endColumn: width });
    expect(result.returned?.endRow).toBe(height - 1);
    expect(result.rows).toHaveLength(height - 1);
    expect(result.truncation).toEqual([{ reason: "cell_limit", limit: MAX_SPREADSHEET_RANGE_CELLS }]);
  });

  it("marks total text truncation and returns only complete requested row slices", async () => {
    const cell = "x".repeat(MAX_SPREADSHEET_CELL_UTF16_UNITS);
    const count = Math.floor(MAX_SPREADSHEET_RANGE_TEXT_UNITS / cell.length);
    const reader = await openSpreadsheet("wide.csv", textBytes(Array(count + 1).fill(cell).join(",")));
    const header = reader.readHeader();
    expect(header.returned).toBeNull();
    expect(header.truncation).toEqual([{ reason: "range_text_limit", limit: MAX_SPREADSHEET_RANGE_TEXT_UNITS }]);
    expect(reader.readHeader({ startColumn: 1, endColumn: count }).cells).toHaveLength(count);
    expect(reader.readHeader({ startColumn: count + 1 }).cells).toEqual([
      { column: count + 1, text: cell, truncated: false },
    ]);
  });

  it("truncates an oversized cell and marks that cell", async () => {
    const reader = await openSpreadsheet(
      "cell.csv",
      textBytes("x".repeat(MAX_SPREADSHEET_CELL_UTF16_UNITS + 1)),
    );

    const result = reader.readRange({
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: 1,
    });
    expect(result.rows[0]?.cells[0]).toEqual({
      text: "x".repeat(MAX_SPREADSHEET_CELL_UTF16_UNITS),
      truncated: true,
    });
    expect(result.truncation).toEqual([
      { reason: "cell_text_limit", limit: MAX_SPREADSHEET_CELL_UTF16_UNITS },
    ]);
  });

  it("keeps a surrogate pair intact when it straddles the cell text limit", async () => {
    const prefix = "x".repeat(MAX_SPREADSHEET_CELL_UTF16_UNITS - 1);
    const reader = await openSpreadsheet("emoji.csv", textBytes(`${prefix}\u{1f600}tail`));

    const result = reader.readRange({
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: 1,
    });
    expect(result.rows[0]?.cells[0]).toEqual({ text: prefix, truncated: true });
  });

  it("rejects an oversized source before parsing it", async () => {
    await expect(
      openSpreadsheet("huge.csv", new Uint8Array(MAX_SPREADSHEET_SOURCE_BYTES + 1)),
    ).rejects.toMatchObject({ code: "source_too_large" });
  });

  it("rejects unsupported formats and invalid ranges with typed codes", async () => {
    await expect(openSpreadsheet("data.ods", new Uint8Array())).rejects.toMatchObject({
      code: "unsupported_format",
    });
    const reader = await openSpreadsheet("data.csv", textBytes("a,b\n"));
    expect(() =>
      reader.readRange({ startRow: 2, endRow: 1, startColumn: 1, endColumn: 2 }),
    ).toThrowError(expect.objectContaining({ code: "invalid_range" }));
  });

  it.each([
    [{ startRow: 0, endRow: 1, startColumn: 1, endColumn: 1 }, "startRow"],
    [{ startRow: 1, endRow: 1.5, startColumn: 1, endColumn: 1 }, "endRow"],
    [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: -1 }, "endColumn"],
  ] as const)("rejects a non-positive or fractional range coordinate: %j", async (range, field) => {
    const reader = await openSpreadsheet("data.csv", textBytes("a,b\n"));

    expect(() => reader.readRange(range)).toThrowError(
      expect.objectContaining({
        code: "invalid_range",
        message: `${field} must be a positive integer.`,
      }),
    );
  });
});
