"""Command-line entry point for one controlled S1 DOCX read."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from research_file_workbench.docx.pipeline import (
    S1PipelineError,
    run_s1_readonly,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfw-s1-read")
    parser.add_argument("source", type=Path)
    parser.add_argument("--application-root", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--author-workspace-root", type=Path, required=True)
    parser.add_argument("--document-annotation", type=Path)
    parser.add_argument("--page-evidence", type=Path)
    parser.add_argument("--render-record", type=Path)
    parser.add_argument("--page-image-directory", type=Path)
    parser.add_argument("--author-workspace-baseline", type=Path)
    parser.add_argument("--actor-id", default="local-operator")
    parser.add_argument("--client-id", default="rfw-s1-read")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Print one controlled S1 read report.

    Exit codes separate an executed read from a failed one: 0 for a run that completed without
    unresolved items, 1 for a run that executed and reported limitations, and 2 for a refusal or
    a run whose integrity check failed. A failed run currently exits 2 rather than 0, because
    ``completed`` is unreachable while the reader declares unconditional limits; never read a
    non-zero code as "no report was produced".
    """
    args = _build_parser().parse_args(argv)
    try:
        report = run_s1_readonly(
            args.source,
            application_root=args.application_root,
            output_directory=args.output_directory,
            author_workspace_root=args.author_workspace_root,
            document_annotation=args.document_annotation,
            page_evidence=args.page_evidence,
            render_record=args.render_record,
            page_image_directory=args.page_image_directory,
            author_workspace_baseline=args.author_workspace_baseline,
            actor_id=args.actor_id,
            client_id=args.client_id,
        )
    except (OSError, S1PipelineError, ValueError) as exc:
        print(f"S1_READ_FAILED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    status = report.get("status")
    if status == "completed":
        return 0
    if status == "partial":
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
