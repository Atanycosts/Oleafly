"""Drawing, OMML, and embedded-object observations."""

from __future__ import annotations

from typing import Literal
from xml.etree import ElementTree

from research_file_workbench.docx.models import (
    DocxComplexObject,
    DocxImage,
    DocxMathObject,
    DocxRelationship,
)
from research_file_workbench.docx.xml_support import (
    DRAWING_MAIN_NAMESPACE,
    OFFICE_RELATIONSHIP_NAMESPACE,
    WORD_NAMESPACE,
    WORDPROCESSING_DRAWING_NAMESPACE,
    first_descendant,
    integer_attribute,
    iter_selected,
    paragraph_membership,
    region_for_part,
    string_attribute,
    tag_local_name,
    text_from_element,
)


def read_images(
    xml_roots: dict[str, ElementTree.Element],
    relationships: tuple[DocxRelationship, ...],
) -> tuple[tuple[DocxImage, ...], list[str]]:
    """Read image relationships and source paragraph ancestry without page inference."""
    images: list[DocxImage] = []
    issues: list[str] = []
    relation_map = {
        (relation.source_part, relation.relationship_id): relation for relation in relationships
    }
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        parent_paragraphs = paragraph_membership(root, part_path)
        for image_index, drawing in enumerate(
            (
                element
                for element in iter_selected(root)
                if tag_local_name(element.tag) == "drawing"
            ),
            start=1,
        ):
            container_element = next(
                (
                    element
                    for element in drawing
                    if tag_local_name(element.tag) in {"inline", "anchor"}
                ),
                None,
            )
            container_name = (
                tag_local_name(container_element.tag)
                if container_element is not None
                else "unknown"
            )
            container: Literal["inline", "anchored", "unknown"] = (
                "inline"
                if container_name == "inline"
                else "anchored"
                if container_name == "anchor"
                else "unknown"
            )
            extent = first_descendant(drawing, WORDPROCESSING_DRAWING_NAMESPACE, "extent")
            docpr = first_descendant(drawing, WORDPROCESSING_DRAWING_NAMESPACE, "docPr")
            blip = first_descendant(drawing, DRAWING_MAIN_NAMESPACE, "blip")
            relationship_id = (
                string_attribute(blip, OFFICE_RELATIONSHIP_NAMESPACE, "embed")
                if blip is not None
                else None
            )
            if container_element is None or blip is None:
                continue
            relation = relation_map.get((part_path, relationship_id or ""))
            wrap_element = next(
                (
                    element
                    for element in (container_element if container_element is not None else ())
                    if tag_local_name(element.tag).startswith("wrap")
                ),
                None,
            )
            parse_status: Literal["parsed", "partial", "unsupported"]
            if relation is None or relation.resolved_target is None:
                parse_status = "partial"
                issues.append(f"unresolved-image-relationship:{part_path}:{relationship_id}")
            else:
                parse_status = "parsed"
            images.append(
                DocxImage(
                    part_path=part_path,
                    node_locator=f"{part_path}#drawing[{image_index}]",
                    container=container,
                    relationship_id=relationship_id,
                    resource_part=relation.resolved_target if relation else None,
                    width_emu=integer_attribute(extent, WORDPROCESSING_DRAWING_NAMESPACE, "cx"),
                    height_emu=integer_attribute(extent, WORDPROCESSING_DRAWING_NAMESPACE, "cy"),
                    docpr_id=string_attribute(docpr, WORDPROCESSING_DRAWING_NAMESPACE, "id"),
                    name=string_attribute(docpr, WORDPROCESSING_DRAWING_NAMESPACE, "name"),
                    wrap_type=tag_local_name(wrap_element.tag)
                    if wrap_element is not None
                    else None,
                    parse_status=parse_status,
                    paragraph_locator=parent_paragraphs.get(id(drawing)),
                )
            )
    return tuple(images), issues


def read_math_objects(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxMathObject, ...], list[str]]:
    """Preserve OMML nodes with their exact selected paragraph ancestry."""
    math_objects: list[DocxMathObject] = []
    issues: list[str] = []
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        parent_paragraphs = paragraph_membership(root, part_path)
        display_ids = {
            id(child)
            for parent in root.iter()
            if tag_local_name(parent.tag) == "oMathPara"
            for child in iter_selected(parent)
            if tag_local_name(child.tag) == "oMath"
        }
        math_index = 0
        for element in iter_selected(root):
            local_name = tag_local_name(element.tag)
            if local_name == "oMathPara":
                math_index += 1
                math_objects.append(
                    DocxMathObject(
                        part_path=part_path,
                        node_locator=f"{part_path}#omml[{math_index}]",
                        kind="display",
                        text=text_from_element(element),
                        omml_source=ElementTree.tostring(element, encoding="unicode"),
                        paragraph_locator=parent_paragraphs.get(id(element)),
                    )
                )
            elif local_name == "oMath" and id(element) not in display_ids:
                math_index += 1
                math_objects.append(
                    DocxMathObject(
                        part_path=part_path,
                        node_locator=f"{part_path}#omml[{math_index}]",
                        kind="inline",
                        text=text_from_element(element),
                        omml_source=ElementTree.tostring(element, encoding="unicode"),
                        paragraph_locator=parent_paragraphs.get(id(element)),
                    )
                )
    return tuple(math_objects), issues


def read_complex_objects(
    xml_roots: dict[str, ElementTree.Element],
    relationships: tuple[DocxRelationship, ...],
) -> tuple[tuple[DocxComplexObject, ...], list[str]]:
    """Register embedded objects without executing or interpreting their payloads."""
    objects: list[DocxComplexObject] = []
    issues: list[str] = []
    relation_map = {
        (relation.source_part, relation.relationship_id): relation for relation in relationships
    }
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        parent_paragraphs = paragraph_membership(root, part_path)
        parent_map = {id(child): parent for parent in root.iter() for child in parent}
        for object_index, element in enumerate(root.iter(), start=1):
            local_name = tag_local_name(element.tag)
            kind: Literal["chart", "ole", "group_drawing", "unknown_extension"] | None = None
            if local_name == "chart":
                kind = "chart"
            elif local_name == "OLEObject":
                kind = "ole"
            elif local_name == "wgp":
                kind = "group_drawing"
            elif local_name == "unknownObject":
                kind = "unknown_extension"
            if kind is None:
                continue
            source_paragraph_locator = parent_paragraphs.get(id(element))
            ancestor = parent_map.get(id(element))
            while source_paragraph_locator is None and ancestor is not None:
                if ancestor.tag == f"{{{WORD_NAMESPACE}}}p":
                    # Source ancestry remains observable for an unselected Choice object.
                    # Do not cross an unselected inner paragraph to claim an outer anchor.
                    source_paragraph_locator = parent_paragraphs.get(id(ancestor))
                    break
                ancestor = parent_map.get(id(ancestor))
            context_elements = [element]
            parent = parent_map.get(id(element))
            while parent is not None:
                context_elements.append(parent)
                if tag_local_name(parent.tag) in {"drawing", "object", "AlternateContent"}:
                    break
                parent = parent_map.get(id(parent))
            relationship_ids = tuple(
                sorted(
                    {
                        relationship_id
                        for context_element in context_elements
                        for child in context_element.iter()
                        for attribute_name, relationship_id in child.attrib.items()
                        if attribute_name.startswith(f"{{{OFFICE_RELATIONSHIP_NAMESPACE}}}")
                    }
                )
            )
            related_parts = _follow_related_parts(part_path, relationship_ids, relation_map)
            metadata: dict[str, str] = {
                f"{element.tag}@{name}": value for name, value in element.attrib.items()
            }
            for context in context_elements:
                for child in context.iter():
                    if child.tag == f"{{{WORDPROCESSING_DRAWING_NAMESPACE}}}docPr":
                        for name, value in child.attrib.items():
                            metadata[f"{child.tag}@{name}"] = value
            available_preview = tuple(
                sorted(
                    {
                        related_part
                        for related_part in related_parts
                        if related_part.casefold().endswith(
                            (".png", ".jpg", ".jpeg", ".emf", ".wmf")
                        )
                    }
                )
            )
            parse_status: Literal["registered", "unsupported"] = "registered"
            if kind in {"chart", "ole", "group_drawing"}:
                parse_status = "unsupported"
            objects.append(
                DocxComplexObject(
                    part_path=part_path,
                    node_locator=f"{part_path}#complex[{object_index}]",
                    kind=kind,
                    relationship_ids=relationship_ids,
                    related_parts=related_parts,
                    available_preview=available_preview,
                    parse_status=parse_status,
                    paragraph_locator=source_paragraph_locator,
                    metadata=tuple(sorted(metadata.items())),
                )
            )
            if kind in {"chart", "ole"} and not relationship_ids:
                issues.append(f"complex-object-without-relationship:{part_path}#{object_index}")
    return tuple(objects), issues


def _follow_related_parts(
    source_part: str,
    relationship_ids: tuple[str, ...],
    relation_map: dict[tuple[str, str], DocxRelationship],
) -> tuple[str, ...]:
    related_parts: set[str] = set()
    pending: list[tuple[str, str]] = [
        (source_part, relationship_id) for relationship_id in relationship_ids
    ]
    visited: set[tuple[str, str]] = set()
    while pending:
        current_source, relationship_id = pending.pop()
        identity = (current_source, relationship_id)
        if identity in visited:
            continue
        visited.add(identity)
        relation = relation_map.get(identity)
        if relation is None or relation.resolved_target is None:
            continue
        target = relation.resolved_target
        related_parts.add(target)
        pending.extend(
            nested_relation for nested_relation in relation_map if nested_relation[0] == target
        )
    return tuple(sorted(related_parts))
