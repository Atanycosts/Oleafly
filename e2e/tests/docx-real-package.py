"""Opt-in real-DOCX package evidence; author inputs are opened read-only."""

import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote
from uuid import UUID
from zipfile import ZipFile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
B = "{http://schemas.openxmlformats.org/officeDocument/2006/bibliography}"
CUSTOM_XML_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml"
SETTINGS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"
MAIN = "word/document.xml"
DOI = re.compile(r"10\.\d{4,9}/\S+")
DOI_LINK = re.compile(r"https?://(?:dx\.)?doi\.org/([^?#]+)", re.IGNORECASE)
PARA_ID = re.compile(r"[0-9A-Fa-f]{8}")
STRUCTURAL_STYLE = re.compile(
    r"(?:heading|title|subtitle|toc|caption|listparagraph|table|figure|cover|"
    r"abstract|keywords|bibliography|reference|header|footer|footnote|endnote|"
    r"signature|appendix|annex)",
    re.IGNORECASE,
)
CITATION_TOKEN = re.compile(r'"[^"\r\n]*"(?=\s|$)|\S+')
CITATION_ARGUMENT = re.compile(r'"[^"\r\n]*"|[^"\\\s]+')
CITATION_VALUE_SWITCHES = {r"\f", r"\l", r"\p", r"\s", r"\v", r"\*"}
CITATION_FLAG_SWITCHES = {r"\n", r"\t", r"\y", r"\*mergeformat"}
PROTECTED = [
    W + tag
    for tag in [
        "tbl", "drawing", "pict", "object", "fldChar", "fldSimple", "instrText",
        "bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd",
        "commentReference", "footnoteReference", "endnoteReference", "hyperlink",
        "ins", "del", "sectPr",
    ]
] + [M + "oMath", M + "oMathPara"]


def canonical(node):
    # Paragraph identity minting and producer rsids do not change authored objects.
    attrs = sorted(
        (k, v) for k, v in node.attrib.items()
        if k not in {W14 + "paraId", W14 + "textId"}
        and not k.startswith(W + "rsid")
    )
    text = node.text or ""
    if len(node) and not text.strip():
        text = ""
    return [node.tag, attrs, text, [canonical(child) for child in node]]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def inspect(path):
    data = Path(path).read_bytes()
    with ZipFile(path) as package:
        parts = {n: package.read(n) for n in package.namelist() if not n.endswith("/")}
    xml = {n: ET.fromstring(b) for n, b in parts.items() if n.endswith((".xml", ".rels"))}
    protected = {}
    for name, root in xml.items():
        counts = Counter(
            (node.tag, digest(canonical(node)))
            for node in root.iter() if node.tag in PROTECTED
        )
        protected[name] = {tag + ":" + sha: count for (tag, sha), count in counts.items()}
    paragraphs = []
    for node in xml[MAIN].iter(W + "p"):
        runs = node.findall(W + "r")
        props = {digest(canonical(p)) if p is not None else "none"
                 for p in (run.find(W + "rPr") for run in runs)}
        tags = {n.tag for n in node.iter()}
        simple = bool(runs) and all(c.tag in {W + "pPr", W + "r"} for c in node)
        simple = simple and all(
            all(c.tag in {W + "rPr", W + "t"} for c in run)
            and len(run.findall(W + "t")) == 1 for run in runs
        )
        text = "".join(n.text or "" for n in node.iter(W + "t"))
        categories = [label for label, tag in [
            ("field", W + "fldChar"), ("formula", M + "oMath"),
            ("image", W + "drawing"), ("revision", W + "ins"),
            ("comment", W + "commentRangeStart"),
        ] if tag in tags]
        if simple and len(props) > 1:
            categories.append("mixed")
        paragraphs.append({
            "paraId": node.get(W14 + "paraId"), "text": text,
            "safe": simple and len(props) == 1 and len(text.strip()) >= 40,
            "categories": categories,
        })
    return {
        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
        "parts": {n: hashlib.sha256(b).hexdigest() for n, b in parts.items()},
        "xmlSemantic": {n: digest(canonical(root)) for n, root in xml.items()},
        "protected": protected,
        "nodeCounts": {n: dict(Counter(e.tag for e in root.iter())) for n, root in xml.items()},
        "paragraphs": paragraphs,
    }


def compare(before, after):
    lost = {name: dict(Counter(nodes) - Counter(after["protected"].get(name, {})))
            for name, nodes in before["protected"].items()}
    lost = {name: nodes for name, nodes in lost.items() if nodes}
    return {
        "sourceSha256": before["sha256"], "outputSha256": after["sha256"],
        "missingParts": sorted(before["parts"].keys() - after["parts"].keys()),
        "addedParts": sorted(after["parts"].keys() - before["parts"].keys()),
        "changedMedia": [n for n in before["parts"] if "/media/" in n
                         and before["parts"][n] != after["parts"].get(n)],
        "changedRelationships": [n for n in before["xmlSemantic"] if n.endswith(".rels")
                                 and before["xmlSemantic"][n] != after["xmlSemantic"].get(n)],
        "changedXmlParts": [n for n in before["xmlSemantic"]
                            if before["xmlSemantic"][n] != after["xmlSemantic"].get(n)],
        "paragraphCount": {"before": len(before["paragraphs"]), "after": len(after["paragraphs"])},
        "paragraphTextChanges": [
            {"index": i, "paraId": old["paraId"], "before": old["text"], "after": new["text"]}
            for i, (old, new) in enumerate(zip(before["paragraphs"], after["paragraphs"]))
            if old["text"] != new["text"]
        ],
        "lostOrModifiedProtectedNodes": lost,
        "nodeCountChanges": {
            n: {tag: {"before": count, "after": after["nodeCounts"].get(n, {}).get(tag, 0)}
                for tag, count in counts.items()
                if count != after["nodeCounts"].get(n, {}).get(tag, 0)}
            for n, counts in before["nodeCounts"].items()
        },
    }


def parse_citation_instruction(instruction):
    tokens = iter(CITATION_TOKEN.findall(instruction))
    next(tokens)
    primary = next(tokens, "")
    if not CITATION_ARGUMENT.fullmatch(primary):
        return None
    tags = [primary.strip('"')]
    options = []
    for token in tokens:
        switch = token.casefold()
        if switch in CITATION_FLAG_SWITCHES:
            if switch != r"\*mergeformat":
                options.append((switch, ""))
            continue
        if switch not in CITATION_VALUE_SWITCHES and switch != r"\m":
            return None
        argument = next(tokens, "")
        if not CITATION_ARGUMENT.fullmatch(argument):
            return None
        if switch == r"\m":
            tags.append(argument.strip('"'))
        elif switch not in {r"\l", r"\*"}:
            options.append((switch, argument.strip('"')))
    if not all(tag and "\\" not in tag for tag in tags):
        return None
    return tags, tuple(sorted(options, key=lambda option: option[0]))


def source_dois(source):
    declared = source.findtext(B + "DOI", "").strip().casefold().removeprefix("doi:").strip()
    url = source.findtext(B + "URL", "").strip()
    declared_url = DOI_LINK.fullmatch(declared)
    url_match = DOI_LINK.fullmatch(url)
    if declared_url:
        declared = unquote(declared_url[1]).casefold()
    return {value for value in (declared, unquote(url_match[1]).casefold() if url_match else "")
            if DOI.fullmatch(value)}


def source_identity(source, dois):
    if len(dois) == 1:
        return ("doi", next(iter(dois)))
    if not dois:
        try:
            return ("guid", str(UUID(source.findtext(B + "Guid", "").strip())))
        except ValueError:
            return None
    return None


def source_payload(source):
    attrs = sorted(source.attrib.items())
    text = source.text or ""
    if len(source) and not text.strip():
        text = ""
    return [source.tag, attrs, text, [
        canonical(child) for child in source if child.tag not in {B + "Tag", B + "Guid"}
    ]]


def field_auxiliary_records(xml, trial_tag):
    from research_file_workbench.docx.xml_support import (
        WORD_NAMESPACE, paragraph_content, paragraphs, region_for_part, string_attribute,
    )

    locations = {}
    payloads_by_part = Counter()
    for part, root in xml.items():
        if region_for_part(part) is None:
            continue
        for paragraph_index, (paragraph, _) in enumerate(paragraphs(root), start=1):
            position = 0
            for node in paragraph_content(paragraph):
                if node.tag == W + "fldSimple":
                    instruction = (string_attribute(node, WORD_NAMESPACE, "instr") or "").split(maxsplit=1)
                    if trial_tag and instruction and instruction[0].casefold() == "citation":
                        citation = parse_citation_instruction(" ".join(instruction))
                        if citation is not None and citation[0] == [trial_tag]:
                            continue
                    boundary = "simple"
                    data = node.findall(W + "fldData")
                elif node.tag == W + "fldChar":
                    boundary = string_attribute(node, WORD_NAMESPACE, "fldCharType")
                    data = list(node)
                else:
                    continue
                position += 1
                locked = string_attribute(node, WORD_NAMESPACE, "fldLock") not in {None, "0", "false", "off"}
                if locked or data:
                    payload = (locked, tuple(digest(canonical(child)) for child in data))
                    locations[(part, paragraph_index, position, boundary)] = payload
                    payloads_by_part[(part, payload)] += 1
    return locations, payloads_by_part


def field_anchors(root, part, occurrences):
    from research_file_workbench.docx.xml_support import (
        WORD_NAMESPACE, paragraph_content, paragraphs, string_attribute, text_token,
    )

    anchors = {}
    for paragraph_index, (paragraph, _) in enumerate(paragraphs(root), start=1):
        locator = f"{part}#paragraph[{paragraph_index}]"
        selected = occurrences.get(locator)
        if not selected:
            continue
        prose = []
        positions = []
        simple_contents = set()
        complex_depth = occurrence = 0
        for node in paragraph_content(paragraph):
            simple = node.tag == W + "fldSimple"
            boundary = string_attribute(node, WORD_NAMESPACE, "fldCharType") if node.tag == W + "fldChar" else None
            if simple or boundary == "begin":
                occurrence += 1
                if occurrence in selected:
                    positions.append(len(prose))
                if simple:
                    simple_contents.update(paragraph_content(node)[1:])
                else:
                    complex_depth += 1
            elif boundary == "end":
                complex_depth = max(0, complex_depth - 1)
            elif not complex_depth and node not in simple_contents:
                prose.append(text_token(node))
        anchors[locator] = (
            " ".join("".join(prose).split()),
            tuple(tuple(" ".join("".join(side).split()) for side in (prose[:position], prose[position:]))
                  for position in positions),
            paragraph_identity(paragraph),
        )
    return anchors


def ordered_citation_anchors(anchors):
    return [anchor for _, (_, anchors, _) in anchors.items() for anchor in anchors]


def anchored_protected_fields(snapshot):
    anchors = snapshot["protected_anchors"]
    locations = [(locator.rsplit("#paragraph[", 1)[0], paragraph_number(locator), locator) for locator in anchors]
    return [(part, instruction, anchor, anchors[locator][2])
            for part, _, locator in sorted(locations)
            for (instruction, *_), anchor in zip(snapshot["protected_by_paragraph"][locator], anchors[locator][1], strict=True)]


def protected_field_identity_issues(before, after, before_counts, after_counts):
    before_by_location = defaultdict(Counter)
    after_by_location = defaultdict(Counter)
    for field in before:
        if field[3] is not None:
            before_by_location[(field[0], field[3])][field[:3]] += 1
    for field in after:
        if field[3] is not None:
            after_by_location[(field[0], field[3])][field[:3]] += 1
    return any(
        before_counts.get(location) == 1
        and after_counts.get(location) == 1
        and (signatures - after_by_location.get(location, Counter()))
        for location, signatures in before_by_location.items()
    )


def word_saved_protected_field_issues(exported, saved, *, allow_added=False):
    before, after = map(anchored_protected_fields, (exported, saved))
    if Counter(field[:2] for field in before) - Counter(field[:2] for field in after):
        return ["Word save: pre-existing non-native field instructions lost or changed"]
    if protected_field_identity_issues(
            before, after, exported["paragraph_identity_counts"], saved["paragraph_identity_counts"]):
        return ["Word save: non-native fields moved relative to their paragraph text"]
    before_fields = [field[:3] for field in before]
    after_fields = [field[:3] for field in after]
    remaining = iter(after_fields)
    preserved = all(field in remaining for field in before_fields) if allow_added else before_fields == after_fields
    if not preserved:
        return ["Word save: non-native fields moved relative to their paragraph text"]
    return []


def field_positions_changed_in_unchanged_prose(before, after):
    return any(prose == after[locator][0] and anchors != after[locator][1]
               for locator, (prose, anchors, _) in before.items())


def main_document_prose_rows(root):
    from research_file_workbench.docx.xml_support import (
        WORD_NAMESPACE, paragraph_content, paragraphs, string_attribute, text_token,
    )

    complex_depth = 0
    prose = []
    for paragraph, in_textbox in paragraphs(root):
        if in_textbox:
            continue
        tokens = []
        simple_contents = set()
        for node in paragraph_content(paragraph):
            if node in simple_contents:
                continue
            if node.tag == W + "fldSimple":
                simple_contents.update(paragraph_content(node)[1:])
            elif node.tag == W + "fldChar":
                boundary = string_attribute(node, WORD_NAMESPACE, "fldCharType")
                if boundary == "begin":
                    complex_depth += 1
                elif boundary == "end":
                    complex_depth = max(0, complex_depth - 1)
            elif not complex_depth:
                tokens.append(text_token(node))
        if text := " ".join("".join(tokens).split()):
            prose.append((paragraph_identity(paragraph), text))
    return prose


def main_document_prose(root):
    return [text for _, text in main_document_prose_rows(root)]


def citation_package(path, doi=None, *, ignore_trial_field_auxiliary=True):
    from research_file_workbench.docx.parsing.fields import read_fields
    from research_file_workbench.docx.parsing.package import package_part_names, read_relationships
    from research_file_workbench.docx.xml_support import on_off_value

    data = Path(path).read_bytes()
    with ZipFile(BytesIO(data)) as package:
        names = package_part_names(package)
        xml = {name: ET.fromstring(package.read(name)) for name in names
               if name.endswith((".xml", ".rels"))}
    fields, field_issues = read_fields(xml)
    relationships, _ = read_relationships(names, xml)
    settings_part = next((relation.resolved_target for relation in relationships
                          if relation.source_part == MAIN and relation.relationship_type == SETTINGS_REL
                          and relation.resolved_target in xml), "word/settings.xml")
    settings = xml.get(settings_part)
    track_revisions = on_off_value(settings.find(W + "trackRevisions")) if settings is not None else False
    linked = {relation.resolved_target for relation in relationships
              if relation.source_part == MAIN and relation.relationship_type == CUSTOM_XML_REL
              and relation.resolved_target is not None}
    sources = [source for name in sorted(linked) if name in xml and xml[name].tag == B + "Sources"
               for source in xml[name].findall(B + "Source")]

    by_tag = defaultdict(list)
    matches = []
    existing_source_records = Counter()
    existing_source_semantics = Counter()
    existing_source_titles = []
    for source in sources:
        tag = source.findtext(B + "Tag", "").strip()
        dois = source_dois(source)
        identity = source_identity(source, dois)
        by_tag[tag].append(identity)
        if doi in dois:
            matches.append(source)
        else:
            existing_source_records[digest(canonical(source))] += 1
            existing_source_semantics[(identity, digest(source_payload(source)))] += 1
            existing_source_titles.append(source.findtext(B + "Title", ""))
    identities = {tag: records[0] for tag, records in by_tag.items() if tag and len(records) == 1}
    trial_identity = ("doi", doi)
    tag = matches[0].findtext(B + "Tag", "").strip() if len(matches) == 1 else ""
    unique_tag = bool(tag) and identities.get(tag) == trial_identity
    citations = []
    trial_fields = []
    trial_occurrences = defaultdict(set)
    existing_citations = Counter()
    existing_occurrences = defaultdict(set)
    citations_by_paragraph = defaultdict(lambda: defaultdict(list))
    existing_native_fields = defaultdict(list)
    unresolved_citations = 0
    for field in sorted(fields, key=lambda field: (field.node_locator, field.occurrence_index)):
        if field.field_kind not in {"citation", "bibliography"}:
            continue
        if field.field_kind == "citation":
            parsed = parse_citation_instruction(field.instruction)
            tags, options = parsed if parsed is not None else ((), ())
            resolved = tuple(identities.get(tag) for tag in tags)
            if not resolved or None in resolved:
                unresolved_citations += 1
            elif unique_tag and field.part_path == MAIN and resolved == (trial_identity,):
                citations.append((field.node_locator, field.result_text.strip()))
                trial_fields.append(field)
                trial_occurrences[field.node_locator].add(field.occurrence_index)
                continue
            else:
                source_group = tuple(sorted(resolved))
                existing_citations[(field.part_path, source_group)] += 1
                citations_by_paragraph[field.part_path][field.node_locator].append((source_group, options))
                if field.part_path == MAIN:
                    existing_occurrences[field.node_locator].add(field.occurrence_index)
        existing_native_fields[field.node_locator].append(
            (field.instruction, field.result_text, field.nested_level, field.boundary_sequence),
        )
    citation_paragraphs = {
        part: {locator: tuple(group for group, _ in fields) for locator, fields in paragraphs.items()}
        for part, paragraphs in citations_by_paragraph.items()
    }
    citation_options = {
        part: {locator: tuple(options for _, options in fields) for locator, fields in paragraphs.items()}
        for part, paragraphs in citations_by_paragraph.items()
    }
    bibliography_fields = [field for field in fields if field.field_kind == "bibliography"]
    bibliography = [field.result_text.strip() for field in bibliography_fields if field.part_path == MAIN]
    bibliography_instructions = Counter((field.part_path, field.node_locator, field.instruction)
                                        for field in bibliography_fields)
    protected_fields = sorted(
        (field for field in fields if field.field_kind not in {"citation", "bibliography"}),
        key=lambda field: (field.node_locator, field.occurrence_index),
    )
    protected_by_paragraph = defaultdict(list)
    protected_occurrences = defaultdict(lambda: defaultdict(set))
    for field in protected_fields:
        protected_by_paragraph[field.node_locator].append(
            (field.instruction, field.result_text, field.nested_level, field.boundary_sequence),
        )
        protected_occurrences[field.part_path][field.node_locator].add(field.occurrence_index)
    protected_anchors = {locator: anchor for part, occurrences in protected_occurrences.items()
                         for locator, anchor in field_anchors(xml[part], part, occurrences).items()}
    auxiliary_exclusion = tag if unique_tag and ignore_trial_field_auxiliary else ""
    field_auxiliary, field_auxiliary_by_part = field_auxiliary_records(xml, auxiliary_exclusion)
    native_fields = Counter(
        (field.part_path, field.node_locator, field.occurrence_index, field.instruction,
         field.result_text, field.nested_level, field.boundary_sequence)
        for field in fields if field.field_kind in {"citation", "bibliography"}
    )
    source_stores = Counter(digest(canonical(xml[name])) for name in linked
                            if name in xml and xml[name].tag == B + "Sources")
    bookmarks = Counter()
    for name, root in xml.items():
        ends = {node.get(W + "id") for node in root.iter(W + "bookmarkEnd")} - {None}
        bookmarks.update((name, node.get(W + "name")) for node in root.iter(W + "bookmarkStart")
                         if node.get(W + "id") in ends and node.get(W + "name"))
    columns = []
    for section in xml[MAIN].iter(W + "sectPr"):
        layout = section.find(W + "cols")
        widths = tuple((column.get(W + "w"), column.get(W + "space"))
                       for column in layout.findall(W + "col")) if layout is not None else ()
        equal_width = layout is None or layout.get(W + "equalWidth", "1") not in {"0", "false", "off"}
        count = int(layout.get(W + "num", "1")) if equal_width and layout is not None else len(widths) or 1
        spacing = int(layout.get(W + "space", "720")) if count > 1 and equal_width else None
        columns.append((count, spacing, () if equal_width else widths))
    title = matches[0].findtext(B + "Title", "").strip() if unique_tag else ""
    body_paragraphs = len(xml[MAIN].findall(f"{W}body/{W}p"))
    return dict(sha256=hashlib.sha256(data).hexdigest(), body_paragraphs=body_paragraphs,
                matches=len(matches), title=title,
                unique_tag=unique_tag, citations=citations, trial_fields=trial_fields,
                main_root=xml[MAIN], track_revisions=track_revisions,
                bibliography=bibliography,
                bibliography_parts=Counter(field.part_path for field in bibliography_fields),
                trial_anchors=field_anchors(xml[MAIN], MAIN, trial_occurrences),
                existing_anchors=field_anchors(xml[MAIN], MAIN, existing_occurrences),
                bibliography_instructions=bibliography_instructions, existing_source_records=existing_source_records,
                existing_source_semantics=existing_source_semantics,
                existing_source_titles=existing_source_titles,
                existing_citations=existing_citations, citation_paragraphs=citation_paragraphs,
                citation_options=citation_options,
                existing_native_fields=existing_native_fields,
                unresolved_citations=unresolved_citations,
                field_issues=field_issues,
                field_auxiliary=field_auxiliary, field_auxiliary_by_part=field_auxiliary_by_part,
                protected_by_paragraph=protected_by_paragraph, protected_anchors=protected_anchors,
                paragraph_identity_counts=paragraph_identity_counts(xml),
                bookmarks=bookmarks, columns=columns,
                native_fields=native_fields, source_stores=source_stores)


def ordered_citation_paragraphs(citation_paragraphs):
    return {part: tuple(paragraphs[locator] for locator in sorted(paragraphs, key=paragraph_number))
            for part, paragraphs in citation_paragraphs.items()}


def paragraph_number(locator):
    return int(locator.rsplit("[", 1)[1][:-1])


def trial_doi(doi):
    doi = doi.strip().casefold()
    if not DOI.fullmatch(doi):
        raise ValueError("Expected the bare DOI selected for the trial.")
    return doi


def citation_parse_issues(snapshot, label):
    issues = []
    if snapshot["field_issues"]:
        issues.append(f"{label}: {len(snapshot['field_issues'])} field parsing issues")
    unresolved = snapshot["unresolved_citations"]
    if unresolved:
        issues.append(f"{label}: {unresolved} native citation field(s) could not be resolved to identified sources")
    return issues


def main_document_citation_count(snapshot):
    return sum(count for (part, _), count in snapshot["existing_citations"].items() if part == MAIN)


def citation_original_issues(original, *, require_existing_citations=False):
    issues = citation_parse_issues(original, "original")
    if original["matches"]:
        issues.append("original: trial DOI is already in the bibliography")
    if not any(count == 2 for count, _, _ in original["columns"]):
        issues.append("original: no double-column section")
    if require_existing_citations and not main_document_citation_count(original):
        issues.append("original: no existing resolvable native citations in the main document")
    return issues


def normalized(text):
    return " ".join(text.casefold().split())


def citation_copy_issues(original, snapshot, *, word_saved):
    label = "Word save" if word_saved else "Oleafly export"
    issues = citation_parse_issues(snapshot, label)
    locations = {location for location, _ in snapshot["citations"]}
    if (snapshot["matches"] != 1 or not snapshot["unique_tag"]
            or len(snapshot["citations"]) != 2 or len(locations) != 2):
        issues.append(f"{label}: expected one uniquely tagged source and citations in two paragraphs for the trial DOI")
    elif word_saved:
        if any(not result or result.startswith("\u27e6") for _, result in snapshot["citations"]):
            issues.append("Word save: citation results have not been refreshed")
    else:
        title = snapshot["title"]
        if not title or any(result != f"\u27e6{title}\u27e7" for _, result in snapshot["citations"]):
            issues.append("Oleafly export: expected the trial title placeholder in both citation results")
        trial_title = normalized(title)
        if trial_title and any(trial_title in normalized(text) for text in (
            *original["existing_source_titles"], *original["bibliography"], *snapshot["bibliography"],
        )):
            issues.append("Oleafly export: cannot verify a new bibliography entry because the trial title already "
                          "occurs in an existing source title or bibliography cache; choose a distinguishable trial DOI")
    return issues + existing_field_issues(original, snapshot, label, word_saved=word_saved)


def existing_field_issues(original, snapshot, label, *, word_saved):
    issues = []
    if snapshot["existing_citations"] != original["existing_citations"]:
        issues.append(f"{label}: pre-existing native citation sources or occurrence counts changed")
    else:
        before = original["citation_paragraphs"]
        after = snapshot["citation_paragraphs"]
        if not word_saved and before != after:
            issues.append(f"{label}: pre-existing native citations moved to different paragraphs or changed order")
        elif not word_saved and field_positions_changed_in_unchanged_prose(original["existing_anchors"], snapshot["existing_anchors"]):
            issues.append(f"{label}: pre-existing native citations moved within unchanged paragraph text")
        elif word_saved:
            if ordered_citation_paragraphs(before) != ordered_citation_paragraphs(after):
                issues.append(f"{label}: pre-existing native citations changed order or paragraph grouping")
            elif (ordered_citation_paragraphs(original["citation_options"])
                  != ordered_citation_paragraphs(snapshot["citation_options"])):
                issues.append(f"{label}: pre-existing native citation options changed")
    if not word_saved:
        if snapshot["protected_by_paragraph"] != original["protected_by_paragraph"]:
            issues.append(f"{label}: pre-existing non-native fields moved or changed")
        elif field_positions_changed_in_unchanged_prose(original["protected_anchors"], snapshot["protected_anchors"]):
            issues.append(f"{label}: pre-existing non-native fields moved within unchanged paragraph text")
    if word_saved and original["field_auxiliary_by_part"] - snapshot["field_auxiliary_by_part"]:
        issues.append(f"{label}: pre-existing field locks or auxiliary data changed")
    elif not word_saved and snapshot["field_auxiliary"] != original["field_auxiliary"]:
        issues.append(f"{label}: pre-existing field locks or auxiliary data changed")
    if not word_saved and original["bibliography_instructions"] - snapshot["bibliography_instructions"]:
        issues.append(f"{label}: pre-existing bibliography fields lost or changed")
    elif (not word_saved and snapshot["citation_paragraphs"] == original["citation_paragraphs"]
          and snapshot["existing_native_fields"] != original["existing_native_fields"]):
        issues.append(f"{label}: pre-existing native field details or cached results changed")
    source_records_changed = (
        snapshot["existing_source_semantics"] != original["existing_source_semantics"]
        if word_saved
        else snapshot["existing_source_records"] != original["existing_source_records"]
    )
    if source_records_changed:
        issues.append(f"{label}: bibliography source records other than the trial changed")
    if original["bookmarks"] - snapshot["bookmarks"]:
        issues.append(f"{label}: pre-existing named bookmarks lost")
    if snapshot["columns"] != original["columns"]:
        issues.append(f"{label}: section column layout changed")
    return issues


def check_citation_input(original_path, doi, selected_paragraphs=None):
    original = citation_package(original_path, trial_doi(doi))
    issues = citation_original_issues(original, require_existing_citations=True)
    if original["track_revisions"]:
        issues.append("original: Word Track Changes is on; citation preview supports only direct, untracked insertions")
    if selected_paragraphs is not None:
        issues += trial_paragraph_issues(original["main_root"], selected_paragraphs)
    return {"ok": not issues, "issues": issues, "sha256": original["sha256"],
            "bodyParagraphs": original["body_paragraphs"], "existingNativeCitationsInMain": main_document_citation_count(original)}


def citation_export_target_issues(original, exported, selected_paragraphs):
    issues = trial_paragraph_issues(original["main_root"], selected_paragraphs)
    if issues:
        return issues
    left, edit, right = (value.strip().upper() for value in selected_paragraphs.split(","))
    rows = body_paragraph_rows(exported["main_root"])
    counts = Counter(paragraph_identity(paragraph) for _, paragraph, _, _ in rows)
    by_locator = {locator: paragraph_identity(paragraph) for locator, paragraph, direct, _ in rows if direct}
    targets = Counter(by_locator.get(field.node_locator) for field in exported["trial_fields"])
    if targets != Counter((left, right)) or any(counts[identity] != 1 for identity in (left, edit, right)):
        issues.append("Oleafly export: trial citations must be in the two specified body paragraphs")
    elif any(before for before, _ in ordered_citation_anchors(exported["trial_anchors"])):
        issues.append("Oleafly export: trial citations must start their specified paragraphs")
    return issues + trial_prose_issues(original["main_root"], exported["main_root"], (left, edit))


def check_citation_export(original_path, export_path, doi, selected_paragraphs=None):
    doi = trial_doi(doi)
    original, exported = (citation_package(path, doi) for path in (original_path, export_path))
    issues = citation_original_issues(original) + citation_copy_issues(original, exported, word_saved=False)
    if selected_paragraphs is not None:
        issues += citation_export_target_issues(original, exported, selected_paragraphs)
    return {"ok": not issues, "issues": issues, "doi": doi,
            "sha256": {"original": original["sha256"], "oleafly": exported["sha256"]}}


def check_citation_round_trip(original_path, export_path, word_path, doi, selected_paragraphs=None):
    """Compare declared Word semantics; actual Word interaction still needs observation."""
    doi = trial_doi(doi)
    original, exported, saved = (citation_package(path, doi) for path in (original_path, export_path, word_path))
    issues = citation_original_issues(original, require_existing_citations=True)
    issues += citation_copy_issues(original, exported, word_saved=False)
    if selected_paragraphs is not None:
        issues += citation_export_target_issues(original, exported, selected_paragraphs)
    issues += citation_copy_issues(original, saved, word_saved=True)
    if main_document_prose(exported["main_root"]) != main_document_prose(saved["main_root"]):
        issues.append("Word save: main-document prose outside fields changed")
    exported_trial_anchors = ordered_citation_anchors(exported["trial_anchors"])
    saved_trial_anchors = ordered_citation_anchors(saved["trial_anchors"])
    if len(exported_trial_anchors) == len(saved_trial_anchors) == 2 and exported_trial_anchors != saved_trial_anchors:
        issues.append("Word save: trial citations moved relative to their paragraph text")
    if (ordered_citation_paragraphs(exported["citation_paragraphs"]) == ordered_citation_paragraphs(saved["citation_paragraphs"])
            and ordered_citation_anchors(exported["existing_anchors"]) != ordered_citation_anchors(saved["existing_anchors"])):
        issues.append("Word save: pre-existing native citations moved relative to their paragraph text")
    issues += word_saved_protected_field_issues(exported, saved, allow_added=True)
    title = normalized(exported["title"])
    if not title or normalized(saved["title"]) != title:
        issues.append("Word save: source title is missing or changed")
    elif sum(normalized(result).count(title) for result in saved["bibliography"]) != 1:
        issues.append("Word save: expected the trial source title once in native bibliography results")
    return {"ok": not issues, "issues": issues, "doi": doi,
            "sha256": {"original": original["sha256"], "oleafly": exported["sha256"], "word": saved["sha256"]}}


def citation_reimport_input_issues(snapshot):
    issues = []
    if (not snapshot["unique_tag"] or len(snapshot["citations"]) != 2
            or len({location for location, _ in snapshot["citations"]}) != 2):
        issues.append("Word save: expected one uniquely tagged source and citations in two paragraphs for the trial DOI")
    if not any(snapshot["bibliography"]) or any(not result or result.startswith("\u27e6")
                                                for _, result in snapshot["citations"]):
        issues.append("Word save: expected refreshed citations and a native bibliography")
    return issues


def word_export_issues(original, exported, edited_paragraphs):
    issues = citation_original_issues(original)
    issues += citation_parse_issues(exported, "Oleafly export")
    issues += reexport_field_issues(original, exported, "Oleafly export")
    identities = [value.strip().upper() for value in edited_paragraphs.split(",")]
    if (len(identities) != 2 or len(set(identities)) != 2
            or any(not PARA_ID.fullmatch(value) or value == "00000000" for value in identities)):
        return issues + ["Oleafly export: supply the two distinct paragraph IDs edited in the candidate check"]
    return issues + trial_prose_issues(original["main_root"], exported["main_root"], identities)


def trial_prose_issues(original_root, exported_root, identities):
    before = main_document_prose_rows(original_root)
    after = main_document_prose_rows(exported_root)
    for rows in (before, after):
        counts = Counter(identity for identity, _ in rows)
        if any(counts[identity] != 1 for identity in identities):
            return ["Oleafly export: trial paragraph IDs must identify one nonempty paragraph in each copy"]
    if len(before) != len(after):
        return ["Oleafly export: nonempty main-document paragraph count changed"]
    changed = Counter()
    for (old_id, old_text), (new_id, new_text) in zip(before, after):
        if old_text == new_text:
            continue
        if old_id == new_id and old_id in identities:
            changed[old_id] += 1
        else:
            return ["Oleafly export: main-document prose outside the trial paragraphs changed"]
    if changed != Counter(identities):
        return ["Oleafly export: expected a text change in each trial paragraph"]
    return []


def check_word_export(original_path, export_path, edited_paragraphs):
    original, exported = (citation_package(path) for path in (original_path, export_path))
    issues = word_export_issues(original, exported, edited_paragraphs)
    return {"ok": not issues, "issues": issues,
            "sha256": {"original": original["sha256"], "oleafly": exported["sha256"]}}


def reexport_prose_issues(saved_root, edited_root, reimport_para_id, edit_prefix):
    para_id = reimport_para_id.strip().upper()
    if not plain_body_target(saved_root, para_id):
        return ["Word save: re-import target must identify one plain, field-free body paragraph"]
    saved = main_document_prose_rows(saved_root)
    edited = main_document_prose_rows(edited_root)
    prefix = " ".join(edit_prefix.split())
    changes = [(before_id, after_id, before, after)
               for (before_id, before), (after_id, after) in zip(saved, edited)
               if before != after]
    if (not prefix or len(saved) != len(edited) or len(changes) != 1
            or changes[0][3] != f"{prefix} {changes[0][2]}"):
        return ["Oleafly re-export: expected only the trial prefix in one existing body paragraph"]
    if changes[0][:2] != (para_id, para_id):
        return ["Oleafly re-export: trial prefix is not in the specified paragraph"]
    if not plain_body_target(edited_root, para_id):
        return ["Oleafly re-export: trial paragraph is no longer a unique plain, field-free body paragraph"]
    return []


def check_word_round_trip(original_path, export_path, word_path, edited_path,
                          edited_paragraphs, reimport_para_id, edit_prefix):
    """Default editing and Word resave; no trial citation required."""
    original, exported, saved, edited = (citation_package(path) for path in (
        original_path, export_path, word_path, edited_path,
    ))
    issues = word_export_issues(original, exported, edited_paragraphs)
    issues += citation_parse_issues(saved, "Word save")
    issues += existing_field_issues(exported, saved, "Word save", word_saved=True)
    if saved["bibliography_parts"] != exported["bibliography_parts"]:
        issues.append("Word save: native bibliography fields added or removed")
    if ordered_citation_anchors(exported["existing_anchors"]) != ordered_citation_anchors(saved["existing_anchors"]):
        issues.append("Word save: native citations moved relative to their paragraph text")
    issues += word_saved_protected_field_issues(exported, saved)
    issues += citation_parse_issues(edited, "Oleafly re-export")
    issues += reexport_field_issues(saved, edited, "Oleafly re-export")

    saved_prose = main_document_prose(saved["main_root"])
    if main_document_prose(exported["main_root"]) != saved_prose:
        issues.append("Word save: main-document prose outside fields changed")
    issues += reexport_prose_issues(saved["main_root"], edited["main_root"], reimport_para_id, edit_prefix)
    return {"ok": not issues, "issues": issues, "sha256": {
        "original": original["sha256"], "oleafly": exported["sha256"],
        "word": saved["sha256"], "oleaflyReexport": edited["sha256"],
    }}


def check_citation_reimport(word_path, edited_path, doi, reimport_para_id, edit_prefix):
    doi = trial_doi(doi)
    saved, edited = (citation_package(path, doi, ignore_trial_field_auxiliary=False)
                     for path in (word_path, edited_path))
    issues = (citation_parse_issues(saved, "Word save")
              + citation_parse_issues(edited, "Oleafly re-export")
              + citation_reimport_input_issues(saved)
              + reexport_field_issues(saved, edited, "Oleafly re-export")
              + reexport_prose_issues(saved["main_root"], edited["main_root"], reimport_para_id, edit_prefix))
    return {"ok": not issues, "issues": issues, "doi": doi,
            "sha256": {"word": saved["sha256"], "oleaflyReexport": edited["sha256"]}}


def reexport_field_issues(saved, edited, label):
    issues = []
    for key, description in (
        ("native_fields", "native citation or bibliography fields"),
        ("source_stores", "linked bibliography stores"),
        ("protected_by_paragraph", "non-native fields"),
        ("field_auxiliary", "field locks or auxiliary data"),
        ("bookmarks", "named bookmarks"),
        ("columns", "section column layout"),
    ):
        if saved[key] != edited[key]:
            issues.append(f"{label}: {description} changed")
    if saved["native_fields"] == edited["native_fields"]:
        if ordered_citation_anchors(saved["trial_anchors"]) != ordered_citation_anchors(edited["trial_anchors"]):
            issues.append(f"{label}: trial citations moved relative to their paragraph text")
        if ordered_citation_anchors(saved["existing_anchors"]) != ordered_citation_anchors(edited["existing_anchors"]):
            issues.append(f"{label}: pre-existing native citations moved relative to their paragraph text")
    if (saved["protected_by_paragraph"] == edited["protected_by_paragraph"]
            and field_positions_changed_in_unchanged_prose(saved["protected_anchors"], edited["protected_anchors"])):
        issues.append(f"{label}: non-native fields moved within unchanged paragraph text")
    return issues


def paragraph_identity(paragraph):
    value = paragraph.get(W14 + "paraId")
    if value and value != "00000000" and PARA_ID.fullmatch(value):
        return value.upper()
    return None


def paragraph_identity_counts(xml):
    from research_file_workbench.docx.xml_support import paragraphs, region_for_part

    counts = Counter()
    for part, root in xml.items():
        if region_for_part(part) is None:
            continue
        for paragraph, _ in paragraphs(root):
            if identity := paragraph_identity(paragraph):
                counts[(part, identity)] += 1
    return counts


def body_paragraph_rows(root):
    from research_file_workbench.docx.xml_support import paragraphs

    body = root.find(W + "body")
    direct = {id(paragraph) for paragraph in body.findall(W + "p")} if body is not None else set()
    return [
        (f"{MAIN}#paragraph[{index}]", paragraph, id(paragraph) in direct, index)
        for index, (paragraph, _) in enumerate(paragraphs(root), start=1)
    ]


def field_touched_body_paragraphs(root):
    from research_file_workbench.docx.xml_support import (
        WORD_NAMESPACE, selected_children, string_attribute,
    )

    body = root.find(W + "body")
    if body is None:
        return set()
    direct = {id(paragraph) for paragraph in body.findall(W + "p")}
    touched = set()
    depth = 0

    def visit(element, paragraph):
        nonlocal depth
        if element.tag == W + "p":
            paragraph = element if id(element) in direct else None
        if paragraph is not None and (
            depth or element.tag in {W + "fldSimple", W + "fldChar", W + "instrText"}
        ):
            touched.add(id(paragraph))
        if element.tag == W + "fldChar":
            boundary = string_attribute(element, WORD_NAMESPACE, "fldCharType")
            if boundary == "begin":
                depth += 1
            elif boundary == "end":
                depth = max(0, depth - 1)
        if element.tag == W + "txbxContent":
            return
        for child in selected_children(element):
            visit(child, paragraph)
        if paragraph is not None and depth:
            touched.add(id(paragraph))

    for child in selected_children(body):
        visit(child, None)
    return touched


def plain_editable_paragraph(paragraph):
    from research_file_workbench.docx.xml_support import (
        WORD_NAMESPACE, selected_children, string_attribute,
    )

    structural_properties = {
        W + "sectPr", W + "numPr", W + "outlineLvl", W + "framePr", W + "divId",
    }
    has_text = False
    for child in selected_children(paragraph):
        if child.tag == W + "pPr":
            for prop in selected_children(child):
                if prop.tag in structural_properties:
                    return False
                if prop.tag == W + "pStyle":
                    style = string_attribute(prop, WORD_NAMESPACE, "val") or ""
                    if not style or STRUCTURAL_STYLE.search(style):
                        return False
        elif child.tag == W + "r":
            for item in selected_children(child):
                if item.tag == W + "rPr":
                    continue
                if item.tag != W + "t":
                    return False
                has_text = has_text or bool((item.text or "").strip())
        elif child.tag != W + "proofErr":
            return False
    return has_text


def plain_body_target(root, para_id):
    matches = [(paragraph, direct) for _, paragraph, direct, _ in body_paragraph_rows(root)
               if paragraph_identity(paragraph) == para_id]
    if len(matches) != 1:
        return False
    (paragraph, direct), = matches
    return direct and id(paragraph) not in field_touched_body_paragraphs(root) and plain_editable_paragraph(paragraph)


def trial_paragraph_issues(root, selected):
    identities = [value.strip().upper() for value in selected.split(",")]
    if (len(identities) != 3 or len(set(identities)) != 3
            or any(not PARA_ID.fullmatch(value) or value == "00000000" for value in identities)):
        return ["original: supply three distinct paragraph IDs in left,edit,right order"]

    candidates = defaultdict(list)
    for _, paragraph, direct, _ in body_paragraph_rows(root):
        identity = paragraph_identity(paragraph)
        if identity in identities:
            candidates[identity].append((paragraph, direct))
    touched = field_touched_body_paragraphs(root)
    issues = []
    for role, identity in zip(("left", "edit", "right"), identities):
        matches = candidates[identity]
        if len(matches) != 1:
            issues.append(f"original: {role} paragraph {identity} is not a unique main-document paragraph")
            continue
        (paragraph, direct), = matches
        if not direct or id(paragraph) in touched or not plain_editable_paragraph(paragraph):
            issues.append(f"original: {role} paragraph {identity} is not a plain, field-free body paragraph")
    return issues


def check_citation_reimport_targets(input_path, doi):
    doi = trial_doi(doi)
    snapshot = citation_package(input_path, doi, ignore_trial_field_auxiliary=False)
    issues = (citation_parse_issues(snapshot, "Word save")
              + citation_reimport_input_issues(snapshot))

    rows = body_paragraph_rows(snapshot["main_root"])
    by_locator = {locator: (paragraph, direct, index)
                  for locator, paragraph, direct, index in rows}
    identities = Counter(identity for _, paragraph, _, _ in rows
                         if (identity := paragraph_identity(paragraph)))
    targets = []
    for field in snapshot["trial_fields"]:
        row = by_locator.get(field.node_locator)
        if row is None:
            continue
        paragraph, direct, index = row
        identity = paragraph_identity(paragraph)
        if direct and identity and identities[identity] == 1:
            targets.append((index, identity, field.instruction))

    targets.sort()
    if len(targets) != 2 or len({identity for _, identity, _ in targets}) != 2:
        issues.append("Word save: expected two distinct body citation paragraphs with unique w14:paraId values")
        citations = []
    else:
        citations = [{"paraId": identity, "instruction": instruction}
                     for _, identity, instruction in targets]

    citation_ids = {citation["paraId"] for citation in citations}
    touched = field_touched_body_paragraphs(snapshot["main_root"])
    edit_para_id = None
    for _, paragraph, direct, _ in rows:
        identity = paragraph_identity(paragraph)
        if not direct or not identity or identities[identity] != 1:
            continue
        if identity in citation_ids or id(paragraph) in touched:
            continue
        if plain_editable_paragraph(paragraph):
            edit_para_id = identity
            break
    if edit_para_id is None:
        issues.append("Word save: expected a distinct editable body paragraph with a unique w14:paraId")

    return {
        "ok": not issues, "issues": issues, "doi": doi, "sha256": snapshot["sha256"],
        "citations": citations, "editParaId": edit_para_id,
    }


if __name__ == "__main__":
    package_checks = {"--word-export": check_word_export, "--word-round-trip": check_word_round_trip,
                      "--citation-input": check_citation_input, "--citation-export": check_citation_export,
                      "--citation-round-trip": check_citation_round_trip,
                      "--citation-reimport": check_citation_reimport,
                      "--citation-reimport-targets": check_citation_reimport_targets}
    if sys.argv[1] in package_checks:
        result = package_checks[sys.argv[1]](*sys.argv[2:])
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result["ok"] else 1)
    source = inspect(sys.argv[1])
    result = source if len(sys.argv) == 2 else compare(source, inspect(sys.argv[2]))
    print(json.dumps(result, ensure_ascii=False))
