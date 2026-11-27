"""Prepare the exact DOCX bytes consumed by the editor and retained readers."""

from dataclasses import dataclass
from io import BytesIO, StringIO
from posixpath import normpath
from xml.etree import ElementTree
from xml.parsers import expat
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, ZipInfo

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadError
from research_file_workbench.docx.parsing.package import package_part_names
from research_file_workbench.docx.parsing.strict_ooxml import (
    NAMESPACES,
    PACKAGE_RELS,
    SCHEMA_BASE,
    TRANSITIONAL_RELS,
    attribute_value,
    is_strict_document,
    relationship_type,
)
from research_file_workbench.docx.xml_support import WORD_NAMESPACE

STRICT_NORMALIZATION_VERSION = "strict-docx-normalization-1.0.0"
_MAIN = "word/document.xml"
_TYPES = "[Content_Types].xml"
_PACKAGE_RELATIONSHIPS = "_rels/.rels"
_TYPE_NS = SCHEMA_BASE + "package/2006/content-types"
_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
_ALTERNATE_DOCX = "application/vnd.ms-word.document.main+xml"
_SEPARATOR = "\x1f"


class DocxNormalizationError(DocxReadError):
    """A DOCX intake refusal with a user-visible reason."""

    def __init__(self, message: str, *, code: str = "invalid_docx") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class NormalizedDocx:
    content: bytes
    original_sha256: str
    source_sha256: str
    provenance: JsonObject | None = None


class _PackageTree(ElementTree.TreeBuilder):
    def doctype(self, name: str, public_id: str | None, system_id: str | None) -> None:
        raise DocxNormalizationError("DOCX package XML cannot contain a DTD.")


def _parse(contents: bytes, part: str) -> ElementTree.Element:
    try:
        return ElementTree.fromstring(contents, parser=ElementTree.XMLParser(target=_PackageTree()))
    except (ElementTree.ParseError, LookupError, ValueError) as exc:
        if isinstance(exc, DocxNormalizationError):
            raise
        raise DocxNormalizationError(f"The DOCX package has unreadable XML in {part}.") from exc


def _office_main(package_relationships: ElementTree.Element | None) -> str | None:
    if package_relationships is None:
        return None
    main = [
        item
        for item in package_relationships.findall(f"{{{PACKAGE_RELS}}}Relationship")
        if relationship_type(item.get("Type", "")) == TRANSITIONAL_RELS + "officeDocument"
    ]
    if not main:
        return None
    if len(main) != 1 or main[0].get("TargetMode") == "External" or not main[0].get("Target"):
        raise DocxNormalizationError(
            "The package does not identify a single internal main document."
        )
    return normpath(main[0].get("Target", "").lstrip("/"))


def _content_type(types: ElementTree.Element, part: str) -> str | None:
    for item in types.findall(f"{{{_TYPE_NS}}}Override"):
        if normpath(item.get("PartName", "").lstrip("/")) == part:
            return item.get("ContentType")
    extension = part.rsplit(".", 1)[-1].casefold()
    return next(
        (
            item.get("ContentType")
            for item in types.findall(f"{{{_TYPE_NS}}}Default")
            if item.get("Extension", "").casefold() == extension
        ),
        None,
    )


def normalize_docx(content: bytes, *, require_word_package: bool = False) -> NormalizedDocx:
    """Recognize Word by its main root; preserve Transitional imports byte for byte."""
    original_sha256 = sha256_bytes(content)
    try:
        with ZipFile(BytesIO(content)) as archive:
            names = package_part_names(archive)
            package_relationships = (
                _parse(archive.read(_PACKAGE_RELATIONSHIPS), _PACKAGE_RELATIONSHIPS)
                if _PACKAGE_RELATIONSHIPS in names
                else None
            )
            related_main = _office_main(package_relationships)
            main = related_main or _MAIN
            if main not in names:
                raise DocxNormalizationError("The package does not contain a Word DOCX document.")
            document = _parse(archive.read(main), main)
            strict = is_strict_document(document)
            if not strict and document.tag != f"{{{WORD_NAMESPACE}}}document":
                raise DocxNormalizationError("The package does not contain a Word DOCX document.")
            types = _parse(archive.read(_TYPES), _TYPES) if _TYPES in names else None
            mime = _content_type(types, main) if types is not None else None
            valid_mime = mime == _DOCX or (strict and mime == _ALTERNATE_DOCX)
            if not valid_mime and (
                require_word_package or strict or mime not in {None, "application/xml"}
            ):
                raise DocxNormalizationError("The package does not declare a Word DOCX document.")
            if strict and related_main is None:
                raise DocxNormalizationError(
                    "The Strict Word package is missing its main document relationship."
                )
            if main != _MAIN:
                raise DocxNormalizationError(
                    f"The Word DOCX main part {main} is outside the supported layout (/{_MAIN}).",
                    code="strict_docx_unsupported" if strict else "docx_unsupported",
                )
            if not strict:
                return NormalizedDocx(content, original_sha256, original_sha256)
            signed_content = types is not None and any(
                item.get("ContentType", "").startswith(
                    "application/vnd.openxmlformats-package.digital-signature-"
                )
                for item in types
            )
            signed_relationship = package_relationships is not None and any(
                item.get("Type", "").startswith(PACKAGE_RELS + "/digital-signature/")
                for item in package_relationships
            )
            if signed_content or signed_relationship:
                raise DocxNormalizationError(
                    "This is a digitally signed Strict DOCX. An editable working copy would "
                    "invalidate the package signature; no working copy was created.",
                    code="strict_docx_unsupported",
                )
            working = _project_package(archive, names)
    except DocxNormalizationError:
        raise
    except (BadZipFile, DocxReadError, NotImplementedError, RuntimeError) as exc:
        raise DocxNormalizationError(f"Could not read the DOCX package: {exc}") from exc

    source_sha256 = sha256_bytes(working)
    return NormalizedDocx(
        working,
        original_sha256,
        source_sha256,
        {
            "engine": "Research Workbench",
            "version": STRICT_NORMALIZATION_VERSION,
            "method": "ISO/IEC 29500 Strict to DOCX working copy",
            "converted_sha256": source_sha256,
        },
    )


def _project_package(archive: ZipFile, names: tuple[str, ...]) -> bytes:
    output = BytesIO()
    with ZipFile(output, mode="w") as projected:
        for part in names:
            data = archive.read(part)
            if part.casefold().endswith((".xml", ".rels")):
                data = _project_xml(data, part)
            projected.writestr(ZipInfo(part), data, compress_type=ZIP_DEFLATED)
    return output.getvalue()


def _qname(expanded: str) -> tuple[str, str, str]:
    pieces = expanded.split(_SEPARATOR)
    if len(pieces) == 1:
        return "", pieces[0], pieces[0]
    namespace, local, *prefix = pieces
    return namespace, local, f"{prefix[0]}:{local}" if prefix else local


def _project_xml(data: bytes, part: str) -> bytes:
    """Keep prefix scopes (including MCE QName values), element order and character data."""
    output = StringIO()
    output.write('<?xml version="1.0" encoding="UTF-8"?>')
    pending_namespaces: list[tuple[str, str]] = []
    stack: list[str] = []
    changed = False

    def declaration(prefix: str | None, uri: str | None) -> None:
        nonlocal changed
        uri = uri or ""
        mapped = NAMESPACES.get(uri, uri)
        changed |= uri != mapped
        pending_namespaces.append((f"xmlns:{prefix}" if prefix else "xmlns", mapped))

    def start(expanded: str, attributes: dict[str, str]) -> None:
        nonlocal changed
        namespace, local, qualified = _qname(expanded)
        parent = stack[-1] if stack else ""
        stack.append(local)
        output.write("<" + qualified)
        for name, value in pending_namespaces:
            output.write(f" {name}={quoteattr(value)}")
        pending_namespaces.clear()
        keys: set[tuple[str, str]] = set()
        for name, value in attributes.items():
            attr_namespace, attr_local, attr_qualified = _qname(name)
            key = (NAMESPACES.get(attr_namespace, attr_namespace), attr_local)
            if key in keys:
                raise DocxNormalizationError(
                    f"Strict DOCX uses conflicting namespace aliases in {part}: {qualified}.",
                    code="strict_docx_unsupported",
                )
            keys.add(key)
            mapped = value
            if (namespace, local, attr_namespace, attr_local) == (
                PACKAGE_RELS,
                "Relationship",
                "",
                "Type",
            ):
                mapped = relationship_type(value)
            elif (
                namespace == _TYPE_NS
                and attr_local == "ContentType"
                and not attr_namespace
                and value == _ALTERNATE_DOCX
            ):
                mapped = _DOCX
            else:
                mapped = attribute_value(
                    namespace, local, parent, attr_namespace, attr_local, value
                )
            output.write(f" {attr_qualified}={quoteattr(mapped)}")
            changed |= mapped != value
        output.write(">")

    def end(expanded: str) -> None:
        stack.pop()
        output.write(f"</{_qname(expanded)[2]}>")

    def text(value: str) -> None:
        output.write(escape(value, {"\r": "&#13;"}))

    def instruction(target: str, value: str) -> None:
        output.write(f"<?{target} {value}?>" if value else f"<?{target}?>")

    def forbid_doctype(
        name: str, system_id: str | None, public_id: str | None, internal: int
    ) -> None:
        raise DocxNormalizationError(f"Strict DOCX package XML cannot contain a DTD ({part}).")

    parser = expat.ParserCreate(namespace_separator=_SEPARATOR)
    parser.namespace_prefixes = True
    parser.StartNamespaceDeclHandler = declaration
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.CommentHandler = lambda value: output.write(f"<!--{value}-->")
    parser.ProcessingInstructionHandler = instruction
    parser.StartDoctypeDeclHandler = forbid_doctype
    try:
        parser.Parse(data, True)
    except (expat.ExpatError, LookupError) as exc:
        raise DocxNormalizationError(f"Strict DOCX has unreadable XML in {part}.") from exc
    return output.getvalue().encode("utf-8") if changed else data
