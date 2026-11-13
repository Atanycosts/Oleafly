"""Recognition of a deliberately narrow set of explicit English and Chinese requirements."""

import re
from decimal import ROUND_HALF_UP, Decimal

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.models import coverage_gap

_PAPER = {"a4": (11906, 16838), "letter": (12240, 15840), "us letter": (12240, 15840)}
_NUMBER = r"([0-9]{1,9}(?:\.[0-9]{1,6})?)"
_UNIT = r"(mm|cm|inches|inch|in|毫米|厘米|英寸)"
_CONTEXT = re.compile(
    r"\b(if|unless|except|only|not|may|should|recommended|optional)\b"
    r"|\bfor\s+.+\b(articles?|submissions?)\b|不得|不要|建议|推荐|仅|若|如果|除外|对于|可选|不应",
    re.IGNORECASE,
)


def recognize_guide(
    source_id: str,
    lines: list[tuple[str, str]],
    *,
    context_lines: list[tuple[str, str]] | None = None,
) -> tuple[list[JsonObject], list[JsonObject]]:
    """Recognize complete unconditional requirement lines; retain every unparsed line as a gap.

    A conditional, negative or unparsed context anywhere in the supplied source blocks
    confirmation: this recognizer cannot determine the extent of surrounding prose or headings.
    """
    observations: list[JsonObject] = []
    gaps: list[JsonObject] = []
    context = lines if context_lines is None else context_lines
    contextual = any(
        _CONTEXT.search(text) or not _requirements(text.strip())[0]
        for _, text in context
        if text.strip()
    )
    if not any(text.strip() for _, text in context):
        gaps.append(
            coverage_gap(
                "empty_guide", "No nonblank guideline text was supplied.", source_id=source_id
            )
        )
    for locator, quote in lines:
        if not quote.strip():
            continue
        parsed, parsed_limitations = _requirements(quote.strip())
        if not parsed or contextual:
            gaps.append(
                coverage_gap(
                    "conditional_or_ambiguous_guide" if contextual else "unparsed_guide_text",
                    "Unparsed, conditional or negative source context prevents confirmation."
                    if contextual
                    else "This line is outside the supported explicit requirement grammar.",
                    source_id=source_id,
                    locator=locator,
                )
            )
            continue
        for property_name, expected in parsed.items():
            observations.append(
                {
                    "property": property_name,
                    "expected": expected,
                    "basis_status": "confirmed",
                    "confirmation_method": "explicit_supplied_guide_pattern",
                    "evidence": [{"source_id": source_id, "locator": locator, "quote": quote}],
                    "limitations": list(parsed_limitations),
                }
            )
    return observations, gaps


def _requirements(text: str) -> tuple[dict[str, int | str], list[str]]:
    text = text.removesuffix("。").removesuffix(".")
    font = re.fullmatch(r"(?:All manuscript body text|Body text) must use (.+?) font", text, re.I)
    if font is None:
        font = re.fullmatch(r"正文必须使用(.+?)字体", text)
    if font is None:
        font = re.fullmatch(r"正文字体必须为(.+)", text)
    if font is not None:
        family = font.group(1).strip().strip('"“”')
        if re.fullmatch(r"[^\W\d_][\w .+\-]*", family) and not re.search(
            r"\b(?:or|and|for)\b|或者|或|以及|和|中文|英文|汉字|西文"
            r"|\b(?:Chinese|English|Latin|CJK)\b.+\b(?:Chinese|English|Latin|CJK)\b",
            family,
            re.I,
        ):
            return {"body_font_family": family}, []
        return {}, []
    paper = re.fullmatch(r"All manuscript pages must use (A4|US Letter|Letter) paper", text, re.I)
    if paper is None:
        paper = re.fullmatch(r"全文必须使用(A4|Letter)纸张", text, re.I)
    if paper is not None:
        width, height = _PAPER[paper.group(1).casefold()]
        return {"page_width_twips": width, "page_height_twips": height}, []
    # Journal page-format definitions, e.g. IEEE CS "A double column page is defined as a
    # 7.875″ x 10.75″ page": the sentence states the column count and the page dimensions.
    defined = re.fullmatch(
        rf"A\s+double\s+column\s+page\s+is\s+defined\s+as\s+a\s+"
        rf"{_NUMBER}\s*(?:″|\"|”)?\s*[x×]\s*{_NUMBER}\s*(?:″|\"|”)?\s*page"
        rf"(?:\s+with\s+(?P<qualifiers>.+))?",
        text,
        re.I,
    )
    if defined is not None:
        properties: dict[str, int | str] = {
            "columns": 2,
            "page_width_twips": _twips(defined.group(1), "in"),
            "page_height_twips": _twips(defined.group(2), "in"),
        }
        limitations: list[str] = []
        qualifiers = defined.group("qualifiers") or ""
        type_sizes = [
            match.group(1) for match in re.finditer(rf"({_NUMBER})-point type", qualifiers, re.I)
        ]
        if len(type_sizes) > 1:
            # Distinct type sizes in one sentence (for example footnotes versus body text)
            # cannot be attributed to the body without interpretation.
            limitations.append(
                "Multiple type sizes are stated in the definition sentence; the body type "
                f"size is ambiguous ({', '.join(type_sizes)})."
            )
        elif type_sizes:
            properties["body_font_size_halfpoints"] = int(
                (Decimal(type_sizes[0]) * 2).quantize(Decimal(1), rounding=ROUND_HALF_UP)
            )
            qualifiers = qualifiers.replace(type_sizes[0] + "-point type", "")
        leadings = [
            match.group(1)
            for match in re.finditer(rf"({_NUMBER})-point vertical spacing", qualifiers, re.I)
        ]
        if len(leadings) > 1:
            limitations.append(
                "Multiple vertical spacings are stated in the definition sentence; the body "
                f"line spacing is ambiguous ({', '.join(leadings)})."
            )
        elif leadings:
            properties["body_line_spacing_twips"] = int(
                (Decimal(leadings[0]) * 20).quantize(Decimal(1), rounding=ROUND_HALF_UP)
            )
            qualifiers = qualifiers.replace(leadings[0] + "-point vertical spacing", "")
        remainder = re.sub(r"\band\b", " ", qualifiers, flags=re.I).strip(" \t,-")
        if remainder:
            limitations.append(
                "The definition sentence continues with requirements that have no checkable "
                f"property: '{remainder}'."
            )
        return properties, limitations
    columns = re.fullmatch(r"All manuscript pages must use ([1-9][0-9]{0,8}) columns?", text, re.I)
    if columns is None:
        columns = re.fullmatch(r"全文必须为([1-9][0-9]{0,8})栏", text)
    if columns is not None:
        return {"columns": int(columns.group(1))}, []
    margins = re.fullmatch(
        rf"All manuscript pages must have {_NUMBER}\s*{_UNIT} margins on all sides", text, re.I
    )
    if margins is None:
        margins = re.fullmatch(rf"全文所有页边距必须为{_NUMBER}\s*{_UNIT}", text)
    if margins is not None:
        value = _twips(margins.group(1), margins.group(2))
        return {f"{side}_margin_twips": value for side in ("top", "right", "bottom", "left")}, []
    side = re.fullmatch(
        rf"All manuscript pages must have (top|right|bottom|left) margins of {_NUMBER}\s*{_UNIT}",
        text,
        re.I,
    )
    if side is not None:
        return {
            f"{side.group(1).casefold()}_margin_twips": _twips(side.group(2), side.group(3))
        }, []
    chinese_side = re.fullmatch(rf"全文(上|右|下|左)页边距必须为{_NUMBER}\s*{_UNIT}", text)
    if chinese_side is not None:
        name = {"上": "top", "右": "right", "下": "bottom", "左": "left"}[chinese_side.group(1)]
        return {f"{name}_margin_twips": _twips(chinese_side.group(2), chinese_side.group(3))}, []
    return {}, []


def _twips(number: str, unit: str) -> int:
    unit = unit.casefold()
    factor = Decimal(1440)
    if unit in {"mm", "毫米"}:
        factor /= Decimal("25.4")
    elif unit in {"cm", "厘米"}:
        factor /= Decimal("2.54")
    return int((Decimal(number) * factor).quantize(Decimal(1), rounding=ROUND_HALF_UP))
