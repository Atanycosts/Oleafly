"""Read-only DOCX package inspection for the first S1 vertical slice."""

from research_file_workbench.docx.models import (
    DocxBreak,
    DocxComplexObject,
    DocxField,
    DocxImage,
    DocxMathObject,
    DocxNumbering,
    DocxReadError,
    DocxReadResult,
    DocxReference,
    DocxSection,
    DocxStyle,
    DocxTable,
    DocxTableCell,
    DocxUnsupportedRecord,
)
from research_file_workbench.docx.page_mapping import (
    PAGE_MAPPING_VERSION,
    PageMappingError,
    PageMappingResult,
    join_page_evidence,
)
from research_file_workbench.docx.pipeline import S1PipelineError, run_s1_readonly
from research_file_workbench.docx.read_receipt import (
    READ_RECEIPT_VERSION,
    ReadCaller,
    ReadPagination,
    ReadRange,
    ReadReceipt,
    ReadReceiptError,
    build_read_receipt,
    load_read_receipt,
    write_read_receipt,
)
from research_file_workbench.docx.reader import read_docx
from research_file_workbench.docx.report import (
    READER_VERSION,
    REPORT_VERSION,
    docx_read_result_to_report,
)

__all__ = [
    "DocxBreak",
    "DocxComplexObject",
    "DocxField",
    "DocxImage",
    "DocxMathObject",
    "DocxNumbering",
    "DocxReference",
    "DocxReadError",
    "DocxReadResult",
    "DocxSection",
    "DocxStyle",
    "DocxTable",
    "DocxTableCell",
    "PAGE_MAPPING_VERSION",
    "PageMappingError",
    "PageMappingResult",
    "DocxUnsupportedRecord",
    "REPORT_VERSION",
    "READER_VERSION",
    "docx_read_result_to_report",
    "read_docx",
    "join_page_evidence",
    "run_s1_readonly",
    "S1PipelineError",
    "READ_RECEIPT_VERSION",
    "ReadPagination",
    "ReadCaller",
    "ReadRange",
    "ReadReceipt",
    "ReadReceiptError",
    "build_read_receipt",
    "load_read_receipt",
    "write_read_receipt",
]
