"""Build a new fixture page-text index from existing render evidence."""

import argparse
import sys
from pathlib import Path

from research_file_workbench.phase0.render_reports import write_fixture_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument(
        "--output", type=Path, required=True, help="New JSON path below reports/ or var/"
    )
    args = parser.parse_args(argv)
    try:
        report = write_fixture_report(args.project_root, args.output, report_kind="page_index")
    except (OSError, ValueError) as exc:
        print(f"FIXTURE_PAGE_INDEX_FAILED: {exc}", file=sys.stderr)
        return 2
    print(args.output.resolve())
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
