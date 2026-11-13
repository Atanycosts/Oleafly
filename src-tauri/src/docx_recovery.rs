use base64::{engine::general_purpose::STANDARD, Engine as _};
use oleafly_research::{
    docx::{
        DocxActivity, DocxDocumentIdentity, DocxOperationCheckpoint, DocxOperationCheckpointPhase,
        DocxProposalOutcome,
    },
    scheduler::ResearchTaskState,
    store::TaskStore,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

const SCHEMA_VERSION: u32 = 2;
const RECOVERY_DIRECTORY: &str = "docx-recovery";
static RECOVERY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryMetadata {
    recovery_key: String,
    app_project_id: String,
    workbench_project_id: String,
    base_baseline_id: String,
    source_sha256: String,
    revision: u64,
    updated_at: String,
    content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_state: Option<DocxRecoveryTaskState>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryApplied {
    proposal_id: String,
    document: DocxDocumentIdentity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryReceipt {
    proposal_id: String,
    document: DocxDocumentIdentity,
    outcome: DocxProposalOutcome,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryOperation {
    operation_id: String,
    document: DocxDocumentIdentity,
    result: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryPendingSave {
    project_id: String,
    expected_baseline_id: String,
    filename: String,
    reason: String,
    request_id: String,
    revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryTaskState {
    document: DocxDocumentIdentity,
    applied: Vec<DocxRecoveryApplied>,
    receipts: Vec<DocxRecoveryReceipt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    operations: Vec<DocxRecoveryOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_save: Option<DocxRecoveryPendingSave>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoverySaveRequest {
    recovery_key: String,
    app_project_id: String,
    workbench_project_id: String,
    base_baseline_id: String,
    source_sha256: String,
    revision: u64,
    updated_at: String,
    content_base64: String,
    #[serde(default)]
    task_state: Option<DocxRecoveryTaskState>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryReadRequest {
    recovery_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryClearRequest {
    recovery_key: String,
    content_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoveryCommitResult {
    baseline_id: String,
    source_sha256: String,
    revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum DocxRecoveryCommitOutcome {
    Saved(DocxRecoveryCommitResult),
    Refused { refusal: String },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocxRecovery {
    schema_version: u32,
    #[serde(flatten)]
    metadata: DocxRecoveryMetadata,
    content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoverySnapshot {
    #[serde(flatten)]
    metadata: DocxRecoveryMetadata,
    bytes_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoveryFailure {
    recovery_key: String,
    error: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoveryListing {
    snapshots: Vec<DocxRecoveryMetadata>,
    failures: Vec<DocxRecoveryFailure>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label} must be a lowercase SHA-256 hex digest"));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.contains('\0') {
        return Err(format!("{label} must be a non-empty string"));
    }
    Ok(())
}

fn known_operation(value: &str) -> bool {
    matches!(value, "read_format" | "format" | "apply" | "save" | "check")
}

fn recovery_key_for(
    app_project_id: &str,
    workbench_project_id: &str,
    base_baseline_id: &str,
    source_sha256: &str,
) -> String {
    let identity = [
        app_project_id,
        workbench_project_id,
        base_baseline_id,
        source_sha256,
    ]
    .into_iter()
    .map(|value| format!("{}:{value}", value.len()))
    .collect::<Vec<_>>()
    .join("\n");
    sha256_hex(identity.as_bytes())
}

fn validate_updated_at(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let separators = [4, 7, 10, 13, 16, 19, 23];
    if bytes.len() != 24
        || !separators.iter().all(|&index| {
            bytes[index]
                == match index {
                    4 | 7 => b'-',
                    10 => b'T',
                    13 | 16 => b':',
                    19 => b'.',
                    _ => b'Z',
                }
        })
        || separators.contains(&bytes.len())
    {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| !separators.contains(&index) && !byte.is_ascii_digit())
    {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    let number = |range: std::ops::Range<usize>| {
        value[range].parse::<u32>().map_err(|_| {
            "updatedAt must be an ISO-8601 UTC timestamp with milliseconds".to_string()
        })
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    if hour > 23 || minute > 59 || second > 59 {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    Ok(())
}

fn validate_metadata(metadata: &DocxRecoveryMetadata) -> Result<(), String> {
    validate_sha256(&metadata.recovery_key, "recoveryKey")?;
    validate_id(&metadata.app_project_id, "appProjectId")?;
    validate_id(&metadata.workbench_project_id, "workbenchProjectId")?;
    validate_id(&metadata.base_baseline_id, "baseBaselineId")?;
    validate_sha256(&metadata.source_sha256, "sourceSha256")?;
    validate_updated_at(&metadata.updated_at)?;
    validate_sha256(&metadata.content_sha256, "contentSha256")
}

fn validate_task_state(metadata: &DocxRecoveryMetadata) -> Result<(), String> {
    let Some(state) = &metadata.task_state else {
        return Ok(());
    };
    let document = &state.document;
    if document.app_project_id != metadata.app_project_id
        || document.workbench_project_id != metadata.workbench_project_id
        || document.baseline_id != metadata.base_baseline_id
        || document.source_sha256 != metadata.source_sha256
        || document.session_revision != metadata.revision
    {
        return Err("DOCX task state does not identify the checkpoint's exported document.".into());
    }
    for source in &state.applied {
        if source.document.session_id != document.session_id
            || source.document.app_project_id != document.app_project_id
            || source.document.workbench_project_id != document.workbench_project_id
            || source.document.session_revision > document.session_revision
        {
            return Err(
                "The checkpoint application belongs to another session or revision.".into(),
            );
        }
    }
    for receipt in &state.receipts {
        if receipt.document.app_project_id != document.app_project_id
            || receipt.document.workbench_project_id != document.workbench_project_id
            || matches!(
                receipt.outcome,
                DocxProposalOutcome::Recovered { .. } | DocxProposalOutcome::Saved { .. }
            )
        {
            return Err(
                "Checkpoint receipts must use this manuscript; recovery and save receipts require verified native operations."
                    .into(),
            );
        }
    }
    for operation in &state.operations {
        validate_id(&operation.operation_id, "operationId")?;
        let same_session = operation.document.session_id == document.session_id;
        let same_recovery_source = operation.document.baseline_id == document.baseline_id
            && operation.document.source_sha256 == document.source_sha256;
        if operation.document.app_project_id != document.app_project_id
            || operation.document.workbench_project_id != document.workbench_project_id
            || same_session && operation.document.session_revision > document.session_revision
            || !same_session && !same_recovery_source
        {
            return Err(
                "A checkpoint operation belongs to another session or exceeds its revision.".into(),
            );
        }
        if !operation.result.is_object()
            || !operation
                .result
                .get("operation")
                .and_then(serde_json::Value::as_str)
                .is_some_and(known_operation)
            || !operation.result["ok"].is_boolean()
        {
            return Err("A checkpoint operation has no valid actual result.".into());
        }
        let result_document: DocxDocumentIdentity =
            serde_json::from_value(operation.result["document"].clone())
                .map_err(|_| "A checkpoint operation has no valid document.".to_string())?;
        if result_document != operation.document {
            return Err("A checkpoint operation result changed its document.".into());
        }
        if operation.result["operation"].as_str() == Some("save")
            && (operation.document != *document
                || operation.document.source_sha256 != metadata.content_sha256)
        {
            return Err(
                "The saved DOCX operation does not match the checkpoint's exact source.".into(),
            );
        }
    }
    if let Some(save) = &state.pending_save {
        if save.project_id != metadata.workbench_project_id
            || save.expected_baseline_id != metadata.base_baseline_id
            || save.revision != metadata.revision
            || save.filename.is_empty()
            || save.reason.trim().is_empty()
            || save.request_id.is_empty()
        {
            return Err("The fixed DOCX save does not match its checkpoint.".into());
        }
    }
    Ok(())
}

fn task_store(root: &Path) -> Result<TaskStore, String> {
    TaskStore::new(root.join("research-tasks"))
}

fn replay_receipts(store: &TaskStore, metadata: &DocxRecoveryMetadata) -> Result<(), String> {
    if let Some(state) = &metadata.task_state {
        for receipt in &state.receipts {
            store.record_docx_proposal_outcome(
                &metadata.app_project_id,
                &metadata.workbench_project_id,
                &receipt.proposal_id,
                receipt.document.clone(),
                receipt.outcome.clone(),
            )?;
        }
    }
    Ok(())
}

fn replay_operations(
    store: &TaskStore,
    metadata: &DocxRecoveryMetadata,
    phase: DocxOperationCheckpointPhase,
    request_id: Option<&str>,
) -> Result<(), String> {
    let Some(state) = &metadata.task_state else {
        return Ok(());
    };
    for operation in &state.operations {
        let operation_kind = operation.result["operation"].as_str();
        if operation_kind == Some("save") && phase == DocxOperationCheckpointPhase::Recovered {
            // Only native Workbench hash verification or the fixed-save commit
            // may turn a renderer save receipt into a completed operation fact.
            continue;
        }
        store.finish_docx_operation(
            &metadata.app_project_id,
            &metadata.workbench_project_id,
            &operation.operation_id,
            operation.document.clone(),
            operation.result.clone(),
        )?;
        let current_session = operation.document.session_id == state.document.session_id;
        if operation_kind != Some("read_format")
            && (current_session || phase == DocxOperationCheckpointPhase::Saved)
        {
            store.record_docx_operation_checkpoint(
                &metadata.app_project_id,
                &metadata.workbench_project_id,
                DocxOperationCheckpoint {
                    operation_id: &operation.operation_id,
                    phase,
                    recovery_key: &metadata.recovery_key,
                    content_sha256: &metadata.content_sha256,
                    from_document: state.document.clone(),
                    request_id,
                },
            )?;
        }
    }
    Ok(())
}

fn verified_sources(store: &TaskStore, metadata: &DocxRecoveryMetadata) -> Result<(), String> {
    if let Some(state) = &metadata.task_state {
        for source in &state.applied {
            let activity = store.docx_applied_source(
                &metadata.app_project_id,
                &metadata.workbench_project_id,
                &source.proposal_id,
                &source.document,
            )?;
            if let oleafly_research::docx::DocxActivityEvent::Outcome {
                outcome: DocxProposalOutcome::Recovered { content_sha256, .. },
            } = &activity.event
            {
                if state.document.session_revision != source.document.session_revision
                    || content_sha256 != &metadata.content_sha256
                {
                    return Err("The recovered checkpoint was edited; withdraw its recovered application before saving.".into());
                }
            }
        }
    }
    Ok(())
}

fn recovery_path(root: &Path, recovery_key: &str) -> Result<PathBuf, String> {
    validate_sha256(recovery_key, "recoveryKey")?;
    Ok(root
        .join(RECOVERY_DIRECTORY)
        .join(format!("{recovery_key}.json")))
}

fn save_at(root: &Path, request: DocxRecoverySaveRequest) -> Result<DocxRecoveryMetadata, String> {
    validate_sha256(&request.recovery_key, "recoveryKey")?;
    validate_id(&request.app_project_id, "appProjectId")?;
    validate_id(&request.workbench_project_id, "workbenchProjectId")?;
    validate_id(&request.base_baseline_id, "baseBaselineId")?;
    validate_sha256(&request.source_sha256, "sourceSha256")?;
    validate_updated_at(&request.updated_at)?;
    if request.recovery_key
        != recovery_key_for(
            &request.app_project_id,
            &request.workbench_project_id,
            &request.base_baseline_id,
            &request.source_sha256,
        )
    {
        return Err("DOCX recovery key does not match its working-copy metadata".into());
    }
    let bytes = STANDARD
        .decode(request.content_base64.trim())
        .map_err(|error| format!("failed to decode DOCX recovery bytes: {error}"))?;
    if bytes.is_empty() {
        return Err("DOCX recovery bytes are empty".into());
    }
    let metadata = DocxRecoveryMetadata {
        recovery_key: request.recovery_key,
        app_project_id: request.app_project_id,
        workbench_project_id: request.workbench_project_id,
        base_baseline_id: request.base_baseline_id,
        source_sha256: request.source_sha256,
        revision: request.revision,
        updated_at: request.updated_at,
        content_sha256: sha256_hex(&bytes),
        task_state: request.task_state,
    };
    validate_task_state(&metadata)?;
    if let Some(existing) = load_stored_at(root, &metadata.recovery_key)? {
        if existing
            .metadata
            .task_state
            .as_ref()
            .is_some_and(|state| state.pending_save.is_some())
        {
            let mut same_request = metadata.clone();
            same_request.updated_at = existing.metadata.updated_at.clone();
            if existing.metadata == same_request {
                return Ok(existing.metadata);
            }
            return Err("The fixed DOCX save must finish or be explicitly discarded before replacing its checkpoint.".into());
        }
    }
    let stored = StoredDocxRecovery {
        schema_version: SCHEMA_VERSION,
        metadata: metadata.clone(),
        content_base64: STANDARD.encode(bytes),
    };
    let encoded = serde_json::to_vec(&stored)
        .map_err(|error| format!("failed to encode DOCX recovery snapshot: {error}"))?;
    let path = recovery_path(root, &metadata.recovery_key)?;
    let directory = path
        .parent()
        .expect("DOCX recovery path always has a parent");
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create DOCX recovery directory: {error}"))?;
    crate::sandbox::atomic_write(&path, &encoded)
        .map_err(|error| format!("failed to write DOCX recovery snapshot: {error}"))?;
    Ok(metadata)
}

fn load_stored_at(root: &Path, recovery_key: &str) -> Result<Option<StoredDocxRecovery>, String> {
    let path = recovery_path(root, recovery_key)?;
    let encoded = match std::fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read DOCX recovery snapshot: {error}")),
    };
    let stored: StoredDocxRecovery = serde_json::from_slice(&encoded)
        .map_err(|error| format!("failed to decode DOCX recovery snapshot: {error}"))?;
    if !(1..=SCHEMA_VERSION).contains(&stored.schema_version) {
        return Err(format!(
            "unsupported DOCX recovery schema version {}",
            stored.schema_version
        ));
    }
    validate_metadata(&stored.metadata)?;
    validate_task_state(&stored.metadata)?;
    if stored.metadata.recovery_key != recovery_key {
        return Err("DOCX recovery key does not match its file".into());
    }
    if stored.metadata.recovery_key
        != recovery_key_for(
            &stored.metadata.app_project_id,
            &stored.metadata.workbench_project_id,
            &stored.metadata.base_baseline_id,
            &stored.metadata.source_sha256,
        )
    {
        return Err("DOCX recovery key does not match its working-copy metadata".into());
    }
    let bytes = STANDARD
        .decode(stored.content_base64.trim())
        .map_err(|error| format!("failed to decode stored DOCX recovery bytes: {error}"))?;
    if bytes.is_empty() {
        return Err("stored DOCX recovery bytes are empty".into());
    }
    if sha256_hex(&bytes) != stored.metadata.content_sha256 {
        return Err("stored DOCX recovery content hash does not match its metadata".into());
    }
    Ok(Some(stored))
}

fn read_at(
    root: &Path,
    request: DocxRecoveryReadRequest,
) -> Result<Option<DocxRecoverySnapshot>, String> {
    let Some(stored) = load_stored_at(root, &request.recovery_key)? else {
        return Ok(None);
    };
    Ok(Some(DocxRecoverySnapshot {
        metadata: stored.metadata,
        bytes_base64: stored.content_base64,
    }))
}

fn list_at(root: &Path) -> Result<DocxRecoveryListing, String> {
    let entries = match std::fs::read_dir(root.join(RECOVERY_DIRECTORY)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DocxRecoveryListing::default());
        }
        Err(error) => return Err(format!("failed to list DOCX recovery directory: {error}")),
    };
    let mut listing = DocxRecoveryListing::default();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to list DOCX recovery directory: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let recovery_key = path
            .file_stem()
            .expect("JSON recovery path has a file stem")
            .to_string_lossy()
            .into_owned();
        match load_stored_at(root, &recovery_key) {
            Ok(Some(stored)) => listing.snapshots.push(stored.metadata),
            Ok(None) => {}
            Err(error) => listing.failures.push(DocxRecoveryFailure {
                recovery_key,
                error,
            }),
        }
    }
    listing.snapshots.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.recovery_key.cmp(&right.recovery_key))
    });
    listing
        .failures
        .sort_by(|left, right| left.recovery_key.cmp(&right.recovery_key));
    Ok(listing)
}

fn clear_at(root: &Path, request: DocxRecoveryClearRequest) -> Result<bool, String> {
    validate_sha256(&request.content_sha256, "contentSha256")?;
    let Some(stored) = load_stored_at(root, &request.recovery_key)? else {
        return Ok(false);
    };
    if stored.metadata.content_sha256 != request.content_sha256 {
        return Ok(false);
    }
    let path = recovery_path(root, &request.recovery_key)?;
    std::fs::remove_file(&path)
        .map_err(|error| format!("failed to clear DOCX recovery snapshot: {error}"))?;
    Ok(true)
}

fn recovery_root() -> Result<PathBuf, String> {
    crate::paths::oleafly_root()
}

#[tauri::command]
pub async fn docx_recovery_save(
    request: DocxRecoverySaveRequest,
) -> Result<DocxRecoveryMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        let root = recovery_root()?;
        let metadata = save_at(&root, request)?;
        if metadata.task_state.is_some() {
            let store = task_store(&root)?;
            replay_receipts(&store, &metadata)?;
            replay_operations(
                &store,
                &metadata,
                DocxOperationCheckpointPhase::Recovered,
                None,
            )?;
            verified_sources(&store, &metadata)?;
        }
        Ok(metadata)
    })
    .await
    .map_err(|error| format!("DOCX recovery save task failed: {error}"))?
}

fn exact_snapshot(
    root: &Path,
    request: &DocxRecoveryClearRequest,
) -> Result<StoredDocxRecovery, String> {
    let stored = load_stored_at(root, &request.recovery_key)?
        .ok_or("The DOCX checkpoint is no longer available.")?;
    if stored.metadata.content_sha256 != request.content_sha256 {
        return Err("The DOCX checkpoint changed; select its current exact bytes.".into());
    }
    Ok(stored)
}

fn resume_at(
    root: &Path,
    store: &TaskStore,
    request: &DocxRecoveryClearRequest,
    document: DocxDocumentIdentity,
) -> Result<Vec<DocxActivity>, String> {
    let stored = exact_snapshot(root, request)?;
    let metadata = &stored.metadata;
    let Some(state) = &metadata.task_state else {
        return Ok(Vec::new());
    };
    if state.pending_save.is_some() {
        return Err(
            "Resolve the checkpoint's fixed save before opening a recovered editing session."
                .into(),
        );
    }
    if document.app_project_id != metadata.app_project_id
        || document.workbench_project_id != metadata.workbench_project_id
        || document.baseline_id != metadata.base_baseline_id
        || document.source_sha256 != metadata.source_sha256
    {
        return Err("The recovered session belongs to a different checkpoint source.".into());
    }
    replay_receipts(store, metadata)?;
    replay_operations(
        store,
        metadata,
        DocxOperationCheckpointPhase::Recovered,
        None,
    )?;
    verified_sources(store, metadata)?;
    state
        .applied
        .iter()
        .map(|source| {
            store.record_docx_proposal_outcome(
                &metadata.app_project_id,
                &metadata.workbench_project_id,
                &source.proposal_id,
                document.clone(),
                DocxProposalOutcome::Recovered {
                    recovery_key: request.recovery_key.clone(),
                    content_sha256: request.content_sha256.clone(),
                    from_document: Box::new(state.document.clone()),
                },
            )
        })
        .collect()
}

#[tauri::command]
pub async fn docx_recovery_resume(
    request: DocxRecoveryClearRequest,
    document: DocxDocumentIdentity,
) -> Result<Vec<DocxActivity>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        let root = recovery_root()?;
        resume_at(&root, &task_store(&root)?, &request, document)
    })
    .await
    .map_err(|error| format!("DOCX recovery resume task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_commit(
    app: tauri::AppHandle,
    state: State<'_, ResearchTaskState>,
    request: DocxRecoveryClearRequest,
) -> Result<DocxRecoveryCommitOutcome, String> {
    let stored = {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        exact_snapshot(&recovery_root()?, &request)?
    };
    let metadata = &stored.metadata;
    let task = metadata
        .task_state
        .as_ref()
        .ok_or("This checkpoint has no fixed save request.")?;
    let save = task
        .pending_save
        .as_ref()
        .ok_or("This checkpoint has no fixed save request.")?;
    let store = state.store()?;
    replay_receipts(&store, metadata)?;
    replay_operations(
        &store,
        metadata,
        DocxOperationCheckpointPhase::Recovered,
        None,
    )?;
    verified_sources(&store, metadata)?;
    let workbench = app.state::<crate::journal_workbench::JournalWorkbenchState>();
    let result = {
        let current = workbench.0.lock().await;
        let session = current
            .as_ref()
            .ok_or("Connect Workbench before resolving the fixed DOCX save.")?;
        crate::journal_workbench::request_docx_baseline(
            session,
            serde_json::json!({
                "project_id":save.project_id,"expected_baseline_id":save.expected_baseline_id,
                "filename":save.filename,"reason":save.reason,"request_id":save.request_id,
                "content_base64":stored.content_base64,
            }),
        )
        .await?
    };
    settle_commit_response(&workbench, &store, metadata, &result).await
}

async fn settle_commit_response(
    workbench: &crate::journal_workbench::JournalWorkbenchState,
    store: &TaskStore,
    metadata: &DocxRecoveryMetadata,
    result: &serde_json::Value,
) -> Result<DocxRecoveryCommitOutcome, String> {
    let save = metadata
        .task_state
        .as_ref()
        .and_then(|task| task.pending_save.as_ref())
        .ok_or("This checkpoint has no fixed save request.")?;
    if result["request_id"] != save.request_id {
        return Err("Workbench did not confirm the fixed DOCX save request.".into());
    }
    if let Some(status @ ("BASELINE_CONFLICT" | "REJECTED" | "IDEMPOTENCY_CONFLICT")) =
        result["status"].as_str()
    {
        if result.get("result_baseline_id") == Some(&serde_json::Value::Null) {
            return Ok(DocxRecoveryCommitOutcome::Refused {
                refusal: status.into(),
            });
        }
    }
    if result["status"] != "APPLIED" {
        return Err("Workbench did not confirm the fixed DOCX save request.".into());
    }
    let baseline_id = result["result_baseline_id"]
        .as_str()
        .ok_or("Workbench did not return a saved baseline.")?
        .to_string();
    let hash = crate::journal_workbench::retained_docx_source_hash(
        workbench,
        &metadata.workbench_project_id,
        &baseline_id,
    )
    .await?;
    if hash != metadata.content_sha256 {
        return Err("The saved Workbench source differs from the fixed checkpoint bytes.".into());
    }
    finish_commit(store, metadata, baseline_id, hash).map(DocxRecoveryCommitOutcome::Saved)
}

fn finish_commit(
    store: &TaskStore,
    metadata: &DocxRecoveryMetadata,
    baseline_id: String,
    hash: String,
) -> Result<DocxRecoveryCommitResult, String> {
    if hash != metadata.content_sha256 {
        return Err("The saved Workbench source differs from the fixed checkpoint bytes.".into());
    }
    let task = metadata
        .task_state
        .as_ref()
        .ok_or("This checkpoint has no fixed save request.")?;
    let save = task
        .pending_save
        .as_ref()
        .ok_or("This checkpoint has no fixed save request.")?;
    let mut document = task.document.clone();
    document.baseline_id = baseline_id.clone();
    document.source_sha256 = hash.clone();
    document.saved_revision =
        i64::try_from(save.revision).map_err(|_| "DOCX save revision is out of range.")?;
    for source in &task.applied {
        store.record_docx_proposal_outcome(
            &metadata.app_project_id,
            &metadata.workbench_project_id,
            &source.proposal_id,
            document.clone(),
            DocxProposalOutcome::Saved {
                request_id: save.request_id.clone(),
                content_sha256: hash.clone(),
            },
        )?;
    }
    replay_operations(
        store,
        metadata,
        DocxOperationCheckpointPhase::Saved,
        Some(&save.request_id),
    )?;
    Ok(DocxRecoveryCommitResult {
        baseline_id,
        source_sha256: hash,
        revision: save.revision,
    })
}

#[tauri::command]
pub async fn docx_recovery_read(
    request: DocxRecoveryReadRequest,
) -> Result<Option<DocxRecoverySnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        read_at(&recovery_root()?, request)
    })
    .await
    .map_err(|error| format!("DOCX recovery read task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_list() -> Result<DocxRecoveryListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        list_at(&recovery_root()?)
    })
    .await
    .map_err(|error| format!("DOCX recovery list task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_clear(request: DocxRecoveryClearRequest) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        clear_at(&recovery_root()?, request)
    })
    .await
    .map_err(|error| format!("DOCX recovery clear task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use oleafly_research::{
        docx::{DocxActivityEvent, DocxRuntimeEvent, DocxTarget},
        model::ResearchTaskDraft,
    };

    fn task_fixture(root: &Path) -> (TaskStore, DocxActivity, DocxDocumentIdentity) {
        let store = task_store(root).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "app-project".into(),
                title: "Recovery source".into(),
                prompt: "Revise".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        let mut document = DocxDocumentIdentity {
            session_id: "original-session".into(),
            app_project_id: "app-project".into(),
            workbench_project_id: "workbench-project".into(),
            baseline_id: "baseline-7".into(),
            source_sha256: "a".repeat(64),
            filename: None,
            title: None,
            session_revision: 3,
            saved_revision: 0,
        };
        store
            .bind_docx_task("app-project", &task.id, document.clone())
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let target = DocxTarget {
            target_id: "target".into(),
            paragraph_ref: "p1".into(),
            revision: 3,
            original: "Original".into(),
            para_id: None,
            structure: None,
        };
        store
            .record_docx_activity(
                "app-project",
                &task.id,
                task.execution_generation,
                document.clone(),
                DocxRuntimeEvent::Captured {
                    target: target.clone(),
                },
            )
            .unwrap();
        let proposal = store
            .record_docx_activity(
                "app-project",
                &task.id,
                task.execution_generation,
                document.clone(),
                DocxRuntimeEvent::Proposed {
                    target,
                    proposed: "Replacement".into(),
                },
            )
            .unwrap();
        document.session_revision = 4;
        (store, proposal, document)
    }

    fn task_request(
        document: DocxDocumentIdentity,
        proposal: &DocxActivity,
        pending: bool,
    ) -> DocxRecoverySaveRequest {
        let mut request = request("", b"exact checkpoint");
        request.task_state = Some(DocxRecoveryTaskState {
            document: document.clone(),
            applied: vec![DocxRecoveryApplied {
                proposal_id: proposal.id.clone(),
                document: document.clone(),
            }],
            receipts: vec![DocxRecoveryReceipt {
                proposal_id: proposal.id.clone(),
                document,
                outcome: DocxProposalOutcome::Applied,
            }],
            operations: Vec::new(),
            pending_save: pending.then(|| DocxRecoveryPendingSave {
                project_id: "workbench-project".into(),
                expected_baseline_id: "baseline-7".into(),
                filename: "paper.docx".into(),
                reason: "User saved".into(),
                request_id: "fixed-save".into(),
                revision: 4,
            }),
        });
        request
    }

    fn recovery_operation(
        store: &TaskStore,
        proposal: &DocxActivity,
        document: &DocxDocumentIdentity,
    ) -> DocxRecoveryOperation {
        let operation_id = store
            .record_docx_activity(
                "app-project",
                &proposal.origin.task_id,
                proposal.origin.generation,
                document.clone(),
                DocxRuntimeEvent::OperationStarted {
                    operation: "format".into(),
                    request: serde_json::json!({"paragraph_ref":"p1","format":{"font":{"bold":true}}}),
                },
            )
            .unwrap()
            .id;
        let result = serde_json::json!({
            "operation":"format","ok":true,"document":document,
            "result":{"ok":true,"revision":document.session_revision,"changed":true},
        });
        DocxRecoveryOperation {
            operation_id,
            document: document.clone(),
            result,
        }
    }

    #[test]
    fn old_schema_one_snapshot_reads_without_task_state() {
        let root = tempfile::tempdir().unwrap();
        let metadata = save_at(root.path(), request("", b"old bytes")).unwrap();
        let path = recovery_path(root.path(), &metadata.recovery_key).unwrap();
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        encoded["schemaVersion"] = 1.into();
        encoded.as_object_mut().unwrap().remove("taskState");
        std::fs::write(path, serde_json::to_vec(&encoded).unwrap()).unwrap();
        assert!(load_stored_at(root.path(), &metadata.recovery_key)
            .unwrap()
            .unwrap()
            .metadata
            .task_state
            .is_none());
    }

    #[test]
    fn pending_save_retry_ignores_updated_at_but_refuses_changed_request_or_bytes() {
        let root = tempfile::tempdir().unwrap();
        let (_store, proposal, document) = task_fixture(root.path());
        let metadata =
            save_at(root.path(), task_request(document.clone(), &proposal, true)).unwrap();
        let mut retry = task_request(document.clone(), &proposal, true);
        retry.updated_at = "2026-11-13T08:30:15.123Z".into();
        assert_eq!(save_at(root.path(), retry).unwrap(), metadata);
        let mut changed = task_request(document.clone(), &proposal, true);
        changed
            .task_state
            .as_mut()
            .unwrap()
            .pending_save
            .as_mut()
            .unwrap()
            .request_id = "another-save".into();
        assert!(save_at(root.path(), changed).is_err());
        let mut changed = task_request(document, &proposal, true);
        changed.content_base64 = STANDARD.encode(b"different");
        assert!(save_at(root.path(), changed).is_err());
        assert_eq!(
            load_stored_at(root.path(), &metadata.recovery_key)
                .unwrap()
                .unwrap()
                .metadata,
            metadata
        );
    }

    #[test]
    fn checkpoint_resume_replays_applied_receipt_and_keeps_distinct_session() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let metadata = save_at(
            root.path(),
            task_request(document.clone(), &proposal, false),
        )
        .unwrap();
        let request = DocxRecoveryClearRequest {
            recovery_key: metadata.recovery_key.clone(),
            content_sha256: metadata.content_sha256.clone(),
        };
        let mut restored = document.clone();
        restored.session_id = "restored".into();
        restored.session_revision = 0;
        restored.saved_revision = -1;
        let activities = resume_at(root.path(), &store, &request, restored.clone()).unwrap();
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].document, restored);
        assert_eq!(activities[0].origin, proposal.origin);
        assert!(matches!(
            activities[0].event,
            DocxActivityEvent::Outcome {
                outcome: DocxProposalOutcome::Recovered { .. }
            }
        ));
        assert_eq!(
            resume_at(root.path(), &store, &request, restored.clone()).unwrap(),
            activities
        );
        let wrong = DocxRecoveryClearRequest {
            recovery_key: request.recovery_key.clone(),
            content_sha256: "f".repeat(64),
        };
        assert!(resume_at(root.path(), &store, &wrong, restored.clone()).is_err());
        restored.app_project_id = "another".into();
        assert!(resume_at(root.path(), &store, &request, restored).is_err());
    }

    #[test]
    fn checkpoint_replay_finishes_operations_and_ties_them_to_recovered_and_saved_bytes() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let operation = recovery_operation(&store, &proposal, &document);
        let mut request = task_request(document.clone(), &proposal, false);
        request
            .task_state
            .as_mut()
            .unwrap()
            .operations
            .push(operation.clone());
        let recovered_metadata = save_at(root.path(), request).unwrap();
        let clear = DocxRecoveryClearRequest {
            recovery_key: recovered_metadata.recovery_key.clone(),
            content_sha256: recovered_metadata.content_sha256.clone(),
        };
        let mut restored = document.clone();
        restored.session_id = "restored".into();
        restored.session_revision = 0;
        restored.saved_revision = -1;
        resume_at(root.path(), &store, &clear, restored).unwrap();
        assert!(store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap()
            .activities
            .iter()
            .any(
                |entry| matches!(&entry.activity.event, DocxActivityEvent::Runtime {
                    event: DocxRuntimeEvent::Operation { ref operation_id, .. }
                } if operation_id.as_deref() == Some(&operation.operation_id))
            ));

        let mut request = task_request(document.clone(), &proposal, true);
        request
            .task_state
            .as_mut()
            .unwrap()
            .operations
            .push(operation.clone());
        let metadata = save_at(root.path(), request).unwrap();
        replay_receipts(&store, &metadata).unwrap();
        finish_commit(
            &store,
            &metadata,
            "baseline-saved".into(),
            metadata.content_sha256.clone(),
        )
        .unwrap();
        finish_commit(
            &store,
            &metadata,
            "baseline-saved".into(),
            metadata.content_sha256.clone(),
        )
        .unwrap();

        let history = store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap();
        let checkpoints = history
            .activities
            .iter()
            .filter_map(|entry| match &entry.activity.event {
                DocxActivityEvent::OperationCheckpoint {
                    operation_id,
                    phase,
                    recovery_key,
                    content_sha256,
                    from_document,
                    request_id,
                } if operation_id == &operation.operation_id => Some((
                    *phase,
                    recovery_key,
                    content_sha256,
                    from_document,
                    request_id,
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(checkpoints.len(), 2);
        for (phase, recovery_key, content_sha256, from_document, request_id) in &checkpoints {
            assert_eq!(recovery_key.as_str(), metadata.recovery_key);
            assert_eq!(content_sha256.as_str(), metadata.content_sha256);
            assert_eq!(
                from_document.as_ref(),
                &metadata.task_state.as_ref().unwrap().document
            );
            match phase {
                DocxOperationCheckpointPhase::Recovered => assert!(request_id.is_none()),
                DocxOperationCheckpointPhase::Saved => {
                    assert_eq!(request_id.as_deref(), Some("fixed-save"))
                }
            }
        }
    }

    #[test]
    fn checkpoint_rejects_operations_from_another_session_or_beyond_its_revision() {
        let root = tempfile::tempdir().unwrap();
        let (_store, proposal, document) = task_fixture(root.path());
        for change in ["session", "revision"] {
            let mut request = task_request(document.clone(), &proposal, false);
            let mut operation_document = document.clone();
            if change == "session" {
                operation_document.session_id = "another-session".into();
                operation_document.baseline_id = "another-baseline".into();
                operation_document.source_sha256 = "b".repeat(64);
            } else {
                operation_document.session_revision += 1;
            }
            request
                .task_state
                .as_mut()
                .unwrap()
                .operations
                .push(DocxRecoveryOperation {
                    operation_id: format!("operation-{change}"),
                    result: serde_json::json!({
                        "operation":"format","ok":true,"document":operation_document,
                        "result":{"ok":true,"changed":true},
                    }),
                    document: operation_document,
                });
            assert!(save_at(root.path(), request).is_err());
        }
    }

    #[test]
    fn recovered_session_keeps_original_operation_documents_and_links_the_save() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let operation = recovery_operation(&store, &proposal, &document);
        let mut restored = document;
        restored.session_id = "restored".into();
        restored.session_revision = 0;
        restored.saved_revision = -1;
        let mut request = task_request(restored.clone(), &proposal, true);
        request.revision = 0;
        let state = request.task_state.as_mut().unwrap();
        state.applied.clear();
        state.receipts.clear();
        state.pending_save.as_mut().unwrap().revision = 0;
        state.operations.push(operation.clone());
        let metadata = save_at(root.path(), request).unwrap();
        replay_operations(
            &store,
            &metadata,
            DocxOperationCheckpointPhase::Recovered,
            None,
        )
        .unwrap();
        replay_receipts(&store, &metadata).unwrap();
        finish_commit(
            &store,
            &metadata,
            "baseline-saved".into(),
            metadata.content_sha256.clone(),
        )
        .unwrap();

        let history = store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap();
        let phases = history
            .activities
            .iter()
            .filter_map(|entry| match &entry.activity.event {
                DocxActivityEvent::OperationCheckpoint {
                    operation_id,
                    phase,
                    ..
                } if operation_id == &operation.operation_id => Some(*phase),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(phases, vec![DocxOperationCheckpointPhase::Saved]);
    }

    #[test]
    fn renderer_save_is_not_finished_before_native_workbench_verification() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let bytes = b"verified saved bytes";
        let content_sha256 = sha256_hex(bytes);
        let mut saved_document = document;
        saved_document.baseline_id = "baseline-saved".into();
        saved_document.source_sha256 = content_sha256.clone();
        saved_document.saved_revision = saved_document.session_revision as i64;
        let operation_id = store
            .record_docx_activity(
                "app-project",
                &proposal.origin.task_id,
                proposal.origin.generation,
                saved_document.clone(),
                DocxRuntimeEvent::OperationStarted {
                    operation: "save".into(),
                    request: serde_json::json!({"expected_revision":4}),
                },
            )
            .unwrap()
            .id;
        let result = serde_json::json!({
            "operation":"save","ok":true,"document":saved_document,
            "result":{"baselineId":"baseline-saved","revision":4,
                "sourceSha256":content_sha256,"document":saved_document},
        });
        let mut request = request("", bytes);
        request.base_baseline_id = "baseline-saved".into();
        request.source_sha256 = content_sha256.clone();
        request.recovery_key = recovery_key_for(
            &request.app_project_id,
            &request.workbench_project_id,
            &request.base_baseline_id,
            &request.source_sha256,
        );
        request.task_state = Some(DocxRecoveryTaskState {
            document: saved_document.clone(),
            applied: Vec::new(),
            receipts: Vec::new(),
            operations: vec![DocxRecoveryOperation {
                operation_id: operation_id.clone(),
                document: saved_document,
                result,
            }],
            pending_save: Some(DocxRecoveryPendingSave {
                project_id: "workbench-project".into(),
                expected_baseline_id: "baseline-saved".into(),
                filename: "paper.docx".into(),
                reason: "User saved".into(),
                request_id: "fixed-save".into(),
                revision: 4,
            }),
        });
        let metadata = save_at(root.path(), request).unwrap();
        replay_operations(
            &store,
            &metadata,
            DocxOperationCheckpointPhase::Recovered,
            None,
        )
        .unwrap();
        assert!(!store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap()
            .activities
            .iter()
            .any(
                |entry| matches!(&entry.activity.event, DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation { operation_id: Some(id), .. }
            } if id == &operation_id)
            ));

        finish_commit(&store, &metadata, "baseline-saved".into(), content_sha256).unwrap();
        assert!(store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap()
            .activities
            .iter()
            .any(
                |entry| matches!(&entry.activity.event, DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation { operation_id: Some(id), .. }
            } if id == &operation_id)
            ));
    }

    #[test]
    fn recovered_source_requires_unchanged_revision_and_bytes() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let metadata = save_at(
            root.path(),
            task_request(document.clone(), &proposal, false),
        )
        .unwrap();
        let mut restored = document;
        restored.session_id = "restored".into();
        restored.session_revision = 0;
        restored.saved_revision = -1;
        resume_at(
            root.path(),
            &store,
            &DocxRecoveryClearRequest {
                recovery_key: metadata.recovery_key,
                content_sha256: metadata.content_sha256,
            },
            restored.clone(),
        )
        .unwrap();
        let mut request = task_request(restored, &proposal, false);
        request.revision = 0;
        request.task_state.as_mut().unwrap().receipts.clear();
        let metadata = save_at(root.path(), request).unwrap();
        verified_sources(&store, &metadata).unwrap();
        let mut edited = metadata.clone();
        edited
            .task_state
            .as_mut()
            .unwrap()
            .document
            .session_revision = 1;
        assert!(verified_sources(&store, &edited).is_err());
        let mut changed = metadata;
        changed.content_sha256 = sha256_hex(b"different serialization at same revision");
        assert!(verified_sources(&store, &changed).is_err());
    }

    #[test]
    fn pending_save_cannot_resume_and_checkpoint_cannot_replay_saved_receipts() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, mut document) = task_fixture(root.path());
        let metadata =
            save_at(root.path(), task_request(document.clone(), &proposal, true)).unwrap();
        document.session_id = "restored".into();
        document.session_revision = 0;
        document.saved_revision = -1;
        assert!(resume_at(
            root.path(),
            &store,
            &DocxRecoveryClearRequest {
                recovery_key: metadata.recovery_key.clone(),
                content_sha256: metadata.content_sha256.clone(),
            },
            document,
        )
        .is_err());
        let mut forged = metadata;
        forged.task_state.as_mut().unwrap().receipts[0].outcome = DocxProposalOutcome::Saved {
            request_id: "unverified-save".into(),
            content_sha256: forged.content_sha256.clone(),
        };
        assert!(validate_task_state(&forged).is_err());
    }

    #[test]
    fn refused_commit_does_not_save_or_clear_checkpoint() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let metadata = save_at(root.path(), task_request(document, &proposal, true)).unwrap();
        replay_receipts(&store, &metadata).unwrap();
        verified_sources(&store, &metadata).unwrap();
        let before = store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let disconnected = crate::journal_workbench::JournalWorkbenchState::default();
        for status in ["BASELINE_CONFLICT", "REJECTED", "IDEMPOTENCY_CONFLICT"] {
            let result = serde_json::json!({"request_id":"fixed-save", "status":status,
                "result_baseline_id":null});
            // No connected Workbench: reaching hash verification or finish_commit would fail.
            let outcome = runtime
                .block_on(settle_commit_response(
                    &disconnected,
                    &store,
                    &metadata,
                    &result,
                ))
                .unwrap();
            assert_eq!(
                serde_json::to_value(outcome).unwrap(),
                serde_json::json!({"refusal":status})
            );
            let mut mismatch = result.clone();
            mismatch["request_id"] = "other".into();
            assert!(runtime
                .block_on(settle_commit_response(
                    &disconnected,
                    &store,
                    &metadata,
                    &mismatch
                ))
                .is_err());
            let mut nonnull = result;
            nonnull["result_baseline_id"] = "baseline".into();
            assert!(runtime
                .block_on(settle_commit_response(
                    &disconnected,
                    &store,
                    &metadata,
                    &nonnull
                ))
                .is_err());
        }
        assert_eq!(
            store
                .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
                .unwrap()
                .activities,
            before.activities
        );
        assert_eq!(
            load_stored_at(root.path(), &metadata.recovery_key)
                .unwrap()
                .unwrap()
                .metadata,
            metadata
        );
        let saved = DocxRecoveryCommitOutcome::Saved(DocxRecoveryCommitResult {
            baseline_id: "saved".into(),
            source_sha256: "a".repeat(64),
            revision: 4,
        });
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            serde_json::json!({
                "baselineId":"saved", "sourceSha256":"a".repeat(64), "revision":4,
            })
        );
    }

    #[test]
    fn partial_saved_receipts_retry_without_changing_fixed_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let (store, proposal, document) = task_fixture(root.path());
        let metadata =
            save_at(root.path(), task_request(document.clone(), &proposal, true)).unwrap();
        replay_receipts(&store, &metadata).unwrap();
        verified_sources(&store, &metadata).unwrap();
        let mut broken = metadata.clone();
        broken
            .task_state
            .as_mut()
            .unwrap()
            .applied
            .push(DocxRecoveryApplied {
                proposal_id: "missing-proposal".into(),
                document,
            });
        assert!(finish_commit(
            &store,
            &broken,
            "baseline-saved".into(),
            metadata.content_sha256.clone()
        )
        .is_err());
        assert!(finish_commit(&store, &metadata, "baseline-saved".into(), "f".repeat(64)).is_err());
        for _ in 0..2 {
            finish_commit(
                &store,
                &metadata,
                "baseline-saved".into(),
                metadata.content_sha256.clone(),
            )
            .unwrap();
        }
        let history = store
            .docx_task_activities("app-project", &proposal.origin.task_id, 0, 50)
            .unwrap();
        assert_eq!(
            history
                .activities
                .iter()
                .filter(|entry| matches!(
                    entry.activity.event,
                    DocxActivityEvent::Outcome {
                        outcome: DocxProposalOutcome::Saved { .. }
                    }
                ))
                .count(),
            1
        );
        assert_eq!(
            load_stored_at(root.path(), &metadata.recovery_key)
                .unwrap()
                .unwrap()
                .metadata,
            metadata
        );
    }

    fn request(key: &str, content: &[u8]) -> DocxRecoverySaveRequest {
        let app_project_id = "app-project";
        let workbench_project_id = "workbench-project";
        let base_baseline_id = "baseline-7";
        let source_sha256 = "a".repeat(64);
        DocxRecoverySaveRequest {
            recovery_key: if key.is_empty() {
                recovery_key_for(
                    app_project_id,
                    workbench_project_id,
                    base_baseline_id,
                    &source_sha256,
                )
            } else {
                key.into()
            },
            app_project_id: app_project_id.into(),
            workbench_project_id: workbench_project_id.into(),
            base_baseline_id: base_baseline_id.into(),
            source_sha256,
            revision: 4,
            updated_at: "2026-11-11T08:30:15.123Z".into(),
            content_base64: STANDARD.encode(content),
            task_state: None,
        }
    }

    #[test]
    fn derives_the_shared_recovery_key_contract() {
        assert_eq!(
            recovery_key_for(
                "app-project",
                "workbench-project",
                "baseline-7",
                &"a".repeat(64),
            ),
            "296d8e392fc181f4ec387ea8ee341712f3c45bd12762dbf3dfc93bf0ca8dbabc"
        );
    }

    #[test]
    fn save_and_read_replace_the_latest_snapshot_with_verified_hashes() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        save_at(temporary.path(), request(&key, b"first")).unwrap();
        let metadata = save_at(temporary.path(), request(&key, b"latest")).unwrap();

        let snapshot = read_at(
            temporary.path(),
            DocxRecoveryReadRequest { recovery_key: key },
        )
        .unwrap()
        .unwrap();

        assert_eq!(snapshot.metadata, metadata);
        assert_eq!(STANDARD.decode(snapshot.bytes_base64).unwrap(), b"latest");
        assert_eq!(metadata.content_sha256, sha256_hex(b"latest"));
    }

    #[test]
    fn lists_verified_metadata_by_latest_update_then_key() {
        let temporary = tempfile::tempdir().unwrap();
        let mut expected = Vec::new();
        for (baseline, updated_at) in [
            ("baseline-old", "2026-11-10T08:30:15.123Z"),
            ("baseline-new-a", "2026-11-11T08:30:15.123Z"),
            ("baseline-new-b", "2026-11-11T08:30:15.123Z"),
        ] {
            let mut save_request = request("", baseline.as_bytes());
            save_request.base_baseline_id = baseline.into();
            save_request.updated_at = updated_at.into();
            save_request.recovery_key = recovery_key_for(
                &save_request.app_project_id,
                &save_request.workbench_project_id,
                baseline,
                &save_request.source_sha256,
            );
            expected.push(save_at(temporary.path(), save_request).unwrap());
        }
        expected[1..].sort_by(|left, right| left.recovery_key.cmp(&right.recovery_key));
        expected.rotate_left(1);
        std::fs::write(
            temporary
                .path()
                .join(RECOVERY_DIRECTORY)
                .join("pending.tmp"),
            b"unfinished atomic write",
        )
        .unwrap();

        let listing = list_at(temporary.path()).unwrap();

        assert_eq!(listing.snapshots, expected);
        assert!(listing.failures.is_empty());
        let encoded = serde_json::to_value(listing).unwrap();
        assert!(encoded["snapshots"][0].get("contentBase64").is_none());
        assert!(encoded["snapshots"][0].get("bytesBase64").is_none());
    }

    #[test]
    fn listing_isolates_invalid_records_and_keeps_them_for_diagnosis() {
        let temporary = tempfile::tempdir().unwrap();
        let saved = save_at(temporary.path(), request("", b"healthy")).unwrap();
        let directory = temporary.path().join(RECOVERY_DIRECTORY);
        let malformed_key = "b".repeat(64);
        let changed_key = "c".repeat(64);
        std::fs::write(directory.join(format!("{malformed_key}.json")), b"not JSON").unwrap();
        let mut changed: StoredDocxRecovery = serde_json::from_slice(
            &std::fs::read(recovery_path(temporary.path(), &saved.recovery_key).unwrap()).unwrap(),
        )
        .unwrap();
        changed.content_base64 = STANDARD.encode(b"tampered");
        let changed_path = recovery_path(temporary.path(), &saved.recovery_key).unwrap();
        std::fs::write(&changed_path, serde_json::to_vec(&changed).unwrap()).unwrap();
        std::fs::write(directory.join(format!("{changed_key}.json")), b"{}").unwrap();
        std::fs::write(directory.join("invalid-key.json"), b"{}").unwrap();
        let mut healthy_request = request("", b"healthy second record");
        healthy_request.source_sha256 = "d".repeat(64);
        healthy_request.recovery_key = recovery_key_for(
            &healthy_request.app_project_id,
            &healthy_request.workbench_project_id,
            &healthy_request.base_baseline_id,
            &healthy_request.source_sha256,
        );
        let healthy = save_at(temporary.path(), healthy_request).unwrap();

        let listing = list_at(temporary.path()).unwrap();

        assert_eq!(listing.snapshots, vec![healthy]);
        assert_eq!(listing.failures.len(), 4);
        assert!(listing.failures.iter().any(|failure| {
            failure.recovery_key == saved.recovery_key
                && failure.error.contains("content hash does not match")
        }));
        for failure in listing.failures {
            assert!(directory
                .join(format!("{}.json", failure.recovery_key))
                .exists());
        }
    }

    #[test]
    fn listing_returns_empty_for_missing_directory_but_fails_directory_io_errors() {
        let temporary = tempfile::tempdir().unwrap();
        let listing = list_at(temporary.path()).unwrap();
        assert!(listing.snapshots.is_empty());
        assert!(listing.failures.is_empty());

        std::fs::write(
            temporary.path().join(RECOVERY_DIRECTORY),
            b"not a directory",
        )
        .unwrap();
        assert!(list_at(temporary.path())
            .unwrap_err()
            .contains("failed to list DOCX recovery directory"));
    }

    #[test]
    fn discard_from_a_listing_does_not_clear_a_newer_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let selected = save_at(temporary.path(), request("", b"selected")).unwrap();
        let latest = save_at(temporary.path(), request("", b"newer edit")).unwrap();

        assert!(!clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: selected.recovery_key.clone(),
                content_sha256: selected.content_sha256,
            },
        )
        .unwrap());
        assert_eq!(list_at(temporary.path()).unwrap().snapshots, vec![latest]);
    }

    #[test]
    fn read_rejects_content_that_no_longer_matches_its_metadata_hash() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        save_at(temporary.path(), request(&key, b"original")).unwrap();
        let path = recovery_path(temporary.path(), &key).unwrap();
        let mut stored: StoredDocxRecovery =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored.content_base64 = STANDARD.encode(b"tampered");
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();

        let error = read_at(
            temporary.path(),
            DocxRecoveryReadRequest { recovery_key: key },
        )
        .unwrap_err();

        assert!(error.contains("content hash does not match"));
        assert!(path.exists());
    }

    #[test]
    fn read_rejects_invalid_metadata_and_clear_preserves_a_different_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        let saved = save_at(temporary.path(), request(&key, b"working copy")).unwrap();

        let cleared = clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: key.clone(),
                content_sha256: sha256_hex(b"committed baseline"),
            },
        )
        .unwrap();

        assert!(!cleared);
        assert!(recovery_path(temporary.path(), &key).unwrap().exists());
        assert!(clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: key.clone(),
                content_sha256: saved.content_sha256,
            },
        )
        .unwrap());
        assert!(!recovery_path(temporary.path(), &key).unwrap().exists());

        let mut invalid = request(&key, b"next");
        invalid.app_project_id.clear();
        assert!(save_at(temporary.path(), invalid)
            .unwrap_err()
            .contains("appProjectId"));

        let mut mismatched = request(&key, b"next");
        mismatched.app_project_id = "other-app-project".into();
        assert!(save_at(temporary.path(), mismatched)
            .unwrap_err()
            .contains("key does not match"));
    }
}
