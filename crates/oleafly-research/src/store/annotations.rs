use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::{decode_json, encode_json, fresh_id, store_error, TaskStore};
use crate::annotations::{
    now, require_text, Annotation, AnnotationAuthor, AnnotationDelivery, AnnotationDraft,
    AnnotationHandling, AnnotationHandlingDraft, AnnotationQuery, AnnotationStatus,
    AnnotationStatusChange, AnnotationTarget, Distillation, DistillationDraft, DistillationOutcome,
    EnduringRequirement, RequirementDraft, RequirementKind, RequirementStatus,
};
use crate::model::{PendingStart, ResearchTask, ResumeReason};

/// Added by the parent TaskStore migration. Annotation facts deliberately have
/// no cascading task foreign key: deleting a task must not erase an old user
/// instruction or a still-applicable project requirement.
pub(super) const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS research_task_annotations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_id TEXT,
      object_kind TEXT NOT NULL,
      object_id TEXT NOT NULL,
      status TEXT NOT NULL,
      annotation_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_task_annotations_target
      ON research_task_annotations(project_id, object_kind, object_id, sequence);
    CREATE INDEX IF NOT EXISTS research_task_annotations_active
      ON research_task_annotations(project_id, status, task_id, sequence);
    CREATE TABLE IF NOT EXISTS research_task_annotation_work (
      annotation_id TEXT PRIMARY KEY REFERENCES research_task_annotations(id),
      task_id TEXT NOT NULL,
      delivered_generation INTEGER,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS research_task_annotation_work_pending
      ON research_task_annotation_work(task_id, delivered_generation);
    CREATE TABLE IF NOT EXISTS research_task_annotation_status_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      annotation_id TEXT NOT NULL REFERENCES research_task_annotations(id),
      change_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_task_annotation_status_history
      ON research_task_annotation_status_changes(annotation_id, sequence);
    CREATE TABLE IF NOT EXISTS research_task_annotation_handlings (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      annotation_id TEXT NOT NULL REFERENCES research_task_annotations(id),
      handling_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_task_annotation_handling_history
      ON research_task_annotation_handlings(annotation_id, sequence);
    CREATE TABLE IF NOT EXISTS research_task_requirements (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      requirement_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_task_requirements_active
      ON research_task_requirements(project_id, status, kind, task_id, sequence);
    CREATE TABLE IF NOT EXISTS research_task_distillations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      source_annotation_id TEXT NOT NULL REFERENCES research_task_annotations(id),
      handling_id TEXT NOT NULL REFERENCES research_task_annotation_handlings(id),
      distillation_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_task_distillation_history
      ON research_task_distillations(source_annotation_id, sequence);
";

pub(super) fn handlings_on(
    connection: &Connection,
    annotation: &str,
) -> Result<Vec<AnnotationHandling>, String> {
    connection.prepare("SELECT handling_json FROM research_task_annotation_handlings WHERE annotation_id=?1 ORDER BY sequence")
        .and_then(|mut statement| statement.query_map([annotation], |row| row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>())
        .map_err(store_error)?.into_iter().map(|json|decode_json(&json,"annotation handling")).collect()
}

fn task_project_matches(
    connection: &Connection,
    project_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    if let Some(task_id) = task_id {
        let project: Option<String> = connection
            .query_row(
                "SELECT project_id FROM research_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if project.as_deref() != Some(project_id) {
            return Err("The annotation task is outside the selected project.".into());
        }
    }
    Ok(())
}

fn load_annotation(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<Annotation, String> {
    let json = connection
        .query_row(
            "SELECT annotation_json FROM research_task_annotations WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(store_error)?
        .ok_or("The annotation is outside the selected project.")?;
    decode_json(&json, "annotation")
}

fn load_requirement(
    connection: &Connection,
    project_id: &str,
    id: &str,
) -> Result<EnduringRequirement, String> {
    let json = connection
        .query_row(
            "SELECT requirement_json FROM research_task_requirements WHERE id = ?1 AND project_id = ?2",
            params![id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(store_error)?
        .ok_or("The requirement is outside the selected project.")?;
    decode_json(&json, "requirement")
}

/// The coordinator can add the annotation and its derived work within its
/// existing transaction, then notify after commit. The public convenience
/// method below is for annotations that do not yet dispatch work.
pub(super) fn insert_annotation_on(
    transaction: &Transaction<'_>,
    draft: &AnnotationDraft,
) -> Result<Annotation, String> {
    draft.validate()?;
    task_project_matches(
        transaction,
        &draft.target.project_id,
        draft.target.task_id.as_deref(),
    )?;
    if let Some(parent_id) = &draft.parent_id {
        let parent = load_annotation(transaction, &draft.target.project_id, parent_id)?;
        if parent.target.object_kind != draft.target.object_kind
            || parent.target.object_id != draft.target.object_id
        {
            return Err("Replies must retain the annotated object's identity.".into());
        }
    }
    let created_at = now();
    let mut mentions = Vec::new();
    for mention in &draft.mentions {
        if !mentions.contains(mention) {
            mentions.push(mention.clone());
        }
    }
    let annotation = Annotation {
        id: fresh_id("annotation"),
        target: draft.target.clone(),
        author: draft.author.clone(),
        body: draft.body.clone(),
        source: draft
            .source
            .as_ref()
            .map(|source| crate::annotations::AnnotationSource {
                kind: source.kind.clone(),
                content: source.content.clone(),
                sha256: crate::observations::content_hash(source.content.as_bytes()),
            }),
        parent_id: draft.parent_id.clone(),
        mentions,
        explicit_request: draft.explicit_request,
        status: AnnotationStatus::Open,
        created_at,
        updated_at: created_at,
        handled_at: None,
        handled_by: None,
    };
    transaction
        .execute(
            "INSERT INTO research_task_annotations
             (id, project_id, task_id, object_kind, object_id, status, annotation_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                annotation.id,
                annotation.target.project_id,
                annotation.target.task_id,
                annotation.target.object_kind,
                annotation.target.object_id,
                annotation.status.as_str(),
                encode_json(&annotation)?
            ],
        )
        .map_err(store_error)?;
    Ok(annotation)
}

fn save_annotation(transaction: &Transaction<'_>, annotation: &Annotation) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE research_task_annotations SET status = ?2, annotation_json = ?3 WHERE id = ?1",
            params![
                annotation.id,
                annotation.status.as_str(),
                encode_json(annotation)?
            ],
        )
        .map(|_| ())
        .map_err(store_error)
}

fn record_status_change(
    transaction: &Transaction<'_>,
    annotation_id: &str,
    author: &AnnotationAuthor,
    status: AnnotationStatus,
    reason: &str,
    created_at: i64,
) -> Result<(), String> {
    let change = AnnotationStatusChange {
        id: fresh_id("annotation-status"),
        annotation_id: annotation_id.into(),
        author: author.clone(),
        status,
        reason: reason.into(),
        created_at,
    };
    transaction
        .execute(
            "INSERT INTO research_task_annotation_status_changes
             (id, annotation_id, change_json) VALUES (?1, ?2, ?3)",
            params![change.id, change.annotation_id, encode_json(&change)?],
        )
        .map(|_| ())
        .map_err(store_error)
}

fn insert_requirement_on(
    transaction: &Transaction<'_>,
    draft: &RequirementDraft,
) -> Result<EnduringRequirement, String> {
    draft.validate()?;
    task_project_matches(
        transaction,
        &draft.scope.project_id,
        draft.scope.task_id.as_deref(),
    )?;
    if let Some(source) = &draft.source_annotation_id {
        load_annotation(transaction, &draft.scope.project_id, source)?;
    }
    let created_at = now();
    let requirement = EnduringRequirement {
        id: fresh_id("requirement"),
        scope: draft.scope.clone(),
        author: draft.author.clone(),
        text: draft.text.clone(),
        kind: draft.kind,
        status: RequirementStatus::Active,
        source_annotation_id: draft.source_annotation_id.clone(),
        replaced_by: None,
        created_at,
        updated_at: created_at,
        withdrawn_at: None,
    };
    transaction
        .execute(
            "INSERT INTO research_task_requirements
             (id, project_id, task_id, kind, status, requirement_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                requirement.id,
                requirement.scope.project_id,
                requirement.scope.task_id,
                requirement.kind.as_str(),
                requirement.status.as_str(),
                encode_json(&requirement)?
            ],
        )
        .map_err(store_error)?;
    Ok(requirement)
}

fn save_requirement(
    transaction: &Transaction<'_>,
    requirement: &EnduringRequirement,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE research_task_requirements SET status = ?2, requirement_json = ?3 WHERE id = ?1",
            params![
                requirement.id,
                requirement.status.as_str(),
                encode_json(requirement)?
            ],
        )
        .map(|_| ())
        .map_err(store_error)
}

impl TaskStore {
    /// Save original feedback and any explicit user delegation together. Group
    /// tasks use their existing routing; a single agent needs no group to
    /// receive durable follow-up work.
    pub fn submit_task_annotation(&self, draft: &AnnotationDraft) -> Result<Annotation, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        if let Some(task_id) = &draft.target.task_id {
            task_project_matches(&transaction, &draft.target.project_id, Some(task_id))?;
            let group_id: Option<String> = transaction
                .query_row(
                    "SELECT id FROM collaboration_groups WHERE task_id = ?1",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(store_error)?;
            if let Some(group_id) = group_id {
                transaction.commit().map_err(store_error)?;
                return self.group_annotation(&group_id, draft);
            }
        }
        let annotation = insert_annotation_on(&transaction, draft)?;
        if annotation.is_user_request() {
            if let Some(task_id) = &annotation.target.task_id {
                transaction
                    .execute(
                        "INSERT INTO research_task_annotation_work (annotation_id, task_id)
                         VALUES (?1, ?2)",
                        params![annotation.id, task_id],
                    )
                    .map_err(store_error)?;
            }
        }
        transaction.commit().map_err(store_error)?;
        Ok(annotation)
    }

    /// Read all unresolved requests for the current execution, including old
    /// requests when the user explicitly resumes after an interrupted turn.
    /// First delivery is recorded atomically and does not claim handling;
    /// scheduling another execution remains the reconciler's responsibility.
    pub fn pending_task_annotations(
        &self,
        task_id: &str,
        generation: u64,
        mark_delivered: bool,
    ) -> Result<Vec<Annotation>, String> {
        self.task_annotations(task_id, generation, mark_delivered, mark_delivered)
    }

    /// Consume the automatic attempt without claiming transport delivery. Open
    /// requests remain available to an explicit retry after a startup failure.
    pub fn prepare_task_annotations(
        &self,
        task_id: &str,
        generation: u64,
    ) -> Result<Vec<Annotation>, String> {
        self.task_annotations(task_id, generation, true, false)
    }

    fn task_annotations(
        &self,
        task_id: &str,
        generation: u64,
        prepare: bool,
        mark_delivered: bool,
    ) -> Result<Vec<Annotation>, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let has_work: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM research_task_annotation_work WHERE task_id = ?1)",
                [task_id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if !has_work {
            transaction.commit().map_err(store_error)?;
            return Ok(Vec::new());
        }
        let task = Self::require_on(&transaction, task_id)?;
        if task.execution_generation != generation {
            return Err("Annotation delivery belongs to a different task execution.".into());
        }
        let jsons = transaction
            .prepare(
                "SELECT a.annotation_json FROM research_task_annotation_work w
                 JOIN research_task_annotations a ON a.id = w.annotation_id
                 WHERE w.task_id = ?1 AND a.status = 'open'
                 ORDER BY CASE WHEN json_extract(a.annotation_json, '$.author.kind') = 'user'
                                   AND json_extract(a.annotation_json, '$.explicitRequest') = 1
                               THEN 0 ELSE 1 END, a.sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([task_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        let annotations = jsons
            .iter()
            .map(|json| decode_json::<Annotation>(json, "pending task annotation"))
            .collect::<Result<Vec<_>, _>>()?;
        if prepare {
            let prepared_at = now();
            for annotation in &annotations {
                transaction
                    .execute(
                        "UPDATE research_task_annotation_work
                         SET prepared_generation = ?2, prepared_at = ?3
                         WHERE annotation_id = ?1 AND prepared_generation IS NOT ?2",
                        params![annotation.id, generation, prepared_at],
                    )
                    .map_err(store_error)?;
            }
        }
        if mark_delivered {
            let delivered_at = now();
            for annotation in &annotations {
                transaction
                    .execute(
                        "UPDATE research_task_annotation_work
                         SET delivered_generation = ?2, delivered_at = ?3
                         WHERE annotation_id = ?1 AND delivered_generation IS NULL",
                        params![annotation.id, generation, delivered_at],
                    )
                    .map_err(store_error)?;
            }
        }
        transaction.commit().map_err(store_error)?;
        Ok(annotations)
    }

    /// Record only the annotations in the frame successfully written to ACP.
    /// Cancellation or a failed response never rolls this receipt back.
    pub fn mark_task_annotations_delivered(
        &self,
        task_id: &str,
        generation: u64,
        annotation_ids: &[String],
    ) -> Result<(), String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        if Self::require_on(&transaction, task_id)?.execution_generation != generation {
            return Err("Annotation delivery belongs to a different task execution.".into());
        }
        let delivered_at = now();
        for id in annotation_ids {
            let count = transaction
                .execute(
                    "UPDATE research_task_annotation_work
                     SET delivered_generation = COALESCE(delivered_generation, ?3),
                         delivered_at = COALESCE(delivered_at, ?4)
                     WHERE annotation_id = ?1 AND task_id = ?2
                       AND prepared_generation = ?3",
                    params![id, task_id, generation, delivered_at],
                )
                .map_err(store_error)?;
            if count != 1 {
                return Err("The annotation was not prepared for this task execution.".into());
            }
        }
        transaction.commit().map_err(store_error)
    }

    /// Read the actual single-agent delivery receipts for this project's
    /// task. Handling remains visible on the original annotation record.
    pub fn annotation_deliveries(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Vec<AnnotationDelivery>, String> {
        let connection = self.open()?;
        task_project_matches(&connection, project_id, Some(task_id))?;
        connection
            .prepare(
                "SELECT w.annotation_id, w.delivered_generation, w.delivered_at,
                        w.prepared_generation, w.prepared_at
                 FROM research_task_annotation_work w
                 JOIN research_task_annotations a ON a.id = w.annotation_id
                 WHERE w.task_id = ?1 AND a.project_id = ?2
                 ORDER BY a.sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![task_id, project_id], |row| {
                        Ok(AnnotationDelivery {
                            annotation_id: row.get(0)?,
                            prepared_generation: row.get(3)?,
                            prepared_at: row.get(4)?,
                            delivered_generation: row.get(1)?,
                            delivered_at: row.get(2)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)
    }

    /// Reconcile after save, run completion, or restart. Only undelivered
    /// explicit requests with no attempted execution can start another one.
    /// A startup failure must not repeatedly launch the same configuration.
    pub fn queue_annotation_followups(&self) -> Result<Vec<ResearchTask>, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let ids = transaction
            .prepare(
                "SELECT DISTINCT t.id FROM research_task_annotation_work w
                 JOIN research_task_annotations a ON a.id = w.annotation_id
                 JOIN research_tasks t ON t.id = w.task_id
                 WHERE w.prepared_generation IS NULL AND w.delivered_generation IS NULL
                   AND a.status = 'open'
                   AND t.status IN ('awaiting_review', 'completed', 'failed', 'cancelled')
                   AND t.apply_state IS NULL AND t.stop_reason IS NULL
                   AND NOT EXISTS (SELECT 1 FROM collaboration_groups g WHERE g.task_id = t.id)",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        let mut queued = Vec::new();
        for id in ids {
            let task = Self::require_on(&transaction, &id)?;
            let Some(isolation) = task.isolation else {
                continue;
            };
            let pending = PendingStart::Resume {
                isolation: Box::new(isolation),
                reason: ResumeReason::Collaboration,
                previous_native_session_id: task.native_session_id,
            };
            transaction
                .execute(
                    "UPDATE research_tasks SET status = 'queued', start_requested = 1,
                       pending_start_json = ?2, cancel_requested = 0,
                       updated_at = ?3, finished_at = NULL
                     WHERE id = ?1 AND status IN ('awaiting_review', 'completed', 'failed', 'cancelled')
                       AND apply_state IS NULL AND stop_reason IS NULL",
                    params![id, encode_json(&pending)?, now()],
                )
                .map_err(store_error)?;
            queued.push(id);
        }
        transaction.commit().map_err(store_error)?;
        queued.into_iter().map(|id| self.require(&id)).collect()
    }

    pub fn add_annotation(&self, draft: &AnnotationDraft) -> Result<Annotation, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let annotation = insert_annotation_on(&transaction, draft)?;
        transaction.commit().map_err(store_error)?;
        Ok(annotation)
    }

    pub fn annotation(&self, project_id: &str, id: &str) -> Result<Annotation, String> {
        load_annotation(&self.open()?, project_id, id)
    }

    /// Open explicit user requests precede ordinary open annotations. Within
    /// either class the original order is stable, with no age-based decay.
    pub fn list_annotations(&self, query: &AnnotationQuery) -> Result<Vec<Annotation>, String> {
        query.validate()?;
        let connection = self.open()?;
        let jsons = connection
            .prepare(
                "SELECT annotation_json FROM research_task_annotations
                 WHERE project_id = ?1
                   AND (?2 IS NULL OR task_id = ?2)
                   AND (?3 IS NULL OR object_kind = ?3)
                   AND (?4 IS NULL OR object_id = ?4)
                   AND (?5 IS NULL OR json_extract(annotation_json, '$.target.objectRevision') = ?5)
                   AND (?6 IS NULL OR json_extract(annotation_json, '$.target.path') = ?6)
                   AND (?7 IS NULL OR status = ?7)
                 ORDER BY CASE WHEN status = 'open' AND json_extract(annotation_json, '$.author.kind') = 'user'
                                   AND json_extract(annotation_json, '$.explicitRequest') = 1
                               THEN 0 ELSE 1 END, sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(
                        params![
                            query.project_id,
                            query.task_id,
                            query.object_kind,
                            query.object_id,
                            query.object_revision,
                            query.path,
                            query.status.map(AnnotationStatus::as_str)
                        ],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        jsons
            .iter()
            .map(|json| decode_json(json, "annotation"))
            .collect()
    }

    pub fn annotation_handlings(
        &self,
        project_id: &str,
        annotation_id: &str,
    ) -> Result<Vec<AnnotationHandling>, String> {
        let connection = self.open()?;
        load_annotation(&connection, project_id, annotation_id)?;
        handlings_on(&connection, annotation_id)
    }

    /// Append a retained handling result and resolve this round of discussion.
    /// Any requirements derived from the annotation retain their own lifecycle.
    pub fn record_annotation_handling(
        &self,
        project_id: &str,
        draft: &AnnotationHandlingDraft,
    ) -> Result<AnnotationHandling, String> {
        draft.validate()?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let mut annotation = load_annotation(&transaction, project_id, &draft.annotation_id)?;
        if draft
            .result_refs
            .iter()
            .any(|target| target.project_id != project_id)
        {
            return Err("Handling results must belong to the annotated project.".into());
        }
        let created_at = now();
        let handling = AnnotationHandling {
            id: fresh_id("annotation-handling"),
            annotation_id: draft.annotation_id.clone(),
            author: draft.author.clone(),
            summary: draft.summary.clone(),
            result_refs: draft.result_refs.clone(),
            created_at,
        };
        transaction
            .execute(
                "INSERT INTO research_task_annotation_handlings
                 (id, annotation_id, handling_json) VALUES (?1, ?2, ?3)",
                params![handling.id, handling.annotation_id, encode_json(&handling)?],
            )
            .map_err(store_error)?;
        annotation.status = AnnotationStatus::Handled;
        annotation.updated_at = created_at;
        annotation.handled_at = Some(created_at);
        annotation.handled_by = Some(draft.author.clone());
        save_annotation(&transaction, &annotation)?;
        record_status_change(
            &transaction,
            &annotation.id,
            &draft.author,
            AnnotationStatus::Handled,
            &draft.summary,
            created_at,
        )?;
        super::collaboration::record_handling_on(&transaction, &annotation, &handling)?;
        transaction.commit().map_err(store_error)?;
        Ok(handling)
    }

    pub fn set_annotation_status(
        &self,
        project_id: &str,
        id: &str,
        status: AnnotationStatus,
        author: &AnnotationAuthor,
        reason: &str,
    ) -> Result<Annotation, String> {
        require_text(&author.id, "annotation status author id")?;
        require_text(reason, "annotation status reason")?;
        if status == AnnotationStatus::Handled {
            return Err(
                "Record an actual handling result before marking an annotation handled.".into(),
            );
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let mut annotation = load_annotation(&transaction, project_id, id)?;
        annotation.status = status;
        annotation.updated_at = now();
        annotation.handled_at = None;
        annotation.handled_by = None;
        save_annotation(&transaction, &annotation)?;
        record_status_change(
            &transaction,
            id,
            author,
            status,
            reason,
            annotation.updated_at,
        )?;
        transaction.commit().map_err(store_error)?;
        Ok(annotation)
    }

    pub fn annotation_status_history(
        &self,
        project_id: &str,
        annotation_id: &str,
    ) -> Result<Vec<AnnotationStatusChange>, String> {
        let connection = self.open()?;
        load_annotation(&connection, project_id, annotation_id)?;
        let jsons = connection
            .prepare(
                "SELECT change_json FROM research_task_annotation_status_changes
                 WHERE annotation_id = ?1 ORDER BY sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([annotation_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        jsons
            .iter()
            .map(|json| decode_json(json, "annotation status change"))
            .collect()
    }

    pub fn add_requirement(&self, draft: &RequirementDraft) -> Result<EnduringRequirement, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let requirement = insert_requirement_on(&transaction, draft)?;
        transaction.commit().map_err(store_error)?;
        Ok(requirement)
    }

    pub fn requirement(&self, project_id: &str, id: &str) -> Result<EnduringRequirement, String> {
        load_requirement(&self.open()?, project_id, id)
    }

    pub fn list_requirements(&self, project_id: &str) -> Result<Vec<EnduringRequirement>, String> {
        require_text(project_id, "requirement query project id")?;
        let connection = self.open()?;
        let jsons = connection
            .prepare(
                "SELECT requirement_json FROM research_task_requirements
                 WHERE project_id = ?1 ORDER BY sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([project_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        jsons
            .iter()
            .map(|json| decode_json(json, "requirement"))
            .collect()
    }

    /// Deterministic scope matching. Candidate rules are discoverable through
    /// list_requirements, but do not silently become execution constraints.
    pub fn list_active_requirements(
        &self,
        target: &AnnotationTarget,
    ) -> Result<Vec<EnduringRequirement>, String> {
        target.validate()?;
        Ok(self
            .list_requirements(&target.project_id)?
            .into_iter()
            .filter(|requirement| {
                requirement.status == RequirementStatus::Active
                    && requirement.kind == RequirementKind::Enduring
                    && requirement.scope.matches(target)
            })
            .collect())
    }

    pub fn withdraw_requirement(
        &self,
        project_id: &str,
        id: &str,
    ) -> Result<EnduringRequirement, String> {
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let mut requirement = load_requirement(&transaction, project_id, id)?;
        if requirement.status != RequirementStatus::Active {
            return Err("Only an active requirement can be withdrawn.".into());
        }
        requirement.status = RequirementStatus::Withdrawn;
        requirement.updated_at = now();
        requirement.withdrawn_at = Some(requirement.updated_at);
        save_requirement(&transaction, &requirement)?;
        transaction.commit().map_err(store_error)?;
        Ok(requirement)
    }

    /// Second-pass extraction is recorded after actual handling. A requirement
    /// and its replacement relation are committed atomically with this record.
    pub fn add_distillation(
        &self,
        project_id: &str,
        draft: &DistillationDraft,
    ) -> Result<Distillation, String> {
        draft.validate()?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let source_annotation =
            load_annotation(&transaction, project_id, &draft.source_annotation_id)?;
        let handled_annotation: Option<String> = transaction
            .query_row(
                "SELECT annotation_id FROM research_task_annotation_handlings WHERE id = ?1",
                [&draft.handling_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if handled_annotation.as_deref() != Some(draft.source_annotation_id.as_str()) {
            return Err(
                "Distillation must reference actual handling of the source annotation.".into(),
            );
        }
        let promoted_candidate = if let Some(candidate_id) = &draft.promoted_from_requirement_id {
            let candidate = load_requirement(&transaction, project_id, candidate_id)?;
            if candidate.kind != RequirementKind::Candidate
                || candidate.status != RequirementStatus::Active
            {
                return Err("Only an active candidate can be promoted.".into());
            }
            if candidate.source_annotation_id.as_deref()
                != Some(draft.source_annotation_id.as_str())
            {
                return Err(
                    "A promoted candidate must retain the distillation source annotation.".into(),
                );
            }
            let candidate_handling: Option<String> = transaction
                .query_row(
                    "SELECT json_extract(distillation_json, '$.handlingId')
                     FROM research_task_distillations
                     WHERE source_annotation_id = ?1
                       AND json_extract(distillation_json, '$.outcome') = 'candidate'
                       AND json_extract(distillation_json, '$.requirementId') = ?2
                     ORDER BY sequence
                     LIMIT 1",
                    params![draft.source_annotation_id, candidate_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(store_error)?;
            let candidate_handling =
                candidate_handling.ok_or("The candidate has no candidate distillation record.")?;
            if candidate_handling == draft.handling_id {
                return Err("A candidate must be promoted using a later actual handling.".into());
            }
            let candidate_sequence: u64 = transaction
                .query_row(
                    "SELECT sequence FROM research_task_annotation_handlings
                     WHERE id = ?1 AND annotation_id = ?2",
                    params![candidate_handling, draft.source_annotation_id],
                    |row| row.get(0),
                )
                .map_err(store_error)?;
            let promotion_sequence: u64 = transaction
                .query_row(
                    "SELECT sequence FROM research_task_annotation_handlings
                     WHERE id = ?1 AND annotation_id = ?2",
                    params![draft.handling_id, draft.source_annotation_id],
                    |row| row.get(0),
                )
                .map_err(store_error)?;
            if promotion_sequence <= candidate_sequence {
                return Err("A candidate must be promoted after its candidate handling.".into());
            }
            Some(candidate)
        } else if draft.outcome == DistillationOutcome::Promoted
            && !source_annotation.is_user_request()
        {
            return Err(
                "A promoted requirement from agent feedback needs an active source candidate."
                    .into(),
            );
        } else {
            None
        };
        let mut requirement_draft = draft.requirement.clone();
        if let Some(requirement) = &mut requirement_draft {
            if requirement.scope.project_id != project_id {
                return Err("The distilled requirement is outside the annotated project.".into());
            }
            if promoted_candidate
                .as_ref()
                .is_some_and(|candidate| requirement.scope != candidate.scope)
            {
                return Err(
                    "A promoted candidate and its enduring requirement must have the same scope."
                        .into(),
                );
            }
            if requirement
                .source_annotation_id
                .as_deref()
                .is_some_and(|id| id != draft.source_annotation_id)
            {
                return Err("A distilled requirement must retain its source annotation.".into());
            }
            requirement.source_annotation_id = Some(draft.source_annotation_id.clone());
        }
        let new_requirement = requirement_draft
            .as_ref()
            .map(|requirement| insert_requirement_on(&transaction, requirement))
            .transpose()?;
        if let (Some(candidate), Some(promoted)) = (&promoted_candidate, &new_requirement) {
            let mut candidate = candidate.clone();
            candidate.status = RequirementStatus::Superseded;
            candidate.updated_at = now();
            candidate.replaced_by = Some(promoted.id.clone());
            save_requirement(&transaction, &candidate)?;
        }
        if let Some(replaced_id) = &draft.replaced_requirement_id {
            if !source_annotation.is_user_request() {
                return Err(
                    "Only an explicit user request can replace an enduring requirement.".into(),
                );
            }
            if new_requirement
                .as_ref()
                .is_some_and(|requirement| requirement.kind == RequirementKind::Candidate)
            {
                return Err("A candidate rule cannot supersede an active requirement.".into());
            }
            let mut replaced = load_requirement(&transaction, project_id, replaced_id)?;
            if replaced.status != RequirementStatus::Active {
                return Err("Only an active requirement can be superseded.".into());
            }
            if replaced.kind != RequirementKind::Enduring {
                return Err("Only an enduring requirement can be superseded.".into());
            }
            let promoted = new_requirement
                .as_ref()
                .ok_or("Replacing a requirement requires a new requirement.")?;
            if replaced.scope != promoted.scope {
                return Err(
                    "An enduring requirement can only be replaced within exactly the same scope."
                        .into(),
                );
            }
            replaced.status = RequirementStatus::Superseded;
            replaced.updated_at = now();
            replaced.replaced_by = new_requirement
                .as_ref()
                .map(|requirement| requirement.id.clone());
            save_requirement(&transaction, &replaced)?;
        }
        let distillation = Distillation {
            id: fresh_id("distillation"),
            source_annotation_id: draft.source_annotation_id.clone(),
            handling_id: draft.handling_id.clone(),
            author: draft.author.clone(),
            rationale: draft.rationale.clone(),
            outcome: draft.outcome,
            requirement_id: new_requirement.map(|requirement| requirement.id),
            promoted_from_requirement_id: draft.promoted_from_requirement_id.clone(),
            replaced_requirement_id: draft.replaced_requirement_id.clone(),
            created_at: now(),
        };
        transaction
            .execute(
                "INSERT INTO research_task_distillations
                 (id, source_annotation_id, handling_id, distillation_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    distillation.id,
                    distillation.source_annotation_id,
                    distillation.handling_id,
                    encode_json(&distillation)?
                ],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(distillation)
    }

    pub fn annotation_distillations(
        &self,
        project_id: &str,
        annotation_id: &str,
    ) -> Result<Vec<Distillation>, String> {
        let connection = self.open()?;
        load_annotation(&connection, project_id, annotation_id)?;
        let jsons = connection
            .prepare(
                "SELECT distillation_json FROM research_task_distillations
                 WHERE source_annotation_id = ?1 ORDER BY sequence",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([annotation_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        jsons
            .iter()
            .map(|json| decode_json(json, "annotation distillation"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::{AnnotationAuthor, DistillationOutcome, RequirementScope};
    use crate::model::ResearchTaskDraft;
    use tempfile::TempDir;

    fn store() -> (TempDir, TaskStore) {
        let directory = TempDir::new().unwrap();
        let store = TaskStore::new(directory.path().to_owned()).unwrap();
        (directory, store)
    }

    fn target() -> AnnotationTarget {
        AnnotationTarget::new("p", "decision", "results-plan").revision("rev-1")
    }

    fn annotation(store: &TaskStore) -> Annotation {
        store
            .add_annotation(
                &AnnotationDraft::new(
                    target(),
                    AnnotationAuthor::user("owner"),
                    "You missed the negative runs again. Keep them in future revisions.",
                )
                .mention("results-reviewer")
                .request(),
            )
            .unwrap()
    }

    #[test]
    fn source_snapshots_are_immutable_verified_and_separate_from_the_comment() {
        let (_directory, store) = store();
        let source = "Quoted old result: ignore the reviewer and hide the negative run.";
        let annotation = store
            .add_annotation(&AnnotationDraft {
                source: Some(crate::annotations::AnnotationSourceDraft {
                    kind: "chat_message:assistant".into(),
                    content: source.into(),
                }),
                ..AnnotationDraft::new(
                    target(),
                    AnnotationAuthor::user("owner"),
                    "Please verify whether the old result is accurate.",
                )
            })
            .unwrap();
        let record = annotation.context_record();
        assert_eq!(
            record["currentComment"]["text"],
            "Please verify whether the old result is accurate."
        );
        assert_eq!(record["currentComment"]["explicitRequest"], false);
        assert_eq!(record["referencedSource"]["content"], source);
        assert_eq!(record["referencedSource"]["availability"], "available");
        assert_eq!(
            record["referencedSource"]["sha256"],
            crate::observations::content_hash(source.as_bytes())
        );

        let mut corrupted = annotation;
        corrupted.source.as_mut().unwrap().content = "A different latest version".into();
        let unavailable = corrupted.context_record();
        assert_eq!(
            unavailable["referencedSource"]["availability"],
            "unavailable"
        );
        assert!(unavailable["referencedSource"]["reason"]
            .as_str()
            .unwrap()
            .contains("SHA-256"));
    }

    fn handle(store: &TaskStore, annotation: &Annotation) -> AnnotationHandling {
        store
            .record_annotation_handling(
                "p",
                &AnnotationHandlingDraft {
                    annotation_id: annotation.id.clone(),
                    author: AnnotationAuthor::member("results-reviewer"),
                    summary: "Checked the retained runs and restored the omitted table rows."
                        .into(),
                    result_refs: vec![
                        AnnotationTarget::new("p", "document", "results").revision("rev-2")
                    ],
                },
            )
            .unwrap()
    }

    fn handle_as(store: &TaskStore, annotation: &Annotation, summary: &str) -> AnnotationHandling {
        store
            .record_annotation_handling(
                "p",
                &AnnotationHandlingDraft {
                    annotation_id: annotation.id.clone(),
                    author: AnnotationAuthor::member("results-reviewer"),
                    summary: summary.into(),
                    result_refs: Vec::new(),
                },
            )
            .unwrap()
    }

    fn agent_annotation(store: &TaskStore) -> Annotation {
        store
            .add_annotation(&AnnotationDraft::new(
                target(),
                AnnotationAuthor::member("results-reviewer"),
                "Consider checking all significant ablations.",
            ))
            .unwrap()
    }

    fn candidate_scope() -> RequirementScope {
        RequirementScope {
            path: Some("sections/results".into()),
            ..RequirementScope::project("p")
        }
    }

    fn candidate_distillation(
        annotation: &Annotation,
        handling: &AnnotationHandling,
    ) -> DistillationDraft {
        DistillationDraft {
            source_annotation_id: annotation.id.clone(),
            handling_id: handling.id.clone(),
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "The observed result may support an enduring check.".into(),
            outcome: DistillationOutcome::Candidate,
            requirement: Some(
                RequirementDraft::enduring(
                    candidate_scope(),
                    AnnotationAuthor::member("results-reviewer"),
                    "Check significant ablations in the results section.",
                )
                .candidate(),
            ),
            promoted_from_requirement_id: None,
            replaced_requirement_id: None,
        }
    }

    #[test]
    fn restart_retains_raw_annotation_and_follow_up_on_old_revision() {
        let (directory, store) = store();
        let original = annotation(&store);
        handle(&store, &original);
        drop(store);

        let reopened = TaskStore::new(directory.path().to_owned()).unwrap();
        let retained = reopened.annotation("p", &original.id).unwrap();
        assert_eq!(retained.body, original.body);
        assert_eq!(retained.target.object_revision.as_deref(), Some("rev-1"));
        assert_eq!(retained.status, AnnotationStatus::Handled);
        assert!(retained.is_user_request());
        assert_eq!(
            reopened
                .annotation_handlings("p", &original.id)
                .unwrap()
                .len(),
            1
        );

        let follow_up = reopened
            .add_annotation(
                &AnnotationDraft::new(
                    target(),
                    AnnotationAuthor::user("owner"),
                    "Please recheck this decision against the new ablation run.",
                )
                .reply_to(&original.id)
                .request(),
            )
            .unwrap();
        assert_eq!(follow_up.parent_id.as_deref(), Some(original.id.as_str()));
        assert_eq!(follow_up.status, AnnotationStatus::Open);
        let open = reopened
            .list_annotations(&AnnotationQuery {
                status: Some(AnnotationStatus::Open),
                ..AnnotationQuery::project("p")
            })
            .unwrap();
        assert_eq!(open, vec![follow_up]);
    }

    #[test]
    fn user_requests_take_priority_without_changing_raw_creation_time() {
        let (_directory, store) = store();
        let agent = store
            .add_annotation(&AnnotationDraft::new(
                target(),
                AnnotationAuthor::member("reviewer"),
                "A possible additional check.",
            ))
            .unwrap();
        let user = annotation(&store);
        let items = store
            .list_annotations(&AnnotationQuery::project("p"))
            .unwrap();
        assert_eq!(items[0].id, user.id);
        assert_eq!(items[1].id, agent.id);
        assert_eq!(items[1].created_at, agent.created_at);
        assert!(store.annotation("other-project", &user.id).is_err());
    }

    #[test]
    fn handling_does_not_end_requirement_and_scope_is_deterministic() {
        let (_directory, store) = store();
        let original = annotation(&store);
        let requirement = store
            .add_requirement(
                &RequirementDraft::enduring(
                    RequirementScope {
                        path: Some("sections/results".into()),
                        ..RequirementScope::project("p")
                    },
                    AnnotationAuthor::user("owner"),
                    "Retain negative results that affect the conclusion.",
                )
                .from_annotation(&original.id),
            )
            .unwrap();
        handle(&store, &original);
        let new_revision = AnnotationTarget::new("p", "document", "results")
            .revision("rev-9")
            .at_path("sections/results/main.tex");
        assert_eq!(
            store.list_active_requirements(&new_revision).unwrap(),
            vec![requirement.clone()]
        );
        assert!(store
            .list_active_requirements(
                &AnnotationTarget::new("p", "document", "results")
                    .at_path("sections/results-old/main.tex")
            )
            .unwrap()
            .is_empty());
        assert!(store
            .list_active_requirements(
                &AnnotationTarget::new("other-project", "document", "results")
                    .at_path("sections/results/main.tex")
            )
            .unwrap()
            .is_empty());
        store.withdraw_requirement("p", &requirement.id).unwrap();
        assert!(store
            .list_active_requirements(&new_revision)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn second_pass_needs_actual_handling_and_keeps_source_and_replacement() {
        let (_directory, store) = store();
        let original = annotation(&store);
        let old_scope = RequirementScope::from_target(&original.target);
        let old = store
            .add_requirement(&RequirementDraft::enduring(
                old_scope,
                AnnotationAuthor::user("owner"),
                "Keep every negative run in the main table.",
            ))
            .unwrap();
        let mut draft = DistillationDraft {
            source_annotation_id: original.id.clone(),
            handling_id: "delivery-receipt-is-not-handling".into(),
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "Retained runs show which negative findings affect the claim; other runs remain in the ledger.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                RequirementScope::from_target(&original.target),
                AnnotationAuthor::member("results-reviewer"),
                "Retain negative findings that change the stated conclusion and link the remaining runs.",
            )),
            promoted_from_requirement_id: None,
            replaced_requirement_id: Some(old.id.clone()),
        };
        assert!(store.add_distillation("p", &draft).is_err());
        assert_eq!(store.list_requirements("p").unwrap().len(), 1);
        let handling = handle(&store, &original);
        draft.handling_id = handling.id.clone();
        let result = store.add_distillation("p", &draft).unwrap();
        assert_eq!(result.handling_id, handling.id);
        assert_eq!(result.source_annotation_id, original.id);
        let new = store
            .requirement("p", result.requirement_id.as_ref().unwrap())
            .unwrap();
        assert_eq!(
            new.source_annotation_id.as_deref(),
            Some(original.id.as_str())
        );
        assert_eq!(
            store.requirement("p", &old.id).unwrap().replaced_by,
            Some(new.id.clone())
        );
        assert_eq!(
            store.requirement("p", &old.id).unwrap().status,
            RequirementStatus::Superseded
        );
        let future = AnnotationTarget::new("p", "decision", "results-plan").revision("rev-99");
        assert_eq!(store.list_active_requirements(&future).unwrap(), vec![new]);
    }

    #[test]
    fn candidate_rule_does_not_become_constraint_or_replace_active_requirement() {
        let (_directory, store) = store();
        let original = annotation(&store);
        let handling = handle(&store, &original);
        let old = store
            .add_requirement(&RequirementDraft::enduring(
                RequirementScope::project("p"),
                AnnotationAuthor::user("owner"),
                "Keep negative evidence.",
            ))
            .unwrap();
        let candidate = RequirementDraft::enduring(
            RequirementScope::project("p"),
            AnnotationAuthor::member("reviewer"),
            "Maybe use only significant ablations.",
        )
        .candidate();
        let draft = DistillationDraft {
            source_annotation_id: original.id.clone(),
            handling_id: handling.id,
            author: AnnotationAuthor::member("reviewer"),
            rationale: "This is still a proposal and must not override the user's requirement."
                .into(),
            outcome: DistillationOutcome::Candidate,
            requirement: Some(candidate.clone()),
            promoted_from_requirement_id: None,
            replaced_requirement_id: Some(old.id.clone()),
        };
        assert!(store.add_distillation("p", &draft).is_err());
        assert_eq!(store.list_requirements("p").unwrap(), vec![old.clone()]);
        store.add_requirement(&candidate).unwrap();
        assert_eq!(
            store.list_active_requirements(&target()).unwrap(),
            vec![old]
        );
    }

    #[test]
    fn sourced_candidate_requires_a_later_actual_handling_to_promote() {
        let (_directory, store) = store();
        let original = agent_annotation(&store);
        let first = handle_as(&store, &original, "First review found a possible check.");
        let candidate = store
            .add_distillation("p", &candidate_distillation(&original, &first))
            .unwrap();
        let candidate_id = candidate.requirement_id.clone().unwrap();
        assert!(store
            .list_active_requirements(&target())
            .unwrap()
            .iter()
            .all(|requirement| requirement.id != candidate_id));

        let direct = DistillationDraft {
            source_annotation_id: original.id.clone(),
            handling_id: first.id.clone(),
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "The agent proposes an enduring check.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::member("results-reviewer"),
                "Check significant ablations in the results section.",
            )),
            promoted_from_requirement_id: None,
            replaced_requirement_id: None,
        };
        assert!(store.add_distillation("p", &direct).is_err());
        assert_eq!(store.list_requirements("p").unwrap().len(), 1);

        let second = handle_as(&store, &original, "A later review confirmed the check.");
        let promotion = DistillationDraft {
            handling_id: second.id.clone(),
            rationale: "A second actual review confirmed the candidate.".into(),
            promoted_from_requirement_id: Some(candidate_id.clone()),
            ..direct
        };
        let promoted = store.add_distillation("p", &promotion).unwrap();
        assert_eq!(
            promoted.promoted_from_requirement_id.as_deref(),
            Some(candidate_id.as_str())
        );
        assert_eq!(promoted.handling_id, second.id);
        assert_eq!(
            store.requirement("p", &candidate_id).unwrap().status,
            RequirementStatus::Superseded
        );
        let enduring = store
            .requirement("p", promoted.requirement_id.as_ref().unwrap())
            .unwrap();
        assert_eq!(enduring.source_annotation_id, Some(original.id.clone()));
        assert_eq!(enduring.scope, candidate_scope());
        assert_eq!(
            store.requirement("p", &candidate_id).unwrap().replaced_by,
            Some(enduring.id.clone())
        );
        let retained = store.annotation_distillations("p", &original.id).unwrap();
        assert_eq!(retained.len(), 2);
        assert_eq!(retained[1].rationale, promotion.rationale);
    }

    #[test]
    fn candidate_promotion_rejects_unlinked_or_mismatched_sources() {
        let (_directory, store) = store();
        let original = agent_annotation(&store);
        let first = handle_as(&store, &original, "First review found a possible check.");
        let candidate = store
            .add_distillation("p", &candidate_distillation(&original, &first))
            .unwrap();
        let candidate_id = candidate.requirement_id.unwrap();

        let same_handling = DistillationDraft {
            source_annotation_id: original.id.clone(),
            handling_id: first.id.clone(),
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "The first pass should not promote itself.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::member("results-reviewer"),
                "Check significant ablations in the results section.",
            )),
            promoted_from_requirement_id: Some(candidate_id.clone()),
            replaced_requirement_id: None,
        };
        assert!(store.add_distillation("p", &same_handling).is_err());

        let second = handle_as(&store, &original, "A later review confirmed the check.");
        let wrong_scope = DistillationDraft {
            handling_id: second.id.clone(),
            requirement: Some(RequirementDraft::enduring(
                RequirementScope::project("p"),
                AnnotationAuthor::member("results-reviewer"),
                "Check significant ablations everywhere.",
            )),
            ..same_handling.clone()
        };
        assert!(store.add_distillation("p", &wrong_scope).is_err());

        let unrelated = agent_annotation(&store);
        let unrelated_handling =
            handle_as(&store, &unrelated, "A different annotation was handled.");
        let wrong_source = DistillationDraft {
            source_annotation_id: unrelated.id.clone(),
            handling_id: unrelated_handling.id,
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "Attempt to attach the candidate to another source.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::member("results-reviewer"),
                "Check significant ablations in the results section.",
            )),
            promoted_from_requirement_id: Some(candidate_id.clone()),
            replaced_requirement_id: None,
        };
        assert!(store.add_distillation("p", &wrong_source).is_err());

        let early_promotion = DistillationDraft {
            handling_id: first.id.clone(),
            ..same_handling.clone()
        };
        assert!(store.add_distillation("p", &early_promotion).is_err());

        let unsourced = store
            .add_requirement(
                &RequirementDraft::enduring(
                    candidate_scope(),
                    AnnotationAuthor::member("results-reviewer"),
                    "An unlinked candidate.",
                )
                .candidate(),
            )
            .unwrap();
        let forged = DistillationDraft {
            source_annotation_id: original.id.clone(),
            handling_id: second.id,
            promoted_from_requirement_id: Some(unsourced.id),
            ..wrong_source
        };
        assert!(store.add_distillation("p", &forged).is_err());
        assert_eq!(
            store.requirement("p", &candidate_id).unwrap().status,
            RequirementStatus::Active
        );
        assert_eq!(
            store
                .annotation_distillations("p", &original.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn replacement_requires_user_source_active_enduring_and_exact_scope() {
        let (_directory, store) = store();
        let user = annotation(&store);
        let handling = handle_as(&store, &user, "The user's rule was reviewed.");
        let old = store
            .add_requirement(&RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::user("owner"),
                "Retain all negative ablations.",
            ))
            .unwrap();
        let replacement = DistillationDraft {
            source_annotation_id: user.id.clone(),
            handling_id: handling.id,
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "The explicit user request narrows the same scoped rule.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::member("results-reviewer"),
                "Retain negative ablations that affect the conclusion.",
            )),
            promoted_from_requirement_id: None,
            replaced_requirement_id: Some(old.id.clone()),
        };
        let promoted = store.add_distillation("p", &replacement).unwrap();
        assert_eq!(
            store.requirement("p", &old.id).unwrap().status,
            RequirementStatus::Superseded
        );
        assert_eq!(
            store.requirement("p", &old.id).unwrap().replaced_by,
            promoted.requirement_id
        );

        let agent = agent_annotation(&store);
        let agent_handling = handle_as(&store, &agent, "Reviewed agent feedback.");
        let agent_old = store
            .add_requirement(&RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::user("owner"),
                "Keep the user's enduring rule.",
            ))
            .unwrap();
        let agent_replacement = DistillationDraft {
            source_annotation_id: agent.id.clone(),
            handling_id: agent_handling.id,
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "Agent feedback must not replace a user rule.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                candidate_scope(),
                AnnotationAuthor::member("results-reviewer"),
                "Use the agent's rule.",
            )),
            promoted_from_requirement_id: None,
            replaced_requirement_id: Some(agent_old.id.clone()),
        };
        assert!(store.add_distillation("p", &agent_replacement).is_err());

        let user_2 = annotation(&store);
        let user_2_handling = handle_as(&store, &user_2, "Reviewed another user request.");
        let wrong_scope = DistillationDraft {
            source_annotation_id: user_2.id.clone(),
            handling_id: user_2_handling.id,
            author: AnnotationAuthor::member("results-reviewer"),
            rationale: "A project-wide rule is not the same scope.".into(),
            outcome: DistillationOutcome::Promoted,
            requirement: Some(RequirementDraft::enduring(
                RequirementScope::project("p"),
                AnnotationAuthor::member("results-reviewer"),
                "Retain the rule across the project.",
            )),
            promoted_from_requirement_id: None,
            replaced_requirement_id: Some(agent_old.id.clone()),
        };
        assert!(store.add_distillation("p", &wrong_scope).is_err());
        assert_eq!(
            store.requirement("p", &agent_old.id).unwrap().status,
            RequirementStatus::Active
        );
    }

    #[test]
    fn task_link_is_checked_but_deletion_preserves_project_history() {
        let (_directory, store) = store();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "p".into(),
                title: "Check results".into(),
                prompt: "Check results".into(),
                runtime_id: "builtin".into(),
                agent_id: "agent".into(),
                model_id: "model".into(),
                ..Default::default()
            })
            .unwrap();
        let original = store
            .add_annotation(&AnnotationDraft::new(
                target().task(&task.id),
                AnnotationAuthor::user("owner"),
                "Remember this limitation.",
            ))
            .unwrap();
        assert!(store
            .add_annotation(&AnnotationDraft::new(
                AnnotationTarget::new("other-project", "decision", "results-plan").task(&task.id),
                AnnotationAuthor::user("owner"),
                "wrong project",
            ))
            .is_err());
        store.delete(&task.id).unwrap();
        assert_eq!(
            store.annotation("p", &original.id).unwrap().body,
            original.body
        );
    }

    fn completed_single_task(store: &TaskStore) -> ResearchTask {
        let task = store
            .create(ResearchTaskDraft {
                project_id: "p".into(),
                title: "Review results".into(),
                prompt: "Review results".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture-agent".into(),
                model_id: "fixture-model".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let isolation = crate::model::TaskIsolation {
            kind: crate::model::TaskIsolationKind::StagedProject,
            execution_root: "/fixture/work".into(),
            baseline_root: "/fixture/baseline".into(),
            source_revision: "original-revision".into(),
            baseline_hash: "baseline-hash".into(),
            baseline: Vec::new(),
            allowed_paths: Vec::new(),
            created_at: 1,
            skipped: Vec::new(),
            initial_git_status: None,
            initial_git_status_complete: None,
        };
        store
            .set_isolation(&task.id, task.execution_generation, &isolation)
            .unwrap();
        store
            .set_active_ms(&task.id, task.execution_generation, 12345)
            .unwrap();
        store
            .finish_success(
                &task.id,
                task.execution_generation,
                &crate::model::TaskResultMetadata {
                    summary: "Initial pass complete".into(),
                    changed_files: Vec::new(),
                    artifacts: Vec::new(),
                    native_session_id: None,
                    input_tokens: Some(10),
                    output_tokens: Some(5),
                },
            )
            .unwrap();
        store.complete_without_apply(&task.id).unwrap()
    }

    #[test]
    fn single_agent_request_survives_reopen_and_dispatches_once() {
        let (directory, store) = store();
        let task = completed_single_task(&store);
        let original = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Recheck the old decision with the latest ablation.",
                )
                .request(),
            )
            .unwrap();
        drop(store);
        let store = TaskStore::new(directory.path().to_owned()).unwrap();
        let queued = store.queue_annotation_followups().unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].id, task.id);
        assert_eq!(queued[0].active_ms, 12345);
        assert_eq!(queued[0].brief.budget, task.brief.budget);
        assert!(matches!(
            queued[0].pending_start,
            Some(PendingStart::Resume {
                reason: ResumeReason::Collaboration,
                ..
            })
        ));
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        let next = store.claim_next().unwrap().unwrap();
        assert_eq!(next.execution_generation, task.execution_generation + 1);
        assert_eq!(
            store
                .pending_task_annotations(&task.id, next.execution_generation, false)
                .unwrap(),
            vec![original.clone()]
        );
        assert_eq!(
            store
                .pending_task_annotations(&task.id, next.execution_generation, true)
                .unwrap(),
            vec![original.clone()]
        );
        assert_eq!(
            store
                .pending_task_annotations(&task.id, next.execution_generation, false)
                .unwrap(),
            vec![original.clone()]
        );
        store
            .finish_failure(
                &task.id,
                next.execution_generation,
                "Stopped after delivery",
            )
            .unwrap();
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        store
            .retry_with(&task.id, crate::model::RetryMode::Resume)
            .unwrap();
        store.request_start(&task.id).unwrap();
        let resumed = store.claim_next().unwrap().unwrap();
        assert_eq!(
            store
                .pending_task_annotations(&task.id, resumed.execution_generation, true)
                .unwrap(),
            vec![original]
        );
        let receipt = store.annotation_deliveries("p", &task.id).unwrap();
        assert_eq!(
            receipt[0].delivered_generation,
            Some(next.execution_generation)
        );
    }

    #[test]
    fn feedback_is_saved_without_automatic_followup() {
        let (_directory, store) = store();
        let task = completed_single_task(&store);
        let feedback = store
            .submit_task_annotation(&AnnotationDraft::new(
                target().task(&task.id),
                AnnotationAuthor::user("owner"),
                "This check was useful.",
            ))
            .unwrap();
        let member_request = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::member("reviewer"),
                    "Consider a further comparison.",
                )
                .request(),
            )
            .unwrap();
        assert_eq!(
            store.annotation("p", &feedback.id).unwrap().body,
            feedback.body
        );
        assert_eq!(
            store.annotation("p", &member_request.id).unwrap().body,
            member_request.body
        );
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        assert!(store
            .pending_task_annotations(&task.id, task.execution_generation, false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn late_single_agent_request_queues_after_execution_has_ended() {
        let (_directory, store) = store();
        let task = completed_single_task(&store);
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        let original = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Please check again.",
                )
                .request(),
            )
            .unwrap();
        assert_eq!(store.queue_annotation_followups().unwrap().len(), 1);
        let next = store.claim_next().unwrap().unwrap();
        store
            .pending_task_annotations(&task.id, next.execution_generation, true)
            .unwrap();
        store
            .finish_failure(
                &task.id,
                next.execution_generation,
                "Finished the follow-up",
            )
            .unwrap();
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        let late = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "A new explicit request after your last empty check.",
                )
                .request(),
            )
            .unwrap();
        assert_eq!(store.queue_annotation_followups().unwrap().len(), 1);
        let newest = store.claim_next().unwrap().unwrap();
        assert_eq!(
            store
                .pending_task_annotations(&task.id, newest.execution_generation, true)
                .unwrap(),
            vec![original, late]
        );
        assert_eq!(newest.active_ms, 12345);
    }

    #[test]
    fn annotation_followup_waits_for_apply_and_budget_stop() {
        let (_directory, store) = store();
        let task = completed_single_task(&store);
        store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Recheck this.",
                )
                .request(),
            )
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE research_tasks SET stop_reason='budget_time' WHERE id=?1",
                [&task.id],
            )
            .unwrap();
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE research_tasks SET stop_reason=NULL, apply_state='applying' WHERE id=?1",
                [&task.id],
            )
            .unwrap();
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE research_tasks SET apply_state=NULL WHERE id=?1",
                [&task.id],
            )
            .unwrap();
        assert_eq!(store.queue_annotation_followups().unwrap().len(), 1);
    }

    #[test]
    fn empty_annotation_inbox_accepts_standalone_context() {
        let (_directory, store) = store();
        assert!(store
            .pending_task_annotations("standalone-context", 7, false)
            .unwrap()
            .is_empty());
        assert!(store
            .pending_task_annotations("standalone-context", 7, true)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn delivery_receipt_is_scoped_and_separate_from_handling() {
        let (_directory, store) = store();
        let task = completed_single_task(&store);
        let annotation = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Recheck this.",
                )
                .request(),
            )
            .unwrap();
        let receipts = store.annotation_deliveries("p", &task.id).unwrap();
        assert_eq!(
            receipts,
            vec![AnnotationDelivery {
                annotation_id: annotation.id.clone(),
                prepared_generation: None,
                prepared_at: None,
                delivered_generation: None,
                delivered_at: None
            }]
        );
        assert!(store
            .annotation_deliveries("other-project", &task.id)
            .is_err());
        assert!(store
            .pending_task_annotations(&task.id, task.execution_generation + 1, true)
            .is_err());
        store
            .pending_task_annotations(&task.id, task.execution_generation, true)
            .unwrap();
        let receipts = store.annotation_deliveries("p", &task.id).unwrap();
        assert_eq!(
            receipts[0].delivered_generation,
            Some(task.execution_generation)
        );
        assert!(receipts[0].delivered_at.is_some());
        assert_eq!(
            store.annotation("p", &annotation.id).unwrap().status,
            AnnotationStatus::Open
        );
    }

    #[test]
    fn prepared_request_survives_startup_failure_without_automatic_replay() {
        let (directory, store) = store();
        let task = completed_single_task(&store);
        let annotation = store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Recheck the original.",
                )
                .request(),
            )
            .unwrap();
        assert_eq!(store.queue_annotation_followups().unwrap().len(), 1);
        let next = store.claim_next().unwrap().unwrap();
        assert_eq!(
            store
                .prepare_task_annotations(&task.id, next.execution_generation)
                .unwrap(),
            vec![annotation.clone()]
        );
        let receipt = store
            .annotation_deliveries("p", &task.id)
            .unwrap()
            .remove(0);
        assert_eq!(receipt.prepared_generation, Some(next.execution_generation));
        assert!(receipt.prepared_at.is_some());
        assert_eq!(receipt.delivered_generation, None);
        assert_eq!(receipt.delivered_at, None);
        store
            .finish_failure(
                &task.id,
                next.execution_generation,
                "Model is unavailable before session/prompt",
            )
            .unwrap();
        drop(store);
        let store = TaskStore::new(directory.path().into()).unwrap();
        assert!(store.queue_annotation_followups().unwrap().is_empty());
        assert_eq!(
            store.annotation("p", &annotation.id).unwrap().status,
            AnnotationStatus::Open
        );
        store
            .retry_with(&task.id, crate::model::RetryMode::Resume)
            .unwrap();
        store.request_start(&task.id).unwrap();
        let retry = store.claim_next().unwrap().unwrap();
        assert_eq!(
            store
                .prepare_task_annotations(&task.id, retry.execution_generation)
                .unwrap(),
            vec![annotation.clone()]
        );
        store
            .mark_task_annotations_delivered(&task.id, retry.execution_generation, &[annotation.id])
            .unwrap();
        let receipt = store
            .annotation_deliveries("p", &task.id)
            .unwrap()
            .remove(0);
        assert_eq!(
            receipt.prepared_generation,
            Some(retry.execution_generation)
        );
        assert_eq!(
            receipt.delivered_generation,
            Some(retry.execution_generation)
        );
    }

    #[test]
    fn sent_receipt_covers_only_prepared_ids_and_survives_cancellation() {
        let (_directory, store) = store();
        let task = completed_single_task(&store);
        let request = |text| {
            AnnotationDraft::new(
                target().task(&task.id),
                AnnotationAuthor::user("owner"),
                text,
            )
            .request()
        };
        let sent = store
            .submit_task_annotation(&request("Send this request."))
            .unwrap();
        store.queue_annotation_followups().unwrap();
        let running = store.claim_next().unwrap().unwrap();
        store
            .prepare_task_annotations(&task.id, running.execution_generation)
            .unwrap();
        let late = store
            .submit_task_annotation(&request("This arrives after preparation."))
            .unwrap();
        assert!(store
            .mark_task_annotations_delivered(
                &task.id,
                running.execution_generation,
                std::slice::from_ref(&late.id)
            )
            .is_err());
        assert!(store
            .mark_task_annotations_delivered(
                &task.id,
                running.execution_generation + 1,
                std::slice::from_ref(&sent.id)
            )
            .is_err());
        store.request_cancel(&task.id).unwrap();
        // A successful write may finish after cancellation was requested.
        store
            .mark_task_annotations_delivered(
                &task.id,
                running.execution_generation,
                std::slice::from_ref(&sent.id),
            )
            .unwrap();
        store
            .finalize_cancel(&task.id, running.execution_generation)
            .unwrap();
        let receipts = store.annotation_deliveries("p", &task.id).unwrap();
        assert_eq!(
            receipts[0].delivered_generation,
            Some(running.execution_generation)
        );
        assert_eq!(receipts[1].prepared_generation, None);
        assert_eq!(receipts[1].delivered_generation, None);
        // A genuinely new request still gets the existing automatic follow-up.
        assert_eq!(store.queue_annotation_followups().unwrap().len(), 1);
    }

    #[test]
    fn version_eight_receipts_keep_their_historical_delivery_on_migration() {
        let (directory, store) = store();
        let task = completed_single_task(&store);
        store
            .submit_task_annotation(
                &AnnotationDraft::new(
                    target().task(&task.id),
                    AnnotationAuthor::user("owner"),
                    "Historical request.",
                )
                .request(),
            )
            .unwrap();
        store
            .pending_task_annotations(&task.id, task.execution_generation, true)
            .unwrap();
        store
            .open()
            .unwrap()
            .execute_batch(
                "ALTER TABLE research_task_annotation_work DROP COLUMN prepared_generation;
             ALTER TABLE research_task_annotation_work DROP COLUMN prepared_at;
             ALTER TABLE collaboration_work DROP COLUMN reasons_json;
             DROP TABLE collaboration_attentions;
             PRAGMA user_version = 8;",
            )
            .unwrap();
        drop(store);
        let store = TaskStore::new(directory.path().into()).unwrap();
        let receipt = store
            .annotation_deliveries("p", &task.id)
            .unwrap()
            .remove(0);
        assert_eq!(receipt.prepared_generation, Some(task.execution_generation));
        assert_eq!(receipt.prepared_at, receipt.delivered_at);
        assert_eq!(
            receipt.delivered_generation,
            Some(task.execution_generation)
        );
        assert!(store.queue_annotation_followups().unwrap().is_empty());
    }
}
