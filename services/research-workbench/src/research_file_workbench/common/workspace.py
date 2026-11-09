import os
import re
from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import DirectorySnapshot, snapshot_directory
from research_file_workbench.common.json_io import JsonObject

WORKSPACE_FINGERPRINT_VERSION = "2.0.0"


def build_workspace_fingerprint(root: Path) -> JsonObject:
    """Capture content identity and observable protection attributes for a read-only tree."""
    snapshot = snapshot_directory(root)
    return _snapshot_to_json(snapshot)


def compare_workspace_fingerprint(before: JsonObject, after: JsonObject) -> JsonObject:
    """Compare version-2 protection evidence; historical content-only records cannot prove it."""
    before_hash = before.get("manifest_sha256")
    after_hash = after.get("manifest_sha256")
    before_root = before.get("root")
    after_root = after.get("root")
    same_root = (
        isinstance(before_root, str)
        and isinstance(after_root, str)
        and os.path.normcase(os.path.normpath(before_root))
        == os.path.normcase(os.path.normpath(after_root))
    )
    before_protection = before.get("protection_sha256")
    after_protection = after.get("protection_sha256")
    compatible = (
        before.get("report_version") == after.get("report_version") == WORKSPACE_FINGERPRINT_VERSION
        and before.get("protection_kind") == after.get("protection_kind")
        and before.get("protection_kind") in {"windows_attributes", "posix_mode"}
        and all(
            _is_digest(value)
            for value in (before_hash, after_hash, before_protection, after_protection)
        )
    )
    content_unchanged = same_root and _is_digest(before_hash) and before_hash == after_hash
    protection_unchanged = compatible and same_root and before_protection == after_protection
    return {
        "report_version": WORKSPACE_FINGERPRINT_VERSION,
        "generated_at": utc_now_iso(),
        "unchanged": content_unchanged and protection_unchanged,
        "content_unchanged": content_unchanged,
        "protection_status": "compatible" if compatible else "incompatible",
        "protection_unchanged": protection_unchanged,
        "protection_kind": after.get("protection_kind"),
        "same_root": same_root,
        "before_root": before_root,
        "after_root": after_root,
        "before_manifest_sha256": before_hash,
        "after_manifest_sha256": after_hash,
        "before_protection_sha256": before_protection,
        "after_protection_sha256": after_protection,
    }


def _snapshot_to_json(snapshot: DirectorySnapshot) -> JsonObject:
    return {
        "report_version": WORKSPACE_FINGERPRINT_VERSION,
        "generated_at": utc_now_iso(),
        "root": snapshot.root,
        "manifest_sha256": snapshot.manifest_sha256,
        "protection_kind": snapshot.protection_kind,
        "root_protection_value": snapshot.root_protection_value,
        "protection_sha256": snapshot.protection_sha256,
        "entries": [
            {
                "relative_path": entry.relative_path,
                "entry_type": entry.entry_type,
                "size": entry.size,
                "sha256": entry.sha256,
                "protection_value": entry.protection_value,
            }
            for entry in snapshot.entries
        ],
    }


def _is_digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None
