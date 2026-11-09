"""Errors shared by the controlled DOCX pipeline modules."""


class S1PipelineError(ValueError):
    """Raised when a controlled S1 run cannot satisfy its storage boundaries."""
