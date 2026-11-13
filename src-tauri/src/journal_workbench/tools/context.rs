//! Tool-facing summaries only. Full receipts and their hashes stay in TaskStore.
use oleafly_research::workbench::{TaskWorkbenchContext, WorkbenchRecordReceipt, WorkbenchScope};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ContextDetail {
    #[default]
    Compact,
    Full,
}

fn fields(value: &Value, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .filter_map(|name| value.get(*name).map(|v| ((*name).into(), v.clone())))
            .collect(),
    )
}

fn full_read(after_sequence: u64, limit: usize) -> Value {
    json!({"tool":"journal_context","arguments":{
        "detail":"full","after_sequence":after_sequence,"limit":limit
    }})
}

fn object_read(kind: &str, id: &Value, version: &Value) -> Value {
    json!({"tool":"journal_read","arguments":{
        "operation":"object","kind":kind,"object_id":id,"world_version_id":version
    }})
}

fn coverage_summary(gaps: &Value) -> Value {
    let Some(gaps) = gaps.as_array() else {
        return gaps.clone();
    };
    // Group only exactly equal explanations, retaining every affected property
    // and locator. This shortens repeated prose without discarding uncertainty.
    let mut groups: Vec<Value> = Vec::new();
    for gap in gaps {
        let mut explanation = gap.clone();
        if let Some(fields) = explanation.as_object_mut() {
            fields.remove("property");
            fields.remove("locator");
        }
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group["explanation"] == explanation)
        {
            group["affected"]
                .as_array_mut()
                .unwrap()
                .push(fields(gap, &["property", "locator"]));
        } else {
            groups.push(
                json!({"explanation":explanation,"affected":[fields(gap,&["property","locator"])]}),
            );
        }
    }
    json!({"count":gaps.len(),"groups":groups})
}

fn receipt_summary(receipt: &WorkbenchRecordReceipt) -> Value {
    let record = &receipt.record;
    let pointer = record.snapshot["projection"] == "retained_pointer";
    let names: &[&str] = if pointer {
        &[
            "projection",
            "kind",
            "contentStatus",
            "snapshotOmitted",
            "domainReadable",
            "contentNote",
            "snapshotSha256",
            "snapshotBytes",
            "journal_id",
            "journal_name",
            "version_id",
            "version_ordinal",
            "ruleCount",
            "manualDecisionCount",
            "coverageGapCount",
            "template",
            "templateSources",
            "world_version_id",
            "rule_id",
            "property",
            "label",
            "expected",
            "unit",
            "scope",
            "basis_status",
            "confirmation_method",
            "resolution",
            "evidenceCount",
            "templateObjectCount",
            "limitations",
        ]
    } else {
        match record.kind.as_str() {
            "world" => &[
                "journal_id",
                "version_ordinal",
                "scope",
                "analyzer_version",
                "reader_version",
                "coverage_gaps",
                "limitations",
            ],
            "rule_version" => &[
                "property",
                "expected",
                "unit",
                "scope",
                "basis_status",
                "confirmation_method",
                "resolution",
                "limitations",
            ],
            "check" => &[
                "baseline_id",
                "binding_id",
                "world_version_id",
                "source_sha256",
                "checker_version",
                "reader_version",
                "summary",
                "coverage_gaps",
                "limitations",
            ],
            "binding" => &[
                "binding_id",
                "baseline_id",
                "world_version_id",
                "previous_binding_id",
            ],
            "disposition" => &["disposition_id", "check_id", "rule_id", "action"],
            _ => &[],
        }
    };
    let mut summary = fields(&record.snapshot, names);
    if let Some(gaps) = record.snapshot.get("coverage_gaps") {
        summary["coverage_gaps"] = coverage_summary(gaps);
    }
    // Do not collapse missing coverage, unreviewed decisions or unsupported
    // record kinds into a successful/empty verdict.
    if record.kind == "world" && !pointer {
        summary["ruleCount"] = record.snapshot["rules"].as_array().map(Vec::len).into();
        summary["manualDecisionCount"] = record.snapshot["manual_decisions"]
            .as_array()
            .map(Vec::len)
            .into();
    }
    summary
}

fn compact_receipt(receipt: &WorkbenchRecordReceipt, current: &Value) -> Value {
    let record = &receipt.record;
    let mut result = json!({
        "sequence":receipt.sequence,"kind":record.kind,"recordId":record.record_id,
        "revision":record.revision,"object":record.object,"eventKind":record.event_kind,
        "snapshotSha256":receipt.snapshot_sha256,"receiptSnapshotSha256":receipt.snapshot_sha256,
        "summary":receipt_summary(receipt),
        "snapshotOmitted":true,
        "fullRead":full_read(receipt.sequence - 1, 1),
        "verifyFullRead":{"sequence":receipt.sequence,"snapshotSha256":receipt.snapshot_sha256}
    });
    if record.snapshot["projection"] == "retained_pointer" {
        result["snapshotState"] = json!("retained_pointer");
        result["contentIncluded"] = json!(false);
        result["contentAvailableInReceipt"] = json!(false);
        result["assessment"] = json!("not_evaluated_from_pointer");
        result["domainRead"] = record.snapshot["domainRead"].clone();
        result["contentSnapshotSha256"] = record.snapshot["snapshotSha256"].clone();
        result["verifyDomainRead"] = json!({
            "snapshotSha256":record.snapshot["snapshotSha256"],
            "snapshotBytes":record.snapshot["snapshotBytes"]
        });
        result["domainReadNote"] = json!(
            "This native receipt is a pointer. The full world/rule body remains in Workbench and is not summarized as a passing verdict."
        );
    } else {
        result["snapshotState"] = json!("embedded");
        result["contentIncluded"] = json!(false);
        result["contentAvailableInReceipt"] = json!(true);
    }
    if record.kind == "check" {
        result["currentCheckState"] = current["checks"][&record.record_id].clone();
    }
    result
}

pub(super) fn task_context(
    context: TaskWorkbenchContext,
    detail: ContextDetail,
) -> Result<Value, String> {
    if matches!(detail, ContextDetail::Full) {
        return serde_json::to_value(context).map_err(|error| error.to_string());
    }
    let current_snapshot = context.current.as_ref().map(|current| &current.snapshot);
    let records = context
        .records
        .iter()
        .map(|record| compact_receipt(record, current_snapshot.unwrap_or(&Value::Null)))
        .collect::<Vec<_>>();
    let current = context.current.as_ref().map(|current| {
        let mut snapshot = current.snapshot.clone();
        if let Some(checks) = snapshot["checks"].as_object() {
            let ids = [
                snapshot["captured"]["checkId"].as_str(),
                snapshot["project"]["latestCheck"]["checkId"].as_str(),
            ];
            let selected: Map<String, Value> = checks
                .iter()
                .filter(|(id, _)| ids.contains(&Some(id.as_str())))
                .map(|(id, value)| (id.clone(), value.clone()))
                .collect();
            snapshot["checksSummary"] = json!({"total":checks.len(),"included":selected.len(),
                "omitted":checks.len()-selected.len(),"fullRead":full_read(0,1)});
            snapshot["checks"] = Value::Object(selected);
        }
        snapshot["objectReads"] = json!({
            "capturedWorld":object_read("world", &snapshot["captured"]["journalId"], &snapshot["captured"]["worldVersionId"]),
            "manuscript":{"tool":"journal_read","arguments":{"operation":"manuscript","baseline_id":snapshot["project"]["baselineId"]}},
            "history":{"tool":"journal_read","arguments":{"operation":"history"}}
        });
        json!({"observationSequence":current.observation_sequence,
            "snapshotSha256":current.snapshot_sha256,"hashBasis":"full_retained_snapshot",
            "snapshot":snapshot,"detail":"compact","fullRead":full_read(0,1)})
    });
    Ok(
        json!({"taskId":context.task_id,"scope":context.scope,"records":records,
        "current":current,"nextSequence":context.next_sequence,"hasMore":context.has_more,
        "detail":"compact","synchronization":{"status":"synchronized","atomicExternalSnapshot":false},
        "readBoundary":"Receipt snapshots are omitted, not deleted. Retained-pointer receipts identify domain-readable world/rule records and carry the full-content hash and exact domainRead parameters; they do not summarize omitted evidence as passing. Rule evidence, conflicts and coverage in omitted bodies have not been summarized as passing. Read the exact world/rule/check before judging them. Full-read sequence and snapshotSha256 must match. The current projection can advance between reads; its hash refers to the full retained snapshot, not this summary."}),
    )
}

pub(super) fn ordinary_context(
    scope: &WorkbenchScope,
    project: &Value,
    capabilities: &Value,
    detail: ContextDetail,
) -> Value {
    let full = matches!(detail, ContextDetail::Full);
    let current = if full {
        project.clone()
    } else {
        let mut current = fields(
            project,
            &[
                "project_id",
                "baseline_id",
                "binding",
                "coverage_gaps",
                "limitations",
            ],
        );
        current["latest_check"] = if project["latest_check"].is_null() {
            Value::Null
        } else {
            let mut check = fields(
                &project["latest_check"],
                &[
                    "check_id",
                    "baseline_id",
                    "binding_id",
                    "world_version_id",
                    "source_sha256",
                    "checker_version",
                    "reader_version",
                    "validity",
                    "stale_reasons",
                    "update_available",
                    "summary",
                    "coverage_gaps",
                    "limitations",
                ],
            );
            check["objectRead"] =
                object_read("check", &check["check_id"], &check["world_version_id"]);
            // Disposition text and joined rule bodies remain explicitly readable.
            check["dispositions"] = project["latest_check"]["dispositions"]
                .as_array()
                .map(|rows| {
                    rows.iter()
                        .map(|row| fields(row, &["disposition_id", "rule_id", "action"]))
                        .collect::<Vec<_>>()
                })
                .into();
            check["fullRead"] = json!({"tool":"journal_context","arguments":{"detail":"full"}});
            if let Some(gaps) = check.get("coverage_gaps").cloned() {
                check["coverage_gaps"] = coverage_summary(&gaps);
            }
            if let Some(world) = project["latest_check"].get("world") {
                check["world"] = fields(
                    world,
                    &[
                        "version_id",
                        "journal_id",
                        "version_ordinal",
                        "scope",
                        "coverage_gaps",
                        "limitations",
                    ],
                );
                check["world"]["objectRead"] =
                    object_read("world", &world["journal_id"], &world["version_id"]);
                if let Some(gaps) = world.get("coverage_gaps") {
                    check["world"]["coverage_gaps"] = coverage_summary(gaps);
                }
                check["world"]["ruleBodies"] =
                    json!("omitted; read world for rule evidence, resolutions and conflicts");
            }
            check
        };
        current
    };
    let mut result = json!({"scope":scope,"current":current,"capabilities":capabilities,
        "receiptStore":null,"latexApplicability":{"status":"not_checked",
            "checkedInput":"workbench_retained_docx","currentDocxBaselineId":project["baseline_id"],
            "basis":"Workbench checks refer to the bound DOCX, not the open LaTeX project."}});
    if !full {
        result["detail"] = json!("compact");
        result["captured"] = Value::Null;
        result["readBoundary"] = json!({"capturedInput":"not_task_bound",
            "history":"not_enumerated","fullRead":{"tool":"journal_context","arguments":{"detail":"full"}},
            "historyRead":{"tool":"journal_read","arguments":{"operation":"history"}}});
    }
    result
}

#[cfg(test)]
mod tests;
