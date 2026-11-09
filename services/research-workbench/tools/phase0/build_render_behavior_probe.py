import argparse
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph

from research_file_workbench.common.filesystem import (
    require_no_reparse_points,
    require_owned_output,
)
from research_file_workbench.common.json_io import load_json_object

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = (
    PROJECT_ROOT / "tests" / "fixtures" / "render-behavior" / "wps-render-behavior-probe.docx"
)


def add_cached_page_field(paragraph: Paragraph) -> None:
    paragraph.add_run("RFW-FX-RB-PAGE-FIELD-BEGIN-001 ")
    begin_run = OxmlElement("w:r")
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin_run.append(begin)

    instruction_run = OxmlElement("w:r")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    instruction_run.append(instruction)

    separate_run = OxmlElement("w:r")
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    separate_run.append(separate)

    result_run = OxmlElement("w:r")
    result = OxmlElement("w:t")
    result.text = "999"
    result_run.append(result)

    end_run = OxmlElement("w:r")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run.append(end)

    paragraph._p.extend([begin_run, instruction_run, separate_run, result_run, end_run])
    paragraph.add_run(" RFW-FX-RB-PAGE-FIELD-END-001")


def add_revision_probe(paragraph: Paragraph) -> None:
    paragraph.add_run("RFW-FX-RB-REVISION-BEGIN-001 ")

    deletion = OxmlElement("w:del")
    deletion.set(qn("w:id"), "901")
    deletion.set(qn("w:author"), "RFW Fixture")
    deletion.set(qn("w:date"), "2026-09-24T00:00:00Z")
    deleted_run = OxmlElement("w:r")
    deleted_text = OxmlElement("w:delText")
    deleted_text.text = "RFW-FX-RB-DELETED-001"
    deleted_run.append(deleted_text)
    deletion.append(deleted_run)

    insertion = OxmlElement("w:ins")
    insertion.set(qn("w:id"), "902")
    insertion.set(qn("w:author"), "RFW Fixture")
    insertion.set(qn("w:date"), "2026-09-24T00:00:00Z")
    inserted_run = OxmlElement("w:r")
    inserted_text = OxmlElement("w:t")
    inserted_text.text = "RFW-FX-RB-INSERTED-001"
    inserted_run.append(inserted_text)
    insertion.append(inserted_run)

    paragraph._p.extend([deletion, insertion])
    paragraph.add_run(" RFW-FX-RB-REVISION-END-001")


def add_hidden_text_probe(paragraph: Paragraph) -> None:
    paragraph.add_run("RFW-FX-RB-HIDDEN-BEGIN-001 ")
    run = paragraph.add_run("RFW-FX-RB-HIDDEN-TEXT-001")
    vanish = OxmlElement("w:vanish")
    run._r.get_or_add_rPr().append(vanish)
    paragraph.add_run(" RFW-FX-RB-HIDDEN-END-001")


def build_probe(output_path: Path) -> Path:
    """Create a new operator-selected probe without replacing a retained input."""
    require_no_reparse_points(output_path)
    catalog_path = PROJECT_ROOT / "contracts/phase0/source-catalog.json"
    forbidden: tuple[Path, ...] = ()
    if catalog_path.exists():
        require_no_reparse_points(catalog_path)
        author_root = load_json_object(catalog_path).get("author_workspace_root")
        if not isinstance(author_root, str) or not Path(author_root).is_absolute():
            raise ValueError("Source catalog must declare an absolute author workspace")
        forbidden = (Path(author_root),)
    require_owned_output(output_path, (output_path.parent,), forbidden)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    document = Document()
    document.core_properties.title = "RFW WPS render behavior probe"
    document.core_properties.created = datetime(2026, 9, 24, tzinfo=UTC)
    document.add_heading("RFW Render Behavior Probe", level=0)
    document.add_paragraph(
        "This controlled document observes WPS PDF export behavior. "
        "It is not a production parser input."
    )
    add_cached_page_field(document.add_paragraph())
    add_revision_probe(document.add_paragraph())
    add_hidden_text_probe(document.add_paragraph())
    with TemporaryDirectory(prefix=".render-probe-", dir=output_path.parent) as temporary:
        staged = Path(temporary) / "probe.docx"
        document.save(str(staged))
        require_owned_output(output_path, (output_path.parent,), forbidden)
        with output_path.open("xb") as output:
            output.write(staged.read_bytes())
    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a fresh WPS render behavior probe")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    print(build_probe(args.output))


if __name__ == "__main__":
    main()
