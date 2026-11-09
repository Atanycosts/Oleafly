import math
from pathlib import Path

import pytest

from research_file_workbench.common.json_io import (
    JsonDocumentError,
    decode_json_object,
    encode_json_object,
    load_json_object,
    write_json_object,
)


@pytest.mark.parametrize("payload", ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}'])
def test_duplicate_json_keys_are_refused(payload: str) -> None:
    with pytest.raises(JsonDocumentError, match="Duplicate"):
        decode_json_object(payload)


@pytest.mark.parametrize("payload", ['{"a":NaN}', '{"a":Infinity}', "[]", b"\xff"])
def test_invalid_json_objects_are_refused(payload: str | bytes) -> None:
    with pytest.raises(JsonDocumentError):
        decode_json_object(payload)


def test_json_file_rejects_ambiguous_input(tmp_path: Path) -> None:
    path = tmp_path / "input.json"
    path.write_text('{"status":"failed","status":"passed"}', encoding="utf-8")
    with pytest.raises(JsonDocumentError, match="Duplicate"):
        load_json_object(path)


def test_encoding_is_stable_and_does_not_escape_unicode() -> None:
    assert encode_json_object({"z": "文字", "a": 1}) == '{"a":1,"z":"文字"}'
    assert decode_json_object(encode_json_object({"a": [1, True, None]})) == {"a": [1, True, None]}


def test_nonfinite_write_preserves_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "result.json"
    write_json_object(path, {"value": 1})
    with pytest.raises(ValueError):
        write_json_object(path, {"value": math.nan})
    assert load_json_object(path) == {"value": 1}
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("payload", ['{"value":1e1000}', '{"values":[-1e1000]}'])
def test_floating_point_overflow_is_refused_at_decode_boundary(payload):
    with pytest.raises(JsonDocumentError, match="finite float"):
        decode_json_object(payload)


@pytest.mark.parametrize("value", [[], {"nested": {1: "value"}}, {"nested": [{None: "value"}]}])
def test_object_encoding_refuses_nonobjects_and_coerced_keys(value, tmp_path):
    with pytest.raises(JsonDocumentError):
        encode_json_object(value)
    output = tmp_path / "result.json"
    write_json_object(output, {"existing": True})
    with pytest.raises(JsonDocumentError):
        write_json_object(output, value)
    assert load_json_object(output) == {"existing": True}


def test_finite_exponents_round_trip_without_value_drift():
    value = decode_json_object('{"value":1.25e100}')
    assert decode_json_object(encode_json_object(value)) == value
