"""AlternateContent selection without changing the physical XML tree."""

from collections.abc import Iterator
from importlib.resources import files
from json import loads
from re import findall
from xml.etree import ElementTree

_POLICY = loads(
    files("research_file_workbench.docx").joinpath("markup-compatibility.json").read_bytes()
)
MARKUP_COMPATIBILITY_NAMESPACE: str = _POLICY["namespace_uri"]
MISSING_BRANCH_CODE: str = _POLICY["missing_branch"]["code"]
MISSING_BRANCH_DETAIL: str = _POLICY["missing_branch"]["detail"]
_SUPPORTED_URIS = frozenset(_POLICY["supported_requires_uris"])
_ALTERNATE = f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}AlternateContent"
_CHOICE = f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}Choice"
_FALLBACK = f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}Fallback"


class _AlternateContent(ElementTree.Element):
    selected_index: int | None = None


class _Choice(ElementTree.Element):
    supported: bool = False


def _element(tag: str, attrs: dict[str, str]) -> ElementTree.Element:
    if tag == _ALTERNATE:
        return _AlternateContent(tag, attrs)
    if tag == _CHOICE:
        return _Choice(tag, attrs)
    return ElementTree.Element(tag, attrs)


class _CompatibilityTreeBuilder(ElementTree.TreeBuilder):
    def __init__(self) -> None:
        super().__init__(element_factory=_element)
        self._bindings: dict[str, list[str]] = {}

    def start_ns(self, prefix: str, uri: str) -> None:
        self._bindings.setdefault(prefix, []).append(uri)

    def end_ns(self, prefix: str) -> None:
        bindings = self._bindings[prefix]
        bindings.pop()
        if not bindings:
            del self._bindings[prefix]

    def start(self, tag: str, attrs: dict[str, str]) -> ElementTree.Element:
        element = super().start(tag, attrs)
        if isinstance(element, _Choice):
            prefixes = findall(r"[^ \t\r\n]+", attrs.get("Requires", ""))
            element.supported = bool(prefixes) and all(
                prefix in self._bindings and self._bindings[prefix][-1] in _SUPPORTED_URIS
                for prefix in prefixes
            )
        return element

    def end(self, tag: str) -> ElementTree.Element:
        element = super().end(tag)
        if isinstance(element, _AlternateContent):
            for index, branch in enumerate(element):
                if isinstance(branch, _Choice) and branch.supported:
                    element.selected_index = index
                    break
                if branch.tag == _FALLBACK and element.selected_index is None:
                    element.selected_index = index
        return element


def parse_docx_xml(payload: bytes) -> ElementTree.Element:
    """Resolve Requires where declared, while preserving both source branches."""
    parser = ElementTree.XMLParser(target=_CompatibilityTreeBuilder())
    return ElementTree.fromstring(payload, parser=parser)


def selected_children(element: ElementTree.Element) -> Iterator[ElementTree.Element]:
    """Treat the chosen branch's children as members of the surrounding story or structure."""
    for child in element:
        if isinstance(child, _AlternateContent):
            if child.selected_index is not None:
                yield from selected_children(child[child.selected_index])
        else:
            yield child


def missing_branch_paths(
    element: ElementTree.Element, path: tuple[int, ...] = (0,)
) -> Iterator[tuple[int, ...]]:
    """Locate gaps in the selected projection using original element-only paths."""
    if isinstance(element, _AlternateContent):
        index = element.selected_index
        if index is None:
            yield path
        else:
            yield from missing_branch_paths(element[index], (*path, index))
        return
    for index, child in enumerate(element):
        yield from missing_branch_paths(child, (*path, index))
