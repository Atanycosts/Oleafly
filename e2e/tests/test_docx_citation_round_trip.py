"""Exercise the citation package check without claiming a Microsoft Word run."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZipFile

CHECK = Path(__file__).with_name("docx-real-package.py")
DOI = "10.1234/Example"
TITLE = "The example study"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WORD14 = "http://schemas.microsoft.com/office/word/2010/wordml"
BIB = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CUSTOM = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml"
SETTINGS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"
ADDIN = "ADDIN ZOTERO_ITEM CSL_CITATION {}"
OLD_ID = "{434223C3-438A-41D5-8F8C-CF983208E7A7}"
OTHER_ID = "{F93D6EA0-7BE8-42F1-ABF2-CC5117468E87}"


def simple(code, text):
    return f'<w:fldSimple w:instr={quoteattr(code)}><w:r><w:t>{escape(text)}</w:t></w:r></w:fldSimple>'


def complex_field(code_parts, text):
    instructions = "".join(f"<w:r><w:instrText>{part}</w:instrText></w:r>" for part in code_parts)
    return (f'<w:r><w:fldChar w:fldCharType="begin"/></w:r>{instructions}'
            f'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>{text}</w:t></w:r>'
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>')


def paragraph(para_id, content, props=""):
    identity = f' w14:paraId="{para_id}"' if para_id else ""
    return f"<w:p{identity}>{props}{content}</w:p>"


def source(tag, doi=DOI, guid="", title=TITLE):
    return (f"<b:Source><b:Tag>{tag}</b:Tag><b:Title>{title}</b:Title>"
            f"<b:Guid>{guid}</b:Guid><b:URL>{'https://doi.org/' + doi if doi else ''}</b:URL></b:Source>")


def package(path, *, fields="", existing_fields="", addon=simple(ADDIN, "[1]"), bookmark_end=True,
            columns='<w:cols w:num="2"/>', sources="", linked=True, settings="",
            settings_name="settings.xml", settings_linked=True):
    bookmark = '<w:bookmarkStart w:id="1" w:name="Target"/>'
    if bookmark_end:
        bookmark += '<w:bookmarkEnd w:id="1"/>'
    with ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{WORD}" xmlns:w14="{WORD14}"><w:body>'
                         f"<w:p>{bookmark}{addon}</w:p>{existing_fields}{fields}<w:sectPr>{columns}</w:sectPr>"
                         "</w:body></w:document>")
        if sources:
            archive.writestr("customXml/item3.xml", f'<b:Sources xmlns:b="{BIB}">{sources}</b:Sources>')
        relationships = []
        if linked and sources:
            relationships.append(f'<Relationship Id="rId1" Type="{CUSTOM}" Target="../customXml/item3.xml"/>')
        if settings:
            archive.writestr(f"word/{settings_name}", f'<w:settings xmlns:w="{WORD}">{settings}</w:settings>')
            if settings_linked:
                relationships.append(f'<Relationship Id="rId2" Type="{SETTINGS}" Target="{settings_name}"/>')
        if relationships:
            archive.writestr("word/_rels/document.xml.rels", f'<Relationships xmlns="{REL}">'
                             + "".join(relationships) + "</Relationships>")


class WordRoundTripTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.paths = [Path(folder.name) / name for name in ("original.docx", "export.docx", "word.docx", "reexport.docx")]
        self.edited = paragraph("1111111A", "<w:r><w:t>Unsaved words became a manuscript edit.</w:t></w:r>")
        self.later = self.edited.replace("Unsaved words", "ROUNDTRIP Unsaved words")
        self.reviewed = paragraph("2222222B", "<w:r><w:t>Accepted review.</w:t></w:r>")
        self.retained = paragraph("3333333C", "<w:r><w:t>Untouched prose.</w:t></w:r>")
        self.word_addin = complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]")
        self.original_text = self.edited.replace("Unsaved words became a manuscript edit", "Original manuscript")
        package(self.paths[0], fields=self.original_text + self.reviewed.replace("Accepted review", "Before review") + self.retained)
        package(self.paths[1], fields=self.edited + self.reviewed + self.retained)
        word_columns = '<w:cols w:num="2" w:space="720"/>'
        package(self.paths[2], fields=self.edited + self.reviewed + self.retained, addon=self.word_addin, columns=word_columns)
        package(self.paths[3], fields=self.later + self.reviewed + self.retained, addon=self.word_addin, columns=word_columns)

    def check(self, edited_ids="1111111A,2222222B", reimport_id="1111111A"):
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--word-round-trip", *map(str, self.paths), edited_ids, reimport_id, "ROUNDTRIP"],
                                 capture_output=True, text=True)
        self.assertIn(process.returncode, (0, 1), process.stderr)
        return process.returncode, json.loads(process.stdout)

    def test_allows_a_word_resave_without_native_citations(self):
        original = self.paths[0].read_bytes()
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (0, []))
        self.assertEqual(report["sha256"]["original"], hashlib.sha256(original).hexdigest())
        self.assertEqual(self.paths[0].read_bytes(), original)
        self.assertNotIn("Unsaved words", json.dumps(report))

    def test_rejects_a_word_resave_that_reverts_manuscript_edits(self):
        package(self.paths[2], fields=self.original_text + self.reviewed + self.retained, addon=self.word_addin)
        package(self.paths[3], fields=self.original_text.replace("Original manuscript", "ROUNDTRIP Original manuscript")
                + self.reviewed + self.retained, addon=self.word_addin)
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (1, ["Word save: main-document prose outside fields changed"]))

    def test_rejects_a_word_resave_that_swaps_fields_with_identical_results(self):
        addon = simple(ADDIN, "[1]")
        unknown = simple("UNKNOWN_EXTENSION other-source", "[1]")
        left = '<w:r><w:t xml:space="preserve">Study A </w:t></w:r>'
        right = '<w:r><w:t xml:space="preserve"> compared with Study B </w:t></w:r>'
        same = left + self.word_addin + right + unknown
        swapped = left + unknown + right + self.word_addin
        package(self.paths[0], fields=self.original_text + self.reviewed.replace("Accepted review", "Before review") + self.retained,
                addon=left + addon + right + unknown)
        package(self.paths[1], fields=self.edited + self.reviewed + self.retained,
                addon=left + addon + right + unknown)
        for fields, issues in (
            (same, []),
            (swapped, ["Word save: non-native fields moved relative to their paragraph text"]),
        ):
            with self.subTest(fields=fields):
                package(self.paths[2], fields=self.edited + self.reviewed + self.retained, addon=fields)
                package(self.paths[3], fields=self.later + self.reviewed + self.retained, addon=fields)
                status, report = self.check()
                self.assertEqual((status, report["issues"]), (int(bool(issues)), issues))

    def test_rejects_unintended_first_export_changes_even_when_preserved_by_word(self):
        for retained, issue in (
            ("", "nonempty main-document paragraph count changed"),
            (self.retained.replace("Untouched prose", "Different prose"), "main-document prose outside the trial paragraphs changed"),
        ):
            with self.subTest(issue=issue):
                package(self.paths[1], fields=self.edited + self.reviewed + retained)
                package(self.paths[2], fields=self.edited + self.reviewed + retained, addon=self.word_addin)
                package(self.paths[3], fields=self.later + self.reviewed + retained, addon=self.word_addin)
                status, report = self.check()
                self.assertEqual((status, report["issues"]), (1, [f"Oleafly export: {issue}"]))

    def test_requires_edits_in_both_named_paragraphs(self):
        before_review = self.reviewed.replace("Accepted review", "Before review")
        package(self.paths[1], fields=self.edited + before_review + self.retained)
        package(self.paths[2], fields=self.edited + before_review + self.retained, addon=self.word_addin)
        package(self.paths[3], fields=self.later + before_review + self.retained, addon=self.word_addin)
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (1, [
            "Oleafly export: expected a text change in each trial paragraph",
        ]))

    def test_rejects_reexport_that_flattens_zotero_and_loses_columns(self):
        package(self.paths[3], fields=self.later + self.reviewed + self.retained,
                addon="<w:r><w:t>[1]</w:t></w:r>", columns='<w:cols w:num="1"/>')
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (1, [
            "Oleafly re-export: non-native fields changed",
            "Oleafly re-export: section column layout changed",
            "Oleafly re-export: expected only the trial prefix in one existing body paragraph",
        ]))

    def test_rejects_a_reexport_with_no_edit_or_an_unrelated_change(self):
        for prose in (self.edited, self.later + paragraph("2222222B", "<w:r><w:t>Extra prose.</w:t></w:r>")):
            with self.subTest(prose=prose):
                package(self.paths[3], fields=prose + self.reviewed + self.retained, addon=self.word_addin)
                status, report = self.check()
                self.assertEqual((status, report["issues"]), (1, [
                    "Oleafly re-export: expected only the trial prefix in one existing body paragraph",
                ]))

    def test_rejects_the_prefix_in_a_different_plain_paragraph(self):
        prefixed = self.retained.replace("Untouched prose", "ROUNDTRIP Untouched prose")
        package(self.paths[3], fields=self.edited + self.reviewed + prefixed, addon=self.word_addin)
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (1, [
            "Oleafly re-export: trial prefix is not in the specified paragraph",
        ]))

    def test_rejects_a_trial_paragraph_inside_a_table(self):
        table = "<w:tbl><w:tr><w:tc>{body}</w:tc></w:tr></w:tbl>"
        package(self.paths[2], fields=table.format(body=self.edited) + self.reviewed + self.retained,
                addon=self.word_addin)
        package(self.paths[3], fields=table.format(body=self.later) + self.reviewed + self.retained,
                addon=self.word_addin)
        status, report = self.check()
        self.assertEqual((status, report["issues"]), (1, [
            "Word save: re-import target must identify one plain, field-free body paragraph",
        ]))


class CitationRoundTripTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.original = Path(folder.name) / "original.docx"
        self.exported = Path(folder.name) / "exported.docx"
        self.saved = Path(folder.name) / "saved.docx"
        self.old_sources = (source("Prior", "10.1234/prior", title="Shared title")
                            + source("Companion", "", OLD_ID, "Shared title")
                            + source("Different", "", OTHER_ID, "Shared title"))
        self.word_sources = (source("PriorRenamed", "10.1234/prior", title="Shared title")
                             + source("CompanionRenamed", "", OLD_ID.strip("{}").lower(), "Shared title")
                             + source("Different", "", OTHER_ID, "Shared title"))
        self.old_single = simple("CITATION Prior", "[2]")
        self.old_group = simple(r'CITATION Prior \m "Companion" \f "See \m here"', "[2, 3]")
        self.old_fields = f"<w:p>{self.old_single}</w:p><w:p>{self.old_group}</w:p><w:p>{self.old_single}</w:p>"
        self.word_single = complex_field([r' CITATION PriorRenamed \l 1033 '], "[1]")
        self.word_group = complex_field([r' CITATION "PriorRenamed" \f "See \m here" ', r'\M "CompanionRenamed" '], "[1, 2]")
        self.word_fields = f"<w:p>{self.word_single}</w:p><w:p>{self.word_group}</w:p><w:p>{self.word_single}</w:p>"
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields)
        self.cached = simple("CITATION Added", f"\u27e6{TITLE}\u27e7")
        self.export_fields = f"<w:p>{self.cached}</w:p><w:p>{self.cached}</w:p>"
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=self.old_fields)
        self.refreshed = complex_field([" CITA", 'TION "Renamed" \\l 1033 '], "(Author, 2024)")
        self.bibliography = complex_field([" BIBLIOGRAPHY "], f"Author (2024). {TITLE}.")

    def check(self, *args, **saved):
        defaults = dict(fields=f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>",
                        sources=self.word_sources + source("Renamed"), existing_fields=self.word_fields,
                        addon=complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]"),
                        columns='<w:cols w:num="2" w:space="720"/>')
        package(self.saved, **(defaults | saved))
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-round-trip",
                                  str(self.original), str(self.exported), str(self.saved), DOI, *args],
                                 capture_output=True, text=True)
        self.assertIn(process.returncode, (0, 1), process.stderr)
        return process.returncode, json.loads(process.stdout)

    def test_accepts_retagged_complex_fields_and_keeps_author_input(self):
        original_bytes = self.original.read_bytes()
        status, report = self.check()
        self.assertEqual((status, report["ok"], report["issues"]), (0, True, []))
        self.assertEqual(self.original.read_bytes(), original_bytes)

    def test_word_refresh_allows_new_fields_but_preserves_the_order_of_adjacent_fields(self):
        zotero = simple(ADDIN, "[1]")
        unknown = simple("UNKNOWN_EXTENSION other-source", "[1]")
        new_field = simple("REF Target", "Target")
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields, addon=zotero + unknown)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=self.old_fields, addon=zotero + unknown)

        for addon, issues in (
            (zotero + new_field + unknown, []),
            (unknown + new_field + zotero, ["Word save: non-native fields moved relative to their paragraph text"]),
        ):
            with self.subTest(addon=addon):
                status, report = self.check(addon=addon)
                self.assertEqual((status, report["issues"]), (int(bool(issues)), issues))

    def test_word_save_rejects_a_non_native_field_moved_between_identical_paragraphs(self):
        prose = '<w:r><w:t xml:space="preserve">Identical visible prose.</w:t></w:r>'
        fielded = paragraph("3333333C", prose + simple(ADDIN, "[1]"))
        plain = paragraph("4444444D", prose)
        moved_fielded = paragraph("3333333C", prose)
        moved_plain = paragraph("4444444D", prose + simple(ADDIN, "[1]"))
        package(self.original, sources=self.old_sources, addon="",
                existing_fields=fielded + plain + self.old_fields)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                addon="", existing_fields=fielded + plain + self.old_fields)

        status, report = self.check(addon="", existing_fields=moved_fielded + moved_plain + self.word_fields)
        self.assertEqual((status, report["issues"]), (1, [
            "Word save: non-native fields moved relative to their paragraph text",
        ]))

    def test_word_save_allows_reissued_paragraph_identities(self):
        prose = '<w:r><w:t xml:space="preserve">Reidentified visible prose.</w:t></w:r>'
        fielded = paragraph("3333333C", prose + simple(ADDIN, "[1]"))
        reidentified = paragraph("AAAAAAAA", prose + simple(ADDIN, "[1]"))
        package(self.original, sources=self.old_sources, addon="",
                existing_fields=fielded + self.old_fields)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                addon="", existing_fields=fielded + self.old_fields)

        status, report = self.check(addon="", existing_fields=reidentified + self.word_fields)
        self.assertEqual((status, report["issues"]), (0, []))

    def test_word_save_checks_reliable_identity_with_unidentified_and_added_fields(self):
        prose = '<w:r><w:t xml:space="preserve">Identical visible prose.</w:t></w:r>'
        fielded = paragraph("3333333C", prose + simple(ADDIN, "[1]"))
        plain = paragraph("4444444D", prose)
        moved_fielded = paragraph("3333333C", prose)
        moved_plain = paragraph("4444444D", prose + simple(ADDIN, "[1]"))
        unidentified = paragraph("", '<w:r><w:t>Unidentified field.</w:t></w:r>'
                                 + simple("UNKNOWN_EXTENSION other-source", "[2]"))
        added = paragraph("", simple("REF Target", "Target"))
        package(self.original, sources=self.old_sources, addon="",
                existing_fields=fielded + plain + unidentified + self.old_fields)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                addon="", existing_fields=fielded + plain + unidentified + self.old_fields)

        status, report = self.check(
            addon="", existing_fields=moved_fielded + moved_plain + unidentified + added + self.word_fields,
        )
        self.assertEqual((status, report["issues"]), (1, [
            "Word save: non-native fields moved relative to their paragraph text",
        ]))

    def test_word_save_rejects_changed_existing_source_metadata(self):
        changed = self.word_sources.replace("Shared title", "Altered title", 1)
        status, report = self.check(sources=changed + source("Renamed"))
        self.assertEqual((status, report["issues"]), (1, [
            "Word save: bibliography source records other than the trial changed",
        ]))

    def test_word_save_preserves_author_citation_options_despite_field_reencoding(self):
        original = self.old_fields.replace(self.old_single, simple(r"CITATION Prior \p 42 \n", "[2, p. 42]"), 1)
        package(self.original, sources=self.old_sources, existing_fields=original)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=original)

        for switches, expected in (
            (r'\N \p "42"', []),
            (r'\N \p 24', ["Word save: pre-existing native citation options changed"]),
            (r'\p "42"', ["Word save: pre-existing native citation options changed"]),
        ):
            with self.subTest(switches=switches):
                citation = complex_field([r' CITATION "PriorRenamed" \l 1033 ', switches, r' \* MERGEFORMAT '], "[1]")
                status, report = self.check(existing_fields=self.word_fields.replace(self.word_single, citation, 1))
                self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))

    def check_export(self, *args):
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-export",
                                  str(self.original), str(self.exported), DOI, *args], capture_output=True, text=True)
        self.assertIn(process.returncode, (0, 1), process.stderr)
        return process.returncode, json.loads(process.stdout)

    def test_named_citation_trial_checks_insertion_and_independent_edits(self):
        ids = "1111111a,2222222b,3333333c"
        left = "<w:r><w:t>Left prose.</w:t></w:r>"
        edit = "<w:r><w:t>Other prose.</w:t></w:r>"
        right = "<w:r><w:t>Right prose.</w:t></w:r>"
        rewritten = left.replace("Left prose", "Accepted suggestion")
        edited = edit.replace("Other prose", "Independent edit")

        def body(left_content, edit_content, right_content):
            return (paragraph("1111111A", left_content) + paragraph("2222222B", edit_content)
                    + paragraph("3333333C", right_content))

        package(self.original, fields=body(left, edit, right), sources=self.old_sources, existing_fields=self.old_fields)
        for content, expected in (
            (body(self.cached + rewritten, edited, self.cached + right), []),
            (body(self.cached + rewritten, self.cached + edited, right),
             ["Oleafly export: trial citations must be in the two specified body paragraphs"]),
            (body(rewritten + self.cached, edited, self.cached + right),
             ["Oleafly export: trial citations must start their specified paragraphs"]),
            (body(self.cached + rewritten, edit, self.cached + right),
             ["Oleafly export: expected a text change in each trial paragraph"]),
            (body(self.cached + rewritten, edited, self.cached + right.replace("Right prose", "Changed prose")),
             ["Oleafly export: main-document prose outside the trial paragraphs changed"]),
        ):
            with self.subTest(issues=expected):
                package(self.exported, fields=content, sources=self.old_sources + source("Added"),
                        existing_fields=self.old_fields)
                status, report = self.check_export(ids)
                self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))
                word_fields = content.replace(self.cached, self.refreshed) + f"<w:p>{self.bibliography}</w:p>"
                status, report = self.check(ids, fields=word_fields)
                self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))

    def check_input(self, *args):
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-input", str(self.original), DOI, *args],
                                 capture_output=True, text=True)
        self.assertIn(process.returncode, (0, 1), process.stderr)
        return process.returncode, json.loads(process.stdout)

    def check_targets(self):
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport-targets",
                                  str(self.saved), DOI], capture_output=True, text=True)
        self.assertIn(process.returncode, (0, 1), process.stderr)
        return process.returncode, json.loads(process.stdout)

    def test_input_preflight_reports_package_facts_without_exposing_text(self):
        original = self.original.read_bytes()
        status, report = self.check_input()
        self.assertEqual(status, 0)
        self.assertEqual(report, {
            "ok": True, "issues": [], "sha256": hashlib.sha256(original).hexdigest(),
            "bodyParagraphs": 4, "existingNativeCitationsInMain": 3,
        })
        self.assertEqual(self.original.read_bytes(), original)

    def test_input_preflight_rejects_unsuitable_manuscript(self):
        unresolved = simple("CITATION Missing", "[2]")
        package(self.original, existing_fields=f"<w:p>{unresolved}</w:p>",
                sources=source("AlreadyUsed"), columns='<w:cols w:num="1"/>')
        status, report = self.check_input()
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "original: 1 native citation field(s) could not be resolved to identified sources",
            "original: trial DOI is already in the bibliography",
            "original: no double-column section",
            "original: no existing resolvable native citations in the main document",
        ]))

    def test_input_preflight_rejects_tracked_revisions_without_restricting_export(self):
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields,
                settings="<w:trackRevisions/>", settings_name="custom-settings.xml")
        original = self.original.read_bytes()
        status, report = self.check_input()
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "original: Word Track Changes is on; citation preview supports only direct, untracked insertions",
        ]))
        self.assertEqual(self.original.read_bytes(), original)
        self.assertEqual(self.check_export(), (0, {
            "ok": True, "issues": [], "doi": DOI.casefold(),
            "sha256": {
                "original": hashlib.sha256(original).hexdigest(),
                "oleafly": hashlib.sha256(self.exported.read_bytes()).hexdigest(),
            },
        }))

        package(self.original, sources=self.old_sources, existing_fields=self.old_fields,
                settings="<w:trackRevisions/>", settings_linked=False)
        self.assertEqual(self.check_input()[0], 1)

        package(self.original, sources=self.old_sources, existing_fields=self.old_fields,
                settings='<w:trackRevisions w:val="false"/>')
        self.assertEqual(self.check_input()[0], 0)

    def test_input_preflight_checks_selected_paragraphs_without_reporting_prose(self):
        left = paragraph("1111111a", '<w:r><w:t>Left column trial prose.</w:t></w:r>')
        edit = paragraph("2222222b", '<w:r><w:t>Independent edit.</w:t></w:r>')
        right = paragraph("3333333c", '<w:r><w:t>Right column trial prose.</w:t></w:r>')
        original_citation = paragraph("4444444d", self.old_single)
        table = f'<w:tbl><w:tr><w:tc>{paragraph("5555555e", "<w:r><w:t>Table prose.</w:t></w:r>")}</w:tc></w:tr></w:tbl>'
        spanning_field = (
            '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText> BIBLIOGRAPHY </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
            + paragraph("6666666f", '<w:r><w:t>Bibliography result text.</w:t></w:r>')
            + '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
        )
        package(self.original, fields=left + edit + right + original_citation + table + spanning_field,
                sources=self.old_sources)
        original = self.original.read_bytes()
        status, report = self.check_input("1111111a,2222222b,3333333c")
        self.assertEqual((status, report["ok"], report["issues"]), (0, True, []))
        self.assertNotIn("Left column trial prose.", json.dumps(report))
        self.assertEqual(self.original.read_bytes(), original)

        for selection, issue in (
            ("1111111a,2222222b,1111111a", "original: supply three distinct paragraph IDs in left,edit,right order"),
            ("1111111a,2222222b,abcdef01", "original: right paragraph ABCDEF01 is not a unique main-document paragraph"),
            ("1111111a,2222222b,5555555e", "original: right paragraph 5555555E is not a plain, field-free body paragraph"),
            ("1111111a,2222222b,6666666f", "original: right paragraph 6666666F is not a plain, field-free body paragraph"),
            ("1111111a,4444444d,3333333c", "original: edit paragraph 4444444D is not a plain, field-free body paragraph"),
        ):
            with self.subTest(selection=selection):
                status, report = self.check_input(selection)
                self.assertEqual((status, report["ok"], report["issues"]), (1, False, [issue]))

        package(self.original, fields=left + edit + right + right + original_citation, sources=self.old_sources)
        status, report = self.check_input("1111111a,2222222b,3333333c")
        self.assertEqual((status, report["issues"]), (1, [
            "original: right paragraph 3333333C is not a unique main-document paragraph",
        ]))

    def test_round_trip_requires_existing_native_citations_but_export_does_not(self):
        package(self.original)
        package(self.exported, fields=self.export_fields, sources=source("Added"))
        self.assertEqual(self.check_export()[0], 0)
        status, report = self.check(sources=source("Renamed"), existing_fields="")
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "original: no existing resolvable native citations in the main document",
        ]))

    def test_export_preflight_requires_two_citations_without_a_word_save(self):
        package(self.exported, fields=f'<w:p>{simple("CITATION Added", TITLE)}</w:p>',
                sources=self.old_sources + source("Added"), existing_fields=self.old_fields)
        status, report = self.check_export()
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "Oleafly export: expected one uniquely tagged source and citations in two paragraphs for the trial DOI",
        ]))

    def test_export_preflight_rejects_a_bibliography_flattened_to_text(self):
        original_bibliography = simple("BIBLIOGRAPHY", "Prior study")
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields,
                fields=f"<w:p>{original_bibliography}</w:p>")
        package(self.exported, sources=self.old_sources + source("Added"), existing_fields=self.old_fields,
                fields=f"<w:p><w:r><w:t>Prior study</w:t></w:r></w:p>{self.export_fields}")
        status, report = self.check_export()
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "Oleafly export: pre-existing bibliography fields lost or changed",
        ]))

    def test_export_preflight_preserves_uncited_sources_and_cited_metadata(self):
        uncited = source("Different", "", OTHER_ID, "Shared title")
        cases = {
            "dropped uncited source": self.old_sources.removesuffix(uncited),
            "changed cited title": self.old_sources.replace("Shared title", "Altered title", 1),
            "duplicated uncited source": self.old_sources + uncited,
        }
        for case, changed_sources in cases.items():
            with self.subTest(case=case):
                package(self.exported, fields=self.export_fields, sources=changed_sources + source("Added"),
                        existing_fields=self.old_fields)
                status, report = self.check_export()
                self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
                    "Oleafly export: bibliography source records other than the trial changed",
                ]))

    def test_export_preflight_rejects_changed_non_native_field_results(self):
        for instruction in (ADDIN, "UNKNOWN_EXTENSION custom-payload"):
            with self.subTest(instruction=instruction):
                package(self.original, addon=simple(instruction, "[1]"),
                        sources=self.old_sources, existing_fields=self.old_fields)
                package(self.exported, addon=simple(instruction, ""),
                        fields=self.export_fields, sources=self.old_sources + source("Added"),
                        existing_fields=self.old_fields)
                status, report = self.check_export()
                self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
                    "Oleafly export: pre-existing non-native fields moved or changed",
                ]))

    def test_export_preflight_rejects_lost_field_payload_or_lock(self):
        endnote = complex_field([" ADDIN EN.CITE "], "[1]").replace(
            '<w:fldChar w:fldCharType="begin"/>',
            '<w:fldChar w:fldCharType="begin" w:fldLock="1"><w:fldData>cGF5bG9hZA==</w:fldData></w:fldChar>',
        )
        legacy_form = complex_field([" FORMTEXT "], "Sample").replace(
            '<w:fldChar w:fldCharType="begin"/>',
            '<w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="InputA"/></w:ffData></w:fldChar>',
        )
        locked_simple = simple("UNKNOWN_EXTENSION custom-payload", "Result").replace(
            "<w:fldSimple ", '<w:fldSimple w:fldLock="1" ',
        )
        for original, removed in (
            (endnote, "<w:fldData>cGF5bG9hZA==</w:fldData>"),
            (legacy_form, '<w:ffData><w:name w:val="InputA"/></w:ffData>'),
            (locked_simple, ' w:fldLock="1"'),
        ):
            with self.subTest(removed=removed):
                package(self.original, addon=original, sources=self.old_sources, existing_fields=self.old_fields)
                package(self.exported, addon=original.replace(removed, ""), fields=self.export_fields,
                        sources=self.old_sources + source("Added"), existing_fields=self.old_fields)
                status, report = self.check_export()
                self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
                    "Oleafly export: pre-existing field locks or auxiliary data changed",
                ]))

    def test_word_save_allows_reencoding_a_field_but_not_losing_its_payload(self):
        instruction = "ADDIN EN.CITE"
        payload = "<w:fldData>cGF5bG9hZA==</w:fldData>"
        addon = simple(instruction, "[1]").replace("<w:r>", payload + "<w:r>", 1)
        package(self.original, addon=addon, sources=self.old_sources, existing_fields=self.old_fields)
        package(self.exported, addon=addon, fields=self.export_fields,
                sources=self.old_sources + source("Added"), existing_fields=self.old_fields)
        field = complex_field([instruction], "[3]")
        with_payload = field.replace('<w:fldChar w:fldCharType="begin"/>',
                                     f'<w:fldChar w:fldCharType="begin">{payload}</w:fldChar>')
        status, report = self.check(addon=with_payload)
        self.assertEqual((status, report["ok"], report["issues"]), (0, True, []))
        status, report = self.check(addon=field)
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "Word save: pre-existing field locks or auxiliary data changed",
        ]))

    def test_export_preflight_rejects_a_non_native_field_moved_to_another_paragraph(self):
        package(self.original, sources=self.old_sources, existing_fields=f"<w:p/>{self.old_fields}")
        package(self.exported, addon="", fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=f'<w:p>{simple(ADDIN, "[1]")}</w:p>{self.old_fields}')
        status, report = self.check_export()
        self.assertEqual((status, report["ok"], report["issues"]), (1, False, [
            "Oleafly export: pre-existing non-native fields moved or changed",
        ]))

    def test_export_preflight_preserves_non_native_field_positions_in_unchanged_prose(self):
        before = '<w:r><w:t xml:space="preserve">Prior work </w:t></w:r>'
        after = '<w:r><w:t xml:space="preserve"> used a different sample.</w:t></w:r>'
        for field in (complex_field([ADDIN], "[1]"), simple("UNKNOWN_EXTENSION custom-payload", "Result")):
            package(self.original, addon=before + field + after, sources=self.old_sources,
                    existing_fields=self.old_fields)
            misplaced = ["Oleafly export: pre-existing non-native fields moved within unchanged paragraph text"]
            for case, addon, fields, expected in (
                ("moved", before + after + field, self.export_fields, misplaced),
                ("added citation before field", before + self.cached + field + after, f"<w:p>{self.cached}</w:p>", []),
                ("rewritten prose", before.replace("Prior work", "A related study") + field + after, self.export_fields, []),
            ):
                with self.subTest(case=case, field=field):
                    package(self.exported, addon=addon, fields=fields, sources=self.old_sources + source("Added"),
                            existing_fields=self.old_fields)
                    status, report = self.check_export()
                    self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))

    def test_export_preflight_allows_inserting_before_a_preserved_non_native_field(self):
        locked = simple(ADDIN, "[1]").replace("<w:fldSimple ", '<w:fldSimple w:fldLock="1" ')
        package(self.original, addon=locked, sources=self.old_sources, existing_fields=self.old_fields)
        package(self.exported, addon=self.cached + locked,
                fields=f"<w:p>{self.cached}</w:p>",
                sources=self.old_sources + source("Added"), existing_fields=self.old_fields)
        status, report = self.check_export()
        self.assertEqual((status, report["ok"], report["issues"]), (0, True, []))

    def test_export_can_insert_before_an_existing_native_field_but_cannot_change_it(self):
        preserved = simple(r"CITATION Prior \p 42", "[2, p. 42]")
        package(self.original, sources=self.old_sources, existing_fields=f"<w:p>{preserved}</w:p>")
        for field in (preserved, preserved.replace(r"\p 42", r"\p 24"), preserved.replace("[2, p. 42]", "[2]")):
            with self.subTest(field=field):
                package(self.exported, existing_fields=f"<w:p>{self.cached}{field}</w:p>",
                        fields=f"<w:p>{self.cached}</w:p>", sources=self.old_sources + source("Added"))
                status, report = self.check_export()
                expected = [] if field == preserved else ["Oleafly export: pre-existing native field details or cached results changed"]
                self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))

    def test_export_preflight_rejects_changes_to_existing_bibliography_cache(self):
        bibliography = f'<w:p>{simple("BIBLIOGRAPHY", "Prior (2023). Shared title.")}</w:p>'
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields, fields=bibliography)
        package(self.exported, sources=self.old_sources + source("Added"), existing_fields=self.old_fields,
                fields=bibliography.replace("Shared title", "Other title") + self.export_fields)
        status, report = self.check_export()
        self.assertEqual((status, report["issues"]), (1, [
            "Oleafly export: pre-existing native field details or cached results changed",
        ]))

    def test_rejects_one_exported_citation_without_the_product_placeholder(self):
        carried_over = simple("CITATION Added", "(Cached author, 2023)")
        package(self.exported, fields=f"<w:p>{self.cached}</w:p><w:p>{carried_over}</w:p>",
                sources=self.old_sources + source("Added"), existing_fields=self.old_fields)
        unchanged = carried_over.replace("Added", "Renamed")
        status, report = self.check(fields=(f"<w:p>{self.refreshed}</w:p><w:p>{unchanged}</w:p>"
                                            f"<w:p>{self.bibliography}</w:p>"))
        issue = "Oleafly export: expected the trial title placeholder in both citation results"
        self.assertEqual((status, report["issues"]), (1, [issue]))
        status, report = self.check_export()
        self.assertEqual((status, report["issues"]), (1, [issue]))

    def test_accepts_a_trial_title_added_to_an_existing_bibliography(self):
        old = f'<w:p>{simple("BIBLIOGRAPHY", "Prior (2023). Shared title.")}</w:p>'
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields, fields=old)
        package(self.exported, sources=self.old_sources + source("Added"), existing_fields=self.old_fields,
                fields=old + self.export_fields)
        updated = complex_field([" BIBLIOGRAPHY "], f"Prior (2023). Shared title. Author (2024). {TITLE}.")
        status, report = self.check(fields=(f"<w:p>{updated}</w:p><w:p>{self.refreshed}</w:p>"
                                            f"<w:p>{self.refreshed}</w:p>"))
        self.assertEqual((status, report["issues"]), (0, []))

    def test_rejects_a_trial_title_already_in_the_exported_bibliography_cache(self):
        stale = f'<w:p>{simple("BIBLIOGRAPHY", f"Prior (2023). {TITLE.upper()}.")}</w:p>'
        package(self.exported, sources=self.old_sources + source("Added"), existing_fields=self.old_fields,
                fields=stale + self.export_fields)
        status, report = self.check(fields=f"{stale}<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p>")
        self.assertEqual(status, 1)
        self.assertEqual(report["issues"], [
            "Oleafly export: cannot verify a new bibliography entry because the trial title already "
            "occurs in an existing source title or bibliography cache; choose a distinguishable trial DOI",
            "Oleafly export: pre-existing native field details or cached results changed",
        ])

    def test_rejects_a_trial_title_indistinguishable_from_a_preexisting_source(self):
        old_sources = self.old_sources.replace("Shared title", "The  Example STUDY", 1)
        word_sources = self.word_sources.replace("Shared title", "The  Example STUDY", 1)
        package(self.original, sources=old_sources, existing_fields=self.old_fields)
        package(self.exported, sources=old_sources + source("Added"), existing_fields=self.old_fields,
                fields=self.export_fields)
        old_only = complex_field([" BIBLIOGRAPHY "], f"Prior (2023). {TITLE}.")
        status, report = self.check(sources=word_sources + source("Renamed"), fields=(
            f"<w:p>{old_only}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p>"
        ))
        self.assertEqual(status, 1)
        self.assertEqual(len(report["issues"]), 1)
        self.assertIn("choose a distinguishable trial DOI", report["issues"][0])

    def test_rejects_duplicate_or_unlinked_sources(self):
        for options in ({"sources": self.word_sources + source("Renamed") + source("Copy")}, {"linked": False}):
            with self.subTest(options=options):
                status, report = self.check(**options)
                self.assertEqual(status, 1)
                self.assertIn("Word save: expected one uniquely tagged source and citations in two paragraphs for the trial DOI", report["issues"])

    def test_rejects_losing_one_occurrence_in_the_export(self):
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=f"<w:p>{self.old_single}</w:p><w:p>{self.old_group}</w:p>")
        status, report = self.check()
        self.assertEqual(status, 1)
        self.assertIn("Oleafly export: pre-existing native citation sources or occurrence counts changed", report["issues"])

    def test_rejects_dropping_or_retargeting_a_second_source(self):
        for instruction in ("CITATION PriorRenamed", r"CITATION PriorRenamed \m Different"):
            with self.subTest(instruction=instruction):
                status, report = self.check(existing_fields=self.word_fields.replace(
                    self.word_group, simple(instruction, "[1, 2]"),
                ))
                self.assertEqual(status, 1)
                self.assertIn("Word save: pre-existing native citation sources or occurrence counts changed", report["issues"])

    def test_rejects_reassigning_a_tag_without_changing_field_instructions(self):
        swapped = self.word_sources.replace(OLD_ID.strip("{}").lower(), OTHER_ID, 1)
        status, report = self.check(sources=swapped + source("Renamed"))
        self.assertEqual(status, 1)
        self.assertIn("Word save: pre-existing native citation sources or occurrence counts changed", report["issues"])

    def test_rejects_swapping_old_citations_between_paragraphs(self):
        swapped = f"<w:p>{self.word_group}</w:p><w:p>{self.word_single}</w:p><w:p>{self.word_single}</w:p>"
        status, report = self.check(existing_fields=swapped)
        self.assertEqual(status, 1)
        self.assertIn("Word save: pre-existing native citations changed order or paragraph grouping", report["issues"])

    def test_rejects_merging_old_citations_into_one_paragraph(self):
        merged = f"<w:p>{self.word_single}{self.word_group}</w:p><w:p/><w:p>{self.word_single}</w:p>"
        status, report = self.check(existing_fields=merged)
        self.assertEqual(status, 1)
        self.assertIn("Word save: pre-existing native citations changed order or paragraph grouping", report["issues"])

    def test_rejects_moving_an_old_citation_to_another_paragraph_in_the_export(self):
        relocated = self.old_fields.replace(f"<w:p>{self.old_group}</w:p>", f"<w:p/><w:p>{self.old_group}</w:p>")
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=relocated)
        status, report = self.check()
        self.assertEqual(status, 1)
        self.assertIn("Oleafly export: pre-existing native citations moved to different paragraphs or changed order", report["issues"])

    def test_export_preflight_checks_citation_positions_in_unchanged_prose(self):
        claim = '<w:r><w:t xml:space="preserve">Earlier studies agree </w:t></w:r>'
        split_claim = ('<w:r><w:t xml:space="preserve">Earlier studies </w:t></w:r>'
                       '<w:r><w:t xml:space="preserve">agree </w:t></w:r>')
        qualifier = '<w:r><w:t xml:space="preserve"> with the measurements.</w:t></w:r>'
        original = self.old_fields.replace(self.old_group, claim + self.old_group + qualifier)
        package(self.original, sources=self.old_sources, existing_fields=original)

        moved = original.replace(claim + self.old_group + qualifier, split_claim + qualifier + self.old_group)
        revised = '<w:r><w:t xml:space="preserve">Prior results concur </w:t></w:r>'
        misplaced = ["Oleafly export: pre-existing native citations moved within unchanged paragraph text"]
        for case, fields, expected in (
            ("split run", original.replace(claim, split_claim), []),
            ("moved citation", moved, misplaced),
            ("revised prose", original.replace(claim, revised), []),
            ("revised prose elsewhere", moved.replace(self.old_single, revised + self.old_single, 1), misplaced),
        ):
            with self.subTest(case=case):
                package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                        existing_fields=fields)
                status, report = self.check_export()
                self.assertEqual((status, report["issues"]), (int(bool(expected)), expected))

    def test_allows_paragraph_number_changes_in_the_word_save(self):
        shifted = self.word_fields.replace(f"<w:p>{self.word_group}", "<w:p/>" * 7 + f"<w:p>{self.word_group}")
        status, report = self.check(existing_fields=shifted)
        self.assertEqual((status, report["ok"], report["issues"]), (0, True, []))

    def test_word_save_keeps_the_edit_in_a_paragraph_without_citations(self):
        edited = paragraph("5C111111", '<w:r><w:t>Corrected sample size.</w:t></w:r>')
        reverted = edited.replace("Corrected", "Original")
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields + reverted)
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=self.old_fields + edited)

        field_end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        bibliography = (f'<w:p>{self.bibliography.removesuffix(field_end)}</w:p>'
                        '<w:p><w:r><w:t>Another bibliography entry.</w:t></w:r>'
                        f'{field_end}</w:p>')
        refreshed = f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p>"
        word_edit = ('<w:p><w:r><w:t xml:space="preserve">Corrected </w:t></w:r>'
                     '<w:r><w:t>sample size.</w:t></w:r></w:p>')
        self.assertEqual(self.check(fields=bibliography + word_edit + refreshed)[0], 0)

        status, report = self.check(fields=bibliography + reverted + refreshed)
        self.assertEqual((status, report["issues"]), (1, ["Word save: main-document prose outside fields changed"]))
        self.assertNotIn("sample size", json.dumps(report))

    def test_word_save_keeps_existing_citations_beside_the_same_prose(self):
        claim = '<w:r><w:t xml:space="preserve">Earlier studies agree </w:t></w:r>'
        qualifier = '<w:r><w:t> with the measurements.</w:t></w:r>'
        old = self.old_fields.replace(self.old_group, claim + self.old_group + qualifier)
        package(self.original, sources=self.old_sources, existing_fields=old.replace("Earlier studies agree", "Prior results agree"))
        package(self.exported, fields=self.export_fields, sources=self.old_sources + source("Added"),
                existing_fields=old)
        split_claim = ('<w:r><w:t xml:space="preserve">Earlier studies </w:t></w:r>'
                       '<w:r><w:t xml:space="preserve">agree </w:t></w:r>')
        restored = self.word_fields.replace(self.word_group, split_claim + self.word_group + qualifier)
        self.assertEqual(self.check(existing_fields="<w:p/>" + restored)[0], 0)

        moved = self.word_fields.replace(self.word_group, split_claim + qualifier + self.word_group)
        status, report = self.check(existing_fields=moved)
        self.assertEqual((status, report["issues"]), (
            1, ["Word save: pre-existing native citations moved relative to their paragraph text"],
        ))

    def test_does_not_claim_preservation_when_original_citation_cannot_be_resolved(self):
        unresolved = simple(r"CITATION Prior \m Missing", "[2, 3]")
        package(self.original, sources=self.old_sources, existing_fields=f"<w:p>{unresolved}</w:p>")
        status, report = self.check()
        self.assertEqual(status, 1)
        self.assertIn("original: 1 native citation field(s) could not be resolved to identified sources", report["issues"])

    def test_reports_two_citations_in_the_same_paragraph(self):
        status, report = self.check(fields=f"<w:p>{self.refreshed}{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>")
        self.assertEqual(status, 1)
        self.assertIn("Word save: expected one uniquely tagged source and citations in two paragraphs for the trial DOI", report["issues"])

    def test_word_save_preserves_trial_citations_in_their_prose(self):
        def paragraph(before, field, after):
            return (f'<w:p><w:r><w:t xml:space="preserve">{before}</w:t></w:r>{field}'
                    f'<w:r><w:t xml:space="preserve">{after}</w:t></w:r></w:p>')

        first = paragraph("Methods were validated ", self.cached, " on a separate sample.").replace(
            "</w:p>", self.old_single + "</w:p>",
        )
        second = paragraph("Results agree ", self.cached, " with prior work.")
        unrelated = paragraph("A sensitivity test excluded short trials.", "", "")
        package(self.exported, sources=self.old_sources + source("Added"), existing_fields=self.old_fields,
                fields=first + second + unrelated)
        updated_first = first.replace(self.cached, self.refreshed).replace(self.old_single, self.word_single)
        updated_first = updated_first.replace("Methods were validated ",
                                              'Methods were </w:t></w:r><w:r><w:t xml:space="preserve">validated ')
        updated_second = second.replace(self.cached, self.refreshed)
        bibliography = f"<w:p>{self.bibliography}</w:p>"

        old = f"<w:p>{self.old_single}</w:p>"
        package(self.original, sources=self.old_sources, existing_fields=self.old_fields + old)
        moved_to_another_paragraph = (updated_first.replace(self.refreshed, "") + updated_second
                                      + unrelated.replace("</w:p>", self.refreshed + "</w:p>"))
        moved_within_paragraph = (paragraph("Methods were validated  on a separate sample.", self.refreshed, "")
                                  .replace("</w:p>", self.word_single + "</w:p>") + updated_second + unrelated)
        status, report = self.check(fields=bibliography + updated_first + updated_second + unrelated)
        self.assertEqual((status, report["issues"]), (0, []))

        for location, wrong_place in (("another paragraph", moved_to_another_paragraph),
                                      ("later in the same paragraph", moved_within_paragraph)):
            with self.subTest(location=location):
                status, report = self.check(fields=bibliography + wrong_place)
                self.assertEqual((status, report["issues"]), (
                    1, ["Word save: trial citations moved relative to their paragraph text"],
                ))

    def test_reports_unrefreshed_results_and_lost_manuscript_objects(self):
        cached = simple("CITATION Renamed", f"\u27e6{TITLE}\u27e7")
        status, report = self.check(
            fields=f'<w:p>{cached}</w:p><w:p>{self.refreshed}</w:p><w:p>{simple("BIBLIOGRAPHY", "Unrelated study")}</w:p>',
            addon="", bookmark_end=False, columns='<w:cols w:num="2" w:space="900"/>',
        )
        self.assertEqual(status, 1)
        self.assertEqual(set(report["issues"]), {
            "Word save: citation results have not been refreshed",
            "Word save: expected the trial source title once in native bibliography results",
            "Word save: pre-existing non-native field instructions lost or changed",
            "Word save: pre-existing named bookmarks lost",
            "Word save: section column layout changed",
        })

    def test_reimport_allows_body_edits_but_not_changes_to_refreshed_fields(self):
        body = paragraph("3333333A", "<w:r><w:t>Body before re-import.</w:t></w:r>")
        edited = body.replace("Body before", "ROUNDTRIP Body before")
        trial = f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>"
        self.check(fields=trial + body)
        saved = self.saved.read_bytes()
        reexport = self.saved.with_name("reexport.docx")
        for case, citations, bibliography in (
            ("body edit", self.refreshed, self.bibliography),
            ("citation result replaced", self.refreshed.replace("(Author, 2024)", "[1]"), self.bibliography),
            ("bibliography lost", self.refreshed, ""),
        ):
            with self.subTest(case=case):
                package(reexport, fields=(f"<w:p>{citations}</w:p><w:p>{self.refreshed}</w:p>"
                                          f"<w:p>{bibliography}</w:p>{edited}"),
                        sources=self.word_sources + source("Renamed"), existing_fields=self.word_fields,
                        addon=complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]"))
                process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport",
                                          str(self.saved), str(reexport), DOI, "3333333A", "ROUNDTRIP"],
                                         capture_output=True, text=True)
                expected = [] if case == "body edit" else ["Oleafly re-export: native citation or bibliography fields changed"]
                self.assertEqual(process.returncode, int(bool(expected)), process.stderr)
                self.assertEqual(json.loads(process.stdout)["issues"], expected)
        self.assertEqual(self.saved.read_bytes(), saved)

    def test_reimport_rejects_missing_or_unrelated_prose_changes(self):
        trial = f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>"
        body = paragraph("3333333A", "<w:r><w:t>Body that remains editable.</w:t></w:r>")
        other = paragraph("4444444B", "<w:r><w:t>Unrelated manuscript text.</w:t></w:r>")
        edited = body.replace("Body that", "ROUNDTRIP Body that")
        self.check(fields=trial + body + other)
        reexport = self.saved.with_name("reexport.docx")
        only_prefix = "Oleafly re-export: expected only the trial prefix in one existing body paragraph"
        for case, prose, expected in (
            ("single prefix", edited + other, []),
            ("missing edit", body + other, [only_prefix]),
            ("lost unrelated paragraph", edited, [only_prefix]),
            ("rewritten unrelated paragraph", edited + other.replace("Unrelated", "Altered"), [only_prefix]),
            ("wrong paragraph", body + other.replace("Unrelated", "ROUNDTRIP Unrelated"),
             ["Oleafly re-export: trial prefix is not in the specified paragraph"]),
        ):
            with self.subTest(case=case):
                package(reexport, fields=trial + prose, sources=self.word_sources + source("Renamed"),
                        existing_fields=self.word_fields,
                        addon=complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]"))
                process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport",
                                          str(self.saved), str(reexport), DOI, "3333333A", "ROUNDTRIP"],
                                         capture_output=True, text=True)
                self.assertEqual(process.returncode, int(bool(expected)), process.stderr)
                self.assertEqual(json.loads(process.stdout)["issues"], expected)

    def test_reimport_rejects_a_trial_paragraph_inside_a_table(self):
        trial = f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>"
        body = paragraph("3333333A", "<w:r><w:t>Table prose.</w:t></w:r>")
        table = f"<w:tbl><w:tr><w:tc>{body}</w:tc></w:tr></w:tbl>"
        self.check(fields=trial + table)
        reexport = self.saved.with_name("reexport.docx")
        package(reexport, fields=trial + table.replace("Table prose", "ROUNDTRIP Table prose"),
                sources=self.word_sources + source("Renamed"), existing_fields=self.word_fields,
                addon=complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]"))
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport",
                                  str(self.saved), str(reexport), DOI, "3333333A", "ROUNDTRIP"],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(json.loads(process.stdout)["issues"], [
            "Word save: re-import target must identify one plain, field-free body paragraph",
        ])

    def test_reimport_keeps_new_and_existing_citations_beside_the_same_prose(self):
        before = '<w:r><w:t xml:space="preserve">Earlier work </w:t></w:r>'
        after = '<w:r><w:t xml:space="preserve"> estimated the effect.</w:t></w:r>'
        trial = f"<w:p>{before}{self.refreshed}{after}</w:p>"
        existing = self.word_fields.replace(self.word_single, before + self.word_single + after, 1)
        tail = f"<w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>"
        body = paragraph("3333333A", "<w:r><w:t>Body before re-import.</w:t></w:r>")
        edited = body.replace("Body before", "ROUNDTRIP Body before")
        self.check(fields=trial + tail + body, existing_fields=existing)
        reexport = self.saved.with_name("reexport.docx")
        for case, fields, old_fields, expected in (
            ("split run", trial.replace("Earlier work ", 'Earlier </w:t></w:r><w:r><w:t xml:space="preserve">work '),
             existing, []),
            ("trial moved", f"<w:p>{before}{after}{self.refreshed}</w:p>", existing,
             ["Oleafly re-export: trial citations moved relative to their paragraph text"]),
            ("existing moved", trial, existing.replace(before + self.word_single + after, before + after + self.word_single, 1),
             ["Oleafly re-export: pre-existing native citations moved relative to their paragraph text"]),
        ):
            with self.subTest(case=case):
                package(reexport, fields=fields + tail + edited, existing_fields=old_fields,
                        sources=self.word_sources + source("Renamed"),
                        addon=complex_field([" ADDIN ZOTERO_ITEM ", "CSL_CITATION {} "], "[1]"))
                process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport",
                                          str(self.saved), str(reexport), DOI, "3333333A", "ROUNDTRIP"],
                                         capture_output=True, text=True)
                self.assertEqual(json.loads(process.stdout)["issues"], expected)
                self.assertEqual(process.returncode, int(bool(expected)), process.stderr)

    def test_reimport_rejects_a_non_native_field_moved_within_a_paragraph(self):
        before = '<w:r><w:t xml:space="preserve">Prior work </w:t></w:r>'
        after = '<w:r><w:t xml:space="preserve"> used a different sample.</w:t></w:r>'
        field = complex_field([ADDIN], "[1]")
        trial = f"<w:p>{self.refreshed}</w:p><w:p>{self.refreshed}</w:p><w:p>{self.bibliography}</w:p>"
        body = paragraph("3333333A", "<w:r><w:t>Body before re-import.</w:t></w:r>")
        edited = body.replace("Body before", "ROUNDTRIP Body before")
        self.check(fields=trial + body, addon=before + field + after)
        reexport = self.saved.with_name("reexport.docx")
        package(reexport, fields=trial + edited, sources=self.word_sources + source("Renamed"),
                existing_fields=self.word_fields, addon=before + after + field)
        process = subprocess.run([sys.executable, "-B", str(CHECK), "--citation-reimport",
                                  str(self.saved), str(reexport), DOI, "3333333A", "ROUNDTRIP"],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(json.loads(process.stdout)["issues"], [
            "Oleafly re-export: non-native fields moved within unchanged paragraph text",
        ])

    def test_reimport_targets_use_field_identity_and_a_plain_edit_paragraph(self):
        first_instruction = r"CITATION Renamed \l 1033"
        second_instruction = r'CITATION "Renamed" \p 42'
        first = paragraph(
            "3333333a",
            complex_field([" CITATION Renamed ", r"\l 1033 "], "(Author, 2024)")
            + simple(r"CITATION PriorRenamed \p 9", "(Author, 2024)"),
        )
        second = paragraph(
            "4444444b",
            complex_field([r' CITATION "Renamed" \p 42 '], "(Author, 2024)")
            + simple(ADDIN, "(Author, 2024)"),
        )
        heading = paragraph(
            "11111111", '<w:r><w:t>Section heading</w:t></w:r>',
            '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>',
        )
        cross_field = (
            '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>'
            '<w:p w14:paraId="22222222"><w:r><w:t>Covered by a field.</w:t></w:r></w:p>'
            '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
        )
        field_only = paragraph("66666666", simple("UNKNOWN_EXTENSION payload", "Sample"))
        edit = paragraph("5555555c", '<w:r><w:t>Editable ordinary prose.</w:t></w:r>')
        bibliography = paragraph("77777777", self.bibliography)
        package(self.saved, fields=heading + cross_field + first + second + field_only + edit + bibliography,
                sources=self.word_sources + source("Renamed"), existing_fields="", addon="")
        original = self.saved.read_bytes()

        status, report = self.check_targets()
        self.assertEqual(status, 0)
        self.assertEqual(report, {
            "ok": True, "issues": [], "doi": DOI.casefold(),
            "sha256": hashlib.sha256(original).hexdigest(),
            "citations": [
                {"paraId": "3333333A", "instruction": first_instruction},
                {"paraId": "4444444B", "instruction": second_instruction},
            ],
            "editParaId": "5555555C",
        })
        self.assertNotIn("Editable ordinary prose.", json.dumps(report))
        self.assertNotIn("(Author, 2024)", json.dumps(report))
        self.assertEqual(self.saved.read_bytes(), original)

    def test_reimport_targets_reject_missing_or_duplicate_paragraph_identities(self):
        citation = complex_field([" CITATION Renamed "], "(Author, 2024)")
        bibliography = paragraph("77777777", self.bibliography)
        edit = paragraph("55555555", '<w:r><w:t>Editable ordinary prose.</w:t></w:r>')
        role_heading = paragraph(
            "11111111", '<w:r><w:t>Section heading</w:t></w:r>',
            '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>',
        )
        cases = {
            "missing citation identity": (
                None, "44444444", role_heading, edit,
                ["Word save: expected two distinct body citation paragraphs with unique w14:paraId values"],
                [], "55555555",
            ),
            "duplicate citation identity": (
                "33333333", "33333333", role_heading, edit,
                ["Word save: expected two distinct body citation paragraphs with unique w14:paraId values"],
                [], "55555555",
            ),
            "duplicate edit identity": (
                "33333333", "44444444", edit, edit,
                ["Word save: expected a distinct editable body paragraph with a unique w14:paraId"],
                [
                    {"paraId": "33333333", "instruction": "CITATION Renamed"},
                    {"paraId": "44444444", "instruction": "CITATION Renamed"},
                ], None,
            ),
        }
        for case, (first_id, second_id, heading, edit_paragraph, issues, citations, edit_para_id) in cases.items():
            with self.subTest(case=case):
                package(self.saved, fields=(heading + paragraph(first_id, citation)
                                            + paragraph(second_id, citation) + edit_paragraph + bibliography),
                        sources=self.word_sources + source("Renamed"), existing_fields="", addon="")
                original = self.saved.read_bytes()
                status, report = self.check_targets()
                self.assertEqual(status, 1)
                self.assertEqual((report["ok"], report["issues"]), (False, issues))
                self.assertEqual(report["citations"], citations)
                self.assertEqual(report["editParaId"], edit_para_id)
                self.assertEqual(report["sha256"], hashlib.sha256(original).hexdigest())
                self.assertEqual(self.saved.read_bytes(), original)

    def test_reimport_targets_apply_the_existing_input_checks(self):
        cached = complex_field([" CITATION Renamed "], f"\u27e6{TITLE}\u27e7")
        fields = (paragraph("33333333", cached) + paragraph("44444444", cached)
                  + paragraph("55555555", '<w:r><w:t>Editable ordinary prose.</w:t></w:r>')
                  + paragraph("77777777", self.bibliography))
        package(self.saved, fields=fields, sources=self.word_sources + source("Renamed"),
                existing_fields="", addon="")
        status, report = self.check_targets()
        self.assertEqual(status, 1)
        self.assertEqual(report["issues"], [
            "Word save: expected refreshed citations and a native bibliography",
        ])
        self.assertEqual([citation["paraId"] for citation in report["citations"]],
                         ["33333333", "44444444"])
        self.assertEqual(report["editParaId"], "55555555")


if __name__ == "__main__":
    unittest.main()
