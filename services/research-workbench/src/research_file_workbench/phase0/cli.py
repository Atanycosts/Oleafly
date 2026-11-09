import argparse
import sys
from pathlib import Path

from research_file_workbench.common.filesystem import require_owned_output
from research_file_workbench.common.json_io import load_json_object, write_json_object
from research_file_workbench.common.workspace import (
    build_workspace_fingerprint,
    compare_workspace_fingerprint,
)
from research_file_workbench.phase0.reports import build_phase0_reports
from research_file_workbench.phase0.validation import validate_phase0_contracts


def _default_project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfw-phase0")
    parser.add_argument(
        "--project-root", type=Path, default=_default_project_root(), help="Repository root"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate", help="Validate Phase 0 contracts and pinned inputs")
    commands.add_parser("build-reports", help="Build reviewable Phase 0 evidence reports")

    fingerprint = commands.add_parser("fingerprint", help="Fingerprint a read-only input directory")
    fingerprint.add_argument("root", type=Path)
    fingerprint.add_argument("output", type=Path)

    compare = commands.add_parser("compare-workspace", help="Compare a baseline fingerprint")
    compare.add_argument("baseline", type=Path)
    compare.add_argument("root", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = args.project_root.resolve()

    if args.command == "validate":
        report = validate_phase0_contracts(project_root / "contracts" / "phase0")
        print("CONTRACT_VALID" if report["contract_valid"] is True else "CONTRACT_INVALID")
        print("PHASE0_COMPLETE" if report["phase0_complete"] is True else "PHASE0_INCOMPLETE")
        if report["phase0_complete"] is not True:
            for key in ("checks", "completion_checks"):
                records = report[key]
                if isinstance(records, list):
                    for record in records:
                        if isinstance(record, dict) and record.get("passed") is False:
                            print(f"{record['check_id']}: {record.get('detail')}", file=sys.stderr)
        return 0 if report["phase0_complete"] is True else 1

    if args.command == "build-reports":
        paths = build_phase0_reports(project_root)
        for name, path in paths.items():
            print(f"{name}: {path}")
        validation = load_json_object(paths["contract-validation.json"])
        return 0 if validation.get("phase0_complete") is True else 1

    if args.command == "fingerprint":
        require_owned_output(
            args.output,
            (project_root / "reports", project_root / "var"),
            (args.root,),
        )
        report = build_workspace_fingerprint(args.root)
        write_json_object(args.output, report)
        print(args.output)
        return 0

    if args.command == "compare-workspace":
        baseline = load_json_object(args.baseline)
        current = build_workspace_fingerprint(args.root)
        comparison = compare_workspace_fingerprint(baseline, current)
        print("UNCHANGED" if comparison["unchanged"] is True else "CHANGED")
        return 0 if comparison["unchanged"] is True else 2

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
