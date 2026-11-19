"""Inspect actual embedded PDF font names and SFNT version records for acceptance."""

import hashlib
import json
import struct
import sys

import pymupdf


def versions(data: bytes) -> list[str]:
    if data[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        return []
    count = struct.unpack_from(">H", data, 4)[0]
    for index in range(count):
        record = 12 + index * 16
        if data[record : record + 4] != b"name":
            continue
        offset = struct.unpack_from(">I", data, record + 8)[0]
        _, length, strings = struct.unpack_from(">HHH", data, offset)
        result = set()
        for number in range(length):
            platform, _, _, name_id, size, position = struct.unpack_from(
                ">HHHHHH", data, offset + 6 + number * 12
            )
            if name_id == 5:
                raw = data[offset + strings + position : offset + strings + position + size]
                result.add(raw.decode("utf-16-be" if platform in (0, 3) else "mac_roman"))
        return sorted(result)
    return []


with pymupdf.open(sys.argv[1]) as document:
    fonts = {}
    for page in document:
        for font in page.get_fonts(full=True):
            if font[0] in fonts:
                continue
            name, extension, kind, data = document.extract_font(font[0])
            fonts[font[0]] = {
                "name": name,
                "extension": extension,
                "type": kind,
                "embedded_bytes": len(data),
                "embedded_subset_sha256": hashlib.sha256(data).hexdigest(),
                "versions": versions(data),
            }
    print(json.dumps(list(fonts.values()), ensure_ascii=False))
