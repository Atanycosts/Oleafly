# Independent annotation guide

## Purpose

Annotations are the expected results used to evaluate the future DOCX reader. Parser output must not
be copied into the annotation and then used to validate the same parser.

## Annotation units

Annotate each known object with:

- stable annotation ID;
- source artifact ID and hash;
- region: body, header, footer, footnote, endnote, or text box;
- object kind;
- human-readable locator and page evidence;
- expected support level;
- expected relationships;
- known ambiguity or limitation;
- annotator and review status.

## Support levels

- `required_structural_result`: the reader must return the declared structure and core properties.
- `register_and_render`: the reader must preserve existence, location, relationships, and available
  page appearance, without claiming semantic understanding.
- `declared_unsupported`: the reader must report the object and limitation without silently omitting it.

## Independence rules

- Use Word/WPS page inspection and direct package inspection as separate evidence paths.
- A page appearance does not prove internal object semantics.
- A ZIP/XML object does not prove its visual location.
- Uncertain annotations stay `pending_review`; do not force a pass/fail answer.
- Page numbers always bind to a rendered PDF hash and render profile.

Templates are under `annotations/templates/`.
