//! Task-scoped access to the application's live DOCX business host.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use oleafly_agent::CancellationToken;
use oleafly_research::{
    docx::{
        DocxActivity, DocxActivityOrigin, DocxActivityPage, DocxDocumentIdentity,
        DocxProposalOutcome, DocxRuntimeEvent, DocxTarget,
    },
    mcp::{
        application_json_content, application_multimodal_content, protocol::ToolMeta,
        ApplicationImage, ApplicationTools,
    },
    model::ResearchTaskStatus,
    scheduler::{ResearchTaskState, TaskRuntimeFuture},
    store::TaskStore,
    task_tools::extra::TaskBinding,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use tokio::sync::oneshot;

struct Pending {
    reply: oneshot::Sender<Result<Value, String>>,
    task: Option<TaskBinding>,
    operation: Option<PendingOperation>,
    claimed: bool,
}

struct PendingOperation {
    id: String,
    operation: String,
    workbench_project_id: String,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Pending>> {
    pending()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Forget(String);
impl Drop for Forget {
    fn drop(&mut self) {
        lock().remove(&self.0);
    }
}

async fn renderer(
    app: &tauri::AppHandle,
    project_id: &str,
    workbench_project_id: Option<&str>,
    operation: &str,
    arguments: Value,
    task: Option<&TaskBinding>,
    intent: Option<&DocxActivity>,
) -> Result<Value, String> {
    let operation_id = intent.map(|intent| intent.id.as_str());
    if app.get_webview_window("main").is_none() {
        return Err("Open the Oleafly DOCX working copy to use this task tool.".into());
    }
    let mut random = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let (reply, answer) = oneshot::channel();
    lock().insert(
        token.clone(),
        Pending {
            reply,
            task: task.cloned(),
            operation: operation_id.map(|id| PendingOperation {
                id: id.into(),
                operation: operation.into(),
                workbench_project_id: workbench_project_id
                    .expect("tracked DOCX operations have a Workbench project")
                    .into(),
            }),
            claimed: false,
        },
    );
    let forget = Forget(token.clone());
    let mut payload = json!({"token":token,"projectId":project_id,"workbenchProjectId":workbench_project_id,
        "operation":operation,"arguments":arguments});
    if let Some(operation_id) = operation_id {
        payload["operationId"] = json!(operation_id);
    }
    if let Some(task) = task {
        payload["origin"] = renderer_origin(
            &task.task_id,
            task.generation,
            intent.map(|intent| &intent.origin),
        );
    }
    app.emit_to("main", "research-docx-request", payload)
        .map_err(|error| error.to_string())?;
    wait_for_pending_result(operation, answer, forget, renderer_timeout(operation)).await
}

fn renderer_timeout(operation: &str) -> Duration {
    Duration::from_secs(
        if matches!(
            operation,
            "save" | "check" | "prepare_fonts" | "export" | "write_equation"
        ) {
            150
        } else {
            45
        },
    )
}

fn docx_tool_timeout(name: &str) -> Duration {
    match name {
        "docx_task_activity" => Duration::from_secs(30),
        "save_docx_document" => renderer_timeout("save"),
        "check_docx_template" => renderer_timeout("check"),
        "prepare_docx_fonts" => renderer_timeout("prepare_fonts"),
        "export_docx_document" => renderer_timeout("export"),
        "propose_docx_change" => renderer_timeout("propose") + renderer_timeout("present"),
        "replace_docx_text_range" => renderer_timeout("replace_range"),
        "write_docx_equation" => renderer_timeout("write_equation"),
        _ => renderer_timeout("read"),
    }
}

async fn wait_for_pending_result(
    operation: &str,
    answer: oneshot::Receiver<Result<Value, String>>,
    forget: Forget,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let wait = async move {
        let _forget = forget;
        tokio::time::timeout_at(deadline, answer)
            .await
            .map_err(|_| {
                "The DOCX window did not answer. Reopen the working copy and retry.".to_string()
            })?
            .map_err(|_| "The DOCX window request ended.".to_string())?
    };
    if retains_result_after_cancel(operation) {
        // The outer tool runner may drop this call on cancellation or timeout.
        // Keep the real receipt channel alive until its original renderer deadline.
        tauri::async_runtime::spawn(wait)
            .await
            .map_err(|error| error.to_string())?
    } else {
        wait.await
    }
}

fn claim(token: &str) -> Result<(), String> {
    let mut requests = lock();
    let request = requests.get_mut(token).ok_or("This DOCX request ended.")?;
    if request.claimed {
        return Err("This DOCX request was already received.".into());
    }
    if let Some(task) = &request.task {
        let store = TaskStore::new(task.services.tasks_root.clone())?;
        active_task(&store, task)?;
    }
    request.claimed = true;
    Ok(())
}

#[tauri::command]
pub fn research_docx_request_claim(
    window: tauri::WebviewWindow,
    token: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main DOCX window can receive this request.".into());
    }
    claim(&token)
}

fn validate_request(token: &str) -> Result<(), String> {
    let requests = lock();
    let request = requests.get(token).ok_or("This DOCX request ended.")?;
    if !request.claimed {
        return Err("The DOCX request has not been claimed.".into());
    }
    if let Some(task) = &request.task {
        active_task(&TaskStore::new(task.services.tasks_root.clone())?, task)?;
    }
    Ok(())
}

fn retains_result_after_cancel(operation: &str) -> bool {
    matches!(
        operation,
        "format"
            | "replace_range"
            | "write_equation"
            | "format_batch"
            | "import_styles"
            | "apply"
            | "save"
            | "check"
            | "reveal"
            | "prepare_fonts"
            | "export"
    )
}

fn begin_renderer_operation(
    store: &TaskStore,
    task_id: &str,
    generation: u64,
    document: &DocxDocumentIdentity,
    operation: &str,
    request: &Value,
) -> Result<Option<DocxActivity>, String> {
    if !matches!(
        operation,
        "read_format"
            | "replace_range"
            | "write_equation"
            | "format"
            | "format_batch"
            | "import_styles"
            | "apply"
            | "save"
            | "check"
            | "read_image"
            | "context"
            | "reveal"
            | "prepare_fonts"
            | "export"
    ) {
        return Ok(None);
    }
    store
        .record_docx_activity(
            &document.app_project_id,
            task_id,
            generation,
            document.clone(),
            DocxRuntimeEvent::OperationStarted {
                operation: operation.into(),
                request: request.clone(),
            },
        )
        .map(Some)
}

fn read_image_operation_result(
    document: &DocxDocumentIdentity,
    result: &Value,
) -> Result<Value, String> {
    let metadata = result
        .get("result")
        .cloned()
        .ok_or("The DOCX image result has no metadata.")?;
    let result_document = metadata
        .get("document")
        .ok_or("The DOCX image metadata has no document identity.")?;
    if result_document["sessionId"].as_str() != Some(document.session_id.as_str())
        || result_document["appProjectId"].as_str() != Some(document.app_project_id.as_str())
        || result_document["workbenchProjectId"].as_str()
            != Some(document.workbench_project_id.as_str())
        || result_document["baselineId"].as_str() != Some(document.baseline_id.as_str())
        || result_document["sourceSha256"].as_str() != Some(document.source_sha256.as_str())
        || result_document["sessionRevision"].as_u64() != Some(document.session_revision)
        || result_document["savedRevision"].as_i64() != Some(document.saved_revision)
    {
        return Err("The DOCX image metadata belongs to a different document.".into());
    }
    if metadata
        .get("imageSha256")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err("The DOCX image metadata has no image hash.".into());
    }
    Ok(json!({
        "operation":"read_image",
        "ok":true,
        "document":document,
        "result":metadata,
    }))
}

fn finish_renderer_operation(
    store: &TaskStore,
    project_id: &str,
    workbench_project_id: &str,
    operation_id: &str,
    operation: &str,
    document: DocxDocumentIdentity,
    result: Value,
) -> Result<DocxActivity, String> {
    let result = if operation == "read_image" {
        read_image_operation_result(&document, &result)?
    } else {
        result
    };
    store.finish_docx_operation(
        project_id,
        workbench_project_id,
        operation_id,
        document,
        result,
    )
}

async fn await_renderer_result(
    operation: &str,
    cancel: &CancellationToken,
    request: impl Future<Output = Result<Value, String>>,
) -> Result<Value, String> {
    if retains_result_after_cancel(operation) {
        // The renderer validates the task before starting a side effect. Retain its
        // actual result even when the task is cancelled while that effect finishes.
        request.await
    } else {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("The DOCX task request was cancelled.".into()),
            result = request => result,
        }
    }
}

/// Preparation does not authorize a later write after cancellation or retry.
/// Once the host starts the side effect, its actual receipt is still accepted.
#[tauri::command]
pub fn research_docx_request_validate(
    window: tauri::WebviewWindow,
    token: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main DOCX window can validate this request.".into());
    }
    validate_request(&token)
}

#[tauri::command]
pub async fn research_docx_result(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Only the main DOCX window can answer this request.".into());
    }
    let workbench = app.state::<crate::journal_workbench::JournalWorkbenchState>();
    receive_renderer_result(&workbench, &token, result, error).await
}

async fn receive_renderer_result(
    workbench: &crate::journal_workbench::JournalWorkbenchState,
    token: &str,
    result: Option<Value>,
    error: Option<String>,
) -> Result<bool, String> {
    let pending = lock().remove(token).ok_or("This DOCX request ended.")?;
    if pending.operation.is_some() && !pending.claimed {
        let _ = pending.reply.send(Err(
            "The DOCX result arrived before the request was claimed.".into(),
        ));
        return Ok(false);
    }
    let mut outcome = match (result, error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        _ => Err("The DOCX window returned no result.".into()),
    };
    let mut recorded = false;
    if let (Ok(result), Some(operation), Some(task)) =
        (&mut outcome, &pending.operation, &pending.task)
    {
        let document = serde_json::from_value::<DocxDocumentIdentity>(result["document"].clone())
            .map_err(|error| format!("The DOCX result has no valid document: {error}"));
        let attempted = match document {
            Ok(document) if operation.operation == "save" => {
                let hash = crate::journal_workbench::retained_docx_source_hash(
                    workbench,
                    &document.workbench_project_id,
                    &document.baseline_id,
                )
                .await;
                hash.and_then(|hash| {
                    if hash != document.source_sha256 {
                        return Err(
                            "The saved DOCX operation does not match the retained baseline.".into(),
                        );
                    }
                    finish_renderer_operation(
                        &TaskStore::new(task.services.tasks_root.clone())?,
                        &task.project_id,
                        &operation.workbench_project_id,
                        &operation.id,
                        &operation.operation,
                        document,
                        result.clone(),
                    )
                })
            }
            Ok(document) => finish_renderer_operation(
                &TaskStore::new(task.services.tasks_root.clone())?,
                &task.project_id,
                &operation.workbench_project_id,
                &operation.id,
                &operation.operation,
                document,
                result.clone(),
            ),
            Err(error) => Err(error),
        };
        match attempted {
            Ok(activity) => {
                result["activity"] = json!(activity);
                recorded = true;
            }
            Err(error) => {
                result["activityPending"] = json!({
                    "error":error,
                    "operationCommitted":retains_result_after_cancel(&operation.operation)
                });
            }
        }
    }
    let _ = pending.reply.send(outcome);
    Ok(recorded)
}

#[derive(Clone)]
pub(crate) struct DocxTools {
    app: tauri::AppHandle,
    task: TaskBinding,
}

pub(crate) fn application_tools(
    app: tauri::AppHandle,
    task: TaskBinding,
) -> Arc<dyn ApplicationTools> {
    Arc::new(DocxTools { app, task })
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn renderer_origin(
    task_id: &str,
    generation: u64,
    activity_origin: Option<&DocxActivityOrigin>,
) -> Value {
    let mut origin = json!({"kind":"task","taskId":task_id,"generation":generation});
    if let Some(member_id) = activity_origin.and_then(|origin| origin.member_id.as_deref()) {
        origin["memberId"] = json!(member_id);
    }
    if let Some(execution_id) = activity_origin.and_then(|origin| origin.execution_id.as_deref()) {
        origin["executionId"] = json!(execution_id);
    }
    origin
}

fn format_read_query_properties() -> Value {
    json!({
        "kind":{"type":"string","enum":["overview","paragraphs","styles","objects","nodes"]},"paragraph_ref":{"type":"string"},"part":{"type":"string"},
        "object_kind":{"type":"string"},"role":{"type":"string"},"style_id":{"type":"string"},"object_id":{"type":"string"},"text":{"type":"string"},
        "text_offset":{"type":"integer","minimum":0},"text_limit":{"type":"integer","minimum":1,"maximum":16000},
        "path":{"type":"array","items":{"type":"integer","minimum":0}},"namespace_uri":{"type":"string"},"local_name":{"type":"string"},
        "attribute":{"type":"object","properties":{
            "namespace_uri":{"type":"string"},"local_name":{"type":"string"},"value":{"type":"string"}
        },"required":["local_name"],"additionalProperties":false},
        "offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50},
        "expected_revision":{"type":"integer","minimum":0}
    })
}

fn validate_format_read_query(query: Option<&Value>) -> Result<(), String> {
    let Some(query) = query else {
        return Ok(());
    };
    if !query.is_object()
        || query
            .get("offset")
            .is_some_and(|value| value.as_u64().is_none())
        || query.get("limit").is_some_and(|value| {
            value
                .as_u64()
                .is_none_or(|limit| !(1..=50).contains(&limit))
        })
        || query
            .get("expected_revision")
            .is_some_and(|value| value.as_u64().is_none())
    {
        return Err(
            "Read one to fifty format objects from non-negative offset and revision values.".into(),
        );
    }
    Ok(())
}

impl ApplicationTools for DocxTools {
    fn call_timeout(&self, name: &str) -> Duration {
        docx_tool_timeout(name)
    }

    fn definitions(&self) -> Vec<ToolMeta> {
        let mut tools = vec![
            ToolMeta::new(
                "get_docx_workspace_context",
                "Read the viewed material separately from this task's bound writable Word session. History and evidence selections are reference data. Only selectionWriteTarget is a verified current write address.",
                schema(json!({}), &[]),
            ),
            ToolMeta::new(
                "reveal_docx_working_copy",
                "Request presentation of the bound working copy, optionally at a live paragraph. Paragraph navigation requires its current expected_revision. The user's paused follow state is respected.",
                schema(json!({"paragraph_ref":{"type":"string","minLength":1},"expected_revision":{"type":"integer","minimum":0}}), &[]),
            ),
            ToolMeta::new(
                "prepare_docx_fonts",
                "Prepare exact fonts for this task's bound working copy using the application's existing font download and refresh services. Returns actual availability and measurement state.",
                schema(json!({}), &[]),
            ),
            ToolMeta::new(
                "export_docx_document",
                "Export the bound live working copy through the same download action as the user. Returns the actual captured revision and saved, cancelled or download-requested outcome. This does not save a Workbench baseline.",
                schema(json!({}), &[]),
            ),
            ToolMeta::new(
                "list_docx_documents",
                "List this task's explicitly bound live DOCX working copy. Read, format, apply, save and recheck operate on this same session. No other open documents are exposed.",
                schema(json!({}), &[]),
            ),
            ToolMeta::new(
                "read_docx_document",
                "Read a bounded paragraph page from this task's bound live DOCX session. text is display text and ranges use whole-paragraph modelText UTF-16 offsets. Each paragraph carries the route that continues its own modelText window. Math payloads expose readableMath and diagnostics rather than an image; drawing objects and fields with one embedded-image route carry read_docx_image when their pixels are available. Continue metadata with next_query, and use the returned text, atom and payload continuation fields for the exact modelText window. The live session may contain unsaved user edits.",
                schema(
                    json!({
                        "session_id":{"type":"string"},"offset":{"type":"integer","minimum":0},
                        "limit":{"type":"integer","minimum":1,"maximum":50},
                        "expected_revision":{"type":"integer","minimum":0},
                        "text_offset":{"type":"integer","minimum":0},
                        "text_limit":{"type":"integer","minimum":1,"maximum":8000},
                        "atom_offset":{"type":"integer","minimum":0},
                        "payload_offset":{"type":"integer","minimum":0}
                    }),
                    &[],
                ),
            ),
            ToolMeta::new(
                "read_docx_image",
                "Read the current embedded PNG, JPEG or GIF referenced by one DrawingML or VML drawing, or by a field whose payload contains one embedded-image route, in this task's bound live DOCX. Supply exactly the paragraph_ref, object_ref and expected_revision attached to that read_docx_image route. Arbitrary media paths and external images are refused. Document/source identity and image metadata travel as text; pixels travel as a separate image content part. This does not edit, save or export the document.",
                schema(
                    json!({
                        "session_id":{"type":"string"},
                        "paragraph_ref":{"type":"string","minLength":1},
                        "object_ref":{"type":"string","minLength":1,"description":"The drawing or field object_ref whose route requested this image."},
                        "expected_revision":{"type":"integer","minimum":0}
                    }),
                    &["paragraph_ref", "object_ref", "expected_revision"],
                ),
            ),
            ToolMeta::new(
                "replace_docx_text_range",
                "Replace one ordinary text range in this task's bound live DOCX. range and expected_text use UTF-16 modelText offsets. Fields, equations, drawings, notes, formatting/container boundaries and stale revisions are refused. One undoable edit; save separately.",
                schema(
                    json!({
                        "paragraph_ref":{"type":"string","minLength":1},
                        "expected_revision":{"type":"integer","minimum":0},
                        "range":{"type":"object","required":["start","end"],"additionalProperties":false,
                            "properties":{"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":1}}},
                        "expected_text":{"type":"string"},
                        "replacement":{"type":"string"}
                    }),
                    &["paragraph_ref","expected_revision","range","expected_text","replacement"],
                ),
            ),
            ToolMeta::new(
                "write_docx_equation",
                "Compile one LaTeX equation body with explicit math macro context into editable Word math. Insert at an exact modelText UTF-16 offset, or replace one math object with object_ref and expected_fingerprint. Replacement cannot include offset. Use adopt_source only for explicit adoption of an absent or externally changed source. Whole documents, algorithms, labels and numbering commands are refused. Conversion diagnostics are preserved. Save separately.",
                schema(json!({
                    "session_id":{"type":"string"},
                    "paragraph_ref":{"type":"string","minLength":1},
                    "expected_revision":{"type":"integer","minimum":0},
                    "latex":{"type":"string","minLength":1,"maxLength":16384},
                    "macros":{"type":"string","maxLength":16384},
                    "object_ref":{"type":"string","minLength":1},
                    "expected_fingerprint":{"type":"string","minLength":1},
                    "adopt_source":{"type":"boolean"},
                    "offset":{"type":"integer","minimum":0},
                    "display":{"type":"boolean"}
                }), &["paragraph_ref","expected_revision","latex"]),
            ),
            ToolMeta::new(
                "capture_docx_target",
                "Capture a paragraph from the bound DOCX as a revision-checked target. The reference is valid only in this live session.",
                schema(
                    json!({
                        "session_id":{"type":"string"},"paragraph_ref":{"type":"string"}
                    }),
                    &["paragraph_ref"],
                ),
            ),
            ToolMeta::new(
                "propose_docx_change",
                "Retain a proposed whole-paragraph replacement and show it beside the bound DOCX for the user's existing accept/reject workflow. Supply your own completed replacement text; this tool does not call another model, edit the document or save a baseline. It refuses stale targets. Runtime task/member/work attribution is recorded automatically.",
                schema(
                    json!({
                        "target_id":{"type":"string"},"expected_revision":{"type":"integer","minimum":0},"text":{"type":"string","maxLength":32768}
                    }),
                    &["target_id", "expected_revision", "text"],
                ),
            ),
            ToolMeta::new(
                "docx_task_activity",
                "Read this task's retained DOCX activity, including earlier members' reads and proposals, user decisions, and exact saved-baseline receipts. History remains readable when the editor is closed. Continue with nextCursor when hasMore is true.",
                schema(
                    json!({
                        "after_cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}
                    }),
                    &[],
                ),
            ),
            ToolMeta::new(
                "read_docx_format",
                "Read system-parsed Word text, structure, styles and effective formatting. Begin with overview for the document directory and reading routes, then page paragraphs, styles or objects. Paragraph modelText provides absolute UTF-16 font-range offsets with fields as U+FFFC. The live session and saved baseline are distinct.",
                schema(
                    json!({
                        "query":{"type":"object","properties":format_read_query_properties(),"additionalProperties":false}
                    }),
                    &[],
                ),
            ),
            ToolMeta::new(
                "apply_docx_format",
            "Apply formatting to a paragraph, exact font range, frame or containing section/table/row/cell in the bound live DOCX at expected_revision. Scope defaults to paragraph. Use only fields for the selected scope. Styles must already exist. Save separately.",
                schema(
                    json!({
                        "paragraph_ref":{"type":"string"},"expected_revision":{"type":"integer","minimum":0},
                        "range":{"type":"object","required":["start","end"],"properties":{"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":1}},"additionalProperties":false},
                        "scope":{"type":"string","enum":["paragraph","frame","section","table","row","cell"]},
                        "frame":{"type":["object","null"],"required":["widthTwips"],"additionalProperties":false,"properties":{
                            "widthTwips":{"type":"integer","minimum":1,"maximum":63360},"heightTwips":{"type":"integer","minimum":0,"maximum":63360},
                            "xTwips":{"type":"integer"},"yTwips":{"type":"integer"},
                            "horizontalAnchor":{"enum":["page","margin","text"]},"verticalAnchor":{"enum":["page","margin","text"]},
                            "horizontalAlignment":{"enum":["left","center","right","inside","outside"]},"verticalAlignment":{"enum":["top","center","bottom","inside","outside"]},
                            "wrap":{"enum":["auto","around","none","notBeside","through","tight"]},"heightRule":{"enum":["auto","atLeast","exact"]},
                            "horizontalSpaceTwips":{"type":"integer","minimum":0},"verticalSpaceTwips":{"type":"integer","minimum":0}
                        }},
                        "font":{"type":"object","properties":{
                            "name":{"type":"string","description":"Exact Latin font family."},"nameEastAsia":{"type":"string","minLength":1,"description":"Exact East Asian font family."},
                            "size":{"type":"number","exclusiveMinimum":0},"bold":{"type":"boolean"},"italic":{"type":"boolean"},
                            "underline":{"type":"string"},"color":{"type":"string"},"highlightColor":{"type":["string","null"]},"strikeThrough":{"type":"boolean"},"subscript":{"type":"boolean"},"superscript":{"type":"boolean"}
                        },"additionalProperties":false},
                        "paragraph":{"type":"object","properties":{
                            "style":{"type":"string","description":"Exact style display name w:name, not w:styleId. Read kind styles to resolve an imported ID."},"alignment":{"type":"string","enum":["Left","Centered","Right","Justified"]},
                            "firstLineIndent":{"type":"number"},"leftIndent":{"type":"number"},"rightIndent":{"type":"number"},
                            "lineSpacing":{"type":"number"},"spaceBefore":{"type":"number"},"spaceAfter":{"type":"number"},"widowControl":{"type":"boolean"},
                            "keepNext":{"type":"boolean"},"keepLines":{"type":"boolean"},"pageBreakBefore":{"type":"boolean"},
                            "readingOrder":{"type":"string","enum":["LeftToRight","RightToLeft"]}
                        },"additionalProperties":false},
                        "section":{"type":"object","minProperties":1,"properties":{
                            "pageWidthTwips":{"type":"integer","minimum":1},"pageHeightTwips":{"type":"integer","minimum":1},
                            "orientation":{"enum":["portrait","landscape"]},
                            "marginTopTwips":{"type":"integer","minimum":0},"marginRightTwips":{"type":"integer","minimum":0},
                            "marginBottomTwips":{"type":"integer","minimum":0},"marginLeftTwips":{"type":"integer","minimum":0},
                            "columns":{"type":"object","required":["count"],"additionalProperties":false,"properties":{
                                "count":{"type":"integer","minimum":1,"maximum":45},"spaceTwips":{"type":"integer","minimum":0,"maximum":31680},"separator":{"type":"boolean"}
                            }}
                        },"additionalProperties":false},
                        "table":{"type":"object","minProperties":1,"properties":{
                            "styleId":{"type":"string","minLength":1},"headerRowCount":{"type":"integer","minimum":0},
                            "columnWidthsTwips":{"type":"array","minItems":1,"items":{"type":"integer","minimum":1}}
                        },"additionalProperties":false},
                        "row":{"type":"object","required":["heightTwips"],"properties":{
                            "heightTwips":{"type":"integer","minimum":1}
                        },"additionalProperties":false},
                        "cell":{"type":"object","minProperties":1,"properties":{
                            "fill":{"type":["string","null"],"pattern":"^#?[0-9A-Fa-f]{6}$"},
                            "verticalAlignment":{"enum":["top","center","bottom"]}
                        },"additionalProperties":false}
                    }),
                    &["paragraph_ref", "expected_revision"],
                ),
            ),
            ToolMeta::new(
                "apply_docx_suggestion",
                "Apply a captured whole-paragraph text change directly to the task's bound live DOCX. Use when the assigned work authorizes direct editing; propose_docx_change remains available for user review. Stale targets and complex inline content are refused.",
                schema(
                    json!({
                        "target_id":{"type":"string"},"expected_revision":{"type":"integer","minimum":0},"text":{"type":"string","maxLength":32768}
                    }),
                    &["target_id", "expected_revision", "text"],
                ),
            ),
            ToolMeta::new(
                "apply_docx_format_batch",
                "Apply one to one hundred DOCX format operations atomically as one revision and one undo step. Every paragraph reference is from this bound live session. An optional range applies font formatting only, using absolute UTF-16 modelText offsets from read_docx_format. Invalid operations leave the entire group unchanged. Save separately.",
                schema(json!({
                    "expected_revision":{"type":"integer","minimum":0},
                    "operations":{"type":"array","minItems":1,"maxItems":100,"items":{
                        "type":"object","required":["paragraph_ref"],"additionalProperties":false,
                        "properties":{
                            "paragraph_ref":{"type":"string","minLength":1},
                            "range":{"type":"object","required":["start","end"],"properties":{"start":{"type":"integer","minimum":0},"end":{"type":"integer","minimum":1}},"additionalProperties":false},
                            "scope":{"type":"string","enum":["paragraph","section","table","row","cell"]},
                            "font":{"type":"object"},"paragraph":{"type":"object"},
                            "section":{"type":"object"},"table":{"type":"object"},"row":{"type":"object"},"cell":{"type":"object"}
                        }
                    }}
                }), &["expected_revision", "operations"]),
            ),
            ToolMeta::new(
                "import_docx_template_styles",
                "Import selected style definitions and their style/numbering dependencies from an explicit retained Word template into this bound live DOCX. Existing styles are preserved. Resolve each returned styleIdMap value using read_docx_format kind styles with style_id, then apply its exact name with paragraph.style; paragraph.style uses w:name, not w:styleId. Source theme fonts and stored color fallbacks become explicit; document defaults and the whole theme are not copied, so unspecified values use target defaults. Read effective formatting after applying. One undoable transaction; save separately.",
                schema(json!({
                    "template":{"type":"string","minLength":1},
                    "style_ids":{"type":"array","minItems":1,"maxItems":100,"uniqueItems":true,"items":{"type":"string","minLength":1}},
                    "expected_revision":{"type":"integer","minimum":0}
                }), &["template", "style_ids", "expected_revision"]),
            ),
            ToolMeta::new(
                "save_docx_document",
                "Save the bound live Word document through the same fixed save and recovery chain as the user. Supply its current session revision. Returns the exact new Workbench baseline and source hash. To check or recheck this saved document against a template, use check_docx_template with its explicit template world. Use export_docx_document when the task requests an exported copy. Author inputs stay read only.",
                schema(
                    json!({
                        "expected_revision":{"type":"integer","minimum":0}
                    }),
                    &["expected_revision"],
                ),
            ),
            ToolMeta::new(
                "check_docx_template",
                "Check or recheck the task's bound live Word document (DOCX) against an explicitly selected retained template world. Save current edits first with save_docx_document. Supply that world version as template; this route uses the DOCX task binding and does not require journal_bind or a retained journal-task input. Returns the actual check tied to the exact saved manuscript and world versions.",
                schema(
                    json!({
                        "template":{"type":"string","minLength":1}
                    }),
                    &["template"],
                ),
            ),
        ];
        let mut item_schema = tools
            .iter()
            .find(|tool| tool.name == "apply_docx_format")
            .expect("the paragraph format tool owns format schemas")
            .input_schema
            .clone();
        item_schema["properties"]
            .as_object_mut()
            .expect("format properties")
            .remove("expected_revision");
        item_schema["required"] = json!(["paragraph_ref"]);
        tools
            .iter_mut()
            .find(|tool| tool.name == "apply_docx_format_batch")
            .expect("the batch format tool is registered")
            .input_schema["properties"]["operations"]["items"] = item_schema;
        tools
    }

    fn call(&self, name: String, args: Value) -> TaskRuntimeFuture<Value> {
        let tools = self.clone();
        Box::pin(async move { tools.execute(&name, args).await })
    }

    fn call_content(&self, name: String, args: Value) -> TaskRuntimeFuture<Value> {
        let tools = self.clone();
        Box::pin(async move {
            let result = tools.execute(&name, args).await?;
            if name != "read_docx_image" {
                return application_json_content(result);
            }
            let data_url = result["image"]
                .as_str()
                .ok_or("The DOCX image result has no image content.")?;
            let (prefix, data) = data_url
                .split_once(',')
                .ok_or("The DOCX image result has no data URL.")?;
            let mime_type = prefix
                .strip_prefix("data:")
                .and_then(|prefix| prefix.strip_suffix(";base64"))
                .ok_or("The DOCX image result has an invalid data URL.")?;
            if result["result"]["mimeType"].as_str() != Some(mime_type) {
                return Err(
                    "The DOCX image metadata and data URL have different MIME types.".into(),
                );
            }
            application_multimodal_content(
                json!({
                    "source": "live-docx",
                    "document": result["document"].clone(),
                    "image": result["result"].clone(),
                }),
                vec![ApplicationImage {
                    mime_type: mime_type.into(),
                    data: data.into(),
                }],
            )
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    session_id: Option<String>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
    expected_revision: Option<u64>,
    text_offset: Option<usize>,
    text_limit: Option<usize>,
    atom_offset: Option<usize>,
    payload_offset: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadImage {
    session_id: Option<String>,
    paragraph_ref: String,
    object_ref: String,
    expected_revision: u64,
}

impl ReadImage {
    fn renderer_arguments(self) -> Value {
        json!({
            "paragraph_ref": self.paragraph_ref,
            "object_ref": self.object_ref,
            "expected_revision": self.expected_revision,
        })
    }
}

impl Read {
    fn renderer_arguments(&self) -> Value {
        let mut arguments = serde_json::Map::from_iter([
            ("offset".into(), json!(self.offset)),
            ("limit".into(), json!(self.limit.unwrap_or(20))),
        ]);
        if let Some(value) = self.expected_revision {
            arguments.insert("expected_revision".into(), json!(value));
        }
        if let Some(value) = self.text_offset {
            arguments.insert("text_offset".into(), json!(value));
        }
        if let Some(value) = self.text_limit {
            arguments.insert("text_limit".into(), json!(value));
        }
        if let Some(value) = self.atom_offset {
            arguments.insert("atom_offset".into(), json!(value));
        }
        if let Some(value) = self.payload_offset {
            arguments.insert("payload_offset".into(), json!(value));
        }
        Value::Object(arguments)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceRange {
    paragraph_ref: String,
    expected_revision: u64,
    range: TextRange,
    expected_text: String,
    replacement: String,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct TextRange {
    start: usize,
    end: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    session_id: Option<String>,
    paragraph_ref: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Propose {
    target_id: String,
    expected_revision: u64,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    #[serde(default)]
    after_cursor: u64,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatRead {
    query: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reveal {
    paragraph_ref: Option<String>,
    expected_revision: Option<u64>,
}

fn workspace_arguments(operation: &str, arguments: Value) -> Result<Value, String> {
    if operation == "reveal" {
        let reveal: Reveal =
            serde_json::from_value(arguments.clone()).map_err(|error| error.to_string())?;
        if reveal.paragraph_ref.as_ref().is_some_and(|paragraph| {
            paragraph.trim().is_empty() || reveal.expected_revision.is_none()
        }) {
            return Err(
                "Paragraph navigation needs its reference and current expected_revision.".into(),
            );
        }
    } else if arguments
        .as_object()
        .is_none_or(|fields| !fields.is_empty())
    {
        return Err("This Word workspace action accepts no arguments and uses the task's bound working copy.".into());
    }
    Ok(arguments)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatEdit {
    paragraph_ref: String,
    expected_revision: u64,
    scope: Option<String>,
    font: Option<Value>,
    paragraph: Option<Value>,
    section: Option<Value>,
    table: Option<Value>,
    row: Option<Value>,
    cell: Option<Value>,
    range: Option<FormatRange>,
    #[serde(default, deserialize_with = "nullable_format")]
    frame: Option<Value>,
}

fn nullable_format<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatRange {
    start: usize,
    end: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FormatBatch {
    expected_revision: u64,
    operations: Vec<Value>,
}

fn batch_renderer_arguments(batch: FormatBatch) -> Result<Value, String> {
    if !(1..=100).contains(&batch.operations.len()) {
        return Err("Supply one to one hundred DOCX format operations.".into());
    }
    let mut operations = Vec::with_capacity(batch.operations.len());
    for item in batch.operations {
        let mut item = item
            .as_object()
            .cloned()
            .ok_or("A DOCX format operation must be an object.")?;
        if item.contains_key("expected_revision") {
            return Err("The DOCX batch owns one expected_revision for all operations.".into());
        }
        item.insert("expected_revision".into(), json!(batch.expected_revision));
        let edit: FormatEdit =
            serde_json::from_value(Value::Object(item)).map_err(|error| error.to_string())?;
        let args = edit.renderer_arguments()?;
        let mut operation = json!({"paragraphRef":args["paragraph_ref"]});
        if let Some(format) = args.get("format") {
            for (name, value) in format.as_object().expect("paragraph format is an object") {
                operation[name] = value.clone();
            }
        }
        if let Some(format) = args.get("object_format") {
            operation["objectFormat"] = format.clone();
        }
        if let Some(range) = args.get("range") {
            operation["range"] = range.clone();
        }
        operations.push(operation);
    }
    Ok(json!({"expected_revision":batch.expected_revision,"operations":operations}))
}

impl FormatEdit {
    fn renderer_arguments(self) -> Result<Value, String> {
        if self.paragraph_ref.is_empty() {
            return Err("A DOCX format edit needs a paragraph reference.".into());
        }
        let scope = self.scope.as_deref().unwrap_or("paragraph");
        if let Some(range) = &self.range {
            if range.start >= range.end
                || scope != "paragraph"
                || self.font.is_none()
                || self.paragraph.is_some()
            {
                return Err("A DOCX range needs 0 <= start < end and font formatting only.".into());
            }
        }
        let mut arguments =
            json!({"paragraph_ref":self.paragraph_ref,"expected_revision":self.expected_revision});
        let objects = [
            ("frame", self.frame),
            ("section", self.section),
            ("table", self.table),
            ("row", self.row),
            ("cell", self.cell),
        ];
        if scope == "paragraph" {
            if objects.iter().any(|(_, value)| value.is_some())
                || self.font.is_none() && self.paragraph.is_none()
            {
                return Err("Supply font or paragraph fields for paragraph formatting.".into());
            }
            let mut format = json!({});
            if let Some(font) = self.font {
                format["font"] = font;
            }
            if let Some(paragraph) = self.paragraph {
                format["paragraph"] = paragraph;
            }
            arguments["format"] = format;
            if let Some(range) = self.range {
                arguments["range"] = json!({"start":range.start,"end":range.end});
            }
        } else {
            if !["frame", "section", "table", "row", "cell"].contains(&scope)
                || self.font.is_some()
                || self.paragraph.is_some()
            {
                return Err("Choose one DOCX formatting scope and its matching fields.".into());
            }
            let mut format = json!({"kind":scope});
            for (kind, value) in objects {
                if kind == scope {
                    let value = value
                        .filter(|value| {
                            (kind == "frame" && value.is_null())
                                || value.as_object().is_some_and(|fields| !fields.is_empty())
                        })
                        .ok_or("Supply at least one format field for the selected scope.")?;
                    format[kind] = value;
                } else if value.is_some() {
                    return Err("Supply format fields only for the selected scope.".into());
                }
            }
            arguments["object_format"] = format;
        }
        Ok(arguments)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    expected_revision: u64,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct WriteEquation {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    paragraph_ref: String,
    expected_revision: u64,
    latex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    macros: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adopt_source: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display: Option<bool>,
}

impl WriteEquation {
    fn validate(&self) -> Result<(), String> {
        if self.paragraph_ref.trim().is_empty()
            || self.latex.trim().is_empty()
            || self.latex.chars().count() + self.macros.as_deref().unwrap_or("").chars().count()
                > 16_384
        {
            return Err("Supply one equation body, its paragraph reference and at most 16,384 source characters.".into());
        }
        if let Some(object_ref) = &self.object_ref {
            if object_ref.trim().is_empty()
                || self
                    .expected_fingerprint
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                || self.offset.is_some()
            {
                return Err("Equation replacement needs object_ref and expected_fingerprint, without an insertion offset.".into());
            }
        } else if self.offset.is_none()
            || self.expected_fingerprint.is_some()
            || self.adopt_source.is_some()
        {
            return Err("Equation insertion needs an exact offset, without replacement fingerprint or source adoption.".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportStyles {
    template: String,
    style_ids: Vec<String>,
    expected_revision: u64,
}

impl ImportStyles {
    fn validate(&self) -> Result<(), String> {
        if self.template.trim().is_empty()
            || !(1..=100).contains(&self.style_ids.len())
            || self.style_ids.iter().any(|id| id.trim().is_empty())
            || self
                .style_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.style_ids.len()
        {
            return Err(
                "Choose one retained template and one to one hundred unique style IDs.".into(),
            );
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Check {
    template: String,
}

fn active_task(store: &TaskStore, task: &TaskBinding) -> Result<(), String> {
    active_execution(
        store,
        &task.project_id,
        &task.task_id,
        task.generation,
        &task.cancel,
    )
}

fn active_execution(
    store: &TaskStore,
    project_id: &str,
    task_id: &str,
    generation: u64,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let current = store.require(task_id)?;
    if cancel.is_cancelled()
        || current.cancel_requested
        || current.project_id != project_id
        || current.execution_generation != generation
        || current.status != ResearchTaskStatus::Running
    {
        return Err("This DOCX task execution is no longer active.".into());
    }
    Ok(())
}

fn same_document(
    bound: &DocxDocumentIdentity,
    actual: &DocxDocumentIdentity,
) -> Result<(), String> {
    if actual.session_id != bound.session_id
        || actual.app_project_id != bound.app_project_id
        || actual.workbench_project_id != bound.workbench_project_id
    {
        return Err("The DOCX window returned a different working copy.".into());
    }
    Ok(())
}

fn proposal_target(result: &Value, proposal: &Propose) -> Result<DocxTarget, String> {
    let target: DocxTarget =
        serde_json::from_value(result["target"].clone()).map_err(|error| error.to_string())?;
    if target.target_id != proposal.target_id || target.revision != proposal.expected_revision {
        return Err("The DOCX proposal target differs from the captured revision.".into());
    }
    if target.original == proposal.text {
        return Err("The DOCX replacement is unchanged from the captured paragraph.".into());
    }
    Ok(target)
}

impl DocxTools {
    async fn execute(&self, name: &str, args: Value) -> Result<Value, String> {
        let store = TaskStore::new(self.task.services.tasks_root.clone())?;
        active_task(&store, &self.task)?;
        if name == "docx_task_activity" {
            let history: History =
                serde_json::from_value(args).map_err(|error| error.to_string())?;
            return serde_json::to_value(store.docx_task_activities(
                &self.task.project_id,
                &self.task.task_id,
                history.after_cursor,
                history.limit.unwrap_or(20),
            )?)
            .map_err(|error| error.to_string());
        }
        let bound = store
            .docx_task_binding(&self.task.project_id, &self.task.task_id)?
            .ok_or("Bind this task to a DOCX working copy from the document's task panel first.")?;
        let mut arguments = args.clone();
        let operation = match name {
            "get_docx_workspace_context"
            | "reveal_docx_working_copy"
            | "prepare_docx_fonts"
            | "export_docx_document" => {
                let operation = match name {
                    "get_docx_workspace_context" => "context",
                    "reveal_docx_working_copy" => "reveal",
                    "prepare_docx_fonts" => "prepare_fonts",
                    _ => "export",
                };
                arguments = workspace_arguments(operation, args.clone())?;
                operation
            }
            "list_docx_documents" => {
                if args.as_object().is_none_or(|fields| !fields.is_empty()) {
                    return Err("list_docx_documents accepts no arguments.".into());
                }
                "list"
            }
            "read_docx_document" => {
                let read: Read =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if read
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &bound.session_id)
                    || !(1..=50).contains(&read.limit.unwrap_or(20))
                    || read.text_offset.is_some() != read.text_limit.is_some()
                    || read
                        .text_limit
                        .is_some_and(|limit| !(1..=8000).contains(&limit))
                    || read.atom_offset.is_some() && read.text_offset.is_none()
                    || read.payload_offset.is_some() && read.atom_offset.is_none()
                {
                    return Err("Read one to fifty DOCX paragraphs, with an optional UTF-16 text window, from the bound session.".into());
                }
                arguments = read.renderer_arguments();
                "read"
            }
            "read_docx_image" => {
                let read: ReadImage =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if read
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &bound.session_id)
                    || read.paragraph_ref.trim().is_empty()
                    || read.object_ref.trim().is_empty()
                {
                    return Err(
                        "Read one image from a current drawing in the bound DOCX session.".into(),
                    );
                }
                arguments = read.renderer_arguments();
                "read_image"
            }
            "replace_docx_text_range" => {
                let replace: ReplaceRange =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if replace.paragraph_ref.trim().is_empty()
                    || replace.range.end <= replace.range.start
                    || replace.expected_text == replace.replacement
                {
                    return Err("Replace one nonempty DOCX text range with different text.".into());
                }
                arguments = json!({
                    "paragraph_ref":replace.paragraph_ref,
                    "expected_revision":replace.expected_revision,
                    "range":replace.range,
                    "expected_text":replace.expected_text,
                    "replacement":replace.replacement
                });
                "replace_range"
            }
            "write_docx_equation" => {
                let write: WriteEquation =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                write.validate()?;
                if write
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &bound.session_id)
                {
                    return Err("Write an equation only in this task's bound DOCX session.".into());
                }
                arguments = serde_json::to_value(write).map_err(|error| error.to_string())?;
                "write_equation"
            }
            "capture_docx_target" => {
                let capture: Capture =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if capture
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &bound.session_id)
                    || capture.paragraph_ref.is_empty()
                {
                    return Err("Capture a paragraph from the bound DOCX session.".into());
                }
                "capture"
            }
            "propose_docx_change" => {
                let proposal: Propose =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if proposal.target_id.is_empty()
                    || proposal.text.is_empty()
                    || proposal.text.len() > 32 * 1024
                {
                    return Err(
                        "A DOCX proposal needs a target and one to 32 KiB of replacement text."
                            .into(),
                    );
                }
                "propose"
            }
            "read_docx_format" => {
                let read: FormatRead =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                validate_format_read_query(read.query.as_ref())?;
                "read_format"
            }
            "apply_docx_format" => {
                let edit: FormatEdit =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                arguments = edit.renderer_arguments()?;
                if arguments.get("range").is_some() {
                    let mut item = json!({"paragraphRef":arguments["paragraph_ref"],"range":arguments["range"]});
                    item["font"] = arguments["format"]["font"].clone();
                    arguments = json!({"expected_revision":arguments["expected_revision"],"operations":[item]});
                    "format_batch"
                } else {
                    "format"
                }
            }
            "apply_docx_format_batch" => {
                let batch: FormatBatch =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                arguments = batch_renderer_arguments(batch)?;
                "format_batch"
            }
            "apply_docx_suggestion" => {
                let edit: Propose =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if edit.target_id.is_empty() || edit.text.len() > 32 * 1024 {
                    return Err("Apply a captured DOCX target within the text limit.".into());
                }
                "apply"
            }
            "save_docx_document" => {
                let save: Save =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                arguments = json!({"expected_revision":save.expected_revision});
                "save"
            }
            "import_docx_template_styles" => {
                let import: ImportStyles =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                import.validate()?;
                arguments = json!({"template":import.template,"style_ids":import.style_ids,"expected_revision":import.expected_revision});
                "import_styles"
            }
            "check_docx_template" => {
                let check: Check =
                    serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
                if check.template.trim().is_empty() {
                    return Err("Choose an explicit template world version.".into());
                }
                "check"
            }
            _ => return Err(format!("Unknown DOCX task tool: {name}")),
        };
        arguments["session_id"] = json!(bound.session_id);
        let event_arguments = arguments.clone();
        let intent = begin_renderer_operation(
            &store,
            &self.task.task_id,
            self.task.generation,
            &bound,
            operation,
            &arguments,
        )?;
        let request = renderer(
            &self.app,
            &self.task.project_id,
            Some(&bound.workbench_project_id),
            operation,
            arguments,
            Some(&self.task),
            intent.as_ref(),
        );
        let result = await_renderer_result(operation, &self.task.cancel, request).await?;
        if !retains_result_after_cancel(operation) {
            active_task(&store, &self.task)?;
        }
        if operation == "list" {
            let documents: Vec<DocxDocumentIdentity> =
                serde_json::from_value(result["documents"].clone())
                    .map_err(|error| error.to_string())?;
            if documents.len() != 1 {
                return Err("The task's bound DOCX working copy is not available.".into());
            }
            same_document(&bound, &documents[0])?;
            return Ok(result);
        }
        let document: DocxDocumentIdentity = serde_json::from_value(result["document"].clone())
            .map_err(|error| error.to_string())?;
        same_document(&bound, &document)?;
        if let Some(intent) = intent {
            if operation == "save" {
                let workbench = self
                    .app
                    .state::<crate::journal_workbench::JournalWorkbenchState>();
                let hash = crate::journal_workbench::retained_docx_source_hash(
                    &workbench,
                    &document.workbench_project_id,
                    &document.baseline_id,
                )
                .await?;
                if hash != document.source_sha256 {
                    return Err(
                        "The saved DOCX operation does not match the retained baseline.".into(),
                    );
                }
            }
            let retained = finish_renderer_operation(
                &store,
                &self.task.project_id,
                &bound.workbench_project_id,
                &intent.id,
                operation,
                document,
                result.clone(),
            );
            let mut output = result;
            match retained {
                Ok(activity) => {
                    output["activity"] = json!(activity);
                    if let Some(output) = output.as_object_mut() {
                        output.remove("activityPending");
                    }
                }
                Err(error) => {
                    output["activityPending"] = json!({"error":error,"operationCommitted":retains_result_after_cancel(operation)})
                }
            }
            return Ok(output);
        }
        let event = match operation {
            "read" => DocxRuntimeEvent::Operation {
                operation_id: None,
                operation: operation.into(),
                request: event_arguments,
                result: json!({
                    "operation": "read",
                    "ok": true,
                    "document": document,
                    "result": result,
                }),
            },
            "read_image" => DocxRuntimeEvent::Operation {
                operation_id: None,
                operation: operation.into(),
                request: event_arguments,
                result: read_image_operation_result(&document, &result)?,
            },
            "capture" => DocxRuntimeEvent::Captured {
                target: serde_json::from_value(result["target"].clone())
                    .map_err(|error| error.to_string())?,
            },
            "propose" => {
                let proposal: Propose =
                    serde_json::from_value(args).map_err(|error| error.to_string())?;
                let target = proposal_target(&result, &proposal)?;
                DocxRuntimeEvent::Proposed {
                    target,
                    proposed: proposal.text,
                }
            }
            _ => unreachable!(),
        };
        let activity = store.record_docx_activity(
            &self.task.project_id,
            &self.task.task_id,
            self.task.generation,
            document,
            event,
        )?;
        if matches!(operation, "read" | "read_image") {
            return Ok(result);
        }
        let mut output = result;
        output["activity"] = json!(activity);
        if operation == "propose" {
            active_task(&store, &self.task)?;
            let present = renderer(
                &self.app,
                &self.task.project_id,
                Some(&bound.workbench_project_id),
                "present",
                json!({"activity":activity}),
                Some(&self.task),
                None,
            );
            let presented = tokio::select! {
                _ = self.task.cancel.cancelled() => Err("The DOCX task was cancelled before presentation completed.".into()),
                result = present => result,
            };
            match presented {
                Ok(_) => output["presented"] = json!(true),
                Err(error) => {
                    output["presented"] = json!(false);
                    output["presentationError"] = json!(error);
                }
            }
        }
        Ok(output)
    }
}

#[tauri::command]
pub async fn research_docx_bind_task(
    app: tauri::AppHandle,
    state: State<'_, ResearchTaskState>,
    project_id: String,
    task_id: String,
    session_id: String,
    expected_revision: Option<u64>,
    expected_session_identity: Option<DocxDocumentIdentity>,
) -> Result<(), String> {
    super::ensure_enabled(&state)?;
    let result = renderer(
        &app,
        &project_id,
        None,
        "identity",
        json!({"session_id":session_id}),
        None,
        None,
    )
    .await?;
    let document: DocxDocumentIdentity =
        serde_json::from_value(result["document"].clone()).map_err(|error| error.to_string())?;
    validate_binding_capture(
        &document,
        &session_id,
        expected_revision,
        expected_session_identity.as_ref(),
    )?;
    state
        .store()?
        .bind_docx_task(&project_id, &task_id, document)
}

fn validate_binding_capture(
    document: &DocxDocumentIdentity,
    session_id: &str,
    expected_revision: Option<u64>,
    expected_identity: Option<&DocxDocumentIdentity>,
) -> Result<(), String> {
    if document.session_id != session_id
        || expected_revision.is_some_and(|revision| document.session_revision != revision)
    {
        return Err("The DOCX working copy changed after this material was captured. Capture its current version before starting the task.".into());
    }
    if let Some(expected) = expected_identity {
        if document.session_id != expected.session_id
            || document.app_project_id != expected.app_project_id
            || document.workbench_project_id != expected.workbench_project_id
            || document.baseline_id != expected.baseline_id
            || document.source_sha256 != expected.source_sha256
            || document.session_revision != expected.session_revision
        {
            return Err("The captured DOCX session no longer matches this working copy.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn research_docx_activities(
    state: State<'_, ResearchTaskState>,
    project_id: String,
    workbench_project_id: String,
    after_cursor: u64,
    limit: usize,
) -> Result<DocxActivityPage, String> {
    state
        .store()?
        .docx_activities(&project_id, &workbench_project_id, after_cursor, limit)
}

#[tauri::command]
pub async fn research_docx_activity_settle(
    app: tauri::AppHandle,
    state: State<'_, ResearchTaskState>,
    project_id: String,
    workbench_project_id: String,
    proposal_id: String,
    document: DocxDocumentIdentity,
    outcome: DocxProposalOutcome,
) -> Result<DocxActivity, String> {
    if matches!(outcome, DocxProposalOutcome::Recovered { .. }) {
        return Err("Recover task sources through the verified DOCX checkpoint.".into());
    }
    if let DocxProposalOutcome::Saved {
        ref content_sha256, ..
    } = outcome
    {
        let workbench = app.state::<crate::journal_workbench::JournalWorkbenchState>();
        let hash = crate::journal_workbench::retained_docx_source_hash(
            &workbench,
            &workbench_project_id,
            &document.baseline_id,
        )
        .await?;
        if hash != *content_sha256 {
            return Err(
                "The saved DOCX receipt does not match the retained Workbench source.".into(),
            );
        }
    }
    state.store()?.record_docx_proposal_outcome(
        &project_id,
        &workbench_project_id,
        &proposal_id,
        document,
        outcome,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use oleafly_research::{
        builtin::{TaskBridge, TaskHost, TaskProvider},
        model::{ResearchTask, TaskRunContext},
        observations::TaskSkills,
        scheduler::TaskServices,
    };

    #[test]
    fn docx_tool_deadlines_cover_the_owned_renderer_flow() {
        for name in [
            "save_docx_document",
            "check_docx_template",
            "prepare_docx_fonts",
            "export_docx_document",
            "write_docx_equation",
        ] {
            assert_eq!(docx_tool_timeout(name), Duration::from_secs(150), "{name}");
        }
        for name in [
            "read_docx_document",
            "read_docx_image",
            "replace_docx_text_range",
            "read_docx_format",
            "apply_docx_format",
            "apply_docx_format_batch",
            "import_docx_template_styles",
            "apply_docx_suggestion",
            "get_docx_workspace_context",
            "reveal_docx_working_copy",
        ] {
            assert_eq!(docx_tool_timeout(name), Duration::from_secs(45), "{name}");
        }
        assert_eq!(
            docx_tool_timeout("docx_task_activity"),
            Duration::from_secs(30)
        );
        assert_eq!(
            docx_tool_timeout("propose_docx_change"),
            Duration::from_secs(90)
        );
    }

    #[test]
    fn docx_equation_write_requires_one_current_address() {
        let parse = |address: Value| {
            let mut request =
                json!({"paragraph_ref":"p1","expected_revision":4,"latex":"\\mathbb{R}^d"});
            request
                .as_object_mut()
                .unwrap()
                .extend(address.as_object().unwrap().clone());
            serde_json::from_value::<WriteEquation>(request)
        };
        let insertion = parse(json!({"offset":2,"display":false})).unwrap();
        insertion.validate().unwrap();
        assert_eq!(
            serde_json::to_value(insertion).unwrap(),
            json!({
                "paragraph_ref":"p1","expected_revision":4,"latex":"\\mathbb{R}^d","offset":2,"display":false
            })
        );
        parse(
            json!({"object_ref":"math-1","expected_fingerprint":"fingerprint","adopt_source":true}),
        )
        .unwrap()
        .validate()
        .unwrap();
        for address in [
            json!({}),
            json!({"object_ref":"math-1"}),
            json!({"object_ref":"math-1","expected_fingerprint":"f","offset":0}),
            json!({"offset":0,"adopt_source":true}),
        ] {
            assert!(parse(address).unwrap().validate().is_err());
        }
        assert!(parse(json!({"offset":-1})).is_err());
        assert!(parse(json!({"offset":0,"unknown":true})).is_err());
        assert!(retains_result_after_cancel("write_equation"));
        assert_eq!(renderer_timeout("write_equation"), Duration::from_secs(150));
    }

    #[test]
    fn docx_read_accepts_complete_continuation_and_rejects_unknown_fields() {
        let read: Read = serde_json::from_value(json!({
            "offset": 3,
            "limit": 1,
            "expected_revision": 7,
            "text_offset": 20,
            "text_limit": 40,
            "atom_offset": 2,
            "payload_offset": 100
        }))
        .unwrap();
        assert_eq!(read.offset, 3);
        assert_eq!(read.limit, Some(1));
        assert_eq!(read.expected_revision, Some(7));
        assert_eq!(read.text_offset, Some(20));
        assert_eq!(read.text_limit, Some(40));
        assert_eq!(read.atom_offset, Some(2));
        assert_eq!(read.payload_offset, Some(100));
        assert!(serde_json::from_value::<Read>(json!({
            "text_offset": 20,
            "text_limit": 40,
            "atomOffset": 2
        }))
        .is_err());
    }

    #[test]
    fn docx_read_arguments_omit_unset_optional_fields() {
        let read: Read = serde_json::from_value(json!({})).unwrap();
        assert_eq!(read.renderer_arguments(), json!({"offset": 0, "limit": 20}));
    }

    #[test]
    fn docx_image_read_uses_only_current_object_route_arguments() {
        let read: ReadImage = serde_json::from_value(json!({
            "session_id": "docx-session",
            "paragraph_ref": "p1",
            "object_ref": "drawing-1",
            "expected_revision": 7
        }))
        .unwrap();
        assert_eq!(
            read.renderer_arguments(),
            json!({
                "paragraph_ref": "p1",
                "object_ref": "drawing-1",
                "expected_revision": 7
            })
        );
        assert!(serde_json::from_value::<ReadImage>(json!({
            "paragraph_ref": "p1",
            "object_ref": "drawing-1",
            "expected_revision": 7,
            "media_path": "word/media/image1.png"
        }))
        .is_err());
    }

    #[tokio::test]
    async fn read_image_intent_finish_retains_metadata_and_keeps_pixels_for_the_model() {
        use oleafly_research::docx::DocxActivityEvent;

        let (_directory, store, task, document) = running_workspace_task();
        let intent = begin_renderer_operation(
            &store,
            &task.id,
            task.execution_generation,
            &document,
            "read_image",
            &json!({
                "session_id":document.session_id,
                "paragraph_ref":"p1",
                "object_ref":"drawing-1",
                "expected_revision":0
            }),
        )
        .unwrap()
        .unwrap();
        let (token, answer, forget) =
            queue_workspace_request(task_binding(&store, &task), "read_image", Some(&intent));
        let mut caller = Box::pin(wait_for_pending_result(
            "read_image",
            answer,
            forget,
            Duration::from_secs(5),
        ));
        assert!(futures_util::poll!(caller.as_mut()).is_pending());
        claim(&token).unwrap();
        validate_request(&token).unwrap();

        let metadata = json!({
            "source":"live-docx",
            "imageReadComplete":true,
            "contentStatus":"pixels_provided",
            "sourceSha256":document.source_sha256,
            "objectRef":"drawing-1",
            "revision":0,
            "part":"/word/document.xml",
            "relationshipId":"rIdImage",
            "mediaPart":"/word/media/image1.png",
            "mimeType":"image/png",
            "imageSha256":"b".repeat(64),
            "width":1,
            "height":1,
            "document":{
                "sessionId":document.session_id,
                "baselineId":document.baseline_id,
                "sessionRevision":document.session_revision,
                "savedRevision":document.saved_revision,
                "dirty":true,
                "sourceSha256":document.source_sha256,
                "appProjectId":document.app_project_id,
                "workbenchProjectId":document.workbench_project_id,
                "title":"Paper",
                "filename":"paper.docx"
            },
        });
        let image = "data:image/png;base64,iVBORw0KGgo=";
        let renderer_result = json!({
            "document":document.clone(),
            "result":metadata.clone(),
            "image":image,
        });
        assert!(renderer_result.get("operation").is_none());
        assert!(renderer_result.get("ok").is_none());

        let workbench = crate::journal_workbench::JournalWorkbenchState::default();
        assert!(
            receive_renderer_result(&workbench, &token, Some(renderer_result.clone()), None,)
                .await
                .unwrap()
        );
        let response = caller.await.unwrap();
        assert_eq!(response["image"], image);
        assert_eq!(response["result"], metadata);
        assert_eq!(
            response["activity"]["origin"]["generation"],
            task.execution_generation
        );

        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let history = reopened
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap();
        let activity = history
            .activities
            .iter()
            .find(|entry| {
                matches!(
                    &entry.activity.event,
                    DocxActivityEvent::Runtime {
                        event: DocxRuntimeEvent::Operation {
                            operation_id: Some(id),
                            operation,
                            ..
                        }
                    } if id == &intent.id && operation == "read_image"
                )
            })
            .unwrap()
            .activity
            .clone();
        let retained = match &activity.event {
            DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation { result, .. },
            } => result,
            _ => unreachable!("the retained read_image activity is an operation"),
        };
        assert_eq!(
            retained,
            &json!({
                "operation":"read_image",
                "ok":true,
                "document":document.clone(),
                "result":metadata.clone(),
            })
        );
        assert!(retained.get("image").is_none());
        assert!(!retained.to_string().contains("base64"));
        for field in [
            "sessionId",
            "appProjectId",
            "workbenchProjectId",
            "baselineId",
            "sourceSha256",
            "sessionRevision",
            "savedRevision",
        ] {
            assert_eq!(
                retained["document"][field], retained["result"]["document"][field],
                "{field}"
            );
        }
        assert_eq!(retained["result"]["document"]["dirty"], true);
        assert_eq!(retained["result"]["document"]["title"], "Paper");
        assert_eq!(retained["result"]["document"]["filename"], "paper.docx");

        assert_eq!(
            finish_renderer_operation(
                &reopened,
                "paper",
                "manuscript",
                &intent.id,
                "read_image",
                document.clone(),
                renderer_result,
            )
            .unwrap(),
            activity
        );

        let mut mismatched = json!({
            "document":document.clone(),
            "result":metadata,
            "image":image,
        });
        mismatched["result"]["document"]["sessionRevision"] = json!(1);
        assert!(finish_renderer_operation(
            &reopened,
            "paper",
            "manuscript",
            &intent.id,
            "read_image",
            document,
            mismatched,
        )
        .is_err());
    }

    struct UnusedTaskHost;

    impl TaskHost for UnusedTaskHost {
        fn skills(&self, _: &TaskRunContext) -> Result<TaskSkills, String> {
            unreachable!("DOCX receipts do not access skills")
        }

        fn skill_read_paths(&self, _: &TaskRunContext) -> Vec<std::path::PathBuf> {
            unreachable!("DOCX receipts do not access skill paths")
        }

        fn provider(&self, _: TaskRunContext) -> TaskRuntimeFuture<TaskProvider> {
            unreachable!("DOCX receipts do not start a provider")
        }

        fn bridge(
            &self,
            _: TaskRunContext,
            _: Option<TaskBinding>,
        ) -> TaskRuntimeFuture<Arc<dyn TaskBridge>> {
            unreachable!("DOCX receipts do not start a bridge")
        }
    }

    fn running_workspace_task() -> (
        tempfile::TempDir,
        TaskStore,
        oleafly_research::model::ResearchTask,
        DocxDocumentIdentity,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(oleafly_research::test_support::draft(
                "paper",
                "Retain workspace receipts",
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

    fn task_binding(store: &TaskStore, task: &ResearchTask) -> TaskBinding {
        let tasks_root = store.root().to_path_buf();
        let clocks = Arc::new(oleafly_research::budget::BudgetClocks::default());
        TaskBinding {
            task_id: task.id.clone(),
            project_id: task.project_id.clone(),
            task_title: task.title.clone(),
            generation: task.execution_generation,
            brief: task.brief.clone(),
            record_dir: task.record_dir(),
            execution_root: tasks_root.clone(),
            allowed_paths: vec![],
            read_paths: vec![],
            linked_roots: vec![],
            search_dirs: vec![],
            project_root: None,
            services: TaskServices {
                runs: oleafly_research::runs::RunManager::new(
                    tasks_root.clone(),
                    tokio::runtime::Handle::current(),
                ),
                tasks_root: tasks_root.clone(),
                approvals: oleafly_research::approvals::ApprovalQueue::new(
                    tasks_root,
                    clocks.clone(),
                ),
                clocks,
                workspace: None,
                suspends: Arc::new(oleafly_research::scheduler::SuspendSignals::default()),
            },
            host: Arc::new(UnusedTaskHost),
            events: None,
            cancel: CancellationToken::new(),
        }
    }

    fn queue_workspace_request(
        task: TaskBinding,
        operation: &str,
        intent: Option<&DocxActivity>,
    ) -> (String, oneshot::Receiver<Result<Value, String>>, Forget) {
        let token = format!("pending-{}-{operation}", task.task_id);
        let (reply, answer) = oneshot::channel();
        assert!(lock()
            .insert(
                token.clone(),
                Pending {
                    reply,
                    task: Some(task),
                    operation: intent.map(|intent| PendingOperation {
                        id: intent.id.clone(),
                        operation: operation.into(),
                        workbench_project_id: intent.document.workbench_project_id.clone(),
                    }),
                    claimed: false,
                }
            )
            .is_none());
        let forget = Forget(token.clone());
        (token, answer, forget)
    }

    #[tokio::test]
    async fn pending_receipts_survive_outer_future_drop_and_retry_in_the_original_generation() {
        use oleafly_research::docx::DocxActivityEvent;

        for operation in ["prepare_fonts", "export", "reveal"] {
            let (_directory, store, task, document) = running_workspace_task();
            let intent = begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                operation,
                &json!({"session_id":document.session_id}),
            )
            .unwrap()
            .unwrap();
            let binding = task_binding(&store, &task);
            let cancel = binding.cancel.clone();
            let (token, answer, forget) =
                queue_workspace_request(binding, operation, Some(&intent));
            let mut caller = Box::pin(wait_for_pending_result(
                operation,
                answer,
                forget,
                Duration::from_secs(5),
            ));
            assert!(futures_util::poll!(caller.as_mut()).is_pending());
            claim(&token).unwrap();
            validate_request(&token).unwrap();
            cancel.cancel();
            store.request_cancel(&task.id).unwrap();
            store
                .finalize_cancel(&task.id, task.execution_generation)
                .unwrap();
            drop(caller);
            store
                .retry_with(&task.id, oleafly_research::model::RetryMode::Fresh)
                .unwrap();
            store.request_start(&task.id).unwrap();
            let next = store.claim_next().unwrap().unwrap();
            assert!(next.execution_generation > task.execution_generation);
            assert!(!lock().get(&token).unwrap().reply.is_closed());

            let expected = json!({"operation":operation,"ok":true,"document":document,
                "result":{"status":"completed","receipt":"actual-renderer-result"}});
            let workbench = crate::journal_workbench::JournalWorkbenchState::default();
            assert!(
                receive_renderer_result(&workbench, &token, Some(expected.clone()), None)
                    .await
                    .unwrap()
            );
            assert!(!lock().contains_key(&token));
            let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
            let history = reopened
                .docx_task_activities("paper", &task.id, 0, 50)
                .unwrap();
            let results = history
                .activities
                .iter()
                .filter(|entry| {
                    matches!(
                        &entry.activity.event,
                        DocxActivityEvent::Runtime { event: DocxRuntimeEvent::Operation {
                            operation_id: Some(id), result, ..
                        }} if id == &intent.id && result == &expected
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].activity.origin, intent.origin);
            assert_eq!(
                results[0].activity.origin.generation,
                task.execution_generation
            );
            assert_eq!(results[0].activity.document, document);
        }
    }

    #[tokio::test]
    async fn pending_receipt_timeout_cleans_up_after_outer_future_drop() {
        let (_directory, store, task, document) = running_workspace_task();
        let intent = begin_renderer_operation(
            &store,
            &task.id,
            task.execution_generation,
            &document,
            "export",
            &json!({}),
        )
        .unwrap()
        .unwrap();
        let (token, answer, forget) =
            queue_workspace_request(task_binding(&store, &task), "export", Some(&intent));
        let mut caller = Box::pin(wait_for_pending_result(
            "export",
            answer,
            forget,
            Duration::from_millis(20),
        ));
        assert!(futures_util::poll!(caller.as_mut()).is_pending());
        drop(caller);
        tokio::time::timeout(Duration::from_secs(2), async {
            while lock().contains_key(&token) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(claim(&token).is_err());
        let workbench = crate::journal_workbench::JournalWorkbenchState::default();
        assert!(
            receive_renderer_result(&workbench, &token, Some(json!({})), None)
                .await
                .unwrap_err()
                .contains("request ended")
        );
        assert_eq!(
            store
                .docx_task_activities("paper", &task.id, 0, 50)
                .unwrap()
                .activities
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn pending_read_and_context_drop_their_request_with_the_caller() {
        for operation in ["read", "context"] {
            let (_directory, store, task, document) = running_workspace_task();
            let intent = begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                operation,
                &json!({}),
            )
            .unwrap();
            let (token, answer, forget) =
                queue_workspace_request(task_binding(&store, &task), operation, intent.as_ref());
            let mut caller = Box::pin(wait_for_pending_result(
                operation,
                answer,
                forget,
                Duration::from_secs(5),
            ));
            assert!(futures_util::poll!(caller.as_mut()).is_pending());
            assert!(lock().contains_key(&token));
            drop(caller);
            assert!(!lock().contains_key(&token));
        }
    }

    #[tokio::test]
    async fn pending_cancellation_before_claim_or_validation_prevents_execution() {
        for claimed in [false, true] {
            let (_directory, store, task, document) = running_workspace_task();
            let intent = begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                "export",
                &json!({}),
            )
            .unwrap()
            .unwrap();
            let binding = task_binding(&store, &task);
            let cancel = binding.cancel.clone();
            let (token, answer, forget) = queue_workspace_request(binding, "export", Some(&intent));
            let mut caller = Box::pin(wait_for_pending_result(
                "export",
                answer,
                forget,
                Duration::from_secs(5),
            ));
            assert!(futures_util::poll!(caller.as_mut()).is_pending());
            if claimed {
                claim(&token).unwrap();
            }
            cancel.cancel();
            store.request_cancel(&task.id).unwrap();
            let refusal = if claimed {
                validate_request(&token)
            } else {
                claim(&token)
            };
            assert!(refusal.unwrap_err().contains("no longer active"));
            let workbench = crate::journal_workbench::JournalWorkbenchState::default();
            assert!(!receive_renderer_result(
                &workbench,
                &token,
                None,
                Some("The task was cancelled before execution.".into())
            )
            .await
            .unwrap());
            assert!(caller.await.is_err());
            assert!(!lock().contains_key(&token));
            assert_eq!(
                store
                    .docx_task_activities("paper", &task.id, 0, 50)
                    .unwrap()
                    .activities
                    .len(),
                2
            );
        }
    }

    #[tokio::test]
    async fn pending_normal_success_returns_the_recorded_receipt_and_cleans_up() {
        let (_directory, store, task, document) = running_workspace_task();
        let intent = begin_renderer_operation(
            &store,
            &task.id,
            task.execution_generation,
            &document,
            "prepare_fonts",
            &json!({}),
        )
        .unwrap()
        .unwrap();
        let (token, answer, forget) =
            queue_workspace_request(task_binding(&store, &task), "prepare_fonts", Some(&intent));
        let mut caller = Box::pin(wait_for_pending_result(
            "prepare_fonts",
            answer,
            forget,
            Duration::from_secs(5),
        ));
        assert!(futures_util::poll!(caller.as_mut()).is_pending());
        claim(&token).unwrap();
        validate_request(&token).unwrap();
        let expected = json!({"operation":"prepare_fonts","ok":true,"document":document,
            "result":{"measurement":{"resolving":false}}});
        let workbench = crate::journal_workbench::JournalWorkbenchState::default();
        assert!(
            receive_renderer_result(&workbench, &token, Some(expected.clone()), None)
                .await
                .unwrap()
        );
        let response = caller.await.unwrap();
        assert_eq!(response["result"], expected["result"]);
        assert_eq!(
            response["activity"]["origin"]["generation"],
            task.execution_generation
        );
        assert!(!lock().contains_key(&token));
        assert!(claim(&token).is_err());
    }

    #[test]
    fn workspace_operations_retain_exact_results_and_identity_without_checkpoints() {
        use oleafly_research::docx::DocxActivityEvent;

        let (_directory, store, task, document) = running_workspace_task();
        let cases = [
            (
                "context",
                json!({"viewed":{"role":"original","revision":"old"},
                "writable":[{"sessionId":document.session_id,"sessionRevision":0}],
                "selectionWriteTarget":null}),
            ),
            (
                "reveal",
                json!({"navigation":"requested","sessionId":document.session_id}),
            ),
            (
                "prepare_fonts",
                json!({
                    "acquisition":{"families":[{"family":"Times New Roman","state":"available"}]},
                    "status":{"probed":true,"missing":[{"family":"Calibri","weight":400,"style":"normal"}],
                        "aliases":[],"loaded":[{"family":"Times New Roman","version":"5.01","sha256":"b".repeat(64)}]},
                    "measurement":{"measurer":"shaped","resolving":false,"producer":"exact-fonts"}
                }),
            ),
            (
                "export",
                json!({"result":{"status":"saved","path":"/exports/manuscript.docx"},
                "filename":"manuscript.docx","sessionId":document.session_id,"sessionRevision":0,
                "byteLength":2062840}),
            ),
            (
                "export",
                json!({"result":{"status":"cancelled"},"filename":"manuscript.docx",
                "sessionId":document.session_id,"sessionRevision":0,"byteLength":2062840}),
            ),
        ];
        for (operation, payload) in &cases {
            let request = json!({"session_id":document.session_id});
            let intent = begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                operation,
                &request,
            )
            .unwrap()
            .unwrap();
            let result =
                json!({"operation":operation,"ok":true,"document":document,"result":payload});
            let mut foreign = document.clone();
            foreign.session_id = "another-session".into();
            let mut foreign_result = result.clone();
            foreign_result["document"] = json!(foreign);
            assert!(store
                .finish_docx_operation("paper", "manuscript", &intent.id, foreign, foreign_result)
                .is_err());
            let activity = store
                .finish_docx_operation(
                    "paper",
                    "manuscript",
                    &intent.id,
                    document.clone(),
                    result.clone(),
                )
                .unwrap();
            assert_eq!(activity.origin, intent.origin);
            assert_eq!(activity.document, document);
            assert!(matches!(&activity.event, DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation { operation_id: Some(id), operation: actual,
                    request: retained_request, result: retained_result }
            } if id == &intent.id && actual == *operation && retained_request == &request && retained_result == &result));
            assert_eq!(
                store
                    .finish_docx_operation(
                        "paper",
                        "manuscript",
                        &intent.id,
                        document.clone(),
                        result.clone()
                    )
                    .unwrap(),
                activity
            );
            let mut changed = result;
            changed["result"]["different"] = json!(true);
            assert!(store
                .finish_docx_operation("paper", "manuscript", &intent.id, document.clone(), changed)
                .is_err());
        }
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let history = reopened
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap();
        let current = history
            .activities
            .iter()
            .filter(|entry| entry.activity.origin.generation == task.execution_generation)
            .collect::<Vec<_>>();
        assert_eq!(current.len(), cases.len() * 2);
        assert!(current
            .iter()
            .all(|entry| matches!(entry.activity.event, DocxActivityEvent::Runtime { .. })));
        assert_eq!(
            reopened.docx_task_binding("paper", &task.id).unwrap(),
            Some(document)
        );
    }

    #[tokio::test]
    async fn workspace_side_effect_results_survive_cancellation_and_retry_in_the_original_generation(
    ) {
        use oleafly_research::docx::DocxActivityEvent;

        for (operation, payload) in [
            (
                "prepare_fonts",
                json!({"status":{"missing":[{"family":"Calibri"}]},
                "measurement":{"resolving":false}}),
            ),
            (
                "export",
                json!({"result":{"status":"saved","path":"/exports/exact.docx"},
                "sessionRevision":0,"byteLength":2062840}),
            ),
            ("reveal", json!({"navigation":"requested"})),
        ] {
            let (_directory, store, task, document) = running_workspace_task();
            let request = json!({"session_id":document.session_id});
            let intent = begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                operation,
                &request,
            )
            .unwrap()
            .unwrap();
            let cancel = CancellationToken::new();
            let expected =
                json!({"operation":operation,"ok":true,"document":document,"result":payload});
            let result = await_renderer_result(operation, &cancel, async {
                // The host's validation has succeeded and the side effect has returned.
                // Cancellation and a new execution must not erase that exact receipt.
                active_execution(
                    &store,
                    "paper",
                    &task.id,
                    task.execution_generation,
                    &cancel,
                )?;
                cancel.cancel();
                store.request_cancel(&task.id).unwrap();
                store
                    .finalize_cancel(&task.id, task.execution_generation)
                    .unwrap();
                Ok(expected.clone())
            })
            .await
            .unwrap();
            store
                .retry_with(&task.id, oleafly_research::model::RetryMode::Fresh)
                .unwrap();
            store.request_start(&task.id).unwrap();
            let next = store.claim_next().unwrap().unwrap();
            assert!(next.execution_generation > task.execution_generation);
            let activity = store
                .finish_docx_operation(
                    "paper",
                    "manuscript",
                    &intent.id,
                    document.clone(),
                    result.clone(),
                )
                .unwrap();
            assert_eq!(activity.origin, intent.origin);
            assert_eq!(activity.origin.generation, task.execution_generation);
            assert!(matches!(&activity.event, DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation { result: retained, .. }
            } if retained == &expected));
            assert_eq!(
                store
                    .finish_docx_operation("paper", "manuscript", &intent.id, document, result)
                    .unwrap(),
                activity
            );
            let history = store
                .docx_task_activities("paper", &task.id, 0, 50)
                .unwrap();
            assert_eq!(history.activities.len(), 3);
        }
    }

    #[tokio::test]
    async fn workspace_cancellation_stops_context_and_prevents_side_effects_before_host_validation()
    {
        use std::cell::Cell;

        let (_directory, store, task, document) = running_workspace_task();
        let cancel = CancellationToken::new();
        cancel.cancel();
        store.request_cancel(&task.id).unwrap();
        let context_called = Cell::new(false);
        assert!(await_renderer_result("context", &cancel, async {
            context_called.set(true);
            Ok(json!({"operation":"context","ok":true,"document":document,"result":{}}))
        })
        .await
        .is_err());
        assert!(!context_called.get());
        for operation in ["prepare_fonts", "export", "reveal"] {
            let side_effect = Cell::new(false);
            let refused = await_renderer_result(operation, &cancel, async {
                active_execution(
                    &store,
                    "paper",
                    &task.id,
                    task.execution_generation,
                    &cancel,
                )?;
                side_effect.set(true);
                Ok(json!({}))
            })
            .await;
            assert!(refused.unwrap_err().contains("no longer active"));
            assert!(!side_effect.get());
            assert!(begin_renderer_operation(
                &store,
                &task.id,
                task.execution_generation,
                &document,
                operation,
                &json!({"session_id":document.session_id})
            )
            .is_err());
        }
        assert_eq!(
            store
                .docx_task_activities("paper", &task.id, 0, 50)
                .unwrap()
                .activities
                .len(),
            1
        );
    }

    #[test]
    fn workspace_actions_keep_task_owned_sessions_and_revision_checked_locations() {
        for operation in ["context", "prepare_fonts", "export"] {
            assert!(workspace_arguments(operation, json!({})).is_ok());
            assert!(
                workspace_arguments(operation, json!({"session_id":"another-session"})).is_err()
            );
            assert!(workspace_arguments(operation, json!({"task_id":"forged"})).is_err());
        }
        assert!(workspace_arguments("reveal", json!({})).is_ok());
        assert!(workspace_arguments(
            "reveal",
            json!({"paragraph_ref":"p1","expected_revision":2})
        )
        .is_ok());
        assert!(workspace_arguments("reveal", json!({"paragraph_ref":"p1"})).is_err());
        assert!(
            workspace_arguments("reveal", json!({"paragraph_ref":"","expected_revision":2}))
                .is_err()
        );
        assert!(workspace_arguments("reveal", json!({"session_id":"another-session"})).is_err());
    }

    #[test]
    fn model_arguments_cannot_supply_runtime_attribution() {
        assert!(serde_json::from_value::<Propose>(json!({
            "target_id":"target", "expected_revision":2, "text":"Replacement",
            "task_id":"forged", "member_id":"forged", "execution_id":"forged"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<Read>(json!({"session_id":"s", "work_ids":["forged"]}))
                .is_err()
        );
        assert!(serde_json::from_value::<History>(json!({"task_id":"another-task"})).is_err());
    }

    #[test]
    fn renderer_cannot_substitute_a_target_or_revision() {
        let proposal = Propose {
            target_id: "target".into(),
            expected_revision: 2,
            text: "Replacement".into(),
        };
        let mut response = json!({"target":{"targetId":"target","paragraphRef":"p1","revision":2,"original":"Original"}});
        assert!(proposal_target(&response, &proposal).is_ok());
        response["target"]["targetId"] = json!("another-target");
        assert!(proposal_target(&response, &proposal).is_err());
        response["target"]["targetId"] = json!("target");
        response["target"]["revision"] = json!(3);
        assert!(proposal_target(&response, &proposal).is_err());
        response["target"]["revision"] = json!(2);
        response["target"]["original"] = json!("Replacement");
        assert!(proposal_target(&response, &proposal).is_err());
    }

    #[test]
    fn direct_operations_require_their_own_fixed_arguments() {
        assert!(serde_json::from_value::<FormatEdit>(json!({
            "paragraph_ref":"p1","expected_revision":2,"font":{"size":14}
        }))
        .is_ok());
        assert!(serde_json::from_value::<FormatEdit>(json!({
            "paragraph_ref":"p1","font":{"size":14}
        }))
        .is_err());
        assert!(serde_json::from_value::<Save>(json!({"expected_revision":-1})).is_err());
        assert!(
            serde_json::from_value::<Check>(json!({"template":"world","task_id":"forged"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<FormatRead>(json!({"query":{},"project_id":"other"})).is_err()
        );
    }

    #[test]
    fn format_read_query_requires_a_nonnegative_expected_revision() {
        assert_eq!(
            format_read_query_properties()["expected_revision"],
            json!({"type":"integer","minimum":0})
        );
        for revision in [json!(0), json!(7)] {
            let read: FormatRead =
                serde_json::from_value(json!({"query":{"expected_revision":revision}})).unwrap();
            assert!(validate_format_read_query(read.query.as_ref()).is_ok());
        }
        for revision in [json!(-1), json!(1.5), json!("2")] {
            let read: FormatRead =
                serde_json::from_value(json!({"query":{"expected_revision":revision}})).unwrap();
            assert!(validate_format_read_query(read.query.as_ref()).is_err());
        }
    }

    #[test]
    fn renderer_origin_preserves_durable_member_attribution() {
        let origin = DocxActivityOrigin {
            task_id: "task-a".into(),
            generation: 3,
            group_id: Some("group-a".into()),
            member_id: Some("member-a".into()),
            execution_id: Some("execution-a".into()),
            work_ids: vec!["work-a".into()],
        };
        assert_eq!(
            renderer_origin("task-a", 3, Some(&origin)),
            json!({
                "kind":"task","taskId":"task-a","generation":3,
                "memberId":"member-a","executionId":"execution-a"
            })
        );
        assert_eq!(
            renderer_origin("task-a", 3, None),
            json!({"kind":"task","taskId":"task-a","generation":3})
        );
    }

    #[test]
    fn style_import_requires_an_explicit_template_and_unique_style_selection() {
        let valid: ImportStyles = serde_json::from_value(json!({
            "template":"world-selected","style_ids":["Title","Heading2"],"expected_revision":3
        }))
        .unwrap();
        assert!(valid.validate().is_ok());
        for styles in [json!([]), json!([""]), json!(["Title", "Title"])] {
            let invalid: ImportStyles = serde_json::from_value(json!({
                "template":"world-selected","style_ids":styles,"expected_revision":3
            }))
            .unwrap();
            assert!(invalid.validate().is_err());
        }
        assert!(serde_json::from_value::<ImportStyles>(json!({
            "template":"world-selected","style_ids":["Title"],"expected_revision":3,"source_path":"outside.docx"
        })).is_err());
    }

    #[test]
    fn object_formats_use_the_existing_tracked_format_operation() {
        let edit: FormatEdit = serde_json::from_value(json!({
            "paragraph_ref":"p1","expected_revision":2,"scope":"cell",
            "cell":{"fill":"D9EAF7","verticalAlignment":"center"}
        }))
        .unwrap();
        assert_eq!(
            edit.renderer_arguments().unwrap(),
            json!({
                "paragraph_ref":"p1","expected_revision":2,
                "object_format":{"kind":"cell","cell":{"fill":"D9EAF7","verticalAlignment":"center"}}
            })
        );
        for value in [
            json!({"paragraph_ref":"p1","expected_revision":2,"cell":{"fill":"D9EAF7"}}),
            json!({"paragraph_ref":"p1","expected_revision":2,"scope":"cell","cell":{}}),
            json!({"paragraph_ref":"p1","expected_revision":2,"scope":"cell","cell":{"fill":null},"font":{"bold":true}}),
        ] {
            assert!(serde_json::from_value::<FormatEdit>(value)
                .unwrap()
                .renderer_arguments()
                .is_err());
        }
    }

    #[test]
    fn batch_resolves_ranges_and_frame_deletion_without_forged_scope_or_revision() {
        let input = json!({"expected_revision":4,"operations":[
            {"paragraph_ref":"p1","range":{"start":2,"end":6},"font":{"name":"Times New Roman"}},
            {"paragraph_ref":"p2","scope":"frame","frame":null},
            {"paragraph_ref":"p2","scope":"section","section":{"columns":{"count":2}}}
        ]});
        let args = batch_renderer_arguments(serde_json::from_value(input).unwrap()).unwrap();
        assert_eq!(
            args["operations"][0],
            json!({"paragraphRef":"p1","range":{"start":2,"end":6},"font":{"name":"Times New Roman"}})
        );
        assert_eq!(
            args["operations"][1]["objectFormat"],
            json!({"kind":"frame","frame":null})
        );
        assert_eq!(args["expected_revision"], 4);
        for invalid in [
            json!({"expected_revision":4,"operations":[]}),
            json!({"expected_revision":4,"operations":[{"paragraph_ref":"p1","expected_revision":5,"font":{"bold":true}}]}),
            json!({"expected_revision":4,"operations":[{"paragraph_ref":"p1","range":{"start":6,"end":2},"font":{"bold":true}}]}),
            json!({"expected_revision":4,"operations":[{"paragraph_ref":"p1","task_id":"forged","font":{"bold":true}}]}),
        ] {
            assert!(batch_renderer_arguments(serde_json::from_value(invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn renderer_identity_stays_bound_after_a_baseline_save() {
        let bound: DocxDocumentIdentity = serde_json::from_value(json!({
            "sessionId":"session", "appProjectId":"paper", "workbenchProjectId":"manuscript",
            "baselineId":"baseline-1", "sourceSha256":"a".repeat(64), "sessionRevision":0,"savedRevision":0
        })).unwrap();
        let mut current = bound.clone();
        current.baseline_id = "baseline-2".into();
        current.source_sha256 = "b".repeat(64);
        current.session_revision = 4;
        current.saved_revision = 3;
        assert!(same_document(&bound, &current).is_ok());
        current.session_id = "recovered-session".into();
        assert!(same_document(&bound, &current).is_err());
        current.session_id = bound.session_id.clone();
        current.workbench_project_id = "another-manuscript".into();
        assert!(same_document(&bound, &current).is_err());
    }

    #[test]
    fn material_binding_rejects_a_new_revision_or_replaced_session() {
        let captured: DocxDocumentIdentity = serde_json::from_value(json!({
            "sessionId":"session", "appProjectId":"paper", "workbenchProjectId":"manuscript",
            "baselineId":"baseline", "sourceSha256":"a".repeat(64), "sessionRevision":4,"savedRevision":3
        })).unwrap();
        assert!(validate_binding_capture(&captured, "session", Some(4), Some(&captured)).is_ok());
        let mut changed = captured.clone();
        changed.session_revision = 5;
        assert!(validate_binding_capture(&changed, "session", Some(4), Some(&captured)).is_err());
        changed = captured.clone();
        changed.session_id = "reopened".into();
        assert!(validate_binding_capture(&changed, "session", None, None).is_err());
        changed = captured.clone();
        changed.baseline_id = "another-baseline".into();
        assert!(validate_binding_capture(&changed, "session", Some(4), Some(&captured)).is_err());
    }

    #[test]
    fn expired_and_duplicate_requests_cannot_be_claimed() {
        let token = "docx-test-claim".to_owned();
        let (reply, _answer) = oneshot::channel();
        lock().insert(
            token.clone(),
            Pending {
                reply,
                task: None,
                operation: None,
                claimed: false,
            },
        );
        let forget = Forget(token.clone());
        assert!(validate_request(&token).is_err());
        assert!(claim(&token).is_ok());
        assert!(validate_request(&token).is_ok());
        assert!(claim(&token).is_err());
        drop(forget);
        assert!(claim(&token).is_err());
        assert!(validate_request(&token).is_err());
    }
}
