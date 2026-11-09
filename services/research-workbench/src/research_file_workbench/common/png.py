"""Bounded inspection of static non-interlaced, 8-bit PNG page images."""

from __future__ import annotations

import struct
import zlib
from collections.abc import Iterator

MAX_PNG_ENCODED_BYTES = 64 * 1024 * 1024
MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024
_DECODE_BLOCK_BYTES = 64 * 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}
_ANIMATION_CHUNKS = {b"acTL", b"fcTL", b"fdAT"}


class PngInspectionError(ValueError):
    """Raised when a PNG is invalid, unsupported or exceeds the inspection budget."""


def inspect_png(content: bytes) -> tuple[int, int]:
    """Validate supported PNG image data and return width and height.

    Supports static, non-interlaced, 8-bit grayscale, RGB, grayscale-alpha and RGBA.
    Indexed, low-bit-depth, 16-bit, interlaced and animated PNGs fail explicitly.
    The compressed stream is decoded in bounded blocks; its exact scanline lengths
    and filter bytes are checked without retaining a complete decoded bitmap.
    """
    if len(content) > MAX_PNG_ENCODED_BYTES:
        raise PngInspectionError("PNG exceeds the encoded image byte limit")
    if not content.startswith(_PNG_SIGNATURE):
        raise PngInspectionError("Page image has no valid PNG signature and header")
    chunks = iter(_chunks(content))
    header = next(chunks, None)
    if header is None or header[0] != b"IHDR" or len(header[1]) != 13:
        raise PngInspectionError("PNG must start with one 13-byte IHDR header")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", header[1]
    )
    if not 0 < width < 2**31 or not 0 < height < 2**31:
        raise PngInspectionError("PNG dimensions must be positive 31-bit integers")
    if depth != 8 or color not in _CHANNELS or interlace != 0:
        raise PngInspectionError(
            "Unsupported PNG format; use static non-interlaced 8-bit grayscale, RGB or RGBA"
        )
    if compression != 0 or filtering != 0:
        raise PngInspectionError("PNG declares an invalid compression or filter method")
    stride = width * _CHANNELS[color] + 1
    expected_bytes = stride * height
    if expected_bytes > MAX_PNG_DECODED_BYTES:
        raise PngInspectionError("PNG exceeds the decoded image byte limit")
    decoder = zlib.decompressobj()
    decoded_bytes = 0
    saw_data = False
    data_closed = False
    saw_palette = False
    saw_transparency = False
    ended = False
    for kind, payload in chunks:
        if kind in _ANIMATION_CHUNKS:
            raise PngInspectionError("Animated PNG page images are not supported")
        if kind == b"IHDR":
            raise PngInspectionError("PNG must contain exactly one IHDR header")
        if kind == b"IDAT":
            if data_closed:
                raise PngInspectionError("PNG IDAT chunks must be consecutive")
            saw_data = True
            # Slice compressed input too: unconsumed_tail must not copy a whole large IDAT.
            for offset in range(0, len(payload), _DECODE_BLOCK_BYTES):
                decoded_bytes = _decode_image_data(
                    decoder,
                    payload[offset : offset + _DECODE_BLOCK_BYTES],
                    decoded_bytes,
                    expected_bytes,
                    stride,
                )
            continue
        if saw_data:
            data_closed = True
        if kind == b"PLTE":
            if saw_palette or saw_data or saw_transparency or color in (0, 4):
                raise PngInspectionError("PNG palette is duplicated, misplaced or forbidden")
            if not payload or len(payload) % 3 or len(payload) > 256 * 3:
                raise PngInspectionError("PNG palette has an invalid length")
            saw_palette = True
        elif kind == b"tRNS":
            if saw_transparency or saw_data or color in (4, 6):
                raise PngInspectionError("PNG transparency is duplicated, misplaced or forbidden")
            required = 2 if color == 0 else 6
            if len(payload) != required or any(payload[index] for index in range(0, required, 2)):
                raise PngInspectionError("PNG transparency values do not match its bit depth")
            saw_transparency = True
        elif kind == b"IEND":
            if payload:
                raise PngInspectionError("PNG end chunk must be empty")
            ended = True
            if next(chunks, None) is not None:
                raise PngInspectionError("PNG contains content after its end chunk")
            break
        elif not kind[0] & 0x20:
            raise PngInspectionError("PNG contains an unsupported critical chunk")
    if not saw_data or not ended:
        raise PngInspectionError("PNG must include image data and a complete end chunk")
    if not decoder.eof or decoded_bytes != expected_bytes:
        raise PngInspectionError("PNG image data is truncated or has an incorrect scanline size")
    return width, height


def _chunks(content: bytes) -> Iterator[tuple[bytes, memoryview]]:
    offset = len(_PNG_SIGNATURE)
    view = memoryview(content)
    while offset < len(content):
        if offset + 12 > len(content):
            raise PngInspectionError("PNG contains a truncated chunk")
        length = struct.unpack_from(">I", content, offset)[0]
        kind = content[offset + 4 : offset + 8]
        end = offset + length + 12
        if length >= 2**31 or end > len(content):
            raise PngInspectionError("PNG chunk extends beyond the captured image")
        if any(not (65 <= value <= 90 or 97 <= value <= 122) for value in kind) or kind[2] & 0x20:
            raise PngInspectionError("PNG chunk has an invalid type code")
        if zlib.crc32(view[offset + 4 : end - 4]) != struct.unpack_from(">I", content, end - 4)[0]:
            raise PngInspectionError("PNG chunk checksum does not match")
        yield kind, view[offset + 8 : end - 4]
        offset = end


def _decode_image_data(
    decoder: zlib._Decompress,
    payload: memoryview,
    decoded_bytes: int,
    expected_bytes: int,
    stride: int,
) -> int:
    pending: bytes | memoryview = payload
    while pending:
        if decoder.eof:
            raise PngInspectionError("PNG contains data after the image compression stream")
        try:
            block = decoder.decompress(
                pending, min(_DECODE_BLOCK_BYTES, expected_bytes - decoded_bytes + 1)
            )
        except zlib.error as exc:
            raise PngInspectionError("PNG image data cannot be decompressed") from exc
        if len(block) > expected_bytes - decoded_bytes:
            raise PngInspectionError("PNG image data exceeds the declared scanline size")
        first_filter = (-decoded_bytes) % stride
        if any(block[index] > 4 for index in range(first_filter, len(block), stride)):
            raise PngInspectionError("PNG scanline uses an invalid filter")
        decoded_bytes += len(block)
        if decoder.unused_data:
            raise PngInspectionError("PNG contains data after the image compression stream")
        pending = decoder.unconsumed_tail
    return decoded_bytes
