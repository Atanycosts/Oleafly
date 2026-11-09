"""Table grids and selected cell text observations."""

from __future__ import annotations

from typing import Literal
from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxTable, DocxTableCell
from research_file_workbench.docx.xml_support import (
    WORD_NAMESPACE,
    integer_attribute,
    iter_selected,
    on_off_value,
    region_for_part,
    selected_children,
    string_attribute,
    tag_local_name,
    text_from_element,
)


def read_tables(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxTable, ...], list[str]]:
    """Read source table grids and selected cell text without rendered geometry."""
    tables: list[DocxTable] = []
    issues: list[str] = []
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        for table_index, table in enumerate(
            (element for element in iter_selected(root) if tag_local_name(element.tag) == "tbl"),
            start=1,
        ):
            grid = next(
                (
                    child
                    for child in selected_children(table)
                    if tag_local_name(child.tag) == "tblGrid"
                ),
                None,
            )
            grid_widths = tuple(
                value
                for child in (selected_children(grid) if grid is not None else ())
                if (value := integer_attribute(child, WORD_NAMESPACE, "w")) is not None
            )
            rows: list[tuple[DocxTableCell, ...]] = []
            repeat_header_rows: list[int] = []
            for row_index, row in enumerate(
                child for child in selected_children(table) if tag_local_name(child.tag) == "tr"
            ):
                row_properties = next(
                    (
                        child
                        for child in selected_children(row)
                        if tag_local_name(child.tag) == "trPr"
                    ),
                    None,
                )
                if row_properties is not None and any(
                    child.tag == f"{{{WORD_NAMESPACE}}}tblHeader" and on_off_value(child)
                    for child in selected_children(row_properties)
                ):
                    repeat_header_rows.append(row_index)
                cells: list[DocxTableCell] = []
                for cell_index, cell in enumerate(
                    child for child in selected_children(row) if tag_local_name(child.tag) == "tc"
                ):
                    properties = next(
                        (
                            child
                            for child in selected_children(cell)
                            if tag_local_name(child.tag) == "tcPr"
                        ),
                        None,
                    )
                    grid_span = 1
                    vertical_merge: Literal["none", "restart", "continue"] = "none"
                    if properties is not None:
                        grid_span_element = next(
                            (
                                child
                                for child in selected_children(properties)
                                if tag_local_name(child.tag) == "gridSpan"
                            ),
                            None,
                        )
                        if grid_span_element is not None:
                            parsed_grid_span = integer_attribute(
                                grid_span_element, WORD_NAMESPACE, "val"
                            )
                            if parsed_grid_span is None or parsed_grid_span < 1:
                                issues.append(f"invalid-grid-span:{part_path}#table[{table_index}]")
                            else:
                                grid_span = parsed_grid_span
                        vertical_merge_element = next(
                            (
                                child
                                for child in selected_children(properties)
                                if tag_local_name(child.tag) == "vMerge"
                            ),
                            None,
                        )
                        if vertical_merge_element is not None:
                            vertical_merge = (
                                "restart"
                                if string_attribute(vertical_merge_element, WORD_NAMESPACE, "val")
                                == "restart"
                                else "continue"
                            )
                    cells.append(
                        DocxTableCell(
                            row_index=row_index,
                            cell_index=cell_index,
                            node_locator=(
                                f"{part_path}#table[{table_index}]/row[{row_index + 1}]"
                                f"/cell[{cell_index + 1}]"
                            ),
                            text=text_from_element(cell),
                            grid_span=grid_span,
                            vertical_merge=vertical_merge,
                        )
                    )
                rows.append(tuple(cells))
            tables.append(
                DocxTable(
                    part_path=part_path,
                    node_locator=f"{part_path}#table[{table_index}]",
                    grid_widths_twips=grid_widths,
                    rows=tuple(rows),
                    repeat_header_rows=tuple(repeat_header_rows),
                )
            )
    return tuple(tables), issues
