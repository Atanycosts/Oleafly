use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::collaboration::{
    GroupEvent, GroupSnapshot, GroupStatus, InterestKind, MemberDraft, MemberInterest,
    MessageDraft, WorkStatus,
};
use crate::model::{ResearchTask, ResearchTaskDraft, ResearchTaskStatus};
use crate::workbench::WorkbenchRecordEvent;

struct Fixture {
    _directory: TempDir,
    store: TaskStore,
    task: ResearchTask,
    scope: WorkbenchScope,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Review retained journal evidence".into(),
                prompt: "Compare the manuscript with its selected Workbench records".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        Self {
            _directory: directory,
            store,
            task,
            scope: WorkbenchScope {
                library_root: "/retained/journal-library".into(),
                project_id: "project-manuscript".into(),
            },
        }
    }

    fn group(&self) -> GroupSnapshot {
        self.store
            .create_task_group(
                "paper",
                Some(&self.task.id),
                &[
                    MemberDraft {
                        name: "Coordinator".into(),
                        responsibility: "Integrate results".into(),
                        runtime_id: "fixture".into(),
                        coordinator: true,
                        ..Default::default()
                    },
                    MemberDraft {
                        name: "Journal reviewer".into(),
                        responsibility: "Inspect changed journal evidence".into(),
                        runtime_id: "fixture".into(),
                        ..Default::default()
                    },
                ],
            )
            .unwrap()
    }

    fn subscribe(&self, group: &GroupSnapshot, kind: InterestKind, value: &str) {
        let reviewer = group
            .members
            .iter()
            .find(|member| !member.config.coordinator)
            .unwrap();
        self.store
            .set_member_interest(
                "paper",
                &group.group.id,
                &MemberInterest {
                    member_id: reviewer.id.clone(),
                    kind,
                    value: value.into(),
                },
                true,
            )
            .unwrap();
    }

    fn context(&self) -> TaskWorkbenchContext {
        self.store
            .task_workbench_context(&self.task.id, 0, 100)
            .unwrap()
    }

    fn reconcile(
        &self,
        records: &[CommittedWorkbenchRecord],
        current: Value,
    ) -> WorkbenchReconcileSummary {
        self.store
            .reconcile_workbench(&self.task.id, &self.scope, records, current)
            .unwrap()
    }

    fn event_count(&self, group: &str) -> u64 {
        self.store
            .open()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collaboration_events WHERE group_id=?1",
                [group],
                |row| row.get(0),
            )
            .unwrap()
    }
}

fn record(kind: &str, id: &str, revision: &str) -> CommittedWorkbenchRecord {
    CommittedWorkbenchRecord {
        kind: kind.into(),
        record_id: id.into(),
        revision: revision.into(),
        object: GroupObject {
            kind: format!("journal_{kind}"),
            id: id.into(),
            revision: Some(revision.into()),
            path: None,
        },
        event_kind: if kind == "world" {
            WorkbenchRecordEvent::UpdateAvailable
        } else {
            WorkbenchRecordEvent::RecordCommitted
        },
        snapshot: json!({"retained_id": id, "revision": revision}),
    }
}

fn current(binding: &str, baseline: &str) -> Value {
    json!({
        "binding": {"binding_id": binding, "world_version_id": "world-1"},
        "baseline": {"baseline_id": baseline},
        "checks": [{"check_id": "check-1", "validity": "CURRENT", "update_available": false}],
        "latex_applicability": "not_checked"
    })
}

fn native_current() -> Value {
    json!({
        "schemaVersion": crate::workbench::CURRENT_SCHEMA_VERSION,
        "scope": {"libraryRoot": "/retained/journal-library", "projectId": "project-manuscript"},
        "captured": {"worldVersionId": "world-1"},
        "project": {
            "manuscriptId": "project-manuscript", "baselineId": "baseline-1",
            "binding": {"binding_id": "binding-a", "world_version_id": "world-1"},
            "latestCheck": null
        },
        "checks": {},
        "latexApplicability": {"status": "not_checked"}
    })
}

fn add_native_check(current: &mut Value, id: &str) {
    let checked = json!({
        "checkId": id, "bindingId": "binding-a", "baselineId": "baseline-1",
        "worldVersionId": "world-1", "validity": "CURRENT",
        "staleReasons": [], "updateAvailable": false, "dispositionIds": []
    });
    current["checks"][id] = checked.clone();
    current["project"]["latestCheck"] = checked;
}

fn running_origin() -> (Fixture, GroupSnapshot, GroupActor) {
    let fixture = Fixture::new();
    fixture.store.request_start(&fixture.task.id).unwrap();
    let task = fixture.store.claim_next().unwrap().unwrap();
    let group = fixture.group();
    let origin = group
        .members
        .iter()
        .find(|member| member.config.coordinator)
        .unwrap();
    fixture
        .store
        .group_message(
            "paper",
            &group.group.id,
            &GroupActor::user(),
            &MessageDraft {
                body: "Run the bound journal check".into(),
                recipients: vec![origin.id.clone()],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    let turn = fixture.store.claim_member_turn(&task).unwrap().unwrap();
    let actor = GroupActor {
        kind: ActorKind::Member,
        id: turn.member.id,
        execution_id: Some(turn.execution.id),
    };
    (fixture, group, actor)
}

fn subscribe_both(fixture: &Fixture, group: &GroupSnapshot, kind: InterestKind, value: &str) {
    for member in &group.members {
        fixture
            .store
            .set_member_interest(
                "paper",
                &group.group.id,
                &MemberInterest {
                    member_id: member.id.clone(),
                    kind: kind.clone(),
                    value: value.into(),
                },
                true,
            )
            .unwrap();
    }
}

#[test]
fn complete_rescan_recovers_all_commits_with_equal_times_and_out_of_order_delivery() {
    let fixture = Fixture::new();
    let mut first = record("binding", "binding-a", "r1");
    let mut second = record("check", "check-a", "r1");
    let mut older = record("binding", "binding-older", "r0");
    for item in [&mut first, &mut second, &mut older] {
        item.snapshot["created_at"] = json!("2026-11-09T00:00:00Z");
    }
    let summary = fixture.reconcile(&[first.clone()], current("binding-a", "baseline-1"));
    assert_eq!(summary.recorded, 1);
    assert!(!summary.current_changed);
    assert!(summary.routed_members.is_empty());
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let summary = reopened
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &[second.clone(), first.clone(), older.clone()],
            current("binding-a", "baseline-1"),
        )
        .unwrap();
    assert_eq!(summary.recorded, 2);
    assert_eq!(summary.duplicates, 1);
    let context = reopened
        .task_workbench_context(&fixture.task.id, 0, 100)
        .unwrap();
    assert_eq!(context.scope, Some(fixture.scope.clone()));
    assert_eq!(
        context
            .records
            .iter()
            .map(|receipt| receipt.record.clone())
            .collect::<Vec<_>>(),
        vec![first, second, older]
    );
    for receipt in &context.records {
        assert_eq!(
            receipt.snapshot_sha256,
            content_hash(
                serde_json::to_vec(&receipt.record.snapshot)
                    .unwrap()
                    .as_slice()
            )
        );
    }
    assert_eq!(context.next_sequence, summary.next_sequence);
    assert!(!context.has_more);
    assert_eq!(
        context.current.unwrap().snapshot,
        current("binding-a", "baseline-1")
    );
    let task = reopened.require(&fixture.task.id).unwrap();
    assert_eq!(task.status, ResearchTaskStatus::Queued);
    assert!(!task.start_requested);
}

#[test]
fn bounded_context_cursor_retains_each_revision_and_always_returns_current() {
    let fixture = Fixture::new();
    let revisions = [
        record("check", "check-a", "r1"),
        record("check", "check-a", "r2"),
        record("disposition", "decision-a", "r1"),
    ];
    fixture.reconcile(&revisions, current("binding-a", "baseline-1"));
    let first = fixture
        .store
        .task_workbench_context(&fixture.task.id, 0, 1)
        .unwrap();
    assert_eq!(first.records.len(), 1);
    assert!(first.has_more);
    assert_eq!(first.records[0].record, revisions[0]);
    let rest = fixture
        .store
        .task_workbench_context(&fixture.task.id, first.next_sequence, 2)
        .unwrap();
    assert_eq!(rest.records.len(), 2);
    assert!(!rest.has_more);
    assert_eq!(rest.records[0].record, revisions[1]);
    assert_eq!(rest.records[1].record, revisions[2]);
    assert_eq!(rest.current, first.current);
    let tail = fixture
        .store
        .task_workbench_context(&fixture.task.id, rest.next_sequence, usize::MAX)
        .unwrap();
    assert!(tail.records.is_empty());
    assert_eq!(tail.next_sequence, rest.next_sequence);
    assert_eq!(tail.current, first.current);
}

#[test]
fn scope_mismatch_or_identity_conflict_rolls_back_the_whole_batch() {
    let fixture = Fixture::new();
    let original = record("check", "check-a", "r1");
    fixture.reconcile(
        std::slice::from_ref(&original),
        current("binding-a", "baseline-1"),
    );
    let before = fixture.context();
    for other_scope in [
        WorkbenchScope {
            library_root: "/another-library".into(),
            ..fixture.scope.clone()
        },
        WorkbenchScope {
            project_id: "project-another".into(),
            ..fixture.scope.clone()
        },
    ] {
        assert!(fixture
            .store
            .reconcile_workbench(
                &fixture.task.id,
                &other_scope,
                &[record("binding", "new-binding", "r2")],
                current("new-binding", "baseline-2"),
            )
            .unwrap_err()
            .contains("another Workbench"));
        assert_eq!(fixture.context(), before);
    }
    let mut conflicting = original;
    conflicting.snapshot["replaced_verdict"] = json!(true);
    assert!(fixture
        .store
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &[record("binding", "new-binding", "r2"), conflicting],
            current("new-binding", "baseline-2"),
        )
        .unwrap_err()
        .contains("different content"));
    assert_eq!(fixture.context(), before);
}

#[test]
fn routing_failure_rolls_back_receipts_current_events_and_work_then_rescan_recovers() {
    let fixture = Fixture::new();
    let group = fixture.group();
    fixture.subscribe(&group, InterestKind::Event, "workbench_record_committed");
    fixture
        .store
        .open()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_workbench_event BEFORE INSERT ON collaboration_events
             WHEN json_extract(NEW.event_json,'$.object.id')='check-failing'
             BEGIN SELECT RAISE(ABORT,'fixture routing failure'); END;",
        )
        .unwrap();
    let batch = [
        record("binding", "binding-a", "r1"),
        record("check", "check-failing", "r1"),
    ];
    assert!(fixture
        .store
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &batch,
            current("binding-a", "baseline-1"),
        )
        .unwrap_err()
        .contains("fixture routing failure"));
    let context = fixture.context();
    assert!(context.records.is_empty());
    assert!(context.scope.is_none());
    assert!(context.current.is_none());
    assert_eq!(fixture.event_count(&group.group.id), 0);
    assert!(fixture
        .store
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap()
        .work
        .is_empty());
    fixture
        .store
        .open()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_workbench_event")
        .unwrap();
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let summary = reopened
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &batch,
            current("binding-a", "baseline-1"),
        )
        .unwrap();
    assert_eq!(summary.recorded, 2);
    assert_eq!(fixture.event_count(&group.group.id), 2);
    let snapshot = reopened
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(snapshot.work.len(), 2);
    assert!(snapshot
        .work
        .iter()
        .all(|work| work.status == WorkStatus::Pending && work.cause_kind == "event"));
    assert_eq!(
        fixture
            .reconcile(&batch, current("binding-a", "baseline-1"))
            .duplicates,
        2
    );
    assert_eq!(fixture.event_count(&group.group.id), 2);
    assert_eq!(
        reopened
            .group_snapshot("paper", &group.group.id, 0)
            .unwrap()
            .work
            .len(),
        2
    );
}

#[test]
fn object_subscription_and_group_created_after_observation_reuse_event_deduplication() {
    let fixture = Fixture::new();
    let selected = record("check", "selected-check", "r1");
    let unrelated = record("check", "other-check", "r1");
    let records = [selected.clone(), unrelated];
    fixture.reconcile(&records, current("binding-a", "baseline-1"));
    let group = fixture.group();
    fixture.subscribe(
        &group,
        InterestKind::Object,
        &format!("{}:{}", selected.object.kind, selected.object.id),
    );
    let resumed = fixture.reconcile(&records, current("binding-a", "baseline-1"));
    assert_eq!(resumed.recorded, 0);
    assert_eq!(resumed.duplicates, 2);
    assert_eq!(resumed.routed_members.len(), 1);
    assert_eq!(fixture.event_count(&group.group.id), 2);
    let snapshot = fixture
        .store
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(snapshot.work.len(), 1);
    assert_eq!(snapshot.work[0].member_id, resumed.routed_members[0]);
    let again = fixture.reconcile(&records, current("binding-a", "baseline-1"));
    assert!(again.routed_members.is_empty());
    assert_eq!(fixture.event_count(&group.group.id), 2);
}

#[test]
fn paused_group_retains_pending_work_and_closed_group_does_not_reopen() {
    let fixture = Fixture::new();
    fixture.store.request_start(&fixture.task.id).unwrap();
    let task = fixture.store.claim_next().unwrap().unwrap();
    let group = fixture.group();
    fixture.subscribe(&group, InterestKind::Event, "workbench_record_committed");
    fixture
        .store
        .set_group_status("paper", &group.group.id, GroupStatus::Paused)
        .unwrap();
    fixture.reconcile(
        &[record("check", "check-paused", "r1")],
        current("binding-a", "baseline-1"),
    );
    assert!(fixture.store.claim_member_turn(&task).unwrap().is_none());
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let snapshot = reopened
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(snapshot.group.status, GroupStatus::Paused);
    assert_eq!(snapshot.work.len(), 1);
    assert_eq!(snapshot.work[0].status, WorkStatus::Pending);
    reopened
        .set_group_status("paper", &group.group.id, GroupStatus::Open)
        .unwrap();
    let turn = reopened.claim_member_turn(&task).unwrap().unwrap();
    assert_eq!(turn.events.len(), 1);
    assert_eq!(turn.events[0].object.id, "check-paused");

    let closed = Fixture::new();
    let group = closed.group();
    closed.subscribe(&group, InterestKind::Event, "workbench_record_committed");
    closed
        .store
        .set_group_status("paper", &group.group.id, GroupStatus::Closed)
        .unwrap();
    closed.store.request_cancel(&closed.task.id).unwrap();
    let summary = closed.reconcile(
        &[record("check", "check-closed", "r1")],
        current("binding-a", "baseline-1"),
    );
    assert!(summary.routed_members.is_empty());
    assert_eq!(closed.event_count(&group.group.id), 1);
    let snapshot = closed
        .store
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(snapshot.group.status, GroupStatus::Closed);
    assert!(snapshot.work.is_empty());
    assert_eq!(
        closed.store.require(&closed.task.id).unwrap().status,
        ResearchTaskStatus::Cancelled
    );
    assert_eq!(closed.context().records.len(), 1);
}

#[test]
fn new_world_only_reports_update_and_current_projection_changes_can_return_to_old_value() {
    let fixture = Fixture::new();
    let group = fixture.group();
    fixture.subscribe(&group, InterestKind::Event, "workbench_update_available");
    fixture.subscribe(
        &group,
        InterestKind::Object,
        &format!("journal_project:{}", fixture.scope.object_id()),
    );
    let original = current("binding-a", "baseline-1");
    fixture.reconcile(&[], original.clone());
    assert_eq!(fixture.event_count(&group.group.id), 0);
    let world = record("world", "world-newer", "world-newer");
    fixture.reconcile(&[world], original.clone());
    let unchanged = fixture.context();
    assert_eq!(unchanged.current.as_ref().unwrap().snapshot, original);
    assert_eq!(unchanged.current.unwrap().observation_sequence, 1);
    let mut changed = original.clone();
    changed["checks"][0]["update_available"] = json!(true);
    let update = fixture.reconcile(&[], changed.clone());
    assert!(update.current_changed);
    assert_eq!(fixture.context().current.unwrap().observation_sequence, 2);
    let same = fixture.reconcile(&[], changed);
    assert!(!same.current_changed);
    assert!(same.routed_members.is_empty());
    let reverted = fixture.reconcile(&[], original.clone());
    assert!(reverted.current_changed);
    let context = fixture.context();
    assert_eq!(context.current.as_ref().unwrap().snapshot, original);
    assert_eq!(context.current.unwrap().observation_sequence, 3);
    assert_eq!(fixture.event_count(&group.group.id), 3);
    let snapshot = fixture
        .store
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(snapshot.work.len(), 3);
    assert_eq!(snapshot.group.status, GroupStatus::Open);
    let events = fixture
        .store
        .open()
        .unwrap()
        .prepare("SELECT event_json FROM collaboration_events WHERE group_id=?1")
        .unwrap()
        .query_map([&group.group.id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let events = events
        .iter()
        .map(|json| serde_json::from_str::<GroupEvent>(json).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "workbench_update_available")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.kind == "workbench_current_changed"
                    && event.object.kind == "journal_project"
                    && event.object.id == fixture.scope.object_id()
            })
            .count(),
        2
    );
    for event in events
        .iter()
        .filter(|event| event.kind == "workbench_current_changed")
    {
        assert!(event.detail.contains("journal_context"));
        assert!(!event.detail.contains("task_workbench_context"));
    }
}

#[test]
fn invalid_batch_missing_task_and_modified_snapshots_are_explicit_errors() {
    let fixture = Fixture::new();
    let valid = record("check", "check-a", "r1");
    let mut invalid = valid.clone();
    invalid.record_id.clear();
    assert!(fixture
        .store
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &[valid.clone(), invalid],
            current("binding-a", "baseline-1"),
        )
        .is_err());
    assert!(fixture.context().scope.is_none());
    assert!(fixture
        .store
        .reconcile_workbench(
            "absent-task",
            &fixture.scope,
            std::slice::from_ref(&valid),
            current("binding-a", "baseline-1"),
        )
        .is_err());
    fixture.reconcile(&[valid], current("binding-a", "baseline-1"));
    let before = fixture.context();
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_task_workbench_scopes SET current_json='{}' WHERE task_id=?1",
            [&fixture.task.id],
        )
        .unwrap();
    assert!(fixture
        .store
        .task_workbench_context(&fixture.task.id, 0, 100)
        .unwrap_err()
        .contains("current snapshot changed"));
    fixture.reconcile(&[], before.current.unwrap().snapshot);
    fixture
        .store
        .open()
        .unwrap()
        .execute(
            "UPDATE research_task_workbench_records
             SET record_json=json_set(record_json,'$.snapshot.injected',1) WHERE task_id=?1",
            [&fixture.task.id],
        )
        .unwrap();
    assert!(fixture
        .store
        .task_workbench_context(&fixture.task.id, 0, 100)
        .unwrap_err()
        .contains("record snapshot changed"));
}

#[test]
fn schema_ten_tasks_migrate_without_a_fabricated_workbench_scope() {
    let fixture = Fixture::new();
    fixture
        .store
        .open()
        .unwrap()
        .execute_batch(
            "DROP TABLE research_task_workbench_records;
             DROP TABLE research_task_workbench_scopes;
             ALTER TABLE collaboration_work DROP COLUMN reasons_json;
             DROP TABLE collaboration_attentions;
             PRAGMA user_version=10;",
        )
        .unwrap();
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    assert_eq!(reopened.require(&fixture.task.id).unwrap(), fixture.task);
    let context = reopened
        .task_workbench_context(&fixture.task.id, 0, 100)
        .unwrap();
    assert!(context.scope.is_none());
    assert!(context.current.is_none());
    assert!(context.records.is_empty());
    reopened
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &[record("binding", "binding-a", "r1")],
            current("binding-a", "baseline-1"),
        )
        .unwrap();
    assert_eq!(fixture.context().records.len(), 1);
}

#[test]
fn cancelled_or_deleted_journal_initialization_withdraws_only_its_copied_input_child() {
    use crate::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationSourceDraft, AnnotationTarget,
    };

    let fixture = Fixture::new();
    for kind in [
        "journal_rule",
        "journal_source",
        "journal_check",
        "journal_world",
    ] {
        let source = AnnotationSourceDraft {
            kind: "journal_object".into(),
            content: format!("retained {kind} source"),
        };
        let target = AnnotationTarget::new("paper", kind, "retained-object").revision("world-1");
        let parent = fixture
            .store
            .add_annotation(&AnnotationDraft {
                source: Some(source.clone()),
                ..AnnotationDraft::new(target.clone(), AnnotationAuthor::user("user"), "Old note")
            })
            .unwrap();
        for delete in [false, true] {
            let task = fixture
                .store
                .create_pending_inputs(ResearchTaskDraft {
                    project_id: "paper".into(),
                    title: "Interrupted journal request".into(),
                    prompt: "Revisit the retained object".into(),
                    runtime_id: "fixture".into(),
                    agent_id: "fixture".into(),
                    ..Default::default()
                })
                .unwrap();
            let child = fixture
                .store
                .submit_task_annotation(&AnnotationDraft {
                    source: Some(source.clone()),
                    ..AnnotationDraft::new(
                        target.clone().task(&task.id),
                        AnnotationAuthor::user("user"),
                        "Current request",
                    )
                    .reply_to(&parent.id)
                    .request()
                })
                .unwrap();
            if delete {
                fixture.store.delete(&task.id).unwrap();
            } else {
                fixture.store.request_cancel(&task.id).unwrap();
            }
            fixture.store.rollback_unstarted_task(&task.id).unwrap();
            fixture.store.rollback_unstarted_task(&task.id).unwrap();
            assert!(fixture.store.require(&task.id).is_err());
            assert!(fixture.store.annotation("paper", &child.id).is_err());
            assert_eq!(
                fixture.store.annotation("paper", &parent.id).unwrap(),
                parent
            );
            let work: u64 = fixture
                .store
                .open()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM research_task_annotation_work WHERE task_id=?1",
                    [&task.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(work, 0);
        }
    }
}

#[test]
fn journal_initialization_rollback_preserves_handlings_replies_and_nonowned_sources() {
    use crate::annotations::{
        AnnotationAuthor, AnnotationDraft, AnnotationHandlingDraft, AnnotationSourceDraft,
        AnnotationTarget,
    };

    let fixture = Fixture::new();
    let source = AnnotationSourceDraft {
        kind: "journal_object".into(),
        content: "captured rule source".into(),
    };
    let target =
        AnnotationTarget::new("paper", "journal_rule", "retained-rule").revision("world-1");
    let parent = fixture
        .store
        .add_annotation(&AnnotationDraft {
            source: Some(source.clone()),
            ..AnnotationDraft::new(
                target.clone(),
                AnnotationAuthor::user("user"),
                "Old rule note",
            )
        })
        .unwrap();
    for reason in [
        "handled",
        "replied",
        "changed_source",
        "changed_revision",
        "wrong_kind",
        "wrong_source",
        "no_parent",
    ] {
        let task = fixture
            .store
            .create_pending_inputs(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Protected journal history".into(),
                prompt: "Preserve historical discussion".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        let mut draft = AnnotationDraft {
            source: Some(source.clone()),
            ..AnnotationDraft::new(
                target.clone().task(&task.id),
                AnnotationAuthor::user("user"),
                "Current question",
            )
            .reply_to(&parent.id)
            .request()
        };
        match reason {
            "changed_source" => draft.source.as_mut().unwrap().content = "new source bytes".into(),
            "changed_revision" => draft.target.object_revision = Some("world-2".into()),
            "wrong_kind" => {
                draft.target.object_kind = "file".into();
                draft.parent_id = None;
            }
            "wrong_source" => draft.source.as_mut().unwrap().kind = "another_source".into(),
            "no_parent" => draft.parent_id = None,
            _ => {}
        }
        let child = fixture.store.submit_task_annotation(&draft).unwrap();
        if reason == "handled" {
            fixture
                .store
                .record_annotation_handling(
                    "paper",
                    &AnnotationHandlingDraft {
                        annotation_id: child.id.clone(),
                        author: AnnotationAuthor::user("user"),
                        summary: "A retained result already exists".into(),
                        result_refs: vec![],
                    },
                )
                .unwrap();
        } else if reason == "replied" {
            fixture
                .store
                .add_annotation(
                    &AnnotationDraft::new(
                        target.clone(),
                        AnnotationAuthor::user("user"),
                        "A later reply must be preserved",
                    )
                    .reply_to(&child.id),
                )
                .unwrap();
        }
        let retained_child = fixture.store.annotation("paper", &child.id).unwrap();
        fixture.store.request_cancel(&task.id).unwrap();
        assert!(
            fixture
                .store
                .rollback_unstarted_task(&task.id)
                .unwrap_err()
                .contains("history"),
            "{reason}"
        );
        assert_eq!(
            fixture.store.annotation("paper", &child.id).unwrap(),
            retained_child
        );
        fixture.store.delete(&task.id).unwrap();
        assert_eq!(
            fixture.store.annotation("paper", &child.id).unwrap(),
            retained_child
        );
        assert!(
            fixture.store.rollback_unstarted_task(&task.id).is_err(),
            "{reason}"
        );
        assert_eq!(
            fixture.store.annotation("paper", &parent.id).unwrap(),
            parent
        );
    }
}

#[test]
fn background_task_enumeration_keeps_old_scopes_beyond_the_ui_project_limit() {
    let fixture = Fixture::new();
    let mut connection = fixture.store.open().unwrap();
    let transaction = connection.transaction().unwrap();
    let added = transaction
        .execute(
            "WITH RECURSIVE sequence(n) AS (
               VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<500
             )
             INSERT INTO research_tasks
               (id,project_id,title,prompt,runtime_id,agent_id,model_id,skill_ids_json,
                status,created_at,updated_at)
             SELECT 'newer-task-'||n,'paper','Newer task','Inspect source','fixture',
                    'fixture','fixture','[]','queued',?1+n,?1+n FROM sequence",
            [fixture.task.created_at],
        )
        .unwrap();
    assert_eq!(added, 500);
    transaction.commit().unwrap();
    fixture.reconcile(
        &[record("check", "old-scope-check", "r1")],
        current("binding-a", "baseline-1"),
    );
    let visible = fixture.store.list("paper").unwrap();
    assert_eq!(visible.len(), 500);
    assert!(!visible.iter().any(|task| task.id == fixture.task.id));
    let background = fixture.store.all_tasks().unwrap();
    assert_eq!(background.len(), 501);
    assert!(background.iter().any(|task| task.id == fixture.task.id));
    assert_eq!(fixture.context().scope, Some(fixture.scope.clone()));
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    assert!(reopened
        .all_tasks()
        .unwrap()
        .iter()
        .any(|task| task.id == fixture.task.id));
}

#[test]
fn originating_member_check_and_current_updates_only_wake_other_subscribers_once() {
    let (fixture, group, actor) = running_origin();
    let peer = group
        .members
        .iter()
        .find(|member| !member.config.coordinator)
        .unwrap();
    let checked = record("check", "new-check", "r1");
    for value in [
        format!("journal_project:{}", fixture.scope.object_id()),
        format!("{}:{}", checked.object.kind, checked.object.id),
    ] {
        subscribe_both(&fixture, &group, InterestKind::Object, &value);
    }
    fixture.reconcile(&[], native_current());
    fixture
        .store
        .record_workbench_check_origin(&fixture.task.id, &fixture.scope, "new-check", &actor)
        .unwrap();
    // The native POST succeeded, then network synchronization failed. A fresh
    // store and ordinary system poll have only the durable origin receipt.
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let mut updated = native_current();
    add_native_check(&mut updated, "new-check");
    let summary = reopened
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            std::slice::from_ref(&checked),
            updated.clone(),
        )
        .unwrap();
    assert_eq!(summary.recorded, 1);
    assert!(summary.current_changed);
    assert_eq!(summary.routed_members, vec![peer.id.clone()]);
    let before_poll = fixture
        .store
        .group_snapshot("paper", &group.group.id, 0)
        .unwrap();
    assert_eq!(before_poll.work.len(), 3);
    assert_eq!(
        before_poll
            .work
            .iter()
            .filter(|work| work.member_id == actor.id && work.cause_kind == "event")
            .count(),
        0
    );
    assert_eq!(
        before_poll
            .work
            .iter()
            .filter(|work| {
                work.member_id == peer.id
                    && work.cause_kind == "event"
                    && work.status == WorkStatus::Pending
            })
            .count(),
        2
    );
    let poll = fixture.reconcile(&[checked], updated);
    assert_eq!(poll.recorded, 0);
    assert_eq!(poll.duplicates, 1);
    assert!(!poll.current_changed);
    assert!(poll.routed_members.is_empty());
    assert_eq!(fixture.event_count(&group.group.id), 2);
    assert_eq!(
        fixture
            .store
            .group_snapshot("paper", &group.group.id, 0)
            .unwrap()
            .work,
        before_poll.work
    );
}

#[test]
fn retained_check_origin_does_not_own_unrelated_records_or_mixed_current_changes() {
    for mixed in [false, true] {
        let (fixture, group, actor) = running_origin();
        subscribe_both(
            &fixture,
            &group,
            InterestKind::Event,
            "workbench_record_committed",
        );
        subscribe_both(
            &fixture,
            &group,
            InterestKind::Event,
            "workbench_update_available",
        );
        subscribe_both(
            &fixture,
            &group,
            InterestKind::Event,
            "workbench_current_changed",
        );
        fixture.reconcile(&[], native_current());
        fixture
            .store
            .record_workbench_check_origin(&fixture.task.id, &fixture.scope, "own-check", &actor)
            .unwrap();
        let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
        let own = record("check", "own-check", "r1");
        let external = [
            record("world", "external-world", "r2"),
            record("binding", "external-binding", "r2"),
            record("disposition", "external-note", "r2"),
        ];
        let mut batch = vec![own.clone()];
        batch.extend(external);
        let mut current = native_current();
        add_native_check(&mut current, "own-check");
        if mixed {
            current["project"]["baselineId"] = json!("external-baseline");
        }
        reopened
            .reconcile_workbench(&fixture.task.id, &fixture.scope, &batch, current.clone())
            .unwrap();
        let connection = reopened.open().unwrap();
        let events = connection
            .prepare("SELECT event_json FROM collaboration_events WHERE group_id=?1")
            .unwrap()
            .query_map([&group.group.id], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str::<GroupEvent>(&row.unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 5);
        let check_event = events
            .iter()
            .find(|event| event.object == own.object)
            .unwrap();
        assert_eq!(check_event.author, actor);
        let current_event = events
            .iter()
            .find(|event| event.kind == "workbench_current_changed")
            .unwrap();
        assert_eq!(
            current_event.author.kind,
            if mixed {
                ActorKind::System
            } else {
                ActorKind::Member
            }
        );
        for event in events
            .iter()
            .filter(|event| event.id != check_event.id && event.id != current_event.id)
        {
            assert_eq!(event.author.kind, ActorKind::System);
        }
        let snapshot = reopened
            .group_snapshot("paper", &group.group.id, 0)
            .unwrap();
        let own_events = snapshot
            .work
            .iter()
            .filter(|work| work.member_id == actor.id && work.cause_kind == "event")
            .collect::<Vec<_>>();
        assert_eq!(own_events.len(), if mixed { 4 } else { 3 });
        assert!(!own_events
            .iter()
            .any(|work| work.cause_id == check_event.id));
        let before = snapshot.work;
        let repeat = reopened
            .reconcile_workbench(&fixture.task.id, &fixture.scope, &batch, current)
            .unwrap();
        assert!(repeat.routed_members.is_empty());
        assert_eq!(
            reopened
                .group_snapshot("paper", &group.group.id, 0)
                .unwrap()
                .work,
            before
        );
    }
}

#[test]
fn check_origin_requires_real_execution_and_rejects_scope_or_author_conflicts() {
    let (fixture, group, actor) = running_origin();
    fixture
        .store
        .record_workbench_check_origin(&fixture.task.id, &fixture.scope, "check-a", &actor)
        .unwrap();
    fixture
        .store
        .record_workbench_check_origin(&fixture.task.id, &fixture.scope, "check-a", &actor)
        .unwrap();
    let connection = fixture.store.open().unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM research_task_workbench_check_origins WHERE task_id=?1",
                [&fixture.task.id],
                |row| row.get::<_, u64>(0)
            )
            .unwrap(),
        1
    );
    let other_scope = WorkbenchScope {
        library_root: "/different-library".into(),
        ..fixture.scope.clone()
    };
    assert!(fixture
        .store
        .record_workbench_check_origin(&fixture.task.id, &other_scope, "check-b", &actor)
        .unwrap_err()
        .contains("another Workbench"));
    assert!(fixture
        .store
        .reconcile_workbench(&fixture.task.id, &other_scope, &[], native_current())
        .unwrap_err()
        .contains("another Workbench"));
    for invalid in [
        GroupActor {
            execution_id: None,
            ..actor.clone()
        },
        GroupActor {
            execution_id: Some("invented-execution".into()),
            ..actor.clone()
        },
        GroupActor {
            kind: ActorKind::System,
            ..actor.clone()
        },
        GroupActor {
            id: group
                .members
                .iter()
                .find(|member| !member.config.coordinator)
                .unwrap()
                .id
                .clone(),
            ..actor.clone()
        },
    ] {
        assert!(fixture
            .store
            .record_workbench_check_origin(
                &fixture.task.id,
                &fixture.scope,
                "check-invalid",
                &invalid
            )
            .is_err());
    }
    let foreign = Fixture::new();
    assert!(foreign
        .store
        .record_workbench_check_origin(&foreign.task.id, &foreign.scope, "check-foreign", &actor)
        .unwrap_err()
        .contains("does not belong"));
    let task = fixture.store.require(&fixture.task.id).unwrap();
    let turn = fixture
        .store
        .task_member_turn(&task.id, task.execution_generation)
        .unwrap()
        .unwrap();
    fixture
        .store
        .finish_member_turn(
            &turn,
            &crate::model::TaskRuntimeOutcome {
                summary: "Native check committed".into(),
                artifacts: vec![],
                native_session_id: None,
                input_tokens: None,
                output_tokens: None,
            },
            None,
        )
        .unwrap();
    fixture
        .store
        .record_workbench_check_origin(&task.id, &fixture.scope, "late-origin", &actor)
        .unwrap();
    fixture
        .store
        .group_message(
            "paper",
            &group.group.id,
            &GroupActor::user(),
            &MessageDraft {
                body: "Run a separate native check".into(),
                recipients: vec![actor.id.clone()],
                request_work: true,
                ..Default::default()
            },
        )
        .unwrap();
    let next = fixture.store.claim_member_turn(&task).unwrap().unwrap();
    let another_actor = GroupActor {
        execution_id: Some(next.execution.id),
        ..actor
    };
    assert!(fixture
        .store
        .record_workbench_check_origin(&task.id, &fixture.scope, "check-a", &another_actor)
        .unwrap_err()
        .contains("different member origin"));
}

#[test]
fn current_check_attribution_rejects_removals_changed_history_and_other_field_changes() {
    let mut before = native_current();
    add_native_check(&mut before, "older-check");
    let mut after = before.clone();
    add_native_check(&mut after, "own-check");
    assert_eq!(
        crate::workbench::check_only_current_change(&before, &after),
        Some(vec!["own-check".into()])
    );
    let mut split_read = after.clone();
    split_read["project"]["latestCheck"] = before["project"]["latestCheck"].clone();
    assert_eq!(
        crate::workbench::check_only_current_change(&before, &split_read),
        Some(vec!["own-check".into()])
    );
    assert_eq!(
        crate::workbench::check_only_current_change(&split_read, &after),
        Some(vec!["own-check".into()])
    );
    for variant in [
        "binding",
        "baseline",
        "old_validity",
        "remove_old",
        "new_disposition",
        "wrong_latest",
        "unknown_schema",
    ] {
        let mut mixed = after.clone();
        match variant {
            "binding" => mixed["project"]["binding"] = json!({"binding_id":"external"}),
            "baseline" => mixed["project"]["baselineId"] = json!("external"),
            "old_validity" => mixed["checks"]["older-check"]["validity"] = json!("STALE"),
            "remove_old" => {
                mixed["checks"]
                    .as_object_mut()
                    .unwrap()
                    .remove("older-check");
            }
            "new_disposition" => {
                mixed["checks"]["own-check"]["dispositionIds"] = json!(["external-note"])
            }
            "wrong_latest" => mixed["project"]["latestCheck"] = json!({"checkId":"external"}),
            "unknown_schema" => mixed["schemaVersion"] = json!("unrecognized"),
            _ => unreachable!(),
        }
        assert_eq!(
            crate::workbench::check_only_current_change(&before, &mixed),
            None,
            "{variant}"
        );
    }
}

#[test]
fn schema_eleven_context_and_receipts_survive_origin_table_migration() {
    let (fixture, _group, actor) = running_origin();
    fixture.reconcile(
        &[record("check", "historical-check", "r1")],
        native_current(),
    );
    let before = fixture.context();
    fixture
        .store
        .open()
        .unwrap()
        .execute_batch(
            "DROP TABLE research_task_workbench_check_origins;
             ALTER TABLE collaboration_work DROP COLUMN reasons_json;
             DROP TABLE collaboration_attentions;
             PRAGMA user_version=11;",
        )
        .unwrap();
    let reopened = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    assert_eq!(
        reopened
            .open()
            .unwrap()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        crate::store::SCHEMA_VERSION as u64
    );
    assert_eq!(
        reopened
            .task_workbench_context(&fixture.task.id, 0, 100)
            .unwrap(),
        before
    );
    reopened
        .record_workbench_check_origin(&fixture.task.id, &fixture.scope, "new-check", &actor)
        .unwrap();
    let again = TaskStore::new(fixture.store.root().to_path_buf()).unwrap();
    let mut after = native_current();
    add_native_check(&mut after, "new-check");
    assert!(again
        .reconcile_workbench(
            &fixture.task.id,
            &fixture.scope,
            &[record("check", "new-check", "r1")],
            after
        )
        .is_ok());
}
