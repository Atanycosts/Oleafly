"""Method identity of effective-format facts captured by the application DOCX core."""

from research_file_workbench.common.json_io import JsonObject

FORMAT_SNAPSHOT_METHOD_VERSION = "docx-core-format-snapshot-1.2.0"
LEGACY_FORMAT_SNAPSHOT_METHOD_VERSION = "docx-core-format-snapshot-1.0.0"


def format_snapshot_method(snapshot: JsonObject) -> str:
    """Keep pre-versioned retained snapshots attached to their original semantics."""
    method = snapshot.get("method_version", LEGACY_FORMAT_SNAPSHOT_METHOD_VERSION)
    if not isinstance(method, str) or method not in {
        LEGACY_FORMAT_SNAPSHOT_METHOD_VERSION,
        "docx-core-format-snapshot-1.1.0",
        FORMAT_SNAPSHOT_METHOD_VERSION,
    }:
        raise ValueError("Unsupported core format snapshot method")
    return method
