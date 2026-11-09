"""Local command-line access to an existing S1 snapshot."""

import argparse
import json
import sys
from pathlib import Path

from research_file_workbench.docx.query import (
    CONTINUATION_AVAILABLE,
    CONTINUATION_EXHAUSTED,
    OBJECT_TYPES,
    ReadQuery,
)
from research_file_workbench.docx.query_run import catalog_run, query_run


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfw-s1-query")
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--application-root", type=Path, required=True)
    parser.add_argument("--author-workspace-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("catalog", help="List object metadata; does not mark content as read")
    read = commands.add_parser("read", help="Return one bounded page of source observations")
    read.add_argument("--output-directory", type=Path, required=True)
    read.add_argument("--region")
    read.add_argument("--object-type", choices=OBJECT_TYPES)
    read.add_argument("--object-id")
    read.add_argument(
        "--page-number", type=int, help="Physical PDF page, requiring reviewed mapping"
    )
    read.add_argument("--page-size", type=int, default=ReadQuery().page_size)
    read.add_argument("--cursor")
    read.add_argument("--actor-id", default="local-operator")
    read.add_argument("--client-id", default="rfw-s1-query")
    return parser


def _selection_delivery(response: object) -> str:
    """Return the continuation state of a content response, refusing any unreadable shape.

    The exit code depends on this value, so a response that is not an object, or whose
    ``selection_delivery`` is missing or not one of the declared values, is refused here
    instead of being allowed to raise past the caller with the continuation exit code.
    """
    if not isinstance(response, dict):
        raise ValueError(f"response is not a JSON object: {type(response).__name__}")
    state = response.get("selection_delivery")
    if not isinstance(state, str) or state not in {CONTINUATION_EXHAUSTED, CONTINUATION_AVAILABLE}:
        raise ValueError(f"response has no readable selection continuation state: {state!r}")
    return state


def main(argv: list[str] | None = None) -> int:
    """Print catalog or content JSON.

    Exit codes follow the continuation axis, never the coverage axis: 0 for a catalog or a
    response after which no further page remains, 1 while a continuation is available, and 2
    for a refusal or a response whose continuation state cannot be read. Exit 0 means the page
    sequence ends here, not that this response holds the whole selection: a page reached with a
    cursor may carry only its last part, and its receipt names every selected object it did not
    return. Coverage stays ``partial`` on every content response and is reported by ``status``
    and ``limitations``.
    """
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "catalog":
            response = catalog_run(
                args.run_directory,
                application_root=args.application_root,
                author_workspace_root=args.author_workspace_root,
            )
            delivery_state: str | None = None
        else:
            response = query_run(
                args.run_directory,
                ReadQuery(
                    region=args.region,
                    object_type=args.object_type,
                    object_id=args.object_id,
                    page_number=args.page_number,
                    page_size=args.page_size,
                    cursor=args.cursor,
                ),
                application_root=args.application_root,
                author_workspace_root=args.author_workspace_root,
                output_directory=args.output_directory,
                actor_id=args.actor_id,
                client_id=args.client_id,
            )
            delivery_state = _selection_delivery(response)
    except (OSError, ValueError) as exc:
        print(f"S1_QUERY_FAILED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0 if delivery_state in (None, CONTINUATION_EXHAUSTED) else 1


if __name__ == "__main__":
    raise SystemExit(main())
