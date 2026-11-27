use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::journal_workbench::{request, JournalWorkbenchState, Session};

use super::{
    api_query, bounded_limit, bounded_read_json_with_tool, candidate_review_check_id, page,
    selected_project, text, validate_check_scope,
};

const TOOL: &str = "read_docx_template_check";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    #[default]
    Status,
    FindingGroups,
    FindingLocations,
    Findings,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::FindingGroups => "finding_groups",
            Self::FindingLocations => "finding_locations",
            Self::Findings => "findings",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    Candidate,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    ObservedMatch,
    ObservedDifference,
    CannotDetermine,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DocxCheckQuery {
    #[serde(default)]
    operation: Operation,
    scope: Option<Scope>,
    check_id: Option<String>,
    group_id: Option<String>,
    location_id: Option<String>,
    verdict: Option<Verdict>,
    offset: Option<usize>,
    limit: Option<usize>,
    json_offset: Option<usize>,
    json_limit: Option<usize>,
    expected_json_sha256: Option<String>,
}

#[tauri::command]
pub(crate) async fn journal_docx_check_for_agent(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    session_id: String,
    query: DocxCheckQuery,
) -> Result<Value, String> {
    let current = state.0.lock().await;
    let session = current
        .as_ref()
        .ok_or("Connect Workbench in Journal checks first.")?;
    read(session, &project_id, &session_id, &query).await
}

async fn read(
    session: &Session,
    project_id: &str,
    session_id: &str,
    query: &DocxCheckQuery,
) -> Result<Value, String> {
    let (result, arguments) = match query.operation {
        Operation::Status => read_status(session, project_id, session_id, query).await?,
        _ => read_findings(session, project_id, session_id, query).await?,
    };
    bounded_read_json_with_tool(
        (TOOL, query.operation.as_str()),
        result,
        arguments,
        query.json_offset,
        query.json_limit,
        None,
        query.expected_json_sha256.as_deref(),
    )
}

async fn retained_check(
    session: &Session,
    project_id: &str,
    check_id: &str,
) -> Result<Value, String> {
    let path = api_query("/api/check", &[("check_id", check_id)])?;
    let check = request(session, &path, None).await?;
    validate_check_scope(&check, check_id, project_id)?;
    Ok(check)
}

fn fields(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|value| ((*key).into(), value.clone())))
            .collect(),
    )
}

async fn read_status(
    session: &Session,
    project_id: &str,
    session_id: &str,
    query: &DocxCheckQuery,
) -> Result<(Value, Value), String> {
    if query.scope.is_some()
        || query.group_id.is_some()
        || query.location_id.is_some()
        || query.verdict.is_some()
        || query.offset.is_some()
        || query.limit.is_some()
    {
        return Err("Status does not accept candidate scope or finding page parameters.".into());
    }
    let state = request(session, "/api/state", None).await?;
    let project = selected_project(&state, project_id)?;
    let latest = &project["latest_check"];
    let mut project_status = fields(&project, &["project_id", "name", "baseline_id", "binding"]);
    project_status["latest_check"] = if latest.is_null() {
        Value::Null
    } else {
        fields(
            latest,
            &[
                "check_id",
                "baseline_id",
                "binding_id",
                "world_version_id",
                "validity",
                "stale_reasons",
                "summary",
            ],
        )
    };
    project_status["bound_template"] = project["binding"]["world_version_id"]
        .as_str()
        .and_then(|id| {
            state["worlds"]
                .as_array()?
                .iter()
                .find(|world| world["version_id"] == id)
        })
        .cloned()
        .unwrap_or(Value::Null);
    let mut arguments = json!({"session_id":session_id,"operation":"status"});
    let mut selected = Value::Null;
    if let Some(check_id) = query
        .check_id
        .as_deref()
        .or_else(|| latest["check_id"].as_str())
    {
        let check = retained_check(session, project_id, check_id).await?;
        selected = fields(
            &check,
            &[
                "check_id",
                "project_id",
                "baseline_id",
                "binding_id",
                "world_version_id",
                "source_sha256",
                "checker_version",
                "reader_version",
                "created_at",
                "validity",
                "stale_reasons",
                "update_available",
                "summary",
                "rule_results",
                "coverage_gaps",
                "limitations",
                "dependencies",
                "dispositions",
            ],
        );
        selected["world"] = fields(
            &check["world"],
            &[
                "version_id",
                "journal_id",
                "journal_name",
                "version_ordinal",
                "scope",
                "template",
            ],
        );
        if let Some(comparison) = check["template_comparison"].as_object() {
            let mut comparison = comparison.clone();
            for key in ["findings", "next_offset", "has_more"] {
                comparison.remove(key);
            }
            selected["template_comparison"] = Value::Object(comparison);
            selected["findingsRead"] = json!({"tool":TOOL,"arguments":{
                "session_id":session_id,"operation":"finding_groups","check_id":check_id
            }});
        }
        arguments["check_id"] = json!(check_id);
    }
    Ok((
        json!({"operation":"status","project":project_status,"check":selected}),
        arguments,
    ))
}

async fn finding_check(
    session: &Session,
    project_id: &str,
    check_id: &str,
    candidate: bool,
) -> Result<Value, String> {
    if !candidate {
        return retained_check(session, project_id, check_id).await;
    }
    let path = api_query(
        "/api/template-candidate-summary",
        &[("project_id", project_id), ("check_id", check_id)],
    )?;
    let review = request(session, &path, None).await?;
    let summary = &review["summary"];
    if candidate_review_check_id(&review)?.as_deref() != Some(check_id)
        || summary["target_project_id"] != project_id
    {
        return Err(
            "The requested check is not linked to this manuscript's retained candidate.".into(),
        );
    }
    let check = retained_check(session, text(summary, "candidate_project_id")?, check_id).await?;
    if check["baseline_id"] != summary["candidate_baseline_id"]
        || check["source_sha256"] != summary["candidate_source_sha256"]
    {
        return Err("The check is not for the retained candidate baseline.".into());
    }
    Ok(check)
}

async fn read_findings(
    session: &Session,
    project_id: &str,
    session_id: &str,
    query: &DocxCheckQuery,
) -> Result<(Value, Value), String> {
    let check_id = query
        .check_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or("Finding reads require a retained check_id.")?;
    let operation = query.operation.as_str();
    let groups = query.operation == Operation::FindingGroups;
    if groups
        && (query.group_id.is_some() || query.location_id.is_some() || query.verdict.is_some())
    {
        return Err("Finding group pages do not accept location or verdict filters.".into());
    }
    if query.operation == Operation::FindingLocations
        && (query.group_id.is_none() || query.location_id.is_some())
    {
        return Err(
            "Pass a group_id, but no location_id, to list a finding group's locations.".into(),
        );
    }
    let offset = query.offset.unwrap_or(0);
    let limit = bounded_limit(query.limit, 20, 50)?;
    let candidate = query.scope.is_some();
    let check = finding_check(session, project_id, check_id, candidate).await?;
    if !check["template_comparison"].is_object() {
        return Err("This saved check is not a DOCX template comparison.".into());
    }
    let mut payload = json!({"operation":operation,"target":{"check_id":check_id}});
    if !groups {
        payload["offset"] = json!(offset);
        payload["limit"] = json!(limit);
        for (field, value) in [
            ("group_id", &query.group_id),
            ("location_id", &query.location_id),
        ] {
            if let Some(value) = value {
                payload[field] = json!(value);
            }
        }
        if let Some(verdict) = &query.verdict {
            payload["verdict"] = json!(verdict);
        }
    }
    let mut result = request(session, "/api/docx-query", Some(payload.clone())).await?;
    let baseline_id = text(&check, "baseline_id")?;
    if result["schema_version"] != 1
        || result["operation"] != operation
        || result["check_id"] != check_id
        || result["source_sha256"] != text(&check, "source_sha256")?
        || result
            .get("baseline_id")
            .is_some_and(|baseline| baseline != baseline_id)
        || (query.operation == Operation::FindingLocations
            && result["group_id"].as_str() != query.group_id.as_deref())
    {
        return Err("Workbench returned evidence outside the pinned check.".into());
    }
    result["scope"] = json!(if candidate { "candidate" } else { "current" });
    result["baseline_id"] = json!(baseline_id);
    result["world_version_id"] = check["world_version_id"].clone();
    result["validity"] = check["validity"].clone();
    result["stale_reasons"] = check["stale_reasons"].clone();
    if groups {
        let page = page(&result["groups"], offset, limit)?;
        result["groups"] = page["items"].clone();
        result["total"] = page["total"].clone();
        result["next_offset"] = page["nextOffset"].clone();
        result["has_more"] = page["hasMore"].clone();
    }
    let mut arguments = fields(
        &payload,
        &["operation", "group_id", "location_id", "verdict"],
    );
    arguments["session_id"] = json!(session_id);
    arguments["check_id"] = json!(check_id);
    arguments["offset"] = json!(offset);
    arguments["limit"] = json!(limit);
    if let Some(scope) = &query.scope {
        arguments["scope"] = json!(scope);
    }
    if let Some(next_offset) = result["next_offset"].as_u64() {
        let mut next = arguments.clone();
        next["offset"] = json!(next_offset);
        result["nextRead"] = json!({"tool":TOOL,"arguments":next});
    }
    Ok((result, arguments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::Uri,
        routing::{get, post},
        Json, Router,
    };
    use std::process::Stdio;

    fn check(check_id: &str, project: &str, baseline: &str, validity: &str) -> Value {
        json!({
            "check_id":check_id,"project_id":project,"baseline_id":baseline,"world_version_id":"world-1",
            "source_sha256":format!("hash-{baseline}"),"validity":validity,
            "coverage_gaps":[{"code":"missing-geometry"}],
            "template_comparison":{"finding_summary":{"observed_difference":2},"findings":[{"raw":true}]}
        })
    }

    async fn evidence(Json(payload): Json<Value>) -> Json<Value> {
        let check_id = payload["target"]["check_id"].as_str().unwrap();
        let baseline = match check_id {
            "check-old" => "old",
            "candidate-check" => "isolated",
            _ => panic!("Unexpected finding request: {payload}"),
        };
        let mut result = json!({"schema_version":1,"operation":payload["operation"],
            "check_id":check_id,"source_sha256":format!("hash-{baseline}")});
        match payload["operation"].as_str().unwrap() {
            "finding_groups" => {
                assert!(payload.get("limit").is_none());
                result["baseline_id"] = json!(baseline);
                result["groups"] = json!([{"id":"body"},{"id":"formula"}]);
                result["summary"] = json!({"group_count":2});
            }
            "finding_locations" => {
                assert_eq!(payload["group_id"], "formula");
                result["baseline_id"] = json!(baseline);
                result["group_id"] = payload["group_id"].clone();
                result["locations"] = json!([{"id":"paragraph-b","para_id":"AABBCCDD"}]);
                result["next_offset"] = Value::Null;
            }
            "findings" => {
                assert_eq!(payload["group_id"], "formula");
                assert_eq!(payload["location_id"], "paragraph-b");
                result["findings"] = json!([{"object_id":"math-b","node_address":{"part":"word/document.xml"},
                    "expected":12,"observed":10}]);
                result["next_offset"] = Value::Null;
            }
            _ => panic!("Unexpected evidence operation: {payload}"),
        }
        Json(result)
    }

    fn follow(pointer: &Value) -> Value {
        assert_eq!(pointer["tool"], TOOL);
        let mut arguments = pointer["arguments"].clone();
        assert_eq!(
            arguments.as_object_mut().unwrap().remove("session_id"),
            Some(json!("session-a"))
        );
        arguments
    }

    #[tokio::test]
    async fn chat_reads_follow_the_pinned_check_through_workbench_http() {
        let router = Router::new()
            .route("/api/state", get(|| async {
                Json(json!({"projects":[
                    {"project_id":"paper","name":"Paper","baseline_id":"saved","binding":{"world_version_id":"world-2"},
                     "latest_check":check("check-new","paper","saved","CURRENT")},
                    {"project_id":"empty","name":"Empty","baseline_id":"start","binding":null,"latest_check":null}
                ],"worlds":[{"version_id":"world-2","journal_name":"Bound journal"}]}))
            }))
            .route("/api/check", get(|uri: Uri| async move {
                Json(match uri.query() {
                    Some("check_id=check-new") => check("check-new", "paper", "saved", "CURRENT"),
                    Some("check_id=check-old") => check("check-old", "paper", "old", "STALE"),
                    Some("check_id=candidate-check") => check("candidate-check", "candidate-paper", "isolated", "CURRENT"),
                    _ => panic!("Unexpected check: {uri}"),
                })
            }))
            .route("/api/template-candidate-summary", get(|uri: Uri| async move {
                let summary = if uri.query() == Some("project_id=paper&check_id=candidate-check") {
                    json!({"target_project_id":"paper","candidate_project_id":"candidate-paper",
                        "candidate_check_id":"candidate-check","candidate_baseline_id":"isolated","candidate_source_sha256":"hash-isolated",
                        "status":"conflict","reason":"target_baseline_changed"})
                } else {
                    Value::Null
                };
                Json(json!({"schema_version":1,"summary":summary}))
            }))
            .route("/api/docx-query", post(evidence));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        assert!(child.wait().await.unwrap().success());
        let session = Session {
            child,
            address,
            token: "test-token".into(),
            client: reqwest::Client::new(),
            library_root: Default::default(),
            runtime: "test".into(),
        };
        let read_page = |project_id, input| {
            let query = serde_json::from_value(input).unwrap();
            let session = &session;
            async move { read(session, project_id, "session-a", &query).await }
        };

        let empty = read_page("empty", json!({})).await.unwrap();
        assert!(empty["check"].is_null());
        assert!(empty["project"]["binding"].is_null());
        let current = read_page("paper", json!({})).await.unwrap();
        assert_eq!(
            current["project"]["bound_template"]["journal_name"],
            "Bound journal"
        );
        assert_eq!(current["check"]["check_id"], "check-new");
        let fragment = read_page("paper", json!({"json_limit":100})).await.unwrap();
        let next = follow(&fragment["continuation"]);
        assert_eq!(next["check_id"], "check-new");
        let continued = read_page("paper", next).await.unwrap();
        assert_eq!(continued["json_sha256"], fragment["json_sha256"]);

        let historical = read_page("paper", json!({"check_id":"check-old"}))
            .await
            .unwrap();
        assert_eq!(historical["project"]["baseline_id"], "saved");
        assert_eq!(
            historical["project"]["latest_check"]["check_id"],
            "check-new"
        );
        assert_eq!(historical["check"]["validity"], "STALE");
        assert!(historical["check"]["template_comparison"]
            .get("findings")
            .is_none());
        let mut arguments = follow(&historical["check"]["findingsRead"]);
        arguments["limit"] = json!(1);
        let first = read_page("paper", arguments).await.unwrap();
        assert_eq!(first["groups"][0]["id"], "body");
        assert_eq!(first["summary"]["group_count"], 2);
        let second = read_page("paper", follow(&first["nextRead"]))
            .await
            .unwrap();
        assert_eq!(second["check_id"], "check-old");
        assert_eq!(second["groups"][0]["id"], "formula");
        let locations = read_page("paper", json!({"check_id":"check-old","operation":"finding_locations","group_id":second["groups"][0]["id"]})).await.unwrap();
        assert_eq!(locations["locations"][0]["para_id"], "AABBCCDD");
        let findings = read_page(
            "paper",
            json!({"check_id":"check-old","operation":"findings","group_id":"formula",
            "location_id":locations["locations"][0]["id"]}),
        )
        .await
        .unwrap();
        assert_eq!(findings["baseline_id"], "old");
        assert_eq!(
            findings["findings"][0]["node_address"]["part"],
            "word/document.xml"
        );

        assert!(read_page(
            "paper",
            json!({"check_id":"candidate-check","operation":"finding_groups"})
        )
        .await
        .is_err());
        let candidate = read_page(
            "paper",
            json!({"scope":"candidate","check_id":"candidate-check","operation":"finding_groups"}),
        )
        .await
        .unwrap();
        assert_eq!(candidate["baseline_id"], "isolated");
        assert_eq!(candidate["scope"], "candidate");
        assert!(read_page(
            "empty",
            json!({"scope":"candidate","check_id":"candidate-check","operation":"finding_groups"})
        )
        .await
        .is_err());
        server.abort();
    }
}
