from datetime import UTC, datetime


def utc_now_iso() -> str:
    """Return a stable UTC timestamp for generated evidence."""
    return datetime.now(UTC).isoformat()
