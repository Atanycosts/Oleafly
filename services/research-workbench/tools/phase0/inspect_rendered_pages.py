"""Inspect one operator-owned PDF page export; never create or repair artifacts."""

import argparse
import re
import sys
from pathlib import Path

from research_file_workbench.common.filesystem import require_no_reparse_points, require_within
from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.common.png import MAX_PNG_ENCODED_BYTES, inspect_png


def inspect_rendered_pages(source: Path, directory: Path, expected_source_hash: str) -> JsonObject:
    """Bind a complete consecutive PNG export to an unchanged physical PDF."""
    require_no_reparse_points(source)
    require_no_reparse_points(directory)
    if sha256_file(source) != expected_source_hash:
        raise ValueError("Input PDF changed before page inspection")
    page_count = read_pdf_page_count(source)
    indexed: dict[int, Path] = {}
    for path in directory.iterdir():
        require_no_reparse_points(path)
        require_within(path, directory)
        # Poppler uses decimal page numbers, with optional zero padding.
        match = re.fullmatch(r"page-(\d+)\.png", path.name)
        if match is None or not path.is_file():
            raise ValueError(f"Unexpected page export entry: {path.name}")
        number = int(match.group(1))
        if number in indexed:
            raise ValueError(f"Duplicate physical page number: {number}")
        indexed[number] = path
    if set(indexed) != set(range(1, page_count + 1)):
        raise ValueError("PNG page sequence differs from the physical PDF page count")
    pages: list[JsonObject] = []
    for number, path in sorted(indexed.items()):
        if path.stat().st_size > MAX_PNG_ENCODED_BYTES:
            raise ValueError(f"PNG exceeds the supported inspection size: {path.name}")
        content = path.read_bytes()
        width, height = inspect_png(content)
        content_hash = sha256_bytes(content)
        if sha256_file(path) != content_hash:
            raise ValueError(f"PNG changed during page inspection: {path.name}")
        pages.append(
            {
                "page_number": number,
                "path": path.as_posix(),
                "sha256": content_hash,
                "size": len(content),
                "width": width,
                "height": height,
            }
        )
    if sha256_file(source) != expected_source_hash:
        raise ValueError("Input PDF changed during page inspection")
    return {"source_sha256": expected_source_hash, "page_count": page_count, "pages": pages}


def main() -> int:
    """Return explicit inspection failure without publishing a successful record."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-pdf", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    arguments = parser.parse_args()
    try:
        result = inspect_rendered_pages(
            arguments.input_pdf, arguments.output_directory, arguments.source_sha256
        )
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(encode_json_object(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
