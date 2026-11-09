"""Recorded licence provenance for the binary components bundled into the desktop package.

The application ships under a proprietary licence, so every third-party binary placed in the
package needs a recorded licence and a place to obtain its source. This module is data, not
enforcement: `package_runtime` refuses to bundle a component that has no entry here, so an
unrecorded binary fails the build instead of shipping quietly.

The identifiers below are recorded from each upstream project and are the input to the
distribution review, not a substitute for it. Confirm them against the exact build being
shipped before distributing.
"""

from __future__ import annotations

import re

# The vendored MiKTeX builds embed their release in the file name, for example
# MiKTeX251200-poppler.dll. Strip that prefix before lookup.
_MIKTEX_PREFIX = re.compile(r"^miktex\d+-")


def normalize(name: str) -> str:
    """Return the lookup key for a bundled file name."""
    lowered = name.lower()
    return _MIKTEX_PREFIX.sub("", lowered)


# component -> (licence identifier, where to obtain the corresponding source)
RECORDED: dict[str, tuple[str, str]] = {
    "pdfinfo": ("GPL-2.0-or-later", "https://poppler.freedesktop.org/"),
    "poppler": ("GPL-2.0-or-later", "https://poppler.freedesktop.org/"),
    "core": ("GPL-2.0-or-later", "https://miktex.org/"),
    "app": ("GPL-2.0-or-later", "https://miktex.org/"),
    "util": ("GPL-2.0-or-later", "https://miktex.org/"),
    "loc": ("GPL-2.0-or-later", "https://miktex.org/"),
    "res": ("GPL-2.0-or-later", "https://miktex.org/"),
    "trace": ("GPL-2.0-or-later", "https://miktex.org/"),
    "setup": ("GPL-2.0-or-later", "https://miktex.org/"),
    "packagemanager": ("GPL-2.0-or-later", "https://miktex.org/"),
    "mspack": ("LGPL-2.1-or-later", "https://www.cabextract.org.uk/libmspack/"),
    "unxemu": ("GPL-2.0-or-later", "https://miktex.org/"),
    "extractor": ("GPL-2.0-or-later", "https://miktex.org/"),
    "utf8wrap": ("GPL-2.0-or-later", "https://miktex.org/"),
    "apr": ("Apache-2.0", "https://apr.apache.org/"),
    "aprutil": ("Apache-2.0", "https://apr.apache.org/"),
    "bzip2": ("bzip2-1.0.6", "https://sourceware.org/bzip2/"),
    "curl": ("curl", "https://curl.se/"),
    "expat": ("MIT", "https://libexpat.github.io/"),
    "fmt": ("MIT", "https://fmt.dev/"),
    "freetype2": ("FTL OR GPL-2.0-or-later", "https://freetype.org/"),
    "jpeg": ("IJG", "https://www.ijg.org/"),
    "libressl-crypto": ("OpenSSL OR ISC", "https://www.libressl.org/"),
    "log4cxx": ("Apache-2.0", "https://logging.apache.org/log4cxx/"),
    "lzma2": ("public-domain OR LGPL-2.1-or-later", "https://tukaani.org/xz/"),
    "md5": ("public-domain", "https://miktex.org/"),
    "png": ("libpng-2.0", "http://www.libpng.org/"),
    "ui-qt": ("LGPL-3.0-only OR commercial", "https://www.qt.io/"),
    "qt6core": ("LGPL-3.0-only OR commercial", "https://www.qt.io/"),
    "qt6gui": ("LGPL-3.0-only OR commercial", "https://www.qt.io/"),
    "qt6widgets": ("LGPL-3.0-only OR commercial", "https://www.qt.io/"),
    "icudt78": ("Unicode-3.0", "https://icu.unicode.org/"),
    "icuuc78": ("Unicode-3.0", "https://icu.unicode.org/"),
    "icuin78": ("Unicode-3.0", "https://icu.unicode.org/"),
    "harfbuzz": ("MIT", "https://harfbuzz.github.io/"),
    "zlib": ("Zlib", "https://zlib.net/"),
    "zlib1": ("Zlib", "https://zlib.net/"),
    "uriparser": ("BSD-3-Clause", "https://uriparser.github.io/"),
    "mgsdll64": ("AGPL-3.0-only OR commercial", "https://www.ghostscript.com/"),
    "python": ("PSF-2.0", "https://www.python.org/"),
    "python312": ("PSF-2.0", "https://www.python.org/"),
    "python3": ("PSF-2.0", "https://www.python.org/"),
    "vcruntime140": ("Microsoft redistributable", "https://visualstudio.microsoft.com/"),
    "vcruntime140_1": ("Microsoft redistributable", "https://visualstudio.microsoft.com/"),
    "msvcp140": ("Microsoft redistributable", "https://visualstudio.microsoft.com/"),
}


def recorded_license(name: str) -> tuple[str, str] | None:
    """Return the recorded licence and source for a bundled file, or None when unrecorded."""
    key = normalize(name)
    for suffix in (".dll", ".exe", ".pyd"):
        if key.endswith(suffix):
            key = key[: -len(suffix)]
            break
    if key in RECORDED:
        return RECORDED[key]
    # Vendored libraries are frequently suffixed with a version, for example zlib1.
    for known, entry in RECORDED.items():
        if key.startswith(known):
            return entry
    return None
