"""Opt-in real-DOCX package evidence; author inputs are opened read-only."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
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
    for node in xml["word/document.xml"].iter(W + "p"):
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


source = inspect(sys.argv[1])
result = source if len(sys.argv) == 2 else compare(source, inspect(sys.argv[2]))
print(json.dumps(result, ensure_ascii=False))
