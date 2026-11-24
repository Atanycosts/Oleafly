use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::journal_workbench::{JournalWorkbenchState, Session};

use super::{
    bounded_read_json_with_tool, read_retained_content, read_saved_receipt, text, ContentQuery,
};

const TOOL: &str = "read_docx_saved_content";

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Detail {
    #[default]
    Compact,
    Full,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SavedDocxQuery {
    Content {
        baseline_id: Option<String>,
        expected_source_sha256: Option<String>,
        render_bundle_id: Option<String>,
        #[serde(default)]
        query: ContentQuery,
    },
    SavedRead {
        baseline_id: Option<String>,
        expected_source_sha256: Option<String>,
        read_record_id: String,
        #[serde(default)]
        detail: Detail,
        json_offset: Option<usize>,
        json_limit: Option<usize>,
        expected_json_sha256: Option<String>,
    },
}

#[tauri::command]
pub(crate) async fn journal_docx_content_for_agent(
    state: State<'_, JournalWorkbenchState>,
    project_id: String,
    session_id: String,
    baseline_id: String,
    source_sha256: String,
    query: SavedDocxQuery,
) -> Result<Value, String> {
    let current = state.0.lock().await;
    let session = current.as_ref().ok_or("Connect Workbench first.")?;
    read(
        session,
        &project_id,
        &session_id,
        (&baseline_id, &source_sha256),
        query,
    )
    .await
}

fn select_baseline<'a>(
    session_basis: (&'a str, &'a str),
    baseline_id: Option<&'a str>,
    source_sha256: Option<&'a str>,
) -> Result<(&'a str, &'a str), String> {
    match (baseline_id, source_sha256) {
        (None, None) => Ok(session_basis),
        (Some(id), Some(hash)) if !id.trim().is_empty() && hash.len() == 64 => Ok((id, hash)),
        _ => Err(
            "Use both baseline_id and expected_source_sha256 from the same retained version."
                .into(),
        ),
    }
}

async fn read(
    session: &Session,
    project_id: &str,
    session_id: &str,
    session_basis: (&str, &str),
    query: SavedDocxQuery,
) -> Result<Value, String> {
    match query {
        SavedDocxQuery::Content {
            baseline_id,
            expected_source_sha256,
            render_bundle_id,
            query,
        } => {
            if query.cursor.is_some() && baseline_id.is_none() {
                return Err(
                    "Follow nextRead with the exact baseline and source hash for this cursor."
                        .into(),
                );
            }
            let basis = select_baseline(
                session_basis,
                baseline_id.as_deref(),
                expected_source_sha256.as_deref(),
            )?;
            let response = read_retained_content(
                session,
                project_id,
                Some(basis.0),
                render_bundle_id.as_deref(),
                query,
            )
            .await?;
            let arguments = receipt_arguments(&response, project_id, session_id, basis, None)?;
            let result = compact_page(response, &arguments);
            bounded_read_json_with_tool(
                (TOOL, "content"),
                result,
                arguments,
                None,
                None,
                None,
                None,
            )
        }
        SavedDocxQuery::SavedRead {
            baseline_id,
            expected_source_sha256,
            read_record_id,
            detail,
            json_offset,
            json_limit,
            expected_json_sha256,
        } => {
            if read_record_id.trim().is_empty() {
                return Err("Choose a retained read_record_id.".into());
            }
            let basis = select_baseline(
                session_basis,
                baseline_id.as_deref(),
                expected_source_sha256.as_deref(),
            )?;
            let response = read_saved_receipt(session, project_id, &read_record_id).await?;
            let mut arguments = receipt_arguments(
                &response,
                project_id,
                session_id,
                basis,
                Some(&read_record_id),
            )?;
            let result = match detail {
                Detail::Compact => compact_page(response, &arguments),
                Detail::Full => {
                    arguments["detail"] = json!("full");
                    response
                }
            };
            bounded_read_json_with_tool(
                (TOOL, "saved_read"),
                result,
                arguments,
                json_offset,
                json_limit,
                None,
                expected_json_sha256.as_deref(),
            )
        }
    }
}

fn receipt_arguments(
    response: &Value,
    project_id: &str,
    session_id: &str,
    (baseline_id, source_sha256): (&str, &str),
    pinned_id: Option<&str>,
) -> Result<Value, String> {
    if response["project"]["project_id"] != project_id
        || response["project"]["baseline_id"] != baseline_id
        || response["source"]["sha256"] != source_sha256
    {
        return Err(
            "The retained read does not match this manuscript and saved source version.".into(),
        );
    }
    let record_id = text(&response["delivery"], "read_record_id")?;
    if response["read_receipt"]["read_record_id"] != record_id
        || pinned_id.is_some_and(|expected| expected != record_id)
    {
        return Err("Workbench returned a different retained read receipt.".into());
    }
    Ok(
        json!({"session_id":session_id, "operation":"saved_read", "read_record_id":record_id,
        "baseline_id":baseline_id, "expected_source_sha256":source_sha256}),
    )
}

fn compact_page(mut result: Value, receipt: &Value) -> Value {
    let mut omitted = json!({});
    for key in ["reader_issues", "unsupported_records"] {
        if let Some(items) = result.as_object_mut().and_then(|fields| fields.remove(key)) {
            omitted[key] = json!(items.as_array().map(Vec::len));
        }
    }
    if let Some(items) = result["read_receipt"]
        .as_object_mut()
        .and_then(|fields| fields.remove("unread_ranges"))
    {
        omitted["unread_ranges"] = json!(items.as_array().map(Vec::len));
    }
    result["projection"] = json!("compact");
    result["omitted_counts"] = omitted;
    let mut full = receipt.clone();
    full["detail"] = json!("full");
    result["fullRead"] = json!({"tool":TOOL,"arguments":full});
    result["nextRead"] = result["pagination"]["next_cursor"].as_str().map_or(Value::Null, |cursor| {
        let mut query = result["query_scope"].clone();
        if let Some(selectors) = query.as_object_mut() {
            selectors.retain(|_, value| !value.is_null());
        }
        query["page_size"] = result["pagination"]["page_size"].clone();
        query["cursor"] = json!(cursor);
        let mut arguments = json!({"session_id":receipt["session_id"], "operation":"content", "baseline_id":receipt["baseline_id"],
            "expected_source_sha256":receipt["expected_source_sha256"], "query":query});
        if let Some(bundle) = result["render_bundle"]["bundle_id"].as_str() {
            arguments["render_bundle_id"] = json!(bundle);
        }
        json!({"tool":TOOL,"arguments":arguments})
    });
    result
}

#[cfg(test)]
mod tests {
    use std::{
        process::Stdio,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    use axum::{http::Uri, routing::post, Json, Router};

    use super::*;

    fn delivery(read_id: &str, object: Value, next_cursor: Option<&str>) -> Value {
        json!({
            "query_version":"s1-read-query-1.8.0",
            "project":{"project_id":"paper","baseline_id":"saved-a"},
            "source":{"sha256":"a".repeat(64)},
            "status":"partial",
            "query_scope":{"region":"body","object_type":"reference","object_id":null,"page_number":null},
            "pagination":{"page_size":1,"has_more":next_cursor.is_some(),"next_cursor":next_cursor},
            "items":[object],"reader_issues":[],"unsupported_records":[],
            "read_receipt":{"read_record_id":read_id,"unread_ranges":[{"locator":"not-returned"}]},
            "delivery":{"read_record_id":read_id},
        })
    }

    fn follow(pointer: &Value) -> Value {
        assert_eq!(pointer["tool"], TOOL);
        let mut arguments = pointer["arguments"].clone();
        assert_eq!(
            arguments.as_object_mut().unwrap().remove("session_id"),
            Some(json!("word-a"))
        );
        arguments
    }

    #[tokio::test]
    async fn chat_follows_saved_pages_and_reassembles_long_content_from_the_receipt() {
        let comment = |body: &str| {
            json!({"kind":"comment_anchor","target_part":"word/comments.xml",
            "comment":{"text":body,"source_text":"Old and current text", "text_projection":"accepted_revisions",
                "author":"Reviewer","date":null,"node_locator":"word/comments.xml#comment[1]"}})
        };
        let first = delivery(
            "receipt-a",
            json!({"content":comment("Current text")}),
            Some("next"),
        );
        let long = delivery(
            "receipt-b",
            json!({"content":comment(&"修订后批注。".repeat(4300))}),
            None,
        );
        let posts = Arc::new(AtomicUsize::new(0));
        let router = Router::new().route(
            "/api/read",
            post({
                let (first, long, posts) = (first.clone(), long.clone(), Arc::clone(&posts));
                move |Json(payload): Json<Value>| {
                    let (first, long, posts) = (first.clone(), long.clone(), Arc::clone(&posts));
                    async move {
                        posts.fetch_add(1, Ordering::Relaxed);
                        assert_eq!(payload["project_id"], "paper");
                        assert_eq!(payload["baseline_id"], "saved-a");
                        assert_eq!(payload["query"]["region"], "body");
                        assert_eq!(payload["query"]["object_type"], "reference");
                        assert_eq!(payload["query"]["page_size"], 1);
                        Json(match payload["query"]["cursor"].as_str() {
                            None => first,
                            Some("next") => long,
                            value => panic!("Unexpected cursor: {value:?}"),
                        })
                    }
                }
            })
            .get({
                let (first, long) = (first.clone(), long.clone());
                move |uri: Uri| {
                    let (first, long) = (first.clone(), long.clone());
                    async move {
                        Json(match uri.query() {
                            Some("project_id=paper&read_record_id=receipt-a") => first,
                            Some("project_id=paper&read_record_id=receipt-b") => long,
                            _ => panic!("Unexpected receipt request: {uri}"),
                        })
                    }
                }
            }),
        );
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
        let read_page = |args, basis| {
            let query = serde_json::from_value(args).unwrap();
            read(&session, "paper", "word-a", basis, query)
        };
        let old_hash = "a".repeat(64);
        let new_hash = "b".repeat(64);
        let start = read_page(json!({"operation":"content","query":{"region":"body","object_type":"reference","page_size":1}}), ("saved-a", &old_hash)).await.unwrap();
        assert_eq!(start["items"], first["items"]);
        assert_eq!(start["omitted_counts"]["unread_ranges"], 1);
        assert!(start["read_receipt"].get("unread_ranges").is_none());
        let current_basis = ("saved-b", new_hash.as_str());
        let full = read_page(follow(&start["fullRead"]), current_basis)
            .await
            .unwrap();
        assert_eq!(full, first);
        let next = follow(&start["nextRead"]);
        assert_eq!(
            next["query"],
            json!({"region":"body","object_type":"reference","page_size":1,"cursor":"next"})
        );
        let mut page = read_page(next, current_basis).await.unwrap();
        assert_eq!(page["projection"], "json_fragment");
        let mut joined = String::new();
        loop {
            joined.push_str(page["json"].as_str().unwrap());
            if page["continuation"].is_null() {
                break;
            }
            let next = follow(&page["continuation"]);
            assert_eq!(next["operation"], "saved_read");
            assert_eq!(next["read_record_id"], "receipt-b");
            assert_eq!(next["expected_source_sha256"], old_hash);
            page = read_page(next, current_basis).await.unwrap();
        }
        let result: Value = serde_json::from_str(&joined).unwrap();
        assert_eq!(result["items"], long["items"]);
        assert!(result["nextRead"].is_null());
        assert_eq!(posts.load(Ordering::Relaxed), 2);
        server.abort();
    }

    #[test]
    fn retained_content_refuses_a_different_manuscript_source_or_receipt() {
        let response = delivery("receipt-a", json!({}), None);
        let hash = "a".repeat(64);
        let basis = ("saved-a", hash.as_str());
        for (project, source, receipt) in [
            ("other-paper", basis, "receipt-a"),
            ("paper", ("other-saved", hash.as_str()), "receipt-a"),
            ("paper", ("saved-a", "another-hash"), "receipt-a"),
            ("paper", basis, "other-receipt"),
        ] {
            assert!(
                receipt_arguments(&response, project, "word-a", source, Some(receipt)).is_err()
            );
        }
        assert!(serde_json::from_value::<SavedDocxQuery>(
            json!({"operation":"content","project_id":"other"})
        )
        .is_err());
        assert!(select_baseline(basis, Some("other-saved"), None).is_err());
    }
}
