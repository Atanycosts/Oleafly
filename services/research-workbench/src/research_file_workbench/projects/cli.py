"""Local operator commands for persistent project reading and baseline management."""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.query import OBJECT_TYPES, ReadQuery
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.author_decision_records import (
    DECISION_KINDS,
    DECISION_SCOPES,
    AuthorDecisionRequest,
)
from research_file_workbench.projects.service import (
    catalog_project,
    create_project,
    import_document,
    inspect_import,
    open_project,
    read_project,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfw-project")
    parser.add_argument("--project-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser(
        "init", help="Create durable project storage outside author inputs"
    )
    create.add_argument("--author-workspace-root", type=Path, required=True)
    create.add_argument("--project-id")
    inspect = commands.add_parser("inspect-import", help="Show source hash and expected baseline")
    inspect.add_argument("source", type=Path)
    change = commands.add_parser("import", help="Confirm a specific source version as a baseline")
    change.add_argument("source", type=Path)
    change.add_argument("--source-sha256", required=True)
    change.add_argument("--request-id", required=True)
    expected = change.add_mutually_exclusive_group(required=True)
    expected.add_argument("--initial", action="store_true")
    expected.add_argument("--expected-baseline")
    change.add_argument(
        "--actor-id", required=True, help="Local operator label, not authentication"
    )
    change.add_argument("--reason", required=True, help="Operator's reason for this exact import")
    commands.add_parser("status", help="Show the authoritative current baseline")
    commands.add_parser("baselines", help="List retained baseline history")
    render = commands.add_parser(
        "register-render", help="Retain an explicit PDF/page evidence bundle"
    )
    render.add_argument("--baseline-id", required=True)
    render.add_argument("--input-root", type=Path, required=True)
    render.add_argument("--render-record", type=Path, required=True)
    render.add_argument("--page-index", type=Path, required=True)
    render.add_argument("--document-annotation", type=Path)
    render.add_argument("--page-evidence", type=Path)
    render.add_argument("--actor-id", required=True)
    render.add_argument("--reason", required=True)
    renders = commands.add_parser(
        "renders", help="List retained bundles without marking pages read"
    )
    renders.add_argument("--baseline-id")
    for command in ("catalog", "evidence", "reads"):
        scoped = commands.add_parser(command)
        scoped.add_argument("--baseline-id")
    read = commands.add_parser(
        "read", help="Read source observations and persist the exact receipt"
    )
    read.add_argument("--baseline-id", help="Explicit historical baseline; default is current")
    read.add_argument("--region")
    read.add_argument("--object-type", choices=OBJECT_TYPES)
    read.add_argument("--object-id")
    read.add_argument("--page-number", type=int)
    read.add_argument("--render-bundle-id")
    read.add_argument("--page-size", type=int, default=ReadQuery().page_size)
    read.add_argument("--cursor")
    read.add_argument("--actor-id", default="local-operator")
    read.add_argument("--client-id", default="rfw-project")
    response = commands.add_parser("response", help="Recover a saved response after disconnect")
    response.add_argument("read_record_id")
    request = commands.add_parser("request", help="Recover a baseline management decision")
    request.add_argument("--actor-id", required=True)
    request.add_argument("request_id")
    decide = commands.add_parser("decide", help="Record one explicitly confirmed author decision")
    decide.add_argument("--decision-key", required=True)
    decide.add_argument("--kind", choices=DECISION_KINDS, required=True)
    decide.add_argument("--scope", choices=DECISION_SCOPES, required=True)
    decide.add_argument("--content", required=True)
    decide.add_argument("--applies-to", required=True)
    decide.add_argument("--reason", required=True)
    decide.add_argument("--invalidation", required=True)
    decide.add_argument("--baseline-id")
    decide.add_argument("--conditions")
    decide.add_argument("--confirmed-at")
    decide.add_argument(
        "--confirmed-source",
        default="local_operator",
        help="Trusted user origin; an agent proposal is refused",
    )
    decide.add_argument("--rule-ref", action="append", default=[])
    decide.add_argument("--evidence-ref", action="append", default=[])
    decisions = commands.add_parser("decisions", help="List saved author decisions")
    decisions.add_argument("--decision-key")
    decisions.add_argument("--history", action="store_true", help="Include superseded versions")
    decision = commands.add_parser("decision", help="Recover one saved author decision")
    decision.add_argument("decision_id")
    return parser


def _execute(args: argparse.Namespace) -> JsonObject:
    root = args.project_root
    if args.command == "init":
        return create_project(
            root, author_workspace_root=args.author_workspace_root, project_id=args.project_id
        )
    if args.command == "inspect-import":
        return inspect_import(root, args.source)
    if args.command == "import":
        return import_document(
            root,
            args.source,
            source_sha256=args.source_sha256,
            request_id=args.request_id,
            expected_baseline_id=args.expected_baseline,
            actor_id=args.actor_id,
            confirmation_reason=args.reason,
        )
    if args.command == "catalog":
        return catalog_project(root, baseline_id=args.baseline_id)
    if args.command == "register-render":
        from research_file_workbench.projects.render_service import register_render_bundle

        return register_render_bundle(
            root,
            baseline_id=args.baseline_id,
            input_root=args.input_root,
            render_record=args.render_record,
            page_index=args.page_index,
            document_annotation=args.document_annotation,
            page_evidence=args.page_evidence,
            actor_id=args.actor_id,
            confirmation_reason=args.reason,
        )
    if args.command == "read":
        return read_project(
            root,
            ReadQuery(
                region=args.region,
                object_type=args.object_type,
                object_id=args.object_id,
                page_number=args.page_number,
                page_size=args.page_size,
                cursor=args.cursor,
            ),
            baseline_id=args.baseline_id,
            render_bundle_id=args.render_bundle_id,
            actor_id=args.actor_id,
            client_id=args.client_id,
        )
    store = open_project(root)
    if args.command == "status":
        return store.info()
    if args.command == "baselines":
        return {"baselines": store.list_baselines()}
    if args.command == "renders":
        return {"render_bundles": store.list_render_bundles(args.baseline_id)}
    if args.command == "evidence":
        return {
            "evidence": store.list_evidence(args.baseline_id, reader_version=READER_VERSION),
            "verification_status": "NOT_REVIEWED",
        }
    if args.command == "reads":
        return {"reads": store.list_reads(args.baseline_id)}
    if args.command == "response":
        return store.get_read(args.read_record_id)
    if args.command == "request":
        return store.get_request(args.actor_id, args.request_id)
    if args.command == "decide":
        return store.save_author_decision(
            AuthorDecisionRequest(
                decision_key=args.decision_key,
                kind=args.kind,
                content=args.content,
                scope=args.scope,
                applies_to=args.applies_to,
                confirmed_source=args.confirmed_source,
                reason=args.reason,
                invalidation=args.invalidation,
                baseline_id=args.baseline_id,
                confirmed_at=args.confirmed_at,
                conditions=args.conditions,
                rule_refs=tuple(args.rule_ref),
                evidence_refs=tuple(args.evidence_ref),
            )
        )
    if args.command == "decision":
        return store.get_author_decision(args.decision_id)
    if args.command == "decisions":
        return {
            "decisions": store.list_author_decisions(
                decision_key=args.decision_key, latest_only=not args.history
            )
        }
    raise ValueError(f"Unsupported project command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    """Return 0 for management success, 1 for partial reads, 2 for refusals/conflicts."""
    args = _parser().parse_args(argv)
    try:
        response = _execute(args)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(f"PROJECT_OPERATION_FAILED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(response, ensure_ascii=False, indent=2))
    status = response.get("status")
    if status in ("BASELINE_CONFLICT", "IDEMPOTENCY_CONFLICT", "REJECTED", "failed"):
        return 2
    return 1 if status == "partial" else 0


if __name__ == "__main__":
    raise SystemExit(main())
