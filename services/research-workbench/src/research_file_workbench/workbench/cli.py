"""Command line entry point for the local research workbench.

The CLI, the MCP server, and the browser surface project the same WorkbenchService
operations: this file holds arguments, files and exit codes only. Author decisions and
render-bundle registration stay on the rfw-project operator path, where an explicitly
confirmed human action is part of the record.
"""

import argparse
import base64
import json
import sys
from pathlib import Path
from uuid import uuid4

from research_file_workbench.journals.models import SOURCE_KINDS, SourceInput
from research_file_workbench.journals.store import WorldStoreError
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.workbench.server import serve
from research_file_workbench.workbench.service import WorkbenchService


def _emit(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=1))


def _read_manifest(path: Path) -> list[dict[str, str]]:
    from research_file_workbench.common.json_io import decode_json_array

    try:
        raw = decode_json_array(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"来源清单无法读取：{path}") from exc
    if not raw:
        raise ValueError("来源清单必须是非空 JSON 数组。")
    sources: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("来源清单条目必须是对象。")
        name = item.get("name")
        kind = item.get("kind")
        source_path = item.get("path")
        if not (
            isinstance(name, str)
            and name.strip()
            and isinstance(kind, str)
            and kind.strip()
            and isinstance(source_path, str)
            and source_path.strip()
        ):
            raise ValueError("来源条目必须包含非空的 name、kind 与 path。")
        sources.append({"name": name, "kind": kind, "path": source_path})
    return sources


def _captured_sources(entries: list[dict[str, str]]) -> list[SourceInput]:
    captured: list[SourceInput] = []
    for entry in entries:
        if entry["kind"] not in SOURCE_KINDS:
            raise ValueError(f"不支持的来源类型：{entry['kind']}")
        try:
            content = Path(entry["path"]).read_bytes()
        except OSError as exc:
            raise ValueError(f"来源文件无法读取：{entry['path']}") from exc
        captured.append(SourceInput(entry["name"], entry["kind"], content))
    return captured


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfw-workbench")
    parser.add_argument("--library-root", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--protected-root", type=Path, action="append", default=[])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="Create one application library")
    commands.add_parser("serve", help="Serve the library over local HTTP")
    commands.add_parser("state", help="Report library discovery state")

    import_world = commands.add_parser("import-world", help="Retain a new journal world")
    import_world.add_argument("--journal-id", required=True)
    import_world.add_argument("--name", required=True)
    import_world.add_argument("--sources-manifest", type=Path, required=True)
    import_world.add_argument("--article-type", default="research_article")
    import_world.add_argument("--stage", default="initial_submission")
    import_world.add_argument("--language", default="en")

    review = commands.add_parser("review", help="Build source-bound review units")
    review.add_argument("--version-id", required=True)

    diff = commands.add_parser("diff", help="Compare two retained world versions")
    diff.add_argument("--from-version", required=True)
    diff.add_argument("--to-version", required=True)

    revise = commands.add_parser("revise", help="Record a reasoned rule correction")
    revise.add_argument("--version-id", required=True)
    revise.add_argument("--rule-id", required=True)
    revise.add_argument("--expected", required=True)
    revise.add_argument("--reason", required=True)

    import_manuscript = commands.add_parser(
        "import-manuscript", help="Capture a DOCX as a new managed project"
    )
    import_manuscript.add_argument("--name", required=True)
    import_manuscript.add_argument("--filename", required=True)
    import_manuscript.add_argument("--docx", type=Path, required=True)

    update_manuscript = commands.add_parser(
        "update-manuscript", help="Capture a DOCX as a new baseline of an existing project"
    )
    update_manuscript.add_argument("--project-id", required=True)
    update_manuscript.add_argument("--expected-baseline-id", required=True)
    update_manuscript.add_argument("--filename", required=True)
    update_manuscript.add_argument("--docx", type=Path, required=True)
    update_manuscript.add_argument("--reason", required=True)

    bind = commands.add_parser("bind", help="Bind a project to a world version")
    bind.add_argument("--project-id", required=True)
    bind.add_argument("--world-version-id", required=True)
    bind.add_argument("--expected-binding-id")

    check = commands.add_parser("check", help="Check a bound project against its world")
    check.add_argument("--project-id", required=True)

    disposition = commands.add_parser("disposition", help="Record a note or defer")
    disposition.add_argument("--check-id", required=True)
    disposition.add_argument("--rule-id", required=True)
    disposition.add_argument("--action", choices=("note", "defer"), required=True)
    disposition.add_argument("--note", required=True)

    history = commands.add_parser("history", help="Present project history")
    history.add_argument("--project-id", required=True)

    source_page = commands.add_parser("source-page", help="Render one retained PDF page")
    source_page.add_argument("--version-id", required=True)
    source_page.add_argument("--source-id", required=True)
    source_page.add_argument("--page", type=int, required=True)
    source_page.add_argument("--out", type=Path, required=True)
    return parser


def _run(args: argparse.Namespace) -> None:
    if args.command == "init":
        WorkbenchService.create(args.library_root, protected_roots=tuple(args.protected_root))
        _emit({"library_root": args.library_root.resolve().as_posix()})
        return
    if args.protected_root:
        raise ValueError("Protected roots are registered during library initialization.")
    if args.command == "serve":
        serve(args.library_root, host=args.host, port=args.port)
        return
    service = WorkbenchService(args.library_root)
    if args.command == "state":
        _emit(service.state())
    elif args.command == "import-world":
        _emit(
            service.import_world(
                args.journal_id,
                args.name,
                _captured_sources(_read_manifest(args.sources_manifest)),
                article_type=args.article_type,
                stage=args.stage,
                language=args.language,
            )
        )
    elif args.command == "review":
        _emit(service.review(args.version_id))
    elif args.command == "diff":
        _emit(service.diff_worlds(args.from_version, args.to_version))
    elif args.command == "revise":
        original = service.store.get_world(args.version_id)
        rules = original["rules"]
        assert isinstance(rules, list)
        rule = next(
            (rule for rule in rules if isinstance(rule, dict) and rule["rule_id"] == args.rule_id),
            None,
        )
        if rule is None:
            raise ValueError("Rule decision must select one existing rule")
        expected = args.expected if rule["property"] == "body_font_family" else int(args.expected)
        _emit(service.revise(args.version_id, args.rule_id, expected, args.reason))
    elif args.command == "import-manuscript":
        content = args.docx.read_bytes()
        _emit(service.import_manuscript(args.name, args.filename, content, surface="cli"))
    elif args.command == "update-manuscript":
        content = args.docx.read_bytes()
        _emit(
            service.update_manuscript(
                args.project_id,
                args.expected_baseline_id,
                args.filename,
                content,
                args.reason,
                request_id=f"request-{uuid4().hex}",
                surface="cli",
            )
        )
    elif args.command == "bind":
        _emit(
            service.bind(
                args.project_id, args.world_version_id, args.expected_binding_id, surface="cli"
            )
        )
    elif args.command == "check":
        _emit(service.run_check(args.project_id, surface="cli"))
    elif args.command == "disposition":
        _emit(
            service.disposition(args.check_id, args.rule_id, args.action, args.note, surface="cli")
        )
    elif args.command == "history":
        _emit(service.history(args.project_id))
    elif args.command == "source-page":
        _refuse_unsafe_preview_output(args.out, service, args.library_root)
        payload = service.source_page(args.version_id, args.source_id, args.page)
        args.out.write_bytes(base64.b64decode(str(payload["png_base64"])))
        _emit({key: value for key, value in payload.items() if key != "png_base64"})


def _refuse_unsafe_preview_output(out: Path, service: WorkbenchService, library_root: Path) -> None:
    """Refuse preview output that would overwrite a file or enter a protected area.

    The operator chooses the file name; the product still refuses author workspaces,
    the application library itself, existing files and non-PNG targets.
    """
    if out.exists():
        raise ValueError(f"输出文件已存在，请选择新文件：{out}")
    if out.suffix.lower() != ".png":
        raise ValueError("页面预览输出必须是 .png 文件。")
    resolved = out.resolve()
    for root in service.store.protected_roots():
        protected = Path(root)
        if resolved == protected or protected in resolved.parents:
            raise ValueError(f"输出不能写入受保护的作者工作区：{out}")
    library = library_root.resolve()
    if resolved == library or library in resolved.parents:
        raise ValueError("页面预览输出不能写入应用库，请选择库外的输出位置。")


def main(argv: list[str] | None = None) -> int:
    """Initialize, serve, or operate a local library, reporting failures through exit status."""
    args = _build_parser().parse_args(argv)
    try:
        _run(args)
    except (OSError, ValueError, WorldStoreError, ProjectStoreError) as exc:
        print(f"WORKBENCH_OPERATION_FAILED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
