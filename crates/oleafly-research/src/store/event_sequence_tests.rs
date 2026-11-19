use super::*;
use crate::docx::{DocxDocumentIdentity, DocxRuntimeEvent};
use crate::model::ToolPhase;

fn running() -> (
    tempfile::TempDir,
    TaskStore,
    ResearchTask,
    DocxDocumentIdentity,
) {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::new(directory.path().join("tasks")).unwrap();
    let task = store
        .create(crate::test_support::draft(
            "paper",
            "Retain parallel results",
        ))
        .unwrap();
    let document = DocxDocumentIdentity {
        session_id: "docx-session".into(),
        app_project_id: "paper".into(),
        workbench_project_id: "manuscript".into(),
        baseline_id: "baseline".into(),
        source_sha256: "a".repeat(64),
        filename: None,
        title: None,
        session_revision: 0,
        saved_revision: 0,
    };
    store
        .bind_docx_task("paper", &task.id, document.clone())
        .unwrap();
    store.request_start(&task.id).unwrap();
    let task = store.claim_next().unwrap().unwrap();
    (directory, store, task, document)
}

fn queued(store: &TaskStore, task: &ResearchTask, event: TaskRuntimeEvent) -> EventWrite {
    EventWrite {
        task_id: task.id.clone(),
        generation: task.execution_generation,
        sequence: store
            .reserve_event_sequence(&task.id, task.execution_generation)
            .unwrap(),
        event_json: encode_json(&event).unwrap(),
        created_at: now_ms(),
        replace: false,
    }
}

#[test]
fn queued_tool_results_and_docx_facts_share_one_reserved_sequence_owner() {
    let (_directory, store, task, document) = running();
    let result = TaskRuntimeEvent::Tool {
        call_id: Some("template-page-1265".into()),
        name: "journal_read".into(),
        phase: ToolPhase::Result,
        detail: "all 47 exact objects; next_offset=1312".into(),
        status: Some("done".into()),
    };
    // Reserve first, but deliberately leave the recorder row unflushed while a different
    // connection commits a domain activity. This is the actual lost-result interleaving.
    let write = queued(&store, &task, result.clone());
    let domain = store
        .record_docx_activity(
            "paper",
            &task.id,
            task.execution_generation,
            document,
            DocxRuntimeEvent::Read {
                offset: 500,
                paragraphs: Vec::new(),
            },
        )
        .unwrap();
    let domain_row = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    assert_eq!(domain_row.len(), 1);
    assert!(domain_row[0].sequence > write.sequence);
    let mut connection = store.writer_connection().unwrap();
    TaskStore::write_events_on(&mut connection, std::slice::from_ref(&write)).unwrap();
    let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
    let events = reopened
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].sequence, write.sequence);
    assert_eq!(events[0].event, result);
    assert_eq!(events[1], domain_row[0]);
    assert_eq!(
        reopened
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap()
            .activities
            .last()
            .unwrap()
            .activity,
        domain
    );
    assert!(
        reopened
            .reserve_event_sequence(&task.id, task.execution_generation)
            .unwrap()
            > events[1].sequence
    );
}

#[test]
fn event_write_replay_requires_identical_payload_and_creation_time() {
    let (_directory, store, task, _document) = running();
    let write = queued(
        &store,
        &task,
        TaskRuntimeEvent::Status {
            message: "retained".into(),
        },
    );
    store.write_events(std::slice::from_ref(&write)).unwrap();
    store.write_events(std::slice::from_ref(&write)).unwrap();
    let mut different = write.clone();
    different.event_json = encode_json(&TaskRuntimeEvent::Status {
        message: "other".into(),
    })
    .unwrap();
    assert!(store
        .write_events(&[different])
        .unwrap_err()
        .contains("different event"));
    different = write.clone();
    different.created_at += 1;
    assert!(store
        .write_events(&[different])
        .unwrap_err()
        .contains("different event"));
    let events = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    assert_eq!(events.len(), 1);
    assert_eq!(encode_json(&events[0].event).unwrap(), write.event_json);
    assert_eq!(events[0].created_at, write.created_at);
}

#[test]
fn text_segment_updates_cannot_replace_domain_facts_or_other_segment_identities() {
    let (_directory, store, task, document) = running();
    let domain = store
        .record_docx_activity(
            "paper",
            &task.id,
            task.execution_generation,
            document,
            DocxRuntimeEvent::Read {
                offset: 0,
                paragraphs: Vec::new(),
            },
        )
        .unwrap();
    let domain_row = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events
        .remove(0);
    let mut update = EventWrite {
        task_id: task.id.clone(),
        generation: task.execution_generation,
        sequence: domain_row.sequence,
        event_json: encode_json(&TaskRuntimeEvent::Text {
            text: "wrong".into(),
        })
        .unwrap(),
        created_at: domain_row.created_at,
        replace: true,
    };
    assert!(store
        .write_events(std::slice::from_ref(&update))
        .unwrap_err()
        .contains("text segment"));
    let text = queued(
        &store,
        &task,
        TaskRuntimeEvent::Text {
            text: "first".into(),
        },
    );
    store.write_events(std::slice::from_ref(&text)).unwrap();
    update.sequence = text.sequence;
    update.created_at = text.created_at + 1;
    assert!(store
        .write_events(std::slice::from_ref(&update))
        .unwrap_err()
        .contains("text segment"));
    update.created_at = text.created_at;
    update.event_json = encode_json(&TaskRuntimeEvent::Reasoning {
        text: "other kind".into(),
    })
    .unwrap();
    assert!(store
        .write_events(std::slice::from_ref(&update))
        .unwrap_err()
        .contains("text segment"));
    update.event_json = encode_json(&TaskRuntimeEvent::Text {
        text: "first second".into(),
    })
    .unwrap();
    store.write_events(std::slice::from_ref(&update)).unwrap();
    store.write_events(&[update]).unwrap();
    let events = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].sequence, text.sequence);
    assert_eq!(
        events[1].event,
        TaskRuntimeEvent::Text {
            text: "first second".into()
        }
    );
    assert_eq!(
        store
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap()
            .activities
            .last()
            .unwrap()
            .activity,
        domain
    );
}

#[test]
fn event_sequence_migration_backfills_without_rewriting_and_never_reuses_trimmed_slots() {
    let (_directory, store, task, _document) = running();
    let write = EventWrite {
        sequence: 50,
        ..queued(
            &store,
            &task,
            TaskRuntimeEvent::Text {
                text: "old text".into(),
            },
        )
    };
    store.write_events(&[write]).unwrap();
    let mut connection = store.writer_connection().unwrap();
    let before = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    connection.execute_batch("ALTER TABLE research_task_generations DROP COLUMN event_sequence; PRAGMA user_version=16;").unwrap();
    drop(connection);
    let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .events(&task.id, task.execution_generation, None, 10)
            .unwrap()
            .events,
        before
    );
    assert_eq!(
        reopened
            .reserve_event_sequence(&task.id, task.execution_generation)
            .unwrap(),
        51
    );
    let appended = reopened
        .append_event(
            &task.id,
            task.execution_generation,
            &TaskRuntimeEvent::Text {
                text: "new text".into(),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(appended.sequence, 52);
    connection = reopened.writer_connection().unwrap();
    connection
        .execute(
            "DELETE FROM research_task_events WHERE task_id=?1 AND execution_generation=?2",
            params![task.id, task.execution_generation as i64],
        )
        .unwrap();
    drop(connection);
    let reopened = TaskStore::new(reopened.root().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .reserve_event_sequence(&task.id, task.execution_generation)
            .unwrap(),
        53
    );
}

#[test]
fn rolled_back_docx_activity_does_not_commit_its_sequence_reservation() {
    let (_directory, store, task, document) = running();
    let first = store
        .reserve_event_sequence(&task.id, task.execution_generation)
        .unwrap();
    let connection = store.writer_connection().unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER reject_docx_cursor BEFORE INSERT ON research_task_docx_cursors
        BEGIN SELECT RAISE(ABORT, 'fixture cursor failure'); END;",
        )
        .unwrap();
    assert!(store
        .record_docx_activity(
            "paper",
            &task.id,
            task.execution_generation,
            document.clone(),
            DocxRuntimeEvent::Read {
                offset: 0,
                paragraphs: Vec::new()
            }
        )
        .is_err());
    assert!(store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events
        .is_empty());
    connection
        .execute_batch("DROP TRIGGER reject_docx_cursor;")
        .unwrap();
    store
        .record_docx_activity(
            "paper",
            &task.id,
            task.execution_generation,
            document,
            DocxRuntimeEvent::Read {
                offset: 0,
                paragraphs: Vec::new(),
            },
        )
        .unwrap();
    let events = store
        .events(&task.id, task.execution_generation, None, 10)
        .unwrap()
        .events;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].sequence, first + 1);
}
