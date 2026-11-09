use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;

use super::{decode_json, encode_json, store_error, validate_text, TaskStore};
use crate::collaboration::{ActorKind, GroupActor, GroupObject};
use crate::observations::content_hash;
use crate::workbench::{
    check_only_current_change, CommittedWorkbenchRecord, TaskWorkbenchContext, WorkbenchCurrent,
    WorkbenchReconcileSummary, WorkbenchRecordReceipt, WorkbenchScope,
};

pub(super) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS research_task_workbench_scopes (
 task_id TEXT PRIMARY KEY REFERENCES research_tasks(id) ON DELETE CASCADE,
 scope_json TEXT NOT NULL, current_json TEXT NOT NULL, current_sha256 TEXT NOT NULL,
 current_observation INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_task_workbench_records (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, record_id TEXT NOT NULL, revision TEXT NOT NULL,
 record_json TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL,
 UNIQUE(task_id,kind,record_id,revision)
);
CREATE INDEX IF NOT EXISTS research_task_workbench_records_task
 ON research_task_workbench_records(task_id,sequence);
";

pub(super) const ORIGINS_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS research_task_workbench_check_origins (
 task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
 check_id TEXT NOT NULL, scope_json TEXT NOT NULL, actor_json TEXT NOT NULL,
 PRIMARY KEY(task_id,check_id)
);
";

const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_RECORDS_PER_BATCH: usize = 512;
const MAX_CONTEXT_RECORDS: usize = 100;

fn snapshot_json(value: &Value) -> Result<String, String> {
    let json = encode_json(value)?;
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err(
            "Workbench snapshots must be at most 256 KiB; retain a smaller projection.".into(),
        );
    }
    Ok(json)
}

fn validate_record(record: &CommittedWorkbenchRecord) -> Result<(String, String), String> {
    validate_text(&record.kind, "Workbench record kind", 1, 80)?;
    validate_text(&record.record_id, "Workbench record identity", 1, 512)?;
    validate_text(&record.revision, "Workbench record revision", 1, 512)?;
    validate_text(&record.object.kind, "Workbench object kind", 1, 80)?;
    validate_text(&record.object.id, "Workbench object identity", 1, 1024)?;
    if let Some(revision) = &record.object.revision {
        validate_text(revision, "Workbench object revision", 1, 512)?;
    }
    if let Some(path) = &record.object.path {
        validate_text(path, "Workbench object path", 1, 4096)?;
    }
    let snapshot = snapshot_json(&record.snapshot)?;
    Ok((encode_json(record)?, content_hash(snapshot.as_bytes())))
}

fn check_scope_on(
    connection: &Connection,
    task_id: &str,
    scope: &WorkbenchScope,
) -> Result<(), String> {
    let selected: Option<String> = connection
        .query_row(
            "SELECT scope_json FROM research_task_workbench_scopes WHERE task_id=?1
             UNION ALL SELECT scope_json FROM research_task_workbench_check_origins
             WHERE task_id=?1 LIMIT 1",
            [task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(store_error)?;
    if let Some(selected) = selected {
        if decode_json::<WorkbenchScope>(&selected, "Workbench scope")? != *scope {
            return Err("This task is bound to another Workbench library or project.".into());
        }
    }
    Ok(())
}

impl TaskStore {
    /// Retain a known successful native check's actual member execution before
    /// network reconciliation. This receipt survives a failed sync or restart;
    /// it does not claim authorship when the POST outcome itself was unknown.
    pub fn record_workbench_check_origin(
        &self,
        task_id: &str,
        scope: &WorkbenchScope,
        check_id: &str,
        actor: &GroupActor,
    ) -> Result<(), String> {
        validate_text(&scope.library_root, "Workbench library root", 1, 4096)?;
        validate_text(&scope.project_id, "Workbench project identity", 1, 512)?;
        validate_text(check_id, "Workbench check identity", 1, 512)?;
        let execution = actor
            .execution_id
            .as_deref()
            .filter(|_| actor.kind == ActorKind::Member)
            .ok_or("A Workbench check origin requires an actual member execution.")?;
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let task = Self::require_on(&transaction, task_id)?;
        check_scope_on(&transaction, task_id, scope)?;
        let belongs: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_executions e
                 JOIN collaboration_groups g ON g.id=e.group_id
                 JOIN collaboration_members m ON m.id=e.member_id AND m.group_id=g.id
                 WHERE e.id=?1 AND e.member_id=?2 AND g.task_id=?3 AND g.project_id=?4)",
                params![execution, actor.id, task_id, task.project_id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if !belongs {
            return Err("The check's member execution does not belong to this task.".into());
        }
        let existing: Option<String> = transaction
            .query_row(
                "SELECT actor_json FROM research_task_workbench_check_origins
                 WHERE task_id=?1 AND check_id=?2",
                params![task_id, check_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if let Some(existing) = existing {
            if decode_json::<GroupActor>(&existing, "Workbench check origin")? != *actor {
                return Err("This Workbench check already has a different member origin.".into());
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO research_task_workbench_check_origins
                     (task_id,check_id,scope_json,actor_json) VALUES(?1,?2,?3,?4)",
                    params![task_id, check_id, encode_json(scope)?, encode_json(actor)?],
                )
                .map_err(store_error)?;
        }
        transaction.commit().map_err(store_error)
    }

    /// Reconcile an explicitly enumerated batch of committed Workbench records.
    /// The caller reads and validates the external records before invoking this
    /// method. Scope selection, receipts, current projection and event routing
    /// commit together; a failure can safely be followed by a complete rescan.
    pub fn reconcile_workbench(
        &self,
        task_id: &str,
        scope: &WorkbenchScope,
        records: &[CommittedWorkbenchRecord],
        current: Value,
    ) -> Result<WorkbenchReconcileSummary, String> {
        validate_text(&scope.library_root, "Workbench library root", 1, 4096)?;
        validate_text(&scope.project_id, "Workbench project identity", 1, 512)?;
        if records.len() > MAX_RECORDS_PER_BATCH {
            return Err("Reconcile at most 512 Workbench records per batch.".into());
        }
        let prepared = records
            .iter()
            .map(validate_record)
            .collect::<Result<Vec<_>, _>>()?;
        let scope_json = encode_json(scope)?;
        let current_json = snapshot_json(&current)?;
        let current_sha256 = content_hash(current_json.as_bytes());
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let task = Self::require_on(&transaction, task_id)?;
        check_scope_on(&transaction, task_id, scope)?;
        let previous: Option<(String, String, u64)> = transaction
            .query_row(
                "SELECT current_json,current_sha256,current_observation
                 FROM research_task_workbench_scopes WHERE task_id=?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(store_error)?;
        let current_changed = previous
            .as_ref()
            .is_some_and(|(_, digest, _)| digest != &current_sha256);
        let current_observation = previous
            .as_ref()
            .map_or(1, |(_, _, sequence)| sequence + u64::from(current_changed));
        let group: Option<String> = transaction
            .query_row(
                "SELECT id FROM collaboration_groups WHERE task_id=?1 AND project_id=?2",
                params![task_id, task.project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        let system = GroupActor {
            kind: ActorKind::System,
            id: "workbench".into(),
            execution_id: None,
        };
        let origins: BTreeMap<String, GroupActor> = transaction
            .prepare(
                "SELECT check_id,actor_json FROM research_task_workbench_check_origins
                 WHERE task_id=?1",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([task_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?
            .into_iter()
            .map(|(check, actor)| Ok((check, decode_json(&actor, "Workbench check origin")?)))
            .collect::<Result<_, String>>()?;
        let current_origin = previous
            .as_ref()
            .map(|(json, _, _)| decode_json::<Value>(json, "Workbench current snapshot"))
            .transpose()?
            .and_then(|before| check_only_current_change(&before, &current))
            .and_then(|checks| {
                let mut actors = checks.iter().map(|id| origins.get(id));
                let first = actors.next().flatten()?;
                actors.all(|actor| actor == Some(first)).then_some(first)
            });
        let mut recorded = 0;
        let mut duplicates = 0;
        let mut routed_members = BTreeSet::new();
        for (record, (record_json, snapshot_sha256)) in records.iter().zip(&prepared) {
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT record_json FROM research_task_workbench_records
                     WHERE task_id=?1 AND kind=?2 AND record_id=?3 AND revision=?4",
                    params![task_id, record.kind, record.record_id, record.revision],
                    |row| row.get(0),
                )
                .optional()
                .map_err(store_error)?;
            match existing {
                Some(existing) => {
                    if existing != *record_json {
                        return Err(format!(
                            "Workbench record {}:{} revision {} identifies different content.",
                            record.kind, record.record_id, record.revision
                        ));
                    }
                    duplicates += 1;
                }
                None => {
                    transaction
                        .execute(
                            "INSERT INTO research_task_workbench_records
                             (task_id,kind,record_id,revision,record_json,snapshot_sha256)
                             VALUES (?1,?2,?3,?4,?5,?6)",
                            params![
                                task_id,
                                record.kind,
                                record.record_id,
                                record.revision,
                                record_json,
                                snapshot_sha256
                            ],
                        )
                        .map_err(store_error)?;
                    recorded += 1;
                }
            }
            if let Some(group) = &group {
                let actor = if record.kind == "check" {
                    origins.get(&record.record_id).unwrap_or(&system)
                } else {
                    &system
                };
                let key = content_hash(
                    encode_json(&(
                        "workbench_record",
                        scope,
                        &record.kind,
                        &record.record_id,
                        &record.revision,
                    ))?
                    .as_bytes(),
                );
                routed_members.extend(super::collaboration::record_group_event_on(
                    &transaction,
                    &task.project_id,
                    group,
                    &format!("workbench-record:{key}"),
                    record.event_kind.as_str(),
                    &record.object,
                    actor,
                    &format!(
                        "Observed committed Workbench {} {} at revision {}; retained snapshot SHA-256 {}. Workbench remains authoritative for applicability.",
                        record.kind, record.record_id, record.revision, snapshot_sha256
                    ),
                )?);
            }
        }
        transaction
            .execute(
                "INSERT INTO research_task_workbench_scopes
                 (task_id,scope_json,current_json,current_sha256,current_observation)
                 VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT(task_id) DO UPDATE SET current_json=excluded.current_json,
                 current_sha256=excluded.current_sha256,current_observation=excluded.current_observation",
                params![task_id, scope_json, current_json, current_sha256, current_observation],
            )
            .map_err(store_error)?;
        if current_changed {
            if let Some(group) = &group {
                let object_id = scope.object_id();
                routed_members.extend(super::collaboration::record_group_event_on(
                    &transaction,
                    &task.project_id,
                    group,
                    &format!("workbench-current:{object_id}:{current_observation}"),
                    "workbench_current_changed",
                    &GroupObject {
                        kind: "journal_project".into(),
                        id: object_id,
                        revision: Some(current_sha256),
                        path: None,
                    },
                    current_origin.unwrap_or(&system),
                    "The last successful Workbench projection changed. Discover journal_ tools if needed and read journal_context for the observed snapshot; this notification does not infer staleness or change a binding.",
                )?);
            }
        }
        let next_sequence = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM research_task_workbench_records WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(WorkbenchReconcileSummary {
            recorded,
            duplicates,
            current_changed,
            routed_members: routed_members.into_iter().collect(),
            next_sequence,
        })
    }

    /// Read bounded retained receipts and the last successful current projection.
    /// The cursor follows local receipts, not timestamps or Workbench history.
    pub fn task_workbench_context(
        &self,
        task_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<TaskWorkbenchContext, String> {
        let after = i64::try_from(after_sequence)
            .map_err(|_| "The Workbench context cursor is invalid.".to_string())?;
        let limit = limit.clamp(1, MAX_CONTEXT_RECORDS);
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(store_error)?;
        Self::require_on(&transaction, task_id)?;
        let selected: Option<(String, String, String, u64)> = transaction
            .query_row(
                "SELECT scope_json,current_json,current_sha256,current_observation
                 FROM research_task_workbench_scopes WHERE task_id=?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(store_error)?;
        let (scope, current) = match selected {
            Some((scope, current, digest, sequence)) => {
                if content_hash(current.as_bytes()) != digest {
                    return Err("The retained Workbench current snapshot changed.".into());
                }
                (
                    Some(decode_json(&scope, "Workbench scope")?),
                    Some(WorkbenchCurrent {
                        observation_sequence: sequence,
                        snapshot: decode_json(&current, "Workbench current snapshot")?,
                        snapshot_sha256: digest,
                    }),
                )
            }
            None => (None, None),
        };
        let rows = transaction
            .prepare(
                "SELECT sequence,record_json,snapshot_sha256
                 FROM research_task_workbench_records WHERE task_id=?1 AND sequence>?2
                 ORDER BY sequence LIMIT ?3",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![task_id, after, limit + 1], |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        let has_more = rows.len() > limit;
        let records = rows
            .into_iter()
            .take(limit)
            .map(|(sequence, json, digest)| {
                let record: CommittedWorkbenchRecord = decode_json(&json, "Workbench record")?;
                if content_hash(encode_json(&record.snapshot)?.as_bytes()) != digest {
                    return Err("The retained Workbench record snapshot changed.".into());
                }
                Ok(WorkbenchRecordReceipt {
                    sequence,
                    record,
                    snapshot_sha256: digest,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let next_sequence = records.last().map_or(after_sequence, |row| row.sequence);
        Ok(TaskWorkbenchContext {
            task_id: task_id.into(),
            scope,
            records,
            current,
            next_sequence,
            has_more,
        })
    }
}

#[cfg(test)]
mod tests;
