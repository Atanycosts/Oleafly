# Annotation workspace

This directory contains independent expected-result templates. It must not contain generated parser
output presented as ground truth.

- `templates/document-annotation.template.json`: structural object expectations.
- `templates/page-evidence.template.json`: page evidence and mapping expectations.

Completed annotations should use stable sample IDs and be reviewed by a person independent of the
reader implementation.

The committed `s1/s1-*` records bind synthetic regression fixtures. Real manuscript annotations
remain private and ignored; moving them into a repository does not grant publication consent.
