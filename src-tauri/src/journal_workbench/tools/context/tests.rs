use super::*;
use oleafly_research::{
    collaboration::GroupObject,
    model::ResearchTaskDraft,
    observations::content_hash,
    store::TaskStore,
    workbench::{CommittedWorkbenchRecord, WorkbenchRecordEvent, WorkbenchRecordReceipt},
};

fn current() -> Value {
    let check = |id: &str| {
        json!({"checkId":id,"baselineId":"docx-a","bindingId":"binding-1",
        "worldVersionId":"w1","validity":"CURRENT","staleReasons":[],"updateAvailable":true,
        "dispositionIds":[]})
    };
    json!({
        "captured":{"worldVersionId":"w1","checkId":"old","baselineId":"docx-a","snapshotSha256":"captured-hash"},
        "project":{"manuscriptId":"paper","baselineId":"docx-b",
            "binding":{"world_version_id":"w1","baseline_id":"docx-a"},"latestCheck":check("new")},
        "checks":{"old":check("old"),"new":check("new"),"other":check("other")},
        "readBoundary":{"atomicExternalSnapshot":false},
        "latexApplicability":{"status":"not_checked","checkedInput":"workbench_retained_docx"},
        "enumerationScope":{"includesReadsOrFullDomainLog":false}
    })
}

fn record(kind: &str, id: &str, snapshot: Value) -> CommittedWorkbenchRecord {
    CommittedWorkbenchRecord {
        kind: kind.into(),
        record_id: id.into(),
        revision: "w2".into(),
        object: GroupObject {
            kind: "journal_world".into(),
            id: "journal".into(),
            revision: Some("w2".into()),
            path: None,
        },
        event_kind: WorkbenchRecordEvent::UpdateAvailable,
        snapshot,
    }
}

fn scope() -> WorkbenchScope {
    WorkbenchScope {
        library_root: "/library".into(),
        project_id: "paper".into(),
    }
}

#[test]
fn repeated_coverage_keeps_each_property_locator_and_distinct_conflict() {
    let gaps = json!([
        {"code":"missing","message":"Not established","property":"width","locator":"line:1"},
        {"code":"missing","message":"Not established","property":"height","locator":null},
        {"code":"conflict","message":"Conflicting sources","property":"width","source_id":"s2"}
    ]);
    let summary = coverage_summary(&gaps);
    assert_eq!(summary["count"], 3);
    assert_eq!(summary["groups"].as_array().unwrap().len(), 2);
    assert_eq!(
        summary["groups"][0]["affected"],
        json!([
            {"property":"width","locator":"line:1"},{"property":"height","locator":null}
        ])
    );
    assert_eq!(summary["groups"][1]["explanation"]["source_id"], "s2");
    assert_eq!(coverage_summary(&Value::Null), Value::Null);
}

#[test]
fn compact_keeps_domain_semantics_and_identifies_omitted_history() {
    let input: TaskWorkbenchContext = serde_json::from_value(json!({
        "taskId":"task","scope":scope(),"records":[],
        "current":{"observationSequence":3,"snapshot":current(),"snapshotSha256":"full-hash"},
        "nextSequence":8,"hasMore":false
    }))
    .unwrap();
    let output = task_context(input, ContextDetail::Compact).unwrap();
    let snapshot = &output["current"]["snapshot"];
    assert_eq!(snapshot["captured"]["baselineId"], "docx-a");
    assert_eq!(snapshot["project"]["baselineId"], "docx-b");
    assert_eq!(snapshot["project"]["binding"]["world_version_id"], "w1");
    assert_eq!(snapshot["checks"]["old"]["validity"], "CURRENT");
    assert_eq!(snapshot["checks"]["old"]["updateAvailable"], true);
    assert_eq!(snapshot["checksSummary"]["omitted"], 1);
    assert_eq!(snapshot["checksSummary"]["total"], 3);
    assert_eq!(snapshot["latexApplicability"]["status"], "not_checked");
    assert_eq!(snapshot["readBoundary"]["atomicExternalSnapshot"], false);
    assert_eq!(output["current"]["snapshotSha256"], "full-hash");
    assert_eq!(output["current"]["hashBasis"], "full_retained_snapshot");
}

#[test]
fn receipt_cursor_full_read_recovers_exact_historical_bytes_after_current_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::new(directory.path().join("tasks")).unwrap();
    let task = store
        .create(ResearchTaskDraft {
            project_id: "oleafly".into(),
            title: "Context receipts".into(),
            prompt: "Read retained evidence".into(),
            runtime_id: "fixture".into(),
            agent_id: "fixture".into(),
            ..Default::default()
        })
        .unwrap();
    let retained = json!({"version_id":"w2","journal_id":"journal","rules":[{"evidence":"原话\r\nBOM\u{feff}"}],
        "coverage_gaps":[{"code":"conflicting_evidence","message":"Do not certify"}],
        "manual_decisions":[{"note":"Unverified revision"}]});
    let records = [
        record("world", "w2", retained.clone()),
        record(
            "disposition",
            "d1",
            json!({"disposition_id":"d1","note":"Keep exact original note"}),
        ),
    ];
    store
        .reconcile_workbench(&task.id, &scope(), &records, current())
        .unwrap();
    let first = task_context(
        store.task_workbench_context(&task.id, 0, 1).unwrap(),
        ContextDetail::Compact,
    )
    .unwrap();
    assert_eq!(first["hasMore"], true);
    assert!(first["records"][0].get("snapshot").is_none());
    assert_eq!(
        first["records"][0]["summary"]["coverage_gaps"]["groups"][0]["explanation"],
        retained["coverage_gaps"][0]
    );
    let args = &first["records"][0]["fullRead"]["arguments"];
    assert_eq!(args["limit"], 1);
    let cursor = first["nextSequence"].as_u64().unwrap();
    assert_eq!(args["after_sequence"].as_u64().unwrap() + 1, cursor);
    let mut changed = current();
    changed["checks"]["old"]["validity"] = json!("STALE");
    store
        .reconcile_workbench(&task.id, &scope(), &[], changed)
        .unwrap();
    let reopened = TaskStore::new(store.root().to_owned()).unwrap();
    let full = task_context(
        reopened
            .task_workbench_context(&task.id, args["after_sequence"].as_u64().unwrap(), 1)
            .unwrap(),
        ContextDetail::Full,
    )
    .unwrap();
    let receipt = &full["records"][0];
    assert_eq!(
        receipt["sequence"],
        first["records"][0]["verifyFullRead"]["sequence"]
    );
    assert_eq!(
        receipt["snapshotSha256"],
        first["records"][0]["verifyFullRead"]["snapshotSha256"]
    );
    assert_eq!(
        receipt["snapshotSha256"],
        content_hash(&serde_json::to_vec(&retained).unwrap())
    );
    assert_eq!(receipt["snapshot"], retained);
    assert_eq!(
        full["current"]["snapshot"]["checks"]["old"]["validity"],
        "STALE"
    );
    let second = task_context(
        reopened
            .task_workbench_context(&task.id, cursor, 1)
            .unwrap(),
        ContextDetail::Compact,
    )
    .unwrap();
    assert_eq!(second["records"][0]["recordId"], "d1");
    assert_eq!(second["hasMore"], false);
    let end = second["nextSequence"].as_u64().unwrap();
    let empty = task_context(
        reopened.task_workbench_context(&task.id, end, 1).unwrap(),
        ContextDetail::Compact,
    )
    .unwrap();
    assert_eq!(empty["records"], json!([]));
    assert_eq!(empty["nextSequence"], end);
}

#[test]
fn compact_receipt_explains_domain_pointer_without_presenting_omitted_content_as_a_verdict() {
    let pointer = json!({
        "projection":"retained_pointer",
        "kind":"world",
        "contentStatus":"not_embedded",
        "snapshotOmitted":true,
        "domainReadable":true,
        "contentNote":"The complete world is retained by Workbench.",
        "snapshotSha256":"full-world-hash",
        "snapshotBytes":337_822,
        "journal_id":"journal",
        "journal_name":"Journal",
        "version_id":"w2",
        "ruleCount":12,
        "manualDecisionCount":2,
        "coverageGapCount":1,
        "limitations":[],
        "template":{"original_sha256":"original-hash","source_sha256":"source-hash"},
        "templateSources":[{"source_id":"source-original","name":"template.doc"}],
        "domainRead":{"method":"GET","path":"/api/world","query":{"version_id":"w2"}},
        "nativeRead":{"tool":"journal_read","arguments":{
            "operation":"object","kind":"world","object_id":"journal","world_version_id":"w2"
        }},
        "verifyDomainRead":{"snapshotSha256":"full-world-hash"}
    });
    let receipt = WorkbenchRecordReceipt {
        sequence: 9,
        record: record("world", "w2", pointer.clone()),
        snapshot_sha256: "pointer-record-hash".into(),
    };

    let compact = compact_receipt(&receipt, &current());
    assert_eq!(compact["snapshotState"], "retained_pointer");
    assert_eq!(compact["contentIncluded"], false);
    assert_eq!(compact["contentAvailableInReceipt"], false);
    assert_eq!(compact["assessment"], "not_evaluated_from_pointer");
    assert_eq!(compact["snapshotSha256"], "pointer-record-hash");
    assert_eq!(compact["contentSnapshotSha256"], "full-world-hash");
    assert_eq!(compact["domainRead"], pointer["domainRead"]);
    assert_eq!(compact["summary"]["ruleCount"], 12);
    assert_eq!(
        compact["summary"]["templateSources"],
        pointer["templateSources"]
    );
    assert_eq!(
        compact["verifyDomainRead"],
        json!({"snapshotSha256":"full-world-hash","snapshotBytes":337_822})
    );
    assert!(compact["summary"].get("rules").is_none());
    assert!(compact["summary"].get("verdict").is_none());
    assert!(compact["domainReadNote"]
        .as_str()
        .is_some_and(|note| note.contains("not summarized as a passing verdict")));
}

#[test]
fn full_mode_is_the_original_context_without_projection_or_text_loss() {
    let original = json!({"taskId":"task","scope":null,"records":[],"current":null,"nextSequence":0,"hasMore":false});
    let context = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(
        task_context(context, ContextDetail::Full).unwrap(),
        original
    );
    let compact = task_context(
        serde_json::from_value(original).unwrap(),
        ContextDetail::Compact,
    )
    .unwrap();
    assert!(compact["current"].is_null());
}

#[test]
fn ordinary_compact_keeps_stale_conflict_coverage_and_exact_object_read_arguments() {
    let project = json!({"project_id":"paper","baseline_id":"docx-b","binding":{"world_version_id":"w1"},
        "latest_check":{"check_id":"c1","baseline_id":"docx-a","world_version_id":"w1",
            "validity":"STALE","stale_reasons":["source_baseline_changed"],"update_available":true,
            "coverage_gaps":[{"code":"missing_geometry"}],"limitations":["DOCX only"],
            "world":{"journal_id":"journal","version_id":"w1","coverage_gaps":[{"code":"conflict"}],
                "rules":[{"evidence":"lengthy historical quote"}]},
            "dispositions":[{"disposition_id":"d1","action":"note","note":"long note"}]}});
    let compact = ordinary_context(
        &scope(),
        &project,
        &json!({"read":true}),
        ContextDetail::Compact,
    );
    let check = &compact["current"]["latest_check"];
    assert_eq!(check["validity"], "STALE");
    assert_eq!(check["stale_reasons"], json!(["source_baseline_changed"]));
    assert_eq!(
        check["world"]["coverage_gaps"]["groups"][0]["explanation"],
        project["latest_check"]["world"]["coverage_gaps"][0]
    );
    assert_eq!(
        check["objectRead"]["arguments"],
        json!({"operation":"object","kind":"check","object_id":"c1","world_version_id":"w1"})
    );
    assert!(check["world"].get("rules").is_none());
    assert_eq!(compact["current"]["baseline_id"], "docx-b");
    assert!(compact["captured"].is_null());
    assert_eq!(compact["readBoundary"]["history"], "not_enumerated");
    assert_eq!(compact["latexApplicability"]["status"], "not_checked");
    let full = ordinary_context(&scope(), &project, &json!({}), ContextDetail::Full);
    assert_eq!(full["current"], project);
}

// Opt-in measurement against retained, real-provider outputs. No fixture copy,
// evidence rewrite or model/network activity is needed.
#[test]
#[ignore = "set OLEAFLY_JOURNAL_CONTEXT_EVIDENCE to retained paired-tools.json"]
fn retained_real_context_response_bytes() {
    let path =
        std::env::var_os("OLEAFLY_JOURNAL_CONTEXT_EVIDENCE").expect("retained evidence path");
    let rows: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut count = 0;
    for row in rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["name"] == "journal_context")
    {
        let envelope: Value = serde_json::from_str(row["output"].as_str().unwrap()).unwrap();
        let original = envelope["content"][0]["text"].as_str().unwrap();
        let retained: TaskWorkbenchContext = serde_json::from_str(original).unwrap();
        let compact = task_context(retained.clone(), ContextDetail::Compact).unwrap();
        let compact_bytes = serde_json::to_vec(&compact).unwrap().len();
        let full = task_context(retained, ContextDetail::Full).unwrap();
        assert_eq!(full, serde_json::from_str::<Value>(original).unwrap());
        assert!(compact_bytes < original.len());
        let mut compact_envelope = envelope.clone();
        compact_envelope["content"][0]["text"] = json!(serde_json::to_string(&compact).unwrap());
        eprintln!("retained-context-{count}: payload {} -> {} bytes; MCP envelope {} -> {} bytes; {} receipts",
            original.len(),compact_bytes,row["output"].as_str().unwrap().len(),
            serde_json::to_vec(&compact_envelope).unwrap().len(),full["records"].as_array().unwrap().len());
        count += 1;
    }
    assert!(count > 0);
}
