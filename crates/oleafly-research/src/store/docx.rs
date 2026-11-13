use super::*;
use crate::docx::*;
use crate::observations::TaskObservation;

const DOCX_FILTER: &str =
    "e.kind='observation' AND json_extract(e.event_json,'$.observation.type')='docx'";

/// Sparse ordering index only; activity contents stay in the immutable event.
/// Preserve old rowid cursor values when upgrading an existing store.
pub(super) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS research_task_docx_cursors (
 cursor INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 UNIQUE(task_id,generation,sequence),
 FOREIGN KEY(task_id,generation,sequence)
  REFERENCES research_task_events(task_id,execution_generation,sequence) ON DELETE CASCADE
);
INSERT OR IGNORE INTO research_task_docx_cursors(cursor,task_id,generation,sequence)
 SELECT e.rowid,e.task_id,e.execution_generation,e.sequence FROM research_task_events e
 WHERE e.kind='observation' AND json_extract(e.event_json,'$.observation.type')='docx'
 ORDER BY e.rowid;
";

fn document_scope(project: &str, document: &DocxDocumentIdentity) -> Result<(), String> {
    if document.app_project_id != project {
        return Err("The DOCX working copy belongs to another application project.".into());
    }
    for (value, label) in [
        (&document.session_id, "DOCX session"),
        (&document.workbench_project_id, "Workbench project"),
        (&document.baseline_id, "DOCX baseline"),
    ] {
        validate_text(value, label, 1, 512)?;
    }
    if document.session_revision > i64::MAX as u64
        || document.saved_revision < -1
        || document.saved_revision > document.session_revision as i64
    {
        return Err("The DOCX saved and session revisions are inconsistent.".into());
    }
    sha256(&document.source_sha256)?;
    Ok(())
}

fn sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("DOCX content hashes must be SHA-256 hex strings.".into());
    }
    Ok(())
}

fn known_operation(operation: &str) -> bool {
    matches!(
        operation,
        "read_format" | "format" | "apply" | "save" | "check"
    )
}

fn target(document: &DocxDocumentIdentity, target: &DocxTarget) -> Result<(), String> {
    validate_text(&target.target_id, "DOCX target", 1, 512)?;
    validate_text(&target.paragraph_ref, "DOCX paragraph", 1, 512)?;
    if target.revision > document.session_revision {
        return Err("The DOCX target revision is newer than its document.".into());
    }
    if target.original.len() > MAX_DOCX_TEXT_BYTES {
        return Err("The DOCX target exceeds the retained text limit.".into());
    }
    Ok(())
}

fn runtime_event(document: &DocxDocumentIdentity, event: &DocxRuntimeEvent) -> Result<(), String> {
    match event {
        DocxRuntimeEvent::OperationStarted { operation, request } => {
            if !known_operation(operation) || !request.is_object() {
                return Err(
                    "Start a known DOCX application operation with its explicit request.".into(),
                );
            }
        }
        DocxRuntimeEvent::Operation {
            operation_id,
            operation,
            request,
            result,
        } => {
            if operation_id
                .as_deref()
                .is_some_and(|id| validate_text(id, "DOCX operation", 1, 512).is_err())
                || !known_operation(operation)
                || !request.is_object()
                || !result.is_object()
                || result["operation"].as_str() != Some(operation)
                || !result["ok"].is_boolean()
            {
                return Err(
                    "Record a known DOCX application operation with its explicit actual result."
                        .into(),
                );
            }
        }
        DocxRuntimeEvent::Bound => return Err("Bind DOCX inputs before starting the task.".into()),
        DocxRuntimeEvent::Read { offset, paragraphs } => {
            if *offset > i64::MAX as usize
                || paragraphs.len() > MAX_DOCX_READ_PARAGRAPHS
                || paragraphs
                    .iter()
                    .map(|paragraph| paragraph.text.len())
                    .sum::<usize>()
                    > MAX_DOCX_TEXT_BYTES
            {
                return Err(
                    "Read at most 50 DOCX paragraphs and 32 KiB of text per window.".into(),
                );
            }
            for paragraph in paragraphs {
                validate_text(&paragraph.paragraph_ref, "DOCX paragraph", 1, 512)?;
            }
        }
        DocxRuntimeEvent::Captured { target: captured } => target(document, captured)?,
        DocxRuntimeEvent::Proposed {
            target: captured,
            proposed,
        } => {
            target(document, captured)?;
            if proposed.len() > MAX_DOCX_TEXT_BYTES {
                return Err("The DOCX proposal exceeds the retained text limit.".into());
            }
        }
    }
    Ok(())
}

fn operation_result(
    operation: &str,
    request: &serde_json::Value,
    result: &serde_json::Value,
) -> serde_json::Value {
    let payload = match operation {
        "read_format" => {
            let source = &result["result"];
            let mut projected = serde_json::json!({
                "sourceSha256": source["sourceSha256"].clone(),
                "revision": source["revision"].clone(),
                "nextOffset": source["nextOffset"].clone(),
            });
            if source.get("total").is_some() {
                projected["total"] = source["total"].clone();
            }
            if let Some(paragraph_ref) = source
                .get("paragraph")
                .and_then(|paragraph| paragraph.get("paragraphRef"))
            {
                projected["paragraphRef"] = paragraph_ref.clone();
            }
            projected
        }
        "check" => {
            let source = &result["result"];
            let check = &source["check"];
            let mut pointer = serde_json::Map::new();
            for field in [
                "check_id",
                "project_id",
                "baseline_id",
                "world_version_id",
                "summary",
            ] {
                if check.get(field).is_some() {
                    pointer.insert(field.into(), check[field].clone());
                }
            }
            let template = source
                .get("template")
                .cloned()
                .or_else(|| request.get("template").cloned())
                .unwrap_or(serde_json::Value::Null);
            serde_json::json!({
                "template": template,
                "check": serde_json::Value::Object(pointer),
            })
        }
        _ => result["result"].clone(),
    };
    serde_json::json!({
        "operation": result["operation"].clone(),
        "ok": result["ok"].clone(),
        "document": result["document"].clone(),
        "result": payload,
    })
}

fn decode_activity(encoded: &str) -> Result<DocxActivity, String> {
    match decode_json::<TaskRuntimeEvent>(encoded, "DOCX activity")? {
        TaskRuntimeEvent::Observation {
            observation: TaskObservation::Docx { activity },
        } => Ok(*activity),
        _ => Err("This event is not a DOCX activity.".into()),
    }
}

fn insert_on(tx: &Transaction<'_>, activity: &DocxActivity) -> Result<(), String> {
    let event = TaskRuntimeEvent::Observation {
        observation: TaskObservation::Docx {
            activity: Box::new(activity.clone()),
        },
    };
    let encoded = encode_json(&event)?;
    if encoded.len() > MAX_EVENT_BYTES {
        return Err("The retained DOCX activity exceeds 128 KiB.".into());
    }
    tx.execute(
        "INSERT INTO research_task_events(task_id,execution_generation,sequence,event_json,created_at)
         SELECT ?1,?2,COALESCE(MAX(sequence),0)+1,?3,?4 FROM research_task_events
         WHERE task_id=?1 AND execution_generation=?2",
        params![activity.origin.task_id, activity.origin.generation as i64, encoded, activity.created_at],
    ).map_err(store_error)?;
    let event_rowid = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO research_task_docx_cursors(task_id,generation,sequence)
         SELECT task_id,execution_generation,sequence FROM research_task_events WHERE rowid=?1",
        [event_rowid],
    )
    .map_err(store_error)?;
    Ok(())
}

fn proposal_on(
    connection: &Connection,
    project: &str,
    manuscript: &str,
    id: &str,
) -> Result<Option<DocxActivity>, String> {
    connection.query_row(
        &format!("SELECT e.event_json FROM research_task_events e JOIN research_tasks t ON t.id=e.task_id
          WHERE {DOCX_FILTER} AND t.project_id=?1
          AND json_extract(e.event_json,'$.observation.activity.document.workbenchProjectId')=?2
          AND json_extract(e.event_json,'$.observation.activity.id')=?3
          AND json_extract(e.event_json,'$.observation.activity.event.type')='runtime'
          AND json_extract(e.event_json,'$.observation.activity.event.event.kind')='proposed'"),
        params![project, manuscript, id], |row| row.get::<_, String>(0),
    ).optional().map_err(store_error)?.map(|encoded| decode_activity(&encoded)).transpose()
}

fn binding_on(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<DocxDocumentIdentity>, String> {
    connection.query_row(
        &format!("SELECT e.event_json FROM research_task_events e WHERE {DOCX_FILTER} AND e.task_id=?1
          AND json_extract(e.event_json,'$.observation.activity.event.type')='runtime'
          AND json_extract(e.event_json,'$.observation.activity.event.event.kind')='bound' ORDER BY e.rowid LIMIT 1"),
        [task_id], |row| row.get::<_, String>(0),
    ).optional().map_err(store_error)?.map(|encoded| Ok(decode_activity(&encoded)?.document)).transpose()
}

fn operation_intent_on(
    connection: &Connection,
    project: &str,
    manuscript: &str,
    operation_id: &str,
) -> Result<Option<DocxActivity>, String> {
    connection
        .query_row(
            &format!(
                "SELECT e.event_json FROM research_task_events e
                 JOIN research_tasks t ON t.id=e.task_id
                 WHERE {DOCX_FILTER} AND t.project_id=?1
                 AND json_extract(e.event_json,'$.observation.activity.document.workbenchProjectId')=?2
                 AND json_extract(e.event_json,'$.observation.activity.id')=?3
                 AND json_extract(e.event_json,'$.observation.activity.event.type')='runtime'
                 AND json_extract(e.event_json,'$.observation.activity.event.event.kind')='operationStarted'"
            ),
            params![project, manuscript, operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(store_error)?
        .map(|encoded| decode_activity(&encoded))
        .transpose()
}

fn operation_on(
    connection: &Connection,
    project: &str,
    manuscript: &str,
    operation_id: &str,
) -> Result<Option<DocxActivity>, String> {
    connection
        .query_row(
            &format!(
                "SELECT e.event_json FROM research_task_events e
                 JOIN research_tasks t ON t.id=e.task_id
                 WHERE {DOCX_FILTER} AND t.project_id=?1
                 AND json_extract(e.event_json,'$.observation.activity.document.workbenchProjectId')=?2
                 AND json_extract(e.event_json,'$.observation.activity.event.type')='runtime'
                 AND json_extract(e.event_json,'$.observation.activity.event.event.kind')='operation'
                 AND json_extract(e.event_json,'$.observation.activity.event.event.operationId')=?3"
            ),
            params![project, manuscript, operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(store_error)?
        .map(|encoded| decode_activity(&encoded))
        .transpose()
}

impl TaskStore {
    /// Explicit application binding; never inferred from the foreground UI.
    /// Immutable once retained, including across task generations.
    pub fn bind_docx_task(
        &self,
        project_id: &str,
        task_id: &str,
        document: DocxDocumentIdentity,
    ) -> Result<(), String> {
        document_scope(project_id, &document)?;
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let task = Self::require_on(&tx, task_id)?;
        if task.project_id != project_id {
            return Err("This DOCX task belongs to another application project.".into());
        }
        if let Some(existing) = binding_on(&tx, task_id)? {
            if existing == document {
                return Ok(());
            }
            return Err(
                "This task is already bound to another DOCX working copy or version.".into(),
            );
        }
        if task.status != ResearchTaskStatus::Queued
            || task.started_at.is_some()
            || task.execution_generation != 0
            || task.cancel_requested
        {
            return Err("Bind the DOCX working copy before the task's first execution.".into());
        }
        let activity = DocxActivity {
            id: fresh_id("docx"),
            origin: DocxActivityOrigin {
                task_id: task_id.into(),
                generation: task.execution_generation,
                group_id: None,
                member_id: None,
                execution_id: None,
                work_ids: Vec::new(),
            },
            document,
            proposal_id: None,
            event: DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Bound,
            },
            created_at: now_ms(),
        };
        insert_on(&tx, &activity)?;
        tx.commit().map_err(store_error)
    }

    pub fn docx_task_binding(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Option<DocxDocumentIdentity>, String> {
        let connection = self.open()?;
        if Self::require_on(&connection, task_id)?.project_id != project_id {
            return Err("This DOCX task belongs to another application project.".into());
        }
        binding_on(&connection, task_id)
    }

    /// Record a known successful operation. The caller is the native task
    /// binding, not model arguments. Resolve membership in this same transaction.
    pub fn record_docx_activity(
        &self,
        project_id: &str,
        task_id: &str,
        generation: u64,
        document: DocxDocumentIdentity,
        event: DocxRuntimeEvent,
    ) -> Result<DocxActivity, String> {
        document_scope(project_id, &document)?;
        runtime_event(&document, &event)?;
        if matches!(event, DocxRuntimeEvent::Operation { .. }) {
            return Err("Finish DOCX application operations through their durable intent.".into());
        }
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let task = Self::require_on(&tx, task_id)?;
        if task.project_id != project_id
            || task.execution_generation != generation
            || task.status != ResearchTaskStatus::Running
            || task.cancel_requested
        {
            return Err(
                "This DOCX activity belongs to an inactive or different task execution.".into(),
            );
        }
        let bound = binding_on(&tx, task_id)?
            .ok_or("This task has no explicitly bound DOCX working copy.")?;
        if bound.session_id != document.session_id
            || bound.workbench_project_id != document.workbench_project_id
        {
            return Err(
                "This DOCX activity is outside the task's explicitly bound working copy.".into(),
            );
        }
        if let DocxRuntimeEvent::Proposed { target, .. } = &event {
            let captures = tx.prepare(&format!(
                "SELECT e.event_json FROM research_task_events e WHERE {DOCX_FILTER} AND e.task_id=?1
                 AND json_extract(e.event_json,'$.observation.activity.document.sessionId')=?2
                 AND json_extract(e.event_json,'$.observation.activity.event.event.kind')='captured'
                 AND json_extract(e.event_json,'$.observation.activity.event.event.target.targetId')=?3"
            )).and_then(|mut statement| statement.query_map(params![task_id, document.session_id, target.target_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()).map_err(store_error)?;
            let mut found = false;
            for encoded in captures {
                let captured = decode_activity(&encoded)?;
                if let DocxActivityEvent::Runtime {
                    event: DocxRuntimeEvent::Captured { target: retained },
                } = captured.event
                {
                    if retained == *target
                        && captured.document.workbench_project_id == document.workbench_project_id
                    {
                        found = true;
                        break;
                    }
                }
            }
            if !found {
                return Err(
                    "Capture this exact DOCX target within this task before proposing a change."
                        .into(),
                );
            }
        }
        let group: Option<String> = tx
            .query_row(
                "SELECT id FROM collaboration_groups WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        let mut origin = DocxActivityOrigin {
            task_id: task_id.into(),
            generation,
            group_id: group.clone(),
            member_id: None,
            execution_id: None,
            work_ids: Vec::new(),
        };
        if let Some(group) = group {
            let active: i64 = tx.query_row(
                "SELECT COUNT(*) FROM collaboration_executions WHERE group_id=?1 AND status='running'",
                [&group], |row| row.get(0),
            ).map_err(store_error)?;
            if active != 1 {
                return Err(
                    "The DOCX task group must have exactly one running member execution.".into(),
                );
            }
            let (member, execution): (String, String) = tx
                .query_row(
                    "SELECT e.member_id,e.id FROM collaboration_executions e
                 JOIN collaboration_members m ON m.id=e.member_id AND m.group_id=e.group_id
                 WHERE e.group_id=?1 AND e.task_generation=?2 AND e.status='running'",
                    params![group, generation as i64],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(store_error)?
                .ok_or("The DOCX task group has no running member execution.")?;
            origin.work_ids = tx.prepare(
                "SELECT id FROM collaboration_work WHERE group_id=?1 AND member_id=?2 AND execution_id=?3
                 AND status='\"running\"' ORDER BY id",
            ).and_then(|mut statement| statement.query_map(params![group, member, execution], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()).map_err(store_error)?;
            origin.member_id = Some(member);
            origin.execution_id = Some(execution);
        }
        let activity = DocxActivity {
            id: fresh_id("docx"),
            origin,
            document,
            proposal_id: None,
            event: DocxActivityEvent::Runtime { event },
            created_at: now_ms(),
        };
        insert_on(&tx, &activity)?;
        tx.commit().map_err(store_error)?;
        Ok(activity)
    }

    /// Finish an operation from its durable intent. The intent, rather than the
    /// task's current status, owns attribution so a committed renderer result
    /// remains recordable after cancellation or terminal settlement.
    pub fn finish_docx_operation(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        operation_id: &str,
        document: DocxDocumentIdentity,
        result: serde_json::Value,
    ) -> Result<DocxActivity, String> {
        validate_text(operation_id, "DOCX operation", 1, 512)?;
        validate_text(workbench_project_id, "Workbench project", 1, 512)?;
        document_scope(project_id, &document)?;
        if !result.is_object() {
            return Err("The DOCX operation result must be an object.".into());
        }
        let result_document: DocxDocumentIdentity =
            serde_json::from_value(result["document"].clone())
                .map_err(|error| format!("The DOCX result has no valid document: {error}"))?;
        if result_document != document {
            return Err("The DOCX result document differs from the supplied working copy.".into());
        }
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let intent = operation_intent_on(&tx, project_id, workbench_project_id, operation_id)?
            .ok_or("The DOCX operation has no retained intent in this manuscript.")?;
        let DocxActivityEvent::Runtime {
            event: DocxRuntimeEvent::OperationStarted { operation, request },
        } = &intent.event
        else {
            return Err("The retained DOCX intent has an invalid event.".into());
        };
        if !known_operation(operation) || result["operation"].as_str() != Some(operation) {
            return Err("The DOCX result does not match its retained operation intent.".into());
        }
        if !result["ok"].is_boolean() {
            return Err("The DOCX operation result must include its actual ok status.".into());
        }
        if intent.document.session_id != document.session_id
            || intent.document.workbench_project_id != document.workbench_project_id
        {
            return Err(
                "The DOCX result is outside the working copy recorded by its operation intent."
                    .into(),
            );
        }
        let result = operation_result(operation, request, &result);
        if let Some(existing) = operation_on(&tx, project_id, workbench_project_id, operation_id)? {
            let same = existing.document == document
                && matches!(
                    &existing.event,
                    DocxActivityEvent::Runtime {
                        event: DocxRuntimeEvent::Operation {
                            operation_id: Some(existing_id),
                            operation: existing_operation,
                            result: existing_result,
                            ..
                        }
                    } if existing_id == operation_id
                        && existing_operation == operation
                        && existing_result == &result
                );
            if same {
                return Ok(existing);
            }
            return Err("This DOCX operation already has a different result or document.".into());
        }
        let activity = DocxActivity {
            id: fresh_id("docx"),
            origin: intent.origin,
            document,
            proposal_id: None,
            event: DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation {
                    operation_id: Some(operation_id.into()),
                    operation: operation.clone(),
                    request: request.clone(),
                    result,
                },
            },
            created_at: now_ms(),
        };
        insert_on(&tx, &activity)?;
        tx.commit().map_err(store_error)?;
        Ok(activity)
    }

    /// Tie a finished operation to the exact recovery or saved bytes. A second
    /// exact call is idempotent; reuse for different bytes or a different save
    /// request is refused even when the operation ID is otherwise valid.
    pub fn record_docx_operation_checkpoint(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        checkpoint: DocxOperationCheckpoint<'_>,
    ) -> Result<DocxActivity, String> {
        let DocxOperationCheckpoint {
            operation_id,
            phase,
            recovery_key,
            content_sha256,
            from_document,
            request_id,
        } = checkpoint;
        validate_text(operation_id, "DOCX operation", 1, 512)?;
        validate_text(workbench_project_id, "Workbench project", 1, 512)?;
        sha256(recovery_key)?;
        sha256(content_sha256)?;
        document_scope(project_id, &from_document)?;
        if from_document.workbench_project_id != workbench_project_id {
            return Err("The DOCX checkpoint belongs to another manuscript.".into());
        }
        match (phase, request_id) {
            (DocxOperationCheckpointPhase::Saved, Some(request_id)) => {
                validate_text(request_id, "DOCX save request", 1, 512)?;
            }
            (DocxOperationCheckpointPhase::Recovered, None) => {}
            (DocxOperationCheckpointPhase::Saved, None) => {
                return Err("A saved DOCX operation must identify its save request.".into());
            }
            (DocxOperationCheckpointPhase::Recovered, Some(_)) => {
                return Err("A recovered DOCX operation cannot invent a save request.".into());
            }
        }
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let intent = operation_intent_on(&tx, project_id, workbench_project_id, operation_id)?
            .ok_or("The DOCX operation has no retained intent in this manuscript.")?;
        let operation = operation_on(&tx, project_id, workbench_project_id, operation_id)?
            .ok_or("The DOCX operation has not recorded an actual result.")?;
        let same_session = operation.document.session_id == from_document.session_id;
        let same_recovery_source = operation.document.baseline_id == from_document.baseline_id
            && operation.document.source_sha256 == from_document.source_sha256;
        if operation.document.app_project_id != from_document.app_project_id
            || operation.document.workbench_project_id != from_document.workbench_project_id
            || same_session && operation.document.session_revision > from_document.session_revision
            || !same_session && !same_recovery_source
        {
            return Err(
                "The DOCX operation belongs to another session or exceeds its checkpoint revision."
                    .into(),
            );
        }
        let previous = tx
            .prepare(&format!(
                "SELECT e.event_json FROM research_task_events e WHERE {DOCX_FILTER}
                 AND e.task_id=?1
                 AND json_extract(e.event_json,'$.observation.activity.event.type')='operationCheckpoint'
                 AND json_extract(e.event_json,'$.observation.activity.event.operationId')=?2
                 ORDER BY e.rowid"
            ))
            .and_then(|mut statement| {
                statement
                    .query_map(params![intent.origin.task_id, operation_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?
            .into_iter()
            .map(|encoded| decode_activity(&encoded))
            .collect::<Result<Vec<_>, _>>()?;
        for existing in previous {
            let DocxActivityEvent::OperationCheckpoint {
                operation_id: existing_id,
                phase: existing_phase,
                recovery_key: existing_key,
                content_sha256: existing_hash,
                from_document: existing_document,
                request_id: existing_request,
            } = &existing.event
            else {
                continue;
            };
            if existing_id == operation_id && *existing_phase == phase {
                if existing_key == recovery_key
                    && existing_hash == content_sha256
                    && existing_document.as_ref() == &from_document
                    && existing_request.as_deref() == request_id
                    && existing.document == operation.document
                {
                    return Ok(existing);
                }
                if phase == DocxOperationCheckpointPhase::Recovered {
                    return Ok(existing);
                }
                return Err("This DOCX operation already has a different checkpoint fact.".into());
            }
        }
        let activity = DocxActivity {
            id: fresh_id("docx"),
            origin: intent.origin,
            document: operation.document,
            proposal_id: None,
            event: DocxActivityEvent::OperationCheckpoint {
                operation_id: operation_id.into(),
                phase,
                recovery_key: recovery_key.into(),
                content_sha256: content_sha256.into(),
                from_document: Box::new(from_document),
                request_id: request_id.map(str::to_owned),
            },
            created_at: now_ms(),
        };
        insert_on(&tx, &activity)?;
        tx.commit().map_err(store_error)?;
        Ok(activity)
    }

    /// Append an application result, including after task completion. Attribution
    /// is inherited from the immutable proposal, never supplied by the UI.
    pub fn record_docx_proposal_outcome(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        proposal_id: &str,
        document: DocxDocumentIdentity,
        outcome: DocxProposalOutcome,
    ) -> Result<DocxActivity, String> {
        document_scope(project_id, &document)?;
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let proposal = proposal_on(&tx, project_id, workbench_project_id, proposal_id)?
            .ok_or("The DOCX proposal is not retained in this project and manuscript.")?;
        if document.workbench_project_id != proposal.document.workbench_project_id {
            return Err("The DOCX result does not belong to this proposal's working copy.".into());
        }
        let previous = tx.prepare(&format!(
            "SELECT e.event_json FROM research_task_events e WHERE {DOCX_FILTER}
             AND e.task_id=?1 AND json_extract(e.event_json,'$.observation.activity.proposalId')=?2 ORDER BY e.rowid"
        )).and_then(|mut statement| statement.query_map(params![proposal.origin.task_id, proposal_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()).map_err(store_error)?
            .into_iter().map(|encoded| decode_activity(&encoded)).collect::<Result<Vec<_>, _>>()?;
        let recovered = previous.iter().find(|receipt| {
            receipt.document.session_id == document.session_id
                && matches!(
                    receipt.event,
                    DocxActivityEvent::Outcome {
                        outcome: DocxProposalOutcome::Recovered { .. }
                    }
                )
        });
        if !matches!(outcome, DocxProposalOutcome::Recovered { .. }) {
            let base = recovered.map_or(&proposal.document, |receipt| &receipt.document);
            if document.session_id != base.session_id
                || document.session_revision < base.session_revision
            {
                return Err("The DOCX result has no matching session or recovery edge.".into());
            }
            if recovered.is_some()
                && matches!(
                    outcome,
                    DocxProposalOutcome::Applied | DocxProposalOutcome::Rejected
                )
            {
                return Err("A recovered proposal cannot be applied again.".into());
            }
        }
        // Exact duplicate acknowledgements are idempotent. A conflicting result
        // cannot use the same applied/rejected/withdrawn kind or save request ID.
        for receipt in &previous {
            if let DocxActivityEvent::Outcome { outcome: existing } = &receipt.event {
                let same_key = receipt.document.session_id == document.session_id
                    && match (existing, &outcome) {
                        (
                            DocxProposalOutcome::Saved { request_id: a, .. },
                            DocxProposalOutcome::Saved { request_id: b, .. },
                        ) => a == b,
                        _ => std::mem::discriminant(existing) == std::mem::discriminant(&outcome),
                    };
                if same_key {
                    if existing == &outcome && receipt.document == document {
                        return Ok(receipt.clone());
                    }
                    return Err(
                        "This DOCX proposal already has a different result for this receipt."
                            .into(),
                    );
                }
            }
        }
        let applied = previous.iter().find(|receipt| {
            receipt.document.session_id == document.session_id
                && matches!(
                    receipt.event,
                    DocxActivityEvent::Outcome {
                        outcome: DocxProposalOutcome::Applied
                            | DocxProposalOutcome::Recovered { .. }
                    }
                )
        });
        let closed = previous.iter().any(|receipt| {
            receipt.document.session_id == document.session_id
                && matches!(
                    receipt.event,
                    DocxActivityEvent::Outcome {
                        outcome: DocxProposalOutcome::Rejected | DocxProposalOutcome::Withdrawn
                    }
                )
        });
        match &outcome {
            DocxProposalOutcome::Recovered {
                recovery_key,
                content_sha256,
                from_document,
            } => {
                sha256(recovery_key)?;
                sha256(content_sha256)?;
                document_scope(project_id, from_document)?;
                if document.session_id == from_document.session_id
                    || document.saved_revision != -1
                    || document.baseline_id != from_document.baseline_id
                    || document.source_sha256 != from_document.source_sha256
                    || from_document.workbench_project_id != workbench_project_id
                {
                    return Err(
                        "The recovered DOCX must use a new unsaved session on the retained source."
                            .into(),
                    );
                }
                let source = previous
                    .iter()
                    .find(|receipt| {
                        receipt.document.session_id == from_document.session_id
                            && receipt.document.session_revision <= from_document.session_revision
                            && matches!(
                                receipt.event,
                                DocxActivityEvent::Outcome {
                                    outcome: DocxProposalOutcome::Applied
                                        | DocxProposalOutcome::Recovered { .. }
                                }
                            )
                    })
                    .ok_or(
                        "The recovery has no retained applied source in its original session.",
                    )?;
                let withdrawn = previous.iter().any(|receipt| {
                    receipt.document.session_id == from_document.session_id
                        && receipt.document.session_revision <= from_document.session_revision
                        && matches!(
                            receipt.event,
                            DocxActivityEvent::Outcome {
                                outcome: DocxProposalOutcome::Withdrawn
                                    | DocxProposalOutcome::Rejected
                            }
                        )
                });
                if withdrawn
                    || (matches!(
                        source.event,
                        DocxActivityEvent::Outcome {
                            outcome: DocxProposalOutcome::Recovered { .. }
                        }
                    ) && source.document.session_revision != from_document.session_revision)
                {
                    return Err(
                        "The recovered source was edited or withdrawn before this checkpoint."
                            .into(),
                    );
                }
            }
            DocxProposalOutcome::Saved {
                request_id,
                content_sha256,
            } => {
                validate_text(request_id, "DOCX save request", 1, 512)?;
                sha256(content_sha256)?;
                let applied =
                    applied.ok_or("Only an applied DOCX proposal can have a save receipt.")?;
                if closed
                    || recovered.is_some_and(|receipt| matches!(&receipt.event,
                        DocxActivityEvent::Outcome { outcome: DocxProposalOutcome::Recovered { content_sha256: hash, .. } } if hash != content_sha256))
                    || (recovered.is_some()
                        && document.saved_revision != applied.document.session_revision as i64)
                    || document.saved_revision < applied.document.session_revision as i64
                    || document.source_sha256 != *content_sha256
                    || document.baseline_id == applied.document.baseline_id
                {
                    return Err("This save does not include the applied DOCX revision.".into());
                }
                for receipt in &previous {
                    if let DocxActivityEvent::Outcome {
                        outcome:
                            DocxProposalOutcome::Saved {
                                content_sha256: hash,
                                ..
                            },
                    } = &receipt.event
                    {
                        if receipt.document.baseline_id == document.baseline_id {
                            if hash == content_sha256
                                && receipt.document.saved_revision == document.saved_revision
                            {
                                return Ok(receipt.clone());
                            }
                            return Err("This DOCX baseline already has a different saved content or revision.".into());
                        }
                    }
                }
            }
            DocxProposalOutcome::Applied | DocxProposalOutcome::Rejected
                if applied.is_some() || closed =>
            {
                return Err("The DOCX proposal already has a terminal decision.".into());
            }
            DocxProposalOutcome::Withdrawn if closed => {
                return Err("The DOCX proposal is already closed.".into());
            }
            DocxProposalOutcome::Applied
                if document.session_revision <= proposal.document.session_revision =>
            {
                return Err("An applied DOCX proposal must advance the session revision.".into());
            }
            _ => {}
        }
        let activity = DocxActivity {
            id: fresh_id("docx"),
            origin: proposal.origin,
            document,
            proposal_id: Some(proposal_id.into()),
            event: DocxActivityEvent::Outcome { outcome },
            created_at: now_ms(),
        };
        insert_on(&tx, &activity)?;
        tx.commit().map_err(store_error)?;
        Ok(activity)
    }

    /// Validate a checkpoint's exact accepted/recovered source without inferring
    /// authorship from text. The native recovery store owns the byte association.
    pub fn docx_applied_source(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        proposal_id: &str,
        document: &DocxDocumentIdentity,
    ) -> Result<DocxActivity, String> {
        document_scope(project_id, document)?;
        let connection = self.open()?;
        let proposal = proposal_on(&connection, project_id, workbench_project_id, proposal_id)?
            .ok_or("The checkpoint proposal is not retained in this manuscript.")?;
        let rows = connection
            .prepare(&format!(
            "SELECT e.event_json FROM research_task_events e WHERE {DOCX_FILTER} AND e.task_id=?1
             AND json_extract(e.event_json,'$.observation.activity.proposalId')=?2 ORDER BY e.rowid"
        ))
            .and_then(|mut query| {
                query
                    .query_map(params![proposal.origin.task_id, proposal_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        for encoded in rows {
            let receipt = decode_activity(&encoded)?;
            if receipt.document == *document
                && matches!(
                    receipt.event,
                    DocxActivityEvent::Outcome {
                        outcome: DocxProposalOutcome::Applied
                            | DocxProposalOutcome::Recovered { .. }
                    }
                )
            {
                return Ok(receipt);
            }
        }
        Err(
            "The checkpoint source does not match an exact retained application or recovery."
                .into(),
        )
    }

    pub fn docx_proposal(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        proposal_id: &str,
    ) -> Result<Option<DocxActivity>, String> {
        proposal_on(&self.open()?, project_id, workbench_project_id, proposal_id)
    }

    /// Cursor is a never-reused activity insertion identity, scoped by both app
    /// and Workbench projects. Read exact proposal contents with docx_proposal.
    pub fn docx_activities(
        &self,
        project_id: &str,
        workbench_project_id: &str,
        after_cursor: u64,
        limit: usize,
    ) -> Result<DocxActivityPage, String> {
        self.docx_activity_page(
            project_id,
            Some(workbench_project_id),
            None,
            after_cursor,
            limit,
        )
    }

    /// Task tools use this narrower view instead of the manuscript-wide UI view.
    pub fn docx_task_activities(
        &self,
        project_id: &str,
        task_id: &str,
        after_cursor: u64,
        limit: usize,
    ) -> Result<DocxActivityPage, String> {
        self.docx_activity_page(project_id, None, Some(task_id), after_cursor, limit)
    }

    fn docx_activity_page(
        &self,
        project_id: &str,
        workbench_project_id: Option<&str>,
        task_id: Option<&str>,
        after_cursor: u64,
        limit: usize,
    ) -> Result<DocxActivityPage, String> {
        if after_cursor > i64::MAX as u64 || !(1..=50).contains(&limit) {
            return Err("Use a nonnegative DOCX cursor and a limit between 1 and 50.".into());
        }
        let connection = self.open()?;
        if let Some(task_id) = task_id {
            if Self::require_on(&connection, task_id)?.project_id != project_id {
                return Err("This DOCX history belongs to another application project.".into());
            }
        }
        let rows = connection.prepare(&format!(
            "SELECT c.cursor,e.event_json FROM research_task_docx_cursors c
             JOIN research_task_events e ON e.task_id=c.task_id AND e.execution_generation=c.generation AND e.sequence=c.sequence
             JOIN research_tasks t ON t.id=e.task_id
             WHERE {DOCX_FILTER} AND t.project_id=?1 AND c.cursor>?3
             AND (?2 IS NULL OR json_extract(e.event_json,'$.observation.activity.document.workbenchProjectId')=?2)
             AND (?5 IS NULL OR e.task_id=?5)
             ORDER BY c.cursor LIMIT ?4"
        )).and_then(|mut statement| statement.query_map(params![project_id, workbench_project_id, after_cursor as i64, (limit + 1) as i64, task_id], |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()).map_err(store_error)?;
        let has_more = rows.len() > limit;
        let activities = rows
            .into_iter()
            .take(limit)
            .map(|(cursor, encoded)| {
                Ok(DocxActivityEntry {
                    cursor,
                    activity: decode_activity(&encoded)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let next_cursor = activities.last().map_or(after_cursor, |entry| entry.cursor);
        Ok(DocxActivityPage {
            activities,
            next_cursor,
            has_more,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::{GroupActor, MemberDraft, MessageDraft};

    fn document() -> DocxDocumentIdentity {
        DocxDocumentIdentity {
            session_id: "docx-session".into(),
            app_project_id: "paper".into(),
            workbench_project_id: "manuscript".into(),
            baseline_id: "baseline-1".into(),
            source_sha256: "a".repeat(64),
            filename: Some("paper.docx".into()),
            title: None,
            session_revision: 5,
            saved_revision: 0,
        }
    }

    fn proposal() -> DocxRuntimeEvent {
        DocxRuntimeEvent::Proposed {
            target: DocxTarget {
                target_id: "target".into(),
                paragraph_ref: "p1".into(),
                revision: 5,
                original: "原始段落".into(),
                para_id: Some("para1".into()),
                structure: Some("plain-text".into()),
            },
            proposed: "Revised paragraph".into(),
        }
    }

    #[test]
    fn operation_receipts_require_an_explicit_matching_status() {
        let document = document();
        let event = |result: serde_json::Value| DocxRuntimeEvent::Operation {
            operation_id: None,
            operation: "format".into(),
            request: serde_json::json!({"paragraph_ref":"p1"}),
            result,
        };

        assert!(runtime_event(
            &document,
            &event(serde_json::json!({"operation":"format","ok":false}))
        )
        .is_ok());
        assert!(
            runtime_event(&document, &event(serde_json::json!({"operation":"format"}))).is_err()
        );
        assert!(runtime_event(
            &document,
            &event(serde_json::json!({"operation":"apply","ok":true}))
        )
        .is_err());
        assert!(runtime_event(
            &document,
            &DocxRuntimeEvent::OperationStarted {
                operation: "format".into(),
                request: serde_json::json!({"paragraph_ref":"p1"}),
            }
        )
        .is_ok());
    }

    fn fixture() -> (tempfile::TempDir, TaskStore, ResearchTask) {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Revise DOCX".into(),
                prompt: "Review the bound paragraph".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        (directory, store, task)
    }

    fn start(store: &TaskStore, task: &ResearchTask) -> ResearchTask {
        store.request_start(&task.id).unwrap();
        store.claim_next().unwrap().unwrap()
    }

    fn running() -> (tempfile::TempDir, TaskStore, ResearchTask) {
        let (directory, store, task) = fixture();
        store.bind_docx_task("paper", &task.id, document()).unwrap();
        let task = start(&store, &task);
        (directory, store, task)
    }

    fn start_operation(
        store: &TaskStore,
        task: &ResearchTask,
        operation: &str,
        request: serde_json::Value,
    ) -> DocxActivity {
        store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::OperationStarted {
                    operation: operation.into(),
                    request,
                },
            )
            .unwrap()
    }

    fn operation_envelope(
        operation: &str,
        document: DocxDocumentIdentity,
        result: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "operation": operation,
            "ok": true,
            "document": document,
            "result": result,
        })
    }

    fn propose(store: &TaskStore, task: &ResearchTask) -> DocxActivity {
        let DocxRuntimeEvent::Proposed { target, .. } = proposal() else {
            unreachable!()
        };
        store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::Captured { target },
            )
            .unwrap();
        store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                proposal(),
            )
            .unwrap()
    }

    fn outcome(
        store: &TaskStore,
        proposal: &DocxActivity,
        document: DocxDocumentIdentity,
        outcome: DocxProposalOutcome,
    ) -> Result<DocxActivity, String> {
        store.record_docx_proposal_outcome("paper", "manuscript", &proposal.id, document, outcome)
    }

    #[test]
    fn docx_binding_is_explicit_immutable_and_precedes_first_execution() {
        let (_directory, store, task) = fixture();
        assert!(store
            .docx_task_binding("paper", &task.id)
            .unwrap()
            .is_none());
        assert!(store.bind_docx_task("other", &task.id, document()).is_err());
        store.bind_docx_task("paper", &task.id, document()).unwrap();
        store.bind_docx_task("paper", &task.id, document()).unwrap();
        assert_eq!(
            store
                .docx_activities("paper", "manuscript", 0, 50)
                .unwrap()
                .activities
                .len(),
            1
        );
        let mut changed = document();
        changed.session_id = "different".into();
        assert!(store.bind_docx_task("paper", &task.id, changed).is_err());
        let bound = store.docx_task_binding("paper", &task.id).unwrap().unwrap();
        assert_eq!(bound, document());
        let task = start(&store, &task);
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::Bound
            )
            .is_err());
        let (_directory2, other_store, unbound) = fixture();
        let unbound = start(&other_store, &unbound);
        assert!(other_store
            .bind_docx_task("paper", &unbound.id, document())
            .is_err());
        assert!(other_store
            .record_docx_activity(
                "paper",
                &unbound.id,
                unbound.execution_generation,
                document(),
                proposal()
            )
            .is_err());
    }

    #[test]
    fn docx_single_task_has_no_invented_member_and_reopens_exact_history() {
        let (_directory, store, task) = running();
        let proposed = propose(&store, &task);
        let encoded = serde_json::json!({
            "kind": "observation", "observation": { "type": "docx", "activity": proposed.clone() }
        });
        assert_eq!(decode_activity(&encoded.to_string()).unwrap(), proposed);
        let observation = TaskRuntimeEvent::Observation {
            observation: TaskObservation::Docx {
                activity: Box::new(proposed.clone()),
            },
        };
        assert_eq!(serde_json::to_value(observation).unwrap(), encoded);
        assert_eq!(proposed.origin.task_id, task.id);
        assert_eq!(proposed.origin.generation, task.execution_generation);
        assert_eq!(
            (
                proposed.origin.group_id.clone(),
                proposed.origin.member_id.clone(),
                proposed.origin.execution_id.clone()
            ),
            (None, None, None)
        );
        assert!(proposed.origin.work_ids.is_empty());
        assert!(proposed.proposal_id.is_none());
        assert_ne!(proposed.id, "target");
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        assert_eq!(
            reopened
                .docx_proposal("paper", "manuscript", &proposed.id)
                .unwrap(),
            Some(proposed.clone())
        );
        let first = reopened
            .docx_activities("paper", "manuscript", 0, 2)
            .unwrap();
        assert!(first.has_more);
        let next = reopened
            .docx_activities("paper", "manuscript", first.next_cursor, 1)
            .unwrap();
        assert_eq!(next.activities[0].activity, proposed);
        assert!(!next.has_more);
        assert!(reopened
            .docx_activities("other", "manuscript", 0, 50)
            .unwrap()
            .activities
            .is_empty());
        assert!(reopened
            .docx_activities("paper", "other", 0, 50)
            .unwrap()
            .activities
            .is_empty());
        assert!(reopened
            .docx_activities("paper", "manuscript", 0, 51)
            .is_err());
    }

    #[test]
    fn docx_group_origin_uses_real_execution_and_all_claimed_work() {
        let (_directory, store, task) = running();
        let group = store
            .create_task_group(
                "paper",
                Some(&task.id),
                &[MemberDraft {
                    name: "Editor".into(),
                    responsibility: "Revise the paragraph".into(),
                    runtime_id: "fixture".into(),
                    agent_id: "fixture".into(),
                    model_id: "fixture".into(),
                    skill_ids: Vec::new(),
                    coordinator: true,
                }],
            )
            .unwrap();
        // Group membership alone is not a running member identity.
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        for body in ["Revise introduction", "Check wording"] {
            store
                .group_message(
                    "paper",
                    &group.group.id,
                    &GroupActor::user(),
                    &MessageDraft {
                        body: body.into(),
                        recipients: vec![group.members[0].id.clone()],
                        request_work: true,
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let turn = store.claim_member_turn(&task).unwrap().unwrap();
        let proposed = propose(&store, &task);
        assert_eq!(
            proposed.origin.group_id.as_deref(),
            Some(group.group.id.as_str())
        );
        assert_eq!(
            proposed.origin.member_id.as_deref(),
            Some(turn.member.id.as_str())
        );
        assert_eq!(
            proposed.origin.execution_id.as_deref(),
            Some(turn.execution.id.as_str())
        );
        let mut expected = turn
            .work
            .iter()
            .map(|work| work.id.clone())
            .collect::<Vec<_>>();
        expected.sort();
        assert!(expected.len() >= 2);
        assert_eq!(proposed.origin.work_ids, expected);
        // Simulate a damaged/imported store; the normal schema already prevents
        // this state with collaboration_one_execution.
        store
            .open()
            .unwrap()
            .execute_batch("DROP INDEX collaboration_one_execution")
            .unwrap();
        store.open().unwrap().execute(
            "INSERT INTO collaboration_executions(id,group_id,member_id,task_generation,session_id,runtime_id,agent_id,model_id,status,started_at)
             SELECT id||'-duplicate',group_id,member_id,task_generation,session_id||'-duplicate',runtime_id,agent_id,model_id,status,started_at
             FROM collaboration_executions WHERE id=?1", [&turn.execution.id],
        ).unwrap();
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::Read {
                    offset: 0,
                    paragraphs: Vec::new()
                }
            )
            .is_err());
    }

    #[test]
    fn operation_finish_is_durable_after_cancellation_and_idempotent() {
        let (_directory, store, task) = running();
        let intent = start_operation(
            &store,
            &task,
            "format",
            serde_json::json!({"paragraph_ref":"p1"}),
        );
        store.request_cancel(&task.id).unwrap();
        let mut actual = document();
        actual.session_revision = 6;
        let result = operation_envelope(
            "format",
            actual.clone(),
            serde_json::json!({"ok":true,"revision":6,"changed":true}),
        );
        let finished = store
            .finish_docx_operation(
                "paper",
                "manuscript",
                &intent.id,
                actual.clone(),
                result.clone(),
            )
            .unwrap();
        assert_eq!(finished.origin, intent.origin);
        assert_eq!(finished.document, actual);
        assert!(matches!(
            &finished.event,
            DocxActivityEvent::Runtime {
                event: DocxRuntimeEvent::Operation {
                    operation_id: Some(id),
                    operation,
                    ..
                }
            } if id == &intent.id && operation == "format"
        ));
        assert_eq!(
            store
                .finish_docx_operation("paper", "manuscript", &intent.id, actual.clone(), result)
                .unwrap(),
            finished
        );
        let mut conflict = actual.clone();
        conflict.session_revision = 7;
        assert!(store
            .finish_docx_operation(
                "paper",
                "manuscript",
                &intent.id,
                conflict.clone(),
                operation_envelope(
                    "format",
                    conflict,
                    serde_json::json!({"ok":true,"revision":7,"changed":true}),
                ),
            )
            .is_err());
        assert!(store
            .finish_docx_operation(
                "paper",
                "manuscript",
                "missing-intent",
                actual.clone(),
                operation_envelope("format", actual, serde_json::json!({"ok":true})),
            )
            .is_err());
    }

    #[test]
    fn operation_results_are_compacted_without_losing_exact_idempotency() {
        let (_directory, store, task) = running();
        let format = start_operation(
            &store,
            &task,
            "format",
            serde_json::json!({"paragraph_ref":"p1"}),
        );
        let format_result = operation_envelope(
            "format",
            document(),
            serde_json::json!({"ok":true,"revision":5,"changed":true}),
        );
        let first = store
            .finish_docx_operation(
                "paper",
                "manuscript",
                &format.id,
                document(),
                format_result.clone(),
            )
            .unwrap();
        let mut with_checkpoint = format_result;
        with_checkpoint["checkpoint"] = serde_json::json!({"status":"failed","error":"disk full"});
        assert_eq!(
            store
                .finish_docx_operation(
                    "paper",
                    "manuscript",
                    &format.id,
                    document(),
                    with_checkpoint,
                )
                .unwrap(),
            first
        );

        let read = start_operation(
            &store,
            &task,
            "read_format",
            serde_json::json!({"query":{"kind":"objects"}}),
        );
        let read_envelope = operation_envelope(
            "read_format",
            document(),
            serde_json::json!({
                "sourceSha256":"b".repeat(64),
                "revision":5,
                "objects":vec![serde_json::json!({"large":"x".repeat(100_000)})],
                "total":500,
                "nextOffset":1,
            }),
        );
        store
            .finish_docx_operation("paper", "manuscript", &read.id, document(), read_envelope)
            .unwrap();

        let check = start_operation(
            &store,
            &task,
            "check",
            serde_json::json!({"template":"world-7"}),
        );
        let check_envelope = operation_envelope(
            "check",
            document(),
            serde_json::json!({
                "template":"world-7",
                "check":{
                    "check_id":"check-7","project_id":"manuscript","baseline_id":"baseline-1",
                    "world_version_id":"world-7","summary":{"PASS":3,"FAIL":1},
                    "validity":"CURRENT","source_sha256":"c".repeat(64),"snapshot_sha256":"d".repeat(64),
                    "world":{"large":"x".repeat(100_000)},
                    "rule_results":vec![serde_json::json!({"findings":[1,2,3]})],
                },
            }),
        );
        let projected = operation_envelope(
            "check",
            document(),
            serde_json::json!({
                "template":"world-7",
                "check":{
                    "check_id":"check-7","project_id":"manuscript","baseline_id":"baseline-1",
                    "world_version_id":"world-7","summary":{"PASS":3,"FAIL":1},
                },
            }),
        );
        let check_activity = store
            .finish_docx_operation("paper", "manuscript", &check.id, document(), check_envelope)
            .unwrap();
        assert_eq!(
            store
                .finish_docx_operation("paper", "manuscript", &check.id, document(), projected,)
                .unwrap(),
            check_activity
        );
        let history = store
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap();
        let retained_read = history.activities.iter().find_map(|entry| {
            if let DocxActivityEvent::Runtime {
                event:
                    DocxRuntimeEvent::Operation {
                        operation_id: Some(id),
                        result,
                        ..
                    },
            } = &entry.activity.event
            {
                (id == &read.id).then_some(result)
            } else {
                None
            }
        });
        assert_eq!(
            retained_read,
            Some(&serde_json::json!({
                "operation":"read_format","ok":true,"document":document(),
                "result":{"sourceSha256":"b".repeat(64),"revision":5,"nextOffset":1,"total":500}
            }))
        );
        let retained_check = history.activities.iter().find_map(|entry| {
            if let DocxActivityEvent::Runtime {
                event:
                    DocxRuntimeEvent::Operation {
                        operation_id: Some(id),
                        result,
                        ..
                    },
            } = &entry.activity.event
            {
                (id == &check.id).then_some(result)
            } else {
                None
            }
        });
        assert_eq!(
            retained_check.unwrap()["result"]["check"],
            serde_json::json!({
                "check_id":"check-7","project_id":"manuscript","baseline_id":"baseline-1",
                "world_version_id":"world-7","summary":{"PASS":3,"FAIL":1}
            })
        );
    }

    #[test]
    fn docx_runtime_rejects_scope_stale_generation_cancel_and_oversized_reads_without_events() {
        let (_directory, store, task) = running();
        let mut wrong_session = document();
        wrong_session.session_id = "other".into();
        let mut wrong_manuscript = document();
        wrong_manuscript.workbench_project_id = "other".into();
        for document in [wrong_session, wrong_manuscript] {
            assert!(store
                .record_docx_activity(
                    "paper",
                    &task.id,
                    task.execution_generation,
                    document,
                    proposal()
                )
                .is_err());
        }
        assert!(store
            .record_docx_activity(
                "other",
                &task.id,
                task.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation + 1,
                document(),
                proposal()
            )
            .is_err());
        let paragraph = DocxParagraph {
            paragraph_ref: "p1".into(),
            text: "x".into(),
            para_id: None,
        };
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::Read {
                    offset: 0,
                    paragraphs: vec![paragraph; 51]
                }
            )
            .is_err());
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                DocxRuntimeEvent::Read {
                    offset: 0,
                    paragraphs: vec![DocxParagraph {
                        paragraph_ref: "p1".into(),
                        text: "x".repeat(MAX_DOCX_TEXT_BYTES + 1),
                        para_id: None
                    }]
                }
            )
            .is_err());
        store.request_cancel(&task.id).unwrap();
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        assert_eq!(
            store
                .docx_activities("paper", "manuscript", 0, 50)
                .unwrap()
                .activities
                .len(),
            1
        );
    }

    #[test]
    fn docx_proposal_results_inherit_original_generation_after_task_finishes_and_are_idempotent() {
        let (_directory, store, task) = running();
        let proposed = propose(&store, &task);
        store
            .finish_success(
                &task.id,
                task.execution_generation,
                &TaskResultMetadata {
                    summary: "Proposed a revision".into(),
                    changed_files: Vec::new(),
                    artifacts: Vec::new(),
                    native_session_id: None,
                    input_tokens: None,
                    output_tokens: None,
                },
            )
            .unwrap();
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        let mut applied_document = document();
        applied_document.session_revision = 6;
        assert!(outcome(&store, &proposed, document(), DocxProposalOutcome::Applied).is_err());
        let applied = outcome(
            &store,
            &proposed,
            applied_document.clone(),
            DocxProposalOutcome::Applied,
        )
        .unwrap();
        assert_eq!(applied.origin, proposed.origin);
        assert_eq!(
            outcome(
                &store,
                &proposed,
                applied_document.clone(),
                DocxProposalOutcome::Applied
            )
            .unwrap(),
            applied
        );
        applied_document.session_revision = 7;
        assert!(outcome(
            &store,
            &proposed,
            applied_document,
            DocxProposalOutcome::Applied
        )
        .is_err());
        assert!(outcome(&store, &proposed, document(), DocxProposalOutcome::Rejected).is_err());
        let mut saved_document = document();
        saved_document.session_revision = 8;
        saved_document.saved_revision = 6;
        saved_document.baseline_id = "baseline-2".into();
        saved_document.source_sha256 = "b".repeat(64);
        let save = DocxProposalOutcome::Saved {
            request_id: "save-1".into(),
            content_sha256: "b".repeat(64),
        };
        let mut invalid = saved_document.clone();
        invalid.saved_revision = 5;
        assert!(outcome(&store, &proposed, invalid, save.clone()).is_err());
        let mut invalid = saved_document.clone();
        invalid.baseline_id = "baseline-1".into();
        assert!(outcome(&store, &proposed, invalid, save.clone()).is_err());
        let mut invalid = saved_document.clone();
        invalid.source_sha256 = "c".repeat(64);
        assert!(outcome(&store, &proposed, invalid, save.clone()).is_err());
        let saved = outcome(&store, &proposed, saved_document.clone(), save.clone()).unwrap();
        assert_eq!(
            outcome(&store, &proposed, saved_document.clone(), save).unwrap(),
            saved
        );
        assert_eq!(
            outcome(
                &store,
                &proposed,
                saved_document.clone(),
                DocxProposalOutcome::Saved {
                    request_id: "retry".into(),
                    content_sha256: "b".repeat(64)
                }
            )
            .unwrap(),
            saved
        );
        saved_document.source_sha256 = "c".repeat(64);
        assert!(outcome(
            &store,
            &proposed,
            saved_document.clone(),
            DocxProposalOutcome::Saved {
                request_id: "contradictory-baseline".into(),
                content_sha256: "c".repeat(64)
            },
        )
        .is_err());
        assert!(outcome(
            &store,
            &proposed,
            saved_document,
            DocxProposalOutcome::Saved {
                request_id: "save-1".into(),
                content_sha256: "c".repeat(64)
            }
        )
        .is_err());
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let history = reopened
            .docx_activities("paper", "manuscript", 0, 50)
            .unwrap();
        assert_eq!(history.activities.len(), 5);
        let rows = reopened
            .observation_event("paper", &task.id, task.execution_generation, 1)
            .unwrap()
            .unwrap();
        assert!(store
            .replace_event(
                &task.id,
                task.execution_generation,
                rows.sequence,
                &rows.event
            )
            .is_err());
    }

    #[test]
    fn docx_unknown_foreign_closed_and_unapplied_proposals_cannot_claim_success() {
        let (_directory, store, task) = running();
        let proposed = propose(&store, &task);
        assert!(store
            .record_docx_proposal_outcome(
                "other",
                "manuscript",
                &proposed.id,
                document(),
                DocxProposalOutcome::Applied
            )
            .is_err());
        assert!(store
            .record_docx_proposal_outcome(
                "paper",
                "other",
                &proposed.id,
                document(),
                DocxProposalOutcome::Applied
            )
            .is_err());
        assert!(store
            .record_docx_proposal_outcome(
                "paper",
                "manuscript",
                "forged",
                document(),
                DocxProposalOutcome::Applied
            )
            .is_err());
        let mut other_session = document();
        other_session.session_id = "other".into();
        assert!(outcome(
            &store,
            &proposed,
            other_session,
            DocxProposalOutcome::Applied
        )
        .is_err());
        assert!(outcome(
            &store,
            &proposed,
            document(),
            DocxProposalOutcome::Saved {
                request_id: "save".into(),
                content_sha256: "a".repeat(64)
            }
        )
        .is_err());
        let rejected =
            outcome(&store, &proposed, document(), DocxProposalOutcome::Rejected).unwrap();
        assert_eq!(
            outcome(&store, &proposed, document(), DocxProposalOutcome::Rejected).unwrap(),
            rejected
        );
        assert!(outcome(&store, &proposed, document(), DocxProposalOutcome::Applied).is_err());
        assert_eq!(
            store
                .docx_activities("paper", "manuscript", 0, 50)
                .unwrap()
                .activities
                .len(),
            4
        );
    }

    #[test]
    fn docx_bound_session_can_save_and_advance_baseline_and_read_windows() {
        let (_directory, store, task) = running();
        let mut advanced = document();
        advanced.baseline_id = "baseline-2".into();
        advanced.source_sha256 = "b".repeat(64);
        advanced.session_revision = 7;
        advanced.saved_revision = 6;
        let event = DocxRuntimeEvent::Read {
            offset: 25,
            paragraphs: vec![DocxParagraph {
                paragraph_ref: "p26".into(),
                text: "Exact live text".into(),
                para_id: None,
            }],
        };
        let activity = store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                advanced.clone(),
                event.clone(),
            )
            .unwrap();
        assert_eq!(activity.document, advanced);
        assert_eq!(activity.event, DocxActivityEvent::Runtime { event });
        assert_eq!(
            store.docx_task_binding("paper", &task.id).unwrap(),
            Some(document())
        );
        assert!(serde_json::from_value::<DocxRuntimeEvent>(serde_json::json!({"kind":"proposed", "target":{}, "proposed":"x", "executionId":"forged"})).is_err());
    }

    #[test]
    fn docx_task_history_and_capture_cannot_cross_tasks_in_the_same_manuscript() {
        let (_directory, store, task) = running();
        assert!(store
            .record_docx_activity(
                "paper",
                &task.id,
                task.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        let proposed = propose(&store, &task);
        let other = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Another task".into(),
                prompt: "Other work".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        store
            .bind_docx_task("paper", &other.id, document())
            .unwrap();
        let other = start(&store, &other);
        assert!(store
            .record_docx_activity(
                "paper",
                &other.id,
                other.execution_generation,
                document(),
                proposal()
            )
            .is_err());
        let DocxRuntimeEvent::Proposed {
            mut target,
            proposed: text,
        } = proposal()
        else {
            unreachable!()
        };
        store
            .record_docx_activity(
                "paper",
                &other.id,
                other.execution_generation,
                document(),
                DocxRuntimeEvent::Captured {
                    target: target.clone(),
                },
            )
            .unwrap();
        target.original = "forged original".into();
        assert!(store
            .record_docx_activity(
                "paper",
                &other.id,
                other.execution_generation,
                document(),
                DocxRuntimeEvent::Proposed {
                    target,
                    proposed: text
                }
            )
            .is_err());
        let page = store
            .docx_task_activities("paper", &other.id, 0, 50)
            .unwrap();
        assert_eq!(page.activities.len(), 2);
        assert!(page
            .activities
            .iter()
            .all(|entry| entry.activity.origin.task_id == other.id));
        assert!(!page
            .activities
            .iter()
            .any(|entry| entry.activity.id == proposed.id));
        assert!(store
            .docx_task_activities("other", &other.id, 0, 50)
            .is_err());
        assert!(store
            .docx_task_activities("paper", &other.id, 0, 0)
            .is_err());
        let mut applied = document();
        applied.session_revision = 6;
        outcome(&store, &proposed, applied, DocxProposalOutcome::Applied).unwrap();
        let withdrawn = outcome(
            &store,
            &proposed,
            document(),
            DocxProposalOutcome::Withdrawn,
        )
        .unwrap();
        assert_eq!(
            outcome(
                &store,
                &proposed,
                document(),
                DocxProposalOutcome::Withdrawn
            )
            .unwrap(),
            withdrawn
        );
        let mut later = document();
        later.session_revision = 7;
        assert!(outcome(&store, &proposed, later, DocxProposalOutcome::Applied).is_err());
    }

    #[test]
    fn docx_late_result_remains_in_original_generation_after_retry() {
        let (_directory, store, task) = running();
        let proposed = propose(&store, &task);
        store
            .finish_failure(&task.id, task.execution_generation, "provider stopped")
            .unwrap();
        store.retry_with(&task.id, RetryMode::Fresh).unwrap();
        let next = start(&store, &task);
        assert!(next.execution_generation > task.execution_generation);
        let mut applied_document = document();
        applied_document.session_revision = 6;
        let applied = outcome(
            &store,
            &proposed,
            applied_document,
            DocxProposalOutcome::Applied,
        )
        .unwrap();
        assert_eq!(applied.origin, proposed.origin);
        let old = store
            .observations("paper", &task.id, next.execution_generation, 0, 50)
            .unwrap();
        assert!(old.page.events.is_empty());
        let history = store
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap();
        assert_eq!(history.activities.last().unwrap().activity, applied);
    }

    #[test]
    fn docx_recovery_uses_explicit_session_edges_and_local_revisions() {
        let (_directory, store, task) = running();
        let proposed = propose(&store, &task);
        let mut accepted = document();
        accepted.session_revision = 6;
        outcome(
            &store,
            &proposed,
            accepted.clone(),
            DocxProposalOutcome::Applied,
        )
        .unwrap();
        let mut restored = document();
        restored.session_id = "recovered-1".into();
        restored.session_revision = 0;
        restored.saved_revision = -1;
        assert!(outcome(
            &store,
            &proposed,
            restored.clone(),
            DocxProposalOutcome::Withdrawn
        )
        .is_err());
        let edge = DocxProposalOutcome::Recovered {
            recovery_key: "d".repeat(64),
            content_sha256: "e".repeat(64),
            from_document: Box::new(accepted.clone()),
        };
        let recovered = outcome(&store, &proposed, restored.clone(), edge.clone()).unwrap();
        assert_eq!(recovered.origin, proposed.origin);
        assert_eq!(
            outcome(&store, &proposed, restored.clone(), edge.clone()).unwrap(),
            recovered
        );
        assert_eq!(
            store
                .docx_applied_source("paper", "manuscript", &proposed.id, &restored)
                .unwrap(),
            recovered
        );
        let mut another = restored.clone();
        another.session_id = "recovered-2".into();
        assert!(outcome(&store, &proposed, another, edge.clone()).is_ok());
        let mut conflict = edge;
        if let DocxProposalOutcome::Recovered { content_sha256, .. } = &mut conflict {
            *content_sha256 = "f".repeat(64);
        }
        assert!(outcome(&store, &proposed, restored.clone(), conflict).is_err());
        let mut saved = restored.clone();
        saved.saved_revision = 0;
        saved.baseline_id = "baseline-restored".into();
        saved.source_sha256 = "e".repeat(64);
        let save = DocxProposalOutcome::Saved {
            request_id: "restored-save".into(),
            content_sha256: "e".repeat(64),
        };
        assert!(outcome(&store, &proposed, saved.clone(), save.clone()).is_ok());
        saved.session_revision = 1;
        saved.saved_revision = 1;
        assert!(outcome(
            &store,
            &proposed,
            saved,
            DocxProposalOutcome::Saved {
                request_id: "edited-save".into(),
                content_sha256: "e".repeat(64)
            }
        )
        .is_err());
        let mut edited = restored.clone();
        edited.session_revision = 1;
        outcome(
            &store,
            &proposed,
            edited.clone(),
            DocxProposalOutcome::Withdrawn,
        )
        .unwrap();
        let mut third = restored;
        third.session_id = "recovered-3".into();
        assert!(outcome(
            &store,
            &proposed,
            third,
            DocxProposalOutcome::Recovered {
                recovery_key: "a".repeat(64),
                content_sha256: "b".repeat(64),
                from_document: Box::new(edited),
            }
        )
        .is_err());
    }

    #[test]
    fn docx_cursor_survives_deleting_last_task_and_binding_another_after_reopen() {
        let (_directory, store, task) = fixture();
        store.bind_docx_task("paper", &task.id, document()).unwrap();
        let before = store.docx_activities("paper", "manuscript", 0, 50).unwrap();
        let cursor = before.next_cursor;
        assert_eq!(before.activities.len(), 1);
        store.delete(&task.id).unwrap();
        let connection = store.open().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM research_task_docx_cursors",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM research_task_events", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
        drop(connection);

        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let next = reopened
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Next DOCX task".into(),
                prompt: "Review the same working copy".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        reopened
            .bind_docx_task("paper", &next.id, document())
            .unwrap();
        let page = reopened
            .docx_activities("paper", "manuscript", cursor, 50)
            .unwrap();
        assert_eq!(page.activities.len(), 1);
        assert_eq!(page.activities[0].activity.origin.task_id, next.id);
        assert!(page.activities[0].cursor > cursor);
        let task = start(&reopened, &next);
        let proposed = propose(&reopened, &task);
        let following = reopened
            .docx_activities("paper", "manuscript", page.next_cursor, 50)
            .unwrap();
        assert_eq!(following.activities.len(), 2);
        assert_eq!(following.activities.last().unwrap().activity, proposed);
    }

    #[test]
    fn docx_schema_fifteen_backfills_sparse_cursors_without_changing_events_or_old_cursor() {
        let (_directory, store, task) = running();
        store
            .append_event(
                &task.id,
                task.execution_generation,
                &TaskRuntimeEvent::Observation {
                    observation: TaskObservation::Usage {
                        input_tokens: Some(1),
                        output_tokens: None,
                    },
                },
            )
            .unwrap();
        let proposed = propose(&store, &task);
        let connection = store.open().unwrap();
        let original = connection
            .prepare("SELECT rowid,event_json FROM research_task_events ORDER BY rowid")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let old_cursor = original.last().unwrap().0 as u64;
        connection
            .execute_batch("DROP TABLE research_task_docx_cursors; PRAGMA user_version=15;")
            .unwrap();
        drop(connection);

        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        let connection = reopened.open().unwrap();
        assert_eq!(schema_version(&connection).unwrap(), 16);
        let retained = connection
            .prepare("SELECT rowid,event_json FROM research_task_events ORDER BY rowid")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(retained, original);
        let columns = connection
            .prepare("PRAGMA table_info(research_task_docx_cursors)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(columns, ["cursor", "task_id", "generation", "sequence"]);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM research_task_docx_cursors",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        drop(connection);
        let history = reopened
            .docx_task_activities("paper", &task.id, 0, 50)
            .unwrap();
        assert_eq!(history.activities.len(), 3);
        assert_eq!(history.next_cursor, old_cursor);
        assert_eq!(history.activities.last().unwrap().activity, proposed);
        let mut document = document();
        document.session_revision = 6;
        let applied =
            outcome(&reopened, &proposed, document, DocxProposalOutcome::Applied).unwrap();
        let later = reopened
            .docx_task_activities("paper", &task.id, old_cursor, 50)
            .unwrap();
        assert_eq!(later.activities.len(), 1);
        assert_eq!(later.activities[0].activity, applied);
        assert!(later.next_cursor > old_cursor);
        let again = TaskStore::new(store.root().to_path_buf()).unwrap();
        assert_eq!(
            again
                .docx_task_activities("paper", &task.id, 0, 50)
                .unwrap()
                .activities
                .len(),
            4
        );
    }
}
