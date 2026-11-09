import hashlib
from pathlib import Path

_CHUNK_SIZE = 1024 * 1024


def sha256_bytes(value: bytes) -> str:
    """Return the lowercase SHA-256 digest for one byte sequence."""
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    """Hash one regular file without loading it into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    """Hash canonical text using UTF-8."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
