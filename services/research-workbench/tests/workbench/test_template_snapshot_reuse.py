"""Focused reuse checks for verified template snapshots and display locations."""

import sqlite3

import pytest

from research_file_workbench.journals import template_models
from research_file_workbench.journals.store_records import WorldStoreError
from research_file_workbench.journals.template_models import template_reference_locations
from research_file_workbench.workbench.template_service import (
    _retained_template_snapshot,
    prepare_template,
)
from tests.workbench.test_template_service import (
    adopt_payload,
    post,
    template_bytes,
    upload,
)


def template_context(server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    status, adopted = post(server, "/api/template-world", payload)
    assert status == 200, adopted
    status, project = post(
        server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    return payload["snapshot"], adopted, project


def prepared_template(server):
    template_snapshot, adopted, project = template_context(server)
    prepared = prepare_template(
        server.service,
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": adopted["version_id"],
        },
    )
    return template_snapshot, prepared["world"]


def test_prepare_validates_template_snapshot_once_and_reuses_it(running_server, monkeypatch):
    original_validate = template_models.validate_snapshot
    validations = []

    def counted_validate(snapshot, content, *, require_current=False):
        validations.append(require_current)
        return original_validate(snapshot, content, require_current=require_current)

    template_snapshot, adopted, project = template_context(running_server)
    monkeypatch.setattr(template_models, "validate_snapshot", counted_validate)
    prepare_template(
        running_server.service,
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": adopted["version_id"],
        },
    )
    world = running_server.service.store.get_world(adopted["version_id"])

    assert len(validations) == 1
    assert _retained_template_snapshot(running_server.service, world) == template_snapshot
    assert len(validations) == 1


def test_retained_template_snapshot_rechecks_source_bytes_before_cache_hit(running_server):
    _, prepared = prepared_template(running_server)
    world = running_server.service.store.get_world(prepared["version_id"])
    snapshot_source_id = world["template"]["snapshot_source_id"]
    with sqlite3.connect(running_server.service.store.database_path) as connection:
        connection.execute(
            "UPDATE source SET content=? WHERE source_id=?",
            (b"changed snapshot bytes", snapshot_source_id),
        )

    with pytest.raises(WorldStoreError, match="does not match its immutable identity"):
        _retained_template_snapshot(running_server.service, world)


def test_template_reference_locations_preserve_compact_display_labels():
    objects = [
        {"object_id": "/word/document.xml#0", "text": "  Body excerpt  "},
        {
            "object_id": "/word/document.xml#1",
            "text": " ",
            "table_context": {"row_index": 1, "column_index": 2},
        },
        {"object_id": "/word/document.xml#2", "text": "x" * 120},
        {"object_id": "/word/document.xml#3", "text": ""},
    ]
    styles = [{"object_id": "/word/styles.xml#0", "name": "Body Text"}]

    locations = template_reference_locations(
        {"objects": objects, "style_definitions": styles},
        {
            "/word/document.xml#0",
            "/word/document.xml#1",
            "/word/document.xml#2",
            "/word/document.xml#3",
            "/word/styles.xml#0",
            "/word/missing.xml#0",
        },
    )

    assert locations == {
        "/word/document.xml#0": "Body excerpt",
        "/word/document.xml#1": "R2 · C3 · /word/document.xml#1",
        "/word/document.xml#2": "x" * 100,
        "/word/document.xml#3": "/word/document.xml#3",
        "/word/missing.xml#0": "/word/missing.xml#0",
        "/word/styles.xml#0": "Body Text",
    }
