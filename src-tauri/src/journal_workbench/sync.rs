//! Reconcile explicit, retained Workbench records into one task's observation scope.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use oleafly_research::{
    collaboration::GroupObject,
    observations::content_hash,
    store::TaskStore,
    workbench::{
        CommittedWorkbenchRecord, WorkbenchReconcileSummary, WorkbenchRecordEvent, WorkbenchScope,
        CURRENT_SCHEMA_VERSION,
    },
};
use serde_json::{json, Value};

use super::annotations::{object_target, JournalObjectKind, JournalObjectReference};
use super::{request, Session};
use crate::task_inputs::JournalInput;

const BATCH_SIZE: usize = 512;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;

#[derive(Debug)]
struct Projection {
    records: Vec<CommittedWorkbenchRecord>,
    current: Value,
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Workbench response is missing {field}."))
}

fn rows<'a>(value: &'a Value, field: &str) -> Result<&'a [Value], String> {
    value[field]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("Workbench response has invalid {field}."))
}

fn query(path: &str, fields: &[(&str, &str)]) -> Result<String, String> {
    let url = reqwest::Url::parse_with_params("http://127.0.0.1/", fields)
        .map_err(|error| error.to_string())?;
    Ok(format!("{path}?{}", url.query().unwrap_or_default()))
}

fn canonical_root(path: &Path) -> Result<String, String> {
    path.canonicalize()
        .map_err(|error| format!("The task's Workbench library is unavailable: {error}"))?
        .into_os_string()
        .into_string()
        .map_err(|_| "The Workbench library path is not Unicode.".into())
}

fn selected_scope(input: &JournalInput, session_root: &Path) -> Result<WorkbenchScope, String> {
    let root = canonical_root(Path::new(&input.library_root))?;
    if root != canonical_root(session_root)? {
        return Err(
            "The task belongs to another Workbench library. Connect that library to sync it."
                .into(),
        );
    }
    let project_id = input
        .manuscript_id
        .as_ref()
        .filter(|id| !id.is_empty())
        .ok_or("The task has no retained Workbench manuscript identity.")?;
    Ok(WorkbenchScope {
        library_root: root,
        project_id: project_id.clone(),
    })
}

fn selected_journal(input: &JournalInput) -> Result<&str, String> {
    if text(&input.snapshot["world"], "version_id")? != input.world_version_id {
        return Err("The task's captured world identity does not match its retained input.".into());
    }
    text(&input.snapshot["world"], "journal_id")
}

fn group_object(
    project_id: &str,
    scope: &WorkbenchScope,
    kind: JournalObjectKind,
    object_id: &str,
    world_version_id: &str,
    check_id: Option<&str>,
) -> Result<GroupObject, String> {
    let target = object_target(
        project_id,
        &JournalObjectReference {
            library_root: scope.library_root.clone(),
            workbench_project_id: scope.project_id.clone(),
            kind,
            object_id: object_id.into(),
            world_version_id: world_version_id.into(),
            check_id: check_id.map(str::to_owned),
        },
    )?;
    Ok(GroupObject {
        kind: target.object_kind,
        id: target.object_id,
        revision: target.object_revision,
        path: target.path,
    })
}

fn snapshot_hash(snapshot: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(snapshot).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(
            "A Workbench sync snapshot exceeds 256 KiB. It was not truncated or recorded.".into(),
        );
    }
    Ok(content_hash(&bytes))
}

fn committed(
    kind: &str,
    record_id: &str,
    revision: Option<&str>,
    object: GroupObject,
    event_kind: WorkbenchRecordEvent,
    snapshot: Value,
) -> Result<CommittedWorkbenchRecord, String> {
    let hash = snapshot_hash(&snapshot)?;
    Ok(CommittedWorkbenchRecord {
        kind: kind.into(),
        record_id: record_id.into(),
        revision: revision.unwrap_or(&hash).into(),
        object,
        event_kind,
        snapshot,
    })
}

fn immutable_check(check: &Value) -> Result<Value, String> {
    let mut immutable = check
        .as_object()
        .cloned()
        .ok_or("Invalid retained Workbench check.")?;
    for field in [
        "world",
        "validity",
        "stale_reasons",
        "update_available",
        "dispositions",
    ] {
        immutable.remove(field);
    }
    Ok(Value::Object(immutable))
}

fn derived_check(check: &Value) -> Result<Value, String> {
    let disposition_ids = rows(check, "dispositions")?
        .iter()
        .map(|record| text(record, "disposition_id"))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "checkId": text(check, "check_id")?,
        "baselineId": text(check, "baseline_id")?,
        "bindingId": text(check, "binding_id")?,
        "worldVersionId": text(check, "world_version_id")?,
        "validity": text(check, "validity")?,
        "staleReasons": rows(check, "stale_reasons")?,
        "updateAvailable": check["update_available"].as_bool()
            .ok_or("Invalid Workbench check update_available projection.")?,
        "dispositionIds": disposition_ids
    }))
}

fn projection(
    project_id: &str,
    scope: &WorkbenchScope,
    input: &JournalInput,
    state: &Value,
    history: &Value,
    worlds: &[Value],
) -> Result<Projection, String> {
    let journal_id = selected_journal(input)?;
    let project = rows(state, "projects")?
        .iter()
        .find(|row| row["project_id"] == scope.project_id)
        .ok_or("The task's manuscript is unavailable in this Workbench library.")?;
    if text(history, "project_id")? != scope.project_id {
        return Err("Workbench returned another manuscript's history.".into());
    }
    let world_index = rows(state, "worlds")?
        .iter()
        .map(|world| Ok((text(world, "version_id")?, text(world, "journal_id")?)))
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    let expected: BTreeSet<&str> = world_index
        .iter()
        .filter_map(|(version, journal)| (*journal == journal_id).then_some(*version))
        .collect();
    let supplied = worlds
        .iter()
        .map(|world| text(world, "version_id"))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if supplied != expected || !expected.contains(input.world_version_id.as_str()) {
        return Err("The selected journal's retained world enumeration is incomplete.".into());
    }
    let mut records = Vec::new();
    for world in worlds {
        let version = text(world, "version_id")?;
        if text(world, "journal_id")? != journal_id {
            return Err("Workbench returned a world from another journal.".into());
        }
        records.push(committed(
            "world",
            version,
            Some(version),
            group_object(
                project_id,
                scope,
                JournalObjectKind::World,
                journal_id,
                version,
                None,
            )?,
            WorkbenchRecordEvent::UpdateAvailable,
            world.clone(),
        )?);
        for rule in rows(world, "rules")? {
            let rule_id = text(rule, "rule_id")?;
            records.push(committed(
                "rule_version",
                rule_id,
                Some(version),
                group_object(
                    project_id,
                    scope,
                    JournalObjectKind::Rule,
                    rule_id,
                    version,
                    None,
                )?,
                WorkbenchRecordEvent::UpdateAvailable,
                rule.clone(),
            )?);
        }
    }
    for binding in rows(history, "bindings")? {
        if text(binding, "project_id")? != scope.project_id {
            return Err("Workbench returned another manuscript's binding.".into());
        }
        let version = text(binding, "world_version_id")?;
        let journal = world_index
            .get(version)
            .ok_or("The retained binding's world is missing from Workbench discovery.")?;
        records.push(committed(
            "binding",
            text(binding, "binding_id")?,
            None,
            group_object(
                project_id,
                scope,
                JournalObjectKind::World,
                journal,
                version,
                None,
            )?,
            WorkbenchRecordEvent::RecordCommitted,
            binding.clone(),
        )?);
    }
    let mut checks = BTreeMap::new();
    for check in rows(history, "checks")? {
        if text(check, "project_id")? != scope.project_id {
            return Err("Workbench returned another manuscript's check.".into());
        }
        let id = text(check, "check_id")?;
        let version = text(check, "world_version_id")?;
        if !world_index.contains_key(version) {
            return Err("The retained check's world is missing from Workbench discovery.".into());
        }
        let object = group_object(
            project_id,
            scope,
            JournalObjectKind::Check,
            id,
            version,
            Some(id),
        )?;
        records.push(committed(
            "check",
            id,
            None,
            object.clone(),
            WorkbenchRecordEvent::RecordCommitted,
            immutable_check(check)?,
        )?);
        for disposition in rows(check, "dispositions")? {
            if text(disposition, "check_id")? != id {
                return Err("Workbench returned a disposition for another check.".into());
            }
            records.push(committed(
                "disposition",
                text(disposition, "disposition_id")?,
                None,
                object.clone(),
                WorkbenchRecordEvent::RecordCommitted,
                disposition.clone(),
            )?);
        }
        checks.insert(id, derived_check(check)?);
    }
    let latest = if project["latest_check"].is_null() {
        Value::Null
    } else {
        if text(&project["latest_check"], "project_id")? != scope.project_id {
            return Err("Workbench returned another manuscript's latest check.".into());
        }
        derived_check(&project["latest_check"])?
    };
    if !project["binding"].is_null() && text(&project["binding"], "project_id")? != scope.project_id
    {
        return Err("Workbench returned another manuscript's current binding.".into());
    }
    let current = json!({
        "schemaVersion": CURRENT_SCHEMA_VERSION,
        "enumeratedKinds": ["world", "rule_version", "binding", "check", "disposition"],
        "enumerationScope": {
            "worldsAndRules": {"journalId": journal_id},
            "bindingsChecksDispositions": {"manuscriptId": scope.project_id},
            "includesReadsOrFullDomainLog": false
        },
        "scope": scope,
        "captured": {
            "worldVersionId": input.world_version_id,
            "journalId": journal_id,
            "checkId": input.check_id,
            "baselineId": input.baseline_id,
            "snapshotSha256": input.snapshot_sha256
        },
        "project": {
            "manuscriptId": scope.project_id,
            "baselineId": text(project, "baseline_id")?,
            "binding": project["binding"],
            "latestCheck": latest
        },
        "checks": checks,
        "readBoundary": {
            "projectSource": "/api/state",
            "checkStateSource": "/api/history",
            "atomicExternalSnapshot": false
        },
        "latexApplicability": {
            "status": "not_checked",
            "checkedInput": "workbench_retained_docx",
            "capturedDocxBaselineId": input.baseline_id,
            "currentDocxBaselineId": text(project, "baseline_id")?,
            "reason": "Workbench checks apply to their retained DOCX baseline. No correspondence to this task's LaTeX or compiled PDF has been verified."
        }
    });
    snapshot_hash(&current)?;
    Ok(Projection { records, current })
}

fn persist_projection(
    store: &TaskStore,
    task_id: &str,
    scope: &WorkbenchScope,
    projection: Projection,
) -> Result<WorkbenchReconcileSummary, String> {
    let mut summary = WorkbenchReconcileSummary {
        recorded: 0,
        duplicates: 0,
        current_changed: false,
        routed_members: Vec::new(),
        next_sequence: 0,
    };
    let mut members = BTreeSet::new();
    if projection.records.is_empty() {
        return store.reconcile_workbench(task_id, scope, &[], projection.current);
    }
    for batch in projection.records.chunks(BATCH_SIZE) {
        let saved = store.reconcile_workbench(task_id, scope, batch, projection.current.clone())?;
        summary.recorded += saved.recorded;
        summary.duplicates += saved.duplicates;
        summary.current_changed |= saved.current_changed;
        summary.next_sequence = saved.next_sequence;
        members.extend(saved.routed_members);
    }
    summary.routed_members = members.into_iter().collect();
    Ok(summary)
}

/// Read every retained record of the declared kinds for this task's fixed scope.
/// Network/projection errors save nothing. Large histories commit in bounded
/// batches; a later failure returns the error and a rescan deduplicates earlier
/// committed batches. No scheduler or workspace association is consulted here.
pub(crate) async fn reconcile_task(
    session: &Session,
    store: &TaskStore,
    task_id: &str,
) -> Result<WorkbenchReconcileSummary, String> {
    let task = store.require(task_id)?;
    let input = crate::task_inputs::journal_input(store.root(), task_id)?
        .ok_or("This task has no retained Workbench input.")?;
    let scope = selected_scope(&input, &session.library_root)?;
    let journal_id = selected_journal(&input)?;
    let state = request(session, "/api/state", None).await?;
    if !rows(&state, "projects")?
        .iter()
        .any(|project| project["project_id"] == scope.project_id)
    {
        return Err("The task's manuscript is unavailable in this Workbench library.".into());
    }
    let history = request(
        session,
        &query("/api/history", &[("project_id", &scope.project_id)])?,
        None,
    )
    .await?;
    let mut worlds = Vec::new();
    for metadata in rows(&state, "worlds")? {
        if text(metadata, "journal_id")? == journal_id {
            let version = text(metadata, "version_id")?;
            let world = request(
                session,
                &query("/api/world", &[("version_id", version)])?,
                None,
            )
            .await?;
            if text(&world, "version_id")? != version {
                return Err("Workbench returned another retained world revision.".into());
            }
            worlds.push(world);
        }
    }
    let projection = projection(&task.project_id, &scope, &input, &state, &history, &worlds)?;
    let store = store.clone();
    let task_id = task_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        persist_projection(&store, &task_id, &scope, projection)
    })
    .await
    .map_err(|error| format!("Workbench reconciliation could not finish: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> WorkbenchScope {
        WorkbenchScope {
            library_root: "/retained/library".into(),
            project_id: "project-a".into(),
        }
    }

    fn world(id: &str, journal: &str, expected: u64) -> Value {
        json!({
            "version_id": id,
            "journal_id": journal,
            "rules": [{"rule_id": "page-limit", "expected": expected}],
            "created_at": "2026-11-09T00:00:00Z"
        })
    }

    fn binding(id: &str, world: &str) -> Value {
        json!({
            "binding_id": id,
            "project_id": "project-a",
            "baseline_id": "baseline-docx-a",
            "world_version_id": world
        })
    }

    fn check(id: &str, world: &str, binding: &str) -> Value {
        json!({
            "check_id": id,
            "project_id": "project-a",
            "baseline_id": "baseline-docx-a",
            "binding_id": binding,
            "world_version_id": world,
            "world": {"joined": true},
            "rule_results": [{"rule_id": "page-limit", "verdict": "PASS"}],
            "validity": "CURRENT",
            "stale_reasons": [],
            "update_available": false,
            "dispositions": []
        })
    }

    fn input() -> JournalInput {
        let snapshot = json!({"world": world("world-1", "journal-a", 10)});
        JournalInput {
            library_root: scope().library_root,
            manuscript_id: Some(scope().project_id),
            world_version_id: "world-1".into(),
            check_id: Some("check-1".into()),
            baseline_id: "baseline-docx-a".into(),
            snapshot_sha256: snapshot_hash(&snapshot).unwrap(),
            snapshot,
        }
    }

    fn fixture() -> (Value, Value, Vec<Value>) {
        let worlds = vec![
            world("world-1", "journal-a", 10),
            world("world-2", "journal-a", 12),
        ];
        let current_binding = binding("binding-1", "world-1");
        let checked = check("check-1", "world-1", "binding-1");
        let state = json!({
            "worlds": [
                {"version_id": "world-1", "journal_id": "journal-a"},
                {"version_id": "world-2", "journal_id": "journal-a"},
                {"version_id": "other-world", "journal_id": "journal-b"}
            ],
            "projects": [{
                "project_id": "project-a",
                "baseline_id": "baseline-docx-a",
                "binding": current_binding,
                "latest_check": checked
            }]
        });
        let history = json!({
            "project_id": "project-a",
            "bindings": [current_binding],
            "checks": [checked],
            "reads": [{"read_record_id": "not-in-enumeration"}]
        });
        (state, history, worlds)
    }

    fn project(state: &Value, history: &Value, worlds: &[Value]) -> Result<Projection, String> {
        projection("oleafly-paper", &scope(), &input(), state, history, worlds)
    }

    #[test]
    fn selected_journal_worlds_and_rules_keep_shared_annotation_object_identity() {
        let (state, history, worlds) = fixture();
        let observed = project(&state, &history, &worlds).unwrap();
        let rules = observed
            .records
            .iter()
            .filter(|record| record.kind == "rule_version")
            .collect::<Vec<_>>();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].object.kind, "journal_rule");
        assert_eq!(rules[0].object.id, rules[1].object.id);
        assert_ne!(rules[0].revision, rules[1].revision);
        assert_eq!(rules[1].snapshot["expected"], 12);
        for rule in rules {
            let target = object_target(
                "oleafly-paper",
                &JournalObjectReference {
                    library_root: scope().library_root,
                    workbench_project_id: scope().project_id,
                    kind: JournalObjectKind::Rule,
                    object_id: "page-limit".into(),
                    world_version_id: rule.revision.clone(),
                    check_id: None,
                },
            )
            .unwrap();
            assert_eq!(rule.object.id, target.object_id);
            assert_eq!(rule.object.revision, target.object_revision);
            assert_eq!(rule.event_kind, WorkbenchRecordEvent::UpdateAvailable);
            let identity: Value = serde_json::from_str(&rule.object.id).unwrap();
            assert_eq!(identity["libraryRoot"], scope().library_root);
            assert_eq!(identity["manuscriptId"], "project-a");
        }
        assert!(!observed
            .records
            .iter()
            .any(|record| record.record_id == "other-world" || record.kind == "read"));
        assert_eq!(
            observed.current["project"]["binding"],
            state["projects"][0]["binding"]
        );
        assert_eq!(observed.current["captured"]["worldVersionId"], "world-1");
        assert_eq!(
            observed.current["latexApplicability"]["status"],
            "not_checked"
        );
        assert_eq!(observed.current["checks"]["check-1"]["validity"], "CURRENT");
        assert_eq!(
            observed.current["checks"]["check-1"]["updateAvailable"],
            false
        );
    }

    #[test]
    fn mutable_check_projection_changes_do_not_create_a_new_immutable_check() {
        let (state, history, worlds) = fixture();
        let original = project(&state, &history, &worlds).unwrap();
        let mut updated_state = state.clone();
        let mut updated_history = history.clone();
        let changed = &mut updated_history["checks"][0];
        changed["world"] = json!({"joined": "new projection"});
        changed["validity"] = json!("STALE");
        changed["stale_reasons"] = json!(["source_baseline_changed"]);
        changed["update_available"] = json!(true);
        changed["dispositions"] = json!([{
            "disposition_id": "disposition-1",
            "check_id": "check-1",
            "rule_id": "page-limit",
            "action": "note",
            "note": "Keep the original verdict"
        }]);
        updated_state["projects"][0]["latest_check"] = changed.clone();
        let updated = project(&updated_state, &updated_history, &worlds).unwrap();
        let check_record = |projection: &Projection| {
            projection
                .records
                .iter()
                .find(|record| record.kind == "check")
                .unwrap()
                .clone()
        };
        assert_eq!(check_record(&original), check_record(&updated));
        let check_record = check_record(&updated);
        for field in [
            "world",
            "validity",
            "stale_reasons",
            "update_available",
            "dispositions",
        ] {
            assert!(check_record.snapshot.get(field).is_none());
        }
        let disposition = updated
            .records
            .iter()
            .find(|record| record.kind == "disposition")
            .unwrap();
        assert_eq!(disposition.object, check_record.object);
        assert_eq!(disposition.record_id, "disposition-1");
        assert_ne!(updated.current, original.current);
        assert_eq!(updated.current["checks"]["check-1"]["validity"], "STALE");
        assert_eq!(
            updated.current["project"]["binding"],
            state["projects"][0]["binding"]
        );
    }

    #[test]
    fn manuscript_history_can_include_another_journal_without_enumerating_its_worlds() {
        let (mut state, mut history, worlds) = fixture();
        let other_binding = binding("binding-other", "other-world");
        let other_check = check("check-other", "other-world", "binding-other");
        history["bindings"]
            .as_array_mut()
            .unwrap()
            .push(other_binding.clone());
        history["checks"]
            .as_array_mut()
            .unwrap()
            .push(other_check.clone());
        state["projects"][0]["binding"] = other_binding;
        state["projects"][0]["latest_check"] = other_check;
        let observed = project(&state, &history, &worlds).unwrap();
        assert_eq!(
            observed
                .records
                .iter()
                .filter(|record| record.kind == "world")
                .count(),
            2
        );
        let binding = observed
            .records
            .iter()
            .find(|record| record.record_id == "binding-other")
            .unwrap();
        let object: Value = serde_json::from_str(&binding.object.id).unwrap();
        assert_eq!(binding.object.kind, "journal_world");
        assert_eq!(object["id"], "journal-b");
        assert_eq!(observed.current["captured"]["journalId"], "journal-a");
        assert_eq!(
            observed.current["project"]["binding"]["world_version_id"],
            "other-world"
        );
    }

    #[test]
    fn incomplete_or_foreign_enumeration_is_rejected_before_persistence() {
        let (state, history, worlds) = fixture();
        assert!(project(&state, &history, &worlds[..1])
            .unwrap_err()
            .contains("incomplete"));
        let mut foreign = history.clone();
        foreign["project_id"] = json!("project-b");
        assert!(project(&state, &foreign, &worlds)
            .unwrap_err()
            .contains("another manuscript"));
        let mut foreign = history.clone();
        foreign["checks"][0]["project_id"] = json!("project-b");
        assert!(project(&state, &foreign, &worlds).is_err());
        let mut foreign = worlds.clone();
        foreign[0]["journal_id"] = json!("journal-b");
        assert!(project(&state, &history, &foreign)
            .unwrap_err()
            .contains("another journal"));
        let mut large = worlds;
        large[0]["unbounded_source"] = json!("x".repeat(MAX_SNAPSHOT_BYTES));
        assert!(project(&state, &history, &large)
            .unwrap_err()
            .contains("not truncated"));
    }

    #[test]
    fn canonical_library_and_retained_manuscript_define_scope() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut input = input();
        input.library_root = root.path().join(".").to_string_lossy().into_owned();
        let selected = selected_scope(&input, root.path()).unwrap();
        assert_eq!(selected.library_root, canonical_root(root.path()).unwrap());
        assert_eq!(selected.project_id, "project-a");
        assert!(selected_scope(&input, other.path())
            .unwrap_err()
            .contains("another Workbench library"));
        input.manuscript_id = None;
        assert!(selected_scope(&input, root.path())
            .unwrap_err()
            .contains("retained Workbench manuscript"));
    }

    #[test]
    fn more_than_one_batch_rescans_every_rule_without_a_timestamp_cursor() {
        let (state, history, mut worlds) = fixture();
        worlds[0]["rules"] = Value::Array(
            (0..600)
                .map(|index| json!({"rule_id":format!("rule-{index}"),"expected":index}))
                .collect(),
        );
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(oleafly_research::model::ResearchTaskDraft {
                project_id: "oleafly-paper".into(),
                title: "Retained journal sync".into(),
                prompt: "Inspect current Workbench observations".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        let first = persist_projection(
            &store,
            &task.id,
            &scope(),
            project(&state, &history, &worlds).unwrap(),
        )
        .unwrap();
        assert_eq!(first.recorded, 605);
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let repeated = persist_projection(
            &reopened,
            &task.id,
            &scope(),
            project(&state, &history, &worlds).unwrap(),
        )
        .unwrap();
        assert_eq!(repeated.recorded, 0);
        assert_eq!(repeated.duplicates, 605);
        assert_eq!(repeated.next_sequence, first.next_sequence);
        let mut cursor = 0;
        let mut count = 0;
        loop {
            let context = reopened
                .task_workbench_context(&task.id, cursor, 100)
                .unwrap();
            count += context.records.len();
            cursor = context.next_sequence;
            assert_eq!(
                context.current.unwrap().snapshot["enumeratedKinds"],
                json!(["world", "rule_version", "binding", "check", "disposition"])
            );
            if !context.has_more {
                break;
            }
        }
        assert_eq!(count, 605);
        assert_eq!(reopened.require(&task.id).unwrap(), task);
    }

    #[test]
    fn failed_native_sync_replays_retained_check_author_without_owning_external_world_updates() {
        use oleafly_research::{
            collaboration::{
                ActorKind, GroupActor, GroupEvent, InterestKind, MemberDraft, MemberInterest,
                MessageDraft,
            },
            model::ResearchTaskDraft,
        };

        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "oleafly-paper".into(),
                title: "Recover native check".into(),
                prompt: "Check the retained manuscript".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let group = store
            .create_task_group(
                "oleafly-paper",
                Some(&task.id),
                &[
                    MemberDraft {
                        name: "Author".into(),
                        responsibility: "Run check".into(),
                        runtime_id: "fixture".into(),
                        coordinator: true,
                        ..Default::default()
                    },
                    MemberDraft {
                        name: "Reviewer".into(),
                        responsibility: "Inspect changes".into(),
                        runtime_id: "fixture".into(),
                        ..Default::default()
                    },
                ],
            )
            .unwrap();
        for member in &group.members {
            for kind in [
                "workbench_record_committed",
                "workbench_update_available",
                "workbench_current_changed",
            ] {
                store
                    .set_member_interest(
                        "oleafly-paper",
                        &group.group.id,
                        &MemberInterest {
                            member_id: member.id.clone(),
                            kind: InterestKind::Event,
                            value: kind.into(),
                        },
                        true,
                    )
                    .unwrap();
            }
        }
        let author = group
            .members
            .iter()
            .find(|member| member.config.coordinator)
            .unwrap();
        store
            .group_message(
                "oleafly-paper",
                &group.group.id,
                &GroupActor::user(),
                &MessageDraft {
                    body: "Run the check".into(),
                    recipients: vec![author.id.clone()],
                    request_work: true,
                    ..Default::default()
                },
            )
            .unwrap();
        let turn = store.claim_member_turn(&task).unwrap().unwrap();
        let actor = GroupActor {
            kind: ActorKind::Member,
            id: turn.member.id,
            execution_id: Some(turn.execution.id),
        };
        let (mut state, mut history, worlds) = fixture();
        // Establish the native current shape without a check. The successful
        // POST's author is retained before the network sync that would fail.
        state["projects"][0]["latest_check"] = Value::Null;
        history["checks"] = json!([]);
        let before = project(&state, &history, &worlds).unwrap();
        store
            .reconcile_workbench(&task.id, &scope(), &[], before.current)
            .unwrap();
        store
            .record_workbench_check_origin(&task.id, &scope(), "check-1", &actor)
            .unwrap();
        let checked = check("check-1", "world-1", "binding-1");
        state["projects"][0]["latest_check"] = checked.clone();
        history["checks"] = json!([checked]);
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let saved = persist_projection(
            &reopened,
            &task.id,
            &scope(),
            project(&state, &history, &worlds).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.recorded, 6);
        let snapshot = reopened
            .group_snapshot("oleafly-paper", &group.group.id, 0)
            .unwrap();
        let peer = group
            .members
            .iter()
            .find(|member| !member.config.coordinator)
            .unwrap();
        let own_check_work = snapshot
            .work
            .iter()
            .filter(|work| work.cause_kind == "event")
            .filter_map(|work| {
                let connection =
                    rusqlite::Connection::open(store.root().join("tasks.sqlite3")).unwrap();
                let json: String = connection
                    .query_row(
                        "SELECT event_json FROM collaboration_events WHERE id=?1",
                        [&work.cause_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let event: GroupEvent = serde_json::from_str(&json).unwrap();
                (event.object.kind == "journal_check" || event.kind == "workbench_current_changed")
                    .then_some((work, event))
            })
            .collect::<Vec<_>>();
        assert_eq!(own_check_work.len(), 2);
        assert!(own_check_work
            .iter()
            .all(|(work, event)| work.member_id == peer.id && event.author == actor));
        assert!(snapshot
            .work
            .iter()
            .any(|work| work.cause_kind == "event" && work.member_id == actor.id));
        let again = persist_projection(
            &reopened,
            &task.id,
            &scope(),
            project(&state, &history, &worlds).unwrap(),
        )
        .unwrap();
        assert_eq!(again.duplicates, 6);
        assert!(again.routed_members.is_empty());
        assert_eq!(
            reopened
                .group_snapshot("oleafly-paper", &group.group.id, 0)
                .unwrap()
                .work,
            snapshot.work
        );
    }
}
