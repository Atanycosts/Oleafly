"""Vocabulary and scalar encodings for the Strict DOCX working-copy projection.

Namespace pairs come from ECMA-376 Parts 1 and 4 and the Open XML SDK's
OpenXmlNamespaceResolver. OPC is a separate vocabulary (Part 2).
"""

import re
from fractions import Fraction
from xml.etree.ElementTree import Element

STRICT_BASE = "http://purl.oclc.org/ooxml/"
SCHEMA_BASE = "http://schemas.openxmlformats.org/"
WORD = STRICT_BASE + "wordprocessingml/main"
MATH = STRICT_BASE + "officeDocument/math"
DRAWING = STRICT_BASE + "drawingml/main"
WORD_DRAWING = STRICT_BASE + "drawingml/wordprocessingDrawing"
OFFICE_RELS = STRICT_BASE + "officeDocument/relationships/"
TRANSITIONAL_RELS = SCHEMA_BASE + "officeDocument/2006/relationships/"
PACKAGE_RELS = SCHEMA_BASE + "package/2006/relationships"

NAMESPACES = (
    {
        STRICT_BASE + name: SCHEMA_BASE + target
        for name, target in {
            "wordprocessingml/main": "wordprocessingml/2006/main",
            "spreadsheetml/main": "spreadsheetml/2006/main",
            "presentationml/main": "presentationml/2006/main",
            "schemaLibrary/main": "schemaLibrary/2006/main",
            "officeDocument/bibliography": "officeDocument/2006/bibliography",
            "officeDocument/characteristics": "officeDocument/2006/characteristics",
            "officeDocument/customProperties": "officeDocument/2006/custom-properties",
            "officeDocument/customXml": "officeDocument/2006/customXml",
            "officeDocument/customXmlDataProps": "officeDocument/2006/customXmlDataProps",
            "officeDocument/docPropsVTypes": "officeDocument/2006/docPropsVTypes",
            "officeDocument/extendedProperties": "officeDocument/2006/extended-properties",
            "officeDocument/math": "officeDocument/2006/math",
            "officeDocument/relationships": "officeDocument/2006/relationships",
            "officeDocument/relationships/customXml": "officeDocument/2006/customXml",
            "officeDocument/sharedTypes": "officeDocument/2006/sharedTypes",
        }.items()
    }
    | {
        STRICT_BASE + "drawingml/" + name: SCHEMA_BASE + "drawingml/2006/" + name
        for name in (
            "chart",
            "chartDrawing",
            "compatibility",
            "diagram",
            "lockedCanvas",
            "main",
            "picture",
            "spreadsheetDrawing",
            "wordprocessingDrawing",
        )
    }
    | {
        STRICT_BASE
        + "descriptions/base": "http://descriptions.openxmlformats.org/description/base",
        STRICT_BASE
        + "descriptions/full": "http://descriptions.openxmlformats.org/description/full",
    }
)

_RELATIONSHIPS = {
    "aFChunk",
    "attachedTemplate",
    "audio",
    "calcChain",
    "chart",
    "chartsheet",
    "chartUserShapes",
    "commentAuthors",
    "comments",
    "connections",
    "control",
    "customProperty",
    "customXml",
    "customXmlProps",
    "diagramColors",
    "diagramData",
    "diagramLayout",
    "diagramQuickStyle",
    "dialogsheet",
    "drawing",
    "endnotes",
    "externalLink",
    "externalLinkPath",
    "font",
    "fontTable",
    "footer",
    "footnotes",
    "frame",
    "glossaryDocument",
    "handoutMaster",
    "header",
    "htmlPubSaveAs",
    "hyperlink",
    "image",
    "mailMergeHeaderSource",
    "mailMergeRecipientData",
    "mailMergeSource",
    "movie",
    "notesMaster",
    "notesSlide",
    "numbering",
    "officeDocument",
    "oleObject",
    "package",
    "pivotCacheDefinition",
    "pivotCacheRecords",
    "pivotTable",
    "presProps",
    "printerSettings",
    "queryTable",
    "revisionHeaders",
    "revisionLog",
    "settings",
    "sharedStrings",
    "sheetMetadata",
    "slide",
    "slideLayout",
    "slideMaster",
    "slideUpdateInfo",
    "slideUpdateUrl",
    "styles",
    "subDocument",
    "table",
    "tableSingleCells",
    "tableStyles",
    "tags",
    "theme",
    "themeOverride",
    "transform",
    "usernames",
    "video",
    "viewProps",
    "volatileDependencies",
    "webSettings",
    "worksheet",
    "xmlMaps",
}
_RELATIONSHIP_EXCEPTIONS = {
    "customProperties": TRANSITIONAL_RELS + "custom-properties",
    "extendedProperties": TRANSITIONAL_RELS + "extended-properties",
    "metadata/core-properties": PACKAGE_RELS + "/metadata/core-properties",
    "metadata/thumbnail": PACKAGE_RELS + "/metadata/thumbnail",
}


def is_strict_document(root: Element) -> bool:
    transitional = NAMESPACES[WORD]
    return root.tag == f"{{{WORD}}}document" or (
        root.tag == f"{{{transitional}}}document"
        and root.get(f"{{{transitional}}}conformance") == "strict"
    )


def relationship_type(value: str) -> str:
    """Translate known relationship types without touching a target URI or an extension type."""
    if not value.startswith(OFFICE_RELS):
        return value
    suffix = value.removeprefix(OFFICE_RELS)
    if suffix in _RELATIONSHIPS:
        return TRANSITIONAL_RELS + suffix
    return _RELATIONSHIP_EXCEPTIONS.get(suffix, value)


_POINTS = {
    "pt": Fraction(1),
    "pc": Fraction(12),
    "pi": Fraction(12),
    "in": Fraction(72),
    "cm": Fraction(3600, 127),
    "mm": Fraction(360, 127),
}
_MEASURE = re.compile(r"(-?[0-9]+(?:\.[0-9]+)?)(mm|cm|in|pt|pc|pi)")
_PERCENT = re.compile(r"(-?[0-9]+(?:\.[0-9]+)?)%")


def _to_integer(value: Fraction) -> str:
    """Round to the nearest target unit, including negative offsets and half ties."""
    magnitude = abs(value) + Fraction(1, 2)
    return str((-1 if value < 0 else 1) * (magnitude.numerator // magnitude.denominator))


def _measure(value: str, per_point: int) -> str:
    match = _MEASURE.fullmatch(value)
    if match is None:
        return value
    return _to_integer(Fraction(match[1]) * _POINTS[match[2]] * per_point)


def _percent(value: str, per_percent: int) -> str:
    match = _PERCENT.fullmatch(value)
    if match is None:
        return value
    return _to_integer(Fraction(match[1]) * per_percent)


_WORD_TWIPS = {
    "pgSz": {"w", "h"},
    "pgMar": {"top", "right", "bottom", "left", "header", "footer", "gutter"},
    "cols": {"space"},
    "col": {"w", "space"},
    "framePr": {"w", "h", "vSpace", "hSpace", "x", "y"},
    "ind": {"start", "end", "hanging", "firstLine"},
    "spacing": {"before", "after", "line", "val"},
    "tab": {"pos"},
    "lnNumType": {"distance"},
    "gridCol": {"w"},
    "tblpPr": {"leftFromText", "rightFromText", "topFromText", "bottomFromText", "tblpX", "tblpY"},
    "object": {"dxaOrig", "dyaOrig"},
} | {
    name: {"val"}
    for name in (
        "defaultTabStop",
        "drawingGridHorizontalOrigin",
        "drawingGridHorizontalSpacing",
        "drawingGridVerticalOrigin",
        "drawingGridVerticalSpacing",
        "fitText",
        "hyphenationZone",
        "marBottom",
        "marLeft",
        "marRight",
        "marTop",
        "trHeight",
    )
}
_WORD_HALF_POINTS = {"hps", "hpsBaseText", "hpsRaise", "kern", "position", "size", "sz", "szCs"}
_WORD_WIDTHS = {"tblCellSpacing", "tblInd", "tblW", "tcW", "wAfter", "wBefore"}
_CELL_SIDES = {"bottom", "end", "start", "top"}
_OMML_TWIPS = {"interSp", "intraSp", "lMargin", "postSp", "preSp", "rMargin", "wrapIndent"}
_WORD_PERCENT = {
    ("w", "val"),
    ("zoom", "percent"),
    ("summaryLength", "val"),
    ("readModeInkLockDown", "fontSz"),
}
_WORD_DRAWING_EMU = {name: {"x", "y"} for name in ("simplePos", "start", "lineTo")} | {
    "effectExtent": {"l", "t", "r", "b"},
}

_DRAWING_PERCENT = (
    {
        name: {"val"}
        for name in (
            "alpha",
            "alphaMod",
            "alphaOff",
            "blue",
            "blueMod",
            "blueOff",
            "green",
            "greenMod",
            "greenOff",
            "hueMod",
            "lum",
            "lumMod",
            "lumOff",
            "red",
            "redMod",
            "redOff",
            "sat",
            "satMod",
            "satOff",
            "shade",
            "spcPct",
            "tint",
        )
    }
    | {
        "scrgbClr": {"r", "g", "b"},
        "hslClr": {"sat", "lum"},
        "camera": {"zoom"},
        "alphaBiLevel": {"thresh"},
        "alphaModFix": {"amt"},
        "alphaRepl": {"a"},
        "biLevel": {"thresh"},
        "hsl": {"sat", "lum"},
        "lum": {"val", "bright", "contrast"},
        "outerShdw": {"sx", "sy"},
        "reflection": {"stA", "stPos", "endA", "endPos", "sx", "sy"},
        "relOff": {"tx", "ty"},
        "tint": {"val", "amt"},
        "xfrm": {"sx", "sy"},
        "gs": {"pos"},
        "tile": {"sx", "sy"},
        "miter": {"lim"},
        "ds": {"d", "sp"},
        "normAutofit": {"fontScale", "lnSpcReduction"},
    }
    | {name: {"l", "t", "r", "b"} for name in ("fillRect", "fillToRect", "srcRect", "tileRect")}
    | {name: {"baseline"} for name in ("defRPr", "endParaRPr", "rPr")}
)
_DRAWING_EMU = (
    {
        "anchor": {"x", "y", "z"},
        "off": {"x", "y"},
        "chOff": {"x", "y"},
        "ext": {"cx", "cy"},
        "chExt": {"cx", "cy"},
        "norm": {"dx", "dy", "dz"},
        "up": {"dx", "dy", "dz"},
        "pos": {"x", "y"},
        "pt": {"x", "y"},
        "rect": {"l", "t", "r", "b"},
        "ahXY": {"minX", "maxX", "minY", "maxY"},
        "ahPolar": {"minR", "maxR"},
        "arcTo": {"wR", "hR"},
        "path": {"w", "h"},
        "sp3d": {"z", "extrusionH", "contourW"},
        "flatTx": {"z"},
        "alphaOutset": {"rad"},
        "blur": {"rad"},
        "glow": {"rad"},
        "softEdge": {"rad"},
        "innerShdw": {"blurRad", "dist"},
        "outerShdw": {"blurRad", "dist"},
        "prstShdw": {"dist"},
        "reflection": {"blurRad", "dist"},
        "xfrm": {"tx", "ty"},
        "tile": {"tx", "ty"},
        "tcPr": {"marL", "marR", "marT", "marB"},
        "gridCol": {"w"},
        "tr": {"h"},
        "bodyPr": {"lIns", "tIns", "rIns", "bIns", "spcCol"},
        "tab": {"pos"},
    }
    | {name: {"w", "h"} for name in ("bevel", "bevelB", "bevelT")}
    | {
        name: {"defTabSz", "marL", "marR", "indent"}
        for name in ("pPr", "defPPr", *(f"lvl{level}pPr" for level in range(1, 10)))
    }
)


def attribute_value(
    element_namespace: str,
    element: str,
    parent: str,
    namespace: str,
    attribute: str,
    value: str,
) -> str:
    """Translate only a schema-typed field, keeping logical start/end and spacing rules.

    ECMA-376 Part 1 §17.3.1.33 interprets canonical ``spacing/@line`` with ``lineRule``.
    Word writes such values as ``6pt`` even with ``auto`` (IEEE templates); as in LibreOffice,
    project to 120 and preserve ``auto``, which the consumer reads as 120/240 of a line.
    """
    if element_namespace in {WORD, NAMESPACES[WORD]} and namespace == element_namespace:
        if element == "document" and attribute == "conformance":
            return "transitional" if value == "strict" else value
        if element in _WORD_HALF_POINTS and attribute == "val":
            return _measure(value, 2)
        if attribute in _WORD_TWIPS.get(element, ()):
            return _measure(value, 20)
        if attribute == "w" and (
            element in _WORD_WIDTHS
            or (element in _CELL_SIDES and parent in {"tcMar", "tblCellMar"})
        ):
            return _percent(_measure(value, 20), 50)
        if (element, attribute) in _WORD_PERCENT:
            return _percent(value, 1)
    if (
        element_namespace == namespace
        and namespace in {MATH, NAMESPACES[MATH]}
        and attribute == "val"
        and element in _OMML_TWIPS
    ):
        return _measure(value, 20)
    if element_namespace == DRAWING and not namespace:
        if element == "graphicData" and attribute == "uri":
            return NAMESPACES.get(value, value)
        if attribute in _DRAWING_PERCENT.get(element, ()):
            return _percent(value, 1000)
        if attribute in _DRAWING_EMU.get(element, ()):
            return _measure(value, 12700)
        if attribute == "spc" and element in {"defRPr", "endParaRPr", "rPr"}:
            return _measure(value, 100)
    if (
        element_namespace == WORD_DRAWING
        and not namespace
        and attribute in _WORD_DRAWING_EMU.get(element, ())
    ):
        return _measure(value, 12700)
    return value
