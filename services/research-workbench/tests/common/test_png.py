"""PNG inspection rejects damaged image data without expanding unbounded images."""

import struct
import zlib
from pathlib import Path

import pytest

from research_file_workbench.common import png as png_module
from research_file_workbench.common.png import PngInspectionError, inspect_png

ROOT = Path(__file__).resolve().parents[2]
SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload))
    )


def png(
    raw: bytes = b"\x00\xff\x00\x00",
    *,
    width: int = 1,
    height: int = 1,
    depth: int = 8,
    color: int = 2,
    interlace: int = 0,
    compressed: bytes | None = None,
) -> bytes:
    return (
        SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace))
        + chunk(b"IDAT", zlib.compress(raw) if compressed is None else compressed)
        + chunk(b"IEND", b"")
    )


@pytest.mark.parametrize("color,channels", [(0, 1), (2, 3), (4, 2), (6, 4)])
def test_supported_static_colors_and_filters(color, channels):
    rows = b"".join(bytes([filter_type]) + b"\x00" * channels for filter_type in range(5))
    assert inspect_png(png(rows, color=color, height=5)) == (1, 5)


def test_frozen_rendered_pages_remain_supported():
    paths = list((ROOT / "reports/phase0/fixtures").glob("*/pages-150dpi/*.png"))
    assert paths
    for path in paths:
        width, height = inspect_png(path.read_bytes())
        assert width > 0 and height > 0


@pytest.mark.parametrize(
    "compressed",
    [b"not-a-zlib-stream", zlib.compress(b"\x00\x00\x00\x00")[:-1]],
)
def test_crc_correct_but_undecodable_or_truncated_image_data_is_rejected(compressed):
    with pytest.raises(PngInspectionError, match="decompressed|truncated"):
        inspect_png(png(compressed=compressed))


@pytest.mark.parametrize("raw", [b"\x00", b"\x00" * 5, b"\x05\x00\x00\x00"])
def test_scanline_size_and_filter_must_match_header(raw):
    with pytest.raises(PngInspectionError, match="scanline|filter"):
        inspect_png(png(raw))


@pytest.mark.parametrize("tail", [b"garbage", zlib.compress(b"\x00\x00\x00\x00")])
def test_image_stream_must_end_without_trailing_data(tail):
    with pytest.raises(PngInspectionError, match="after the image compression stream"):
        inspect_png(png(compressed=zlib.compress(b"\x00\x00\x00\x00") + tail))


def test_multiple_consecutive_idat_chunks_form_one_stream():
    compressed = zlib.compress(b"\x00\x01\x02\x03")
    content = png()
    header = content[:33]
    data = chunk(b"IDAT", compressed[:3]) + chunk(b"IDAT", compressed[3:])
    assert inspect_png(header + data + chunk(b"IEND", b"")) == (1, 1)
    with pytest.raises(PngInspectionError, match="consecutive"):
        inspect_png(
            header
            + chunk(b"IDAT", compressed[:3])
            + chunk(b"tEXt", b"label\x00value")
            + chunk(b"IDAT", compressed[3:])
            + chunk(b"IEND", b"")
        )


@pytest.mark.parametrize(
    "settings",
    [{"depth": 16}, {"depth": 1, "color": 0}, {"color": 3}, {"interlace": 1}],
)
def test_unsupported_formats_are_explicit(settings):
    with pytest.raises(PngInspectionError, match="Unsupported PNG format"):
        inspect_png(png(**settings))


def test_animation_and_unknown_critical_chunks_are_rejected():
    content = png()
    for kind, error in [(b"acTL", "Animated"), (b"ABCD", "critical")]:
        with pytest.raises(PngInspectionError, match=error):
            inspect_png(content[:33] + chunk(kind, b"payload") + content[33:])


def test_oversized_header_is_refused_before_decoding():
    with pytest.raises(PngInspectionError, match="decoded image byte limit"):
        inspect_png(png(width=2**30, compressed=b"not-decompressed"))


def test_decode_output_is_bounded_by_declared_image_size():
    compressed = zlib.compress(b"\x00" * (1024 * 1024))
    with pytest.raises(PngInspectionError, match="exceeds the declared scanline size"):
        inspect_png(png(compressed=compressed))


def test_encoded_and_decoded_budgets_are_enforced(monkeypatch):
    content = png()
    monkeypatch.setattr(png_module, "MAX_PNG_ENCODED_BYTES", len(content) - 1)
    with pytest.raises(PngInspectionError, match="encoded image byte limit"):
        inspect_png(content)
    monkeypatch.setattr(png_module, "MAX_PNG_ENCODED_BYTES", len(content))
    monkeypatch.setattr(png_module, "MAX_PNG_DECODED_BYTES", 3)
    with pytest.raises(PngInspectionError, match="decoded image byte limit"):
        inspect_png(content)


def test_large_rows_are_checked_across_decode_blocks():
    width = 30_000
    raw = b"\x00" * (width * 3 + 1)
    assert inspect_png(png(raw * 2, width=width, height=2)) == (width, 2)
    with pytest.raises(PngInspectionError, match="invalid filter"):
        inspect_png(png(raw + b"\x05" + raw[1:], width=width, height=2))


@pytest.mark.parametrize(
    "transform",
    [
        lambda content: content[:33] + content[:33][8:] + content[33:],
        lambda content: content + chunk(b"tEXt", b"label\x00value"),
        lambda content: content[:-12],
        lambda content: content[:-1],
        lambda content: content[:29] + b"bad!" + content[33:],
    ],
)
def test_structure_and_checksums_are_validated(transform):
    with pytest.raises(PngInspectionError):
        inspect_png(transform(png()))
