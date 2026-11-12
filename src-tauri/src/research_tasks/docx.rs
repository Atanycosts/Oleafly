//! Task-scoped access to the application's live DOCX business host.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use oleafly_research::{
    docx::{
        DocxActivity, DocxActivityPage, DocxDocumentIdentity, DocxProposalOutcome,
        DocxRuntimeEvent, DocxTarget,
    },
    mcp::{protocol::ToolMeta, ApplicationTools},
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
    claimed: bool,
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
) -> Result<Value, String> {
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
            claimed: false,
        },
    );
    let _forget = Forget(token.clone());
    app.emit_to(
        "main",
        "research-docx-request",
        json!({"token":token,"projectId":project_id,"workbenchProjectId":workbench_project_id,
            "operation":operation,"arguments":arguments}),
    )
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(45), answer)
        .await
        .map_err(|_| {
            "The DOCX window did not answer. Reopen the working copy and retry.".to_string()
        })?
        .map_err(|_| "The DOCX window request ended.".to_string())?
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

#[tauri::command]
pub fn research_docx_result(
    window: tauri::WebviewWindow,
    token: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main DOCX window can answer this request.".into());
    }
    let pending = lock().remove(&token).ok_or("This DOCX request ended.")?;
    let outcome = match (result, error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        _ => Err("The DOCX window returned no result.".into()),
    };
    let _ = pending.reply.send(outcome);
    Ok(())
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

impl ApplicationTools for DocxTools {
    fn definitions(&self) -> Vec<ToolMeta> {
        vec![
            ToolMeta::new("list_docx_documents", "List this task's explicitly bound live DOCX working copy. No other open documents are exposed. The task cannot apply edits or save over the manuscript.", schema(json!({}), &[])),
            ToolMeta::new("read_docx_document", "Read a bounded paragraph window from this task's bound live DOCX session. The retained activity records the actual session revision and original saved baseline; it may contain unsaved user edits. Continue with nextOffset.", schema(json!({
                "session_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}
            }), &[])),
            ToolMeta::new("capture_docx_target", "Capture a paragraph from the bound DOCX as a revision-checked target. The reference is valid only in this live session.", schema(json!({
                "session_id":{"type":"string"},"paragraph_ref":{"type":"string"}
            }), &["paragraph_ref"])),
            ToolMeta::new("propose_docx_change", "Retain a proposed whole-paragraph replacement and show it beside the bound DOCX for the user's existing accept/reject workflow. Supply your own completed replacement text; this tool does not call another model, edit the document or save a baseline. It refuses stale targets. Runtime task/member/work attribution is recorded automatically.", schema(json!({
                "target_id":{"type":"string"},"expected_revision":{"type":"integer","minimum":0},"text":{"type":"string","maxLength":32768}
            }), &["target_id","expected_revision","text"])),
            ToolMeta::new("docx_task_activity", "Read this task's retained DOCX activity, including earlier members' reads and proposals, user decisions, and exact saved-baseline receipts. History remains readable when the editor is closed. Continue with nextCursor when hasMore is true.", schema(json!({
                "after_cursor":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":50}
            }), &[])),
        ]
    }

    fn call(&self, name: String, args: Value) -> TaskRuntimeFuture<Value> {
        let tools = self.clone();
        Box::pin(async move { tools.execute(&name, args).await })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    session_id: Option<String>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
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

fn active_task(store: &TaskStore, task: &TaskBinding) -> Result<(), String> {
    let current = store.require(&task.task_id)?;
    if task.cancel.is_cancelled()
        || current.cancel_requested
        || current.project_id != task.project_id
        || current.execution_generation != task.generation
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
        let operation = match name {
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
                {
                    return Err("Read one to fifty paragraphs from the bound DOCX session.".into());
                }
                "read"
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
            _ => return Err(format!("Unknown DOCX task tool: {name}")),
        };
        let mut arguments = args.clone();
        arguments["session_id"] = json!(bound.session_id);
        let request = renderer(
            &self.app,
            &self.task.project_id,
            Some(&bound.workbench_project_id),
            operation,
            arguments,
            Some(&self.task),
        );
        let result = tokio::select! {
            _ = self.task.cancel.cancelled() => return Err("The DOCX task request was cancelled.".into()),
            result = request => result?,
        };
        active_task(&store, &self.task)?;
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
        let event = match operation {
            "read" => {
                let read: Read = serde_json::from_value(args).map_err(|error| error.to_string())?;
                DocxRuntimeEvent::Read {
                    offset: read.offset,
                    paragraphs: serde_json::from_value(result["paragraphs"].clone())
                        .map_err(|error| error.to_string())?,
                }
            }
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
) -> Result<(), String> {
    super::ensure_enabled(&state)?;
    let result = renderer(
        &app,
        &project_id,
        None,
        "identity",
        json!({"session_id":session_id}),
        None,
    )
    .await?;
    let document =
        serde_json::from_value(result["document"].clone()).map_err(|error| error.to_string())?;
    state
        .store()?
        .bind_docx_task(&project_id, &task_id, document)
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
    fn expired_and_duplicate_requests_cannot_be_claimed() {
        let token = "docx-test-claim".to_owned();
        let (reply, _answer) = oneshot::channel();
        lock().insert(
            token.clone(),
            Pending {
                reply,
                task: None,
                claimed: false,
            },
        );
        let forget = Forget(token.clone());
        assert!(claim(&token).is_ok());
        assert!(claim(&token).is_err());
        drop(forget);
        assert!(claim(&token).is_err());
    }
}
