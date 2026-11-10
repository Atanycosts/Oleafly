use rusqlite::{params, OptionalExtension};

use super::{decode_json, store_error, TaskStore};
use crate::model::{TaskRuntimeEvent, TaskTranscriptEvent};
use crate::observations::{TaskObservationPage, TaskObservationSummary, TaskObservationView};

impl TaskStore {
    /// Resolve an exact, namespaced tool call in its retained generation. This
    /// returns only the immutable event, never a summary of the current task.
    pub fn observation_tool_call(
        &self,
        project_id: &str,
        task_id: &str,
        generation: u64,
        call_id: &str,
    ) -> Result<Option<TaskTranscriptEvent>, String> {
        let generation_sql = i64::try_from(generation).map_err(|_| {
            "The observation generation is outside the supported range.".to_string()
        })?;
        let connection = self.open()?;
        let task = Self::require_on(&connection, task_id)?;
        if task.project_id != project_id {
            return Err("This observation is outside the bound research project.".into());
        }
        connection
            .query_row(
                "SELECT sequence, event_json, created_at FROM research_task_events
                 WHERE task_id = ?1 AND execution_generation = ?2 AND kind = 'observation'
                   AND json_extract(event_json, '$.observation.type') = 'toolExecution'
                   AND json_extract(event_json, '$.observation.callId') = ?3
                 ORDER BY sequence LIMIT 1",
                params![task_id, generation_sql, call_id],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(store_error)?
            .map(|(sequence, encoded, created_at)| {
                Ok(TaskTranscriptEvent {
                    task_id: task_id.into(),
                    execution_generation: generation,
                    sequence,
                    event: decode_json::<TaskRuntimeEvent>(&encoded, "task observation")?,
                    created_at,
                })
            })
            .transpose()
    }

    /// Read one retained observation from any generation without resolving its
    /// source against the task's current generation.
    pub fn observation_event(
        &self,
        project_id: &str,
        task_id: &str,
        generation: u64,
        sequence: u64,
    ) -> Result<Option<TaskTranscriptEvent>, String> {
        if sequence > i64::MAX as u64 {
            return Err("The observation sequence is outside the supported range.".into());
        }
        let connection = self.open()?;
        let task = Self::require_on(&connection, task_id)?;
        if task.project_id != project_id {
            return Err("This observation is outside the bound research project.".into());
        }
        connection
            .query_row(
                "SELECT event_json, created_at FROM research_task_events
                 WHERE task_id = ?1 AND execution_generation = ?2 AND sequence = ?3
                   AND kind = 'observation'",
                params![task_id, generation as i64, sequence as i64],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(store_error)?
            .map(|(encoded, created_at)| {
                Ok(TaskTranscriptEvent {
                    task_id: task_id.into(),
                    execution_generation: generation,
                    sequence,
                    event: decode_json::<TaskRuntimeEvent>(&encoded, "task observation")?,
                    created_at,
                })
            })
            .transpose()
    }

    /// Only immutable observation rows advance this cursor. Transcript segments
    /// can grow in place, and tool detail can be shortened; neither is returned.
    pub fn observations(
        &self,
        project_id: &str,
        task_id: &str,
        generation: u64,
        after_sequence: u64,
        limit: usize,
    ) -> Result<TaskObservationView, String> {
        if !(1..=50).contains(&limit) || after_sequence > i64::MAX as u64 {
            return Err("Use a nonnegative cursor and a limit between 1 and 50.".into());
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(store_error)?;
        let task = Self::require_on(&transaction, task_id)?;
        if task.project_id != project_id || task.execution_generation != generation {
            return Err("This task or generation is outside the bound research session.".into());
        }
        let through: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM research_task_events
             WHERE task_id = ?1 AND execution_generation = ?2",
                params![task_id, generation as i64],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if after_sequence > through as u64 {
            return Err("The cursor is beyond this generation's committed events.".into());
        }
        let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(i64, String, i64)> {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        };
        let decode = |(sequence, encoded, created_at): (i64, String, i64)| {
            Ok(TaskTranscriptEvent {
                task_id: task_id.into(),
                execution_generation: generation,
                sequence: sequence as u64,
                event: decode_json::<TaskRuntimeEvent>(&encoded, "task observation")?,
                created_at,
            })
        };
        let rows = transaction
            .prepare(
                "SELECT sequence, event_json, created_at FROM research_task_events
             WHERE task_id = ?1 AND execution_generation = ?2 AND kind = 'observation'
               AND sequence > ?3 AND sequence <= ?4 ORDER BY sequence LIMIT ?5",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(
                        params![
                            task_id,
                            generation as i64,
                            after_sequence as i64,
                            through,
                            (limit + 1) as i64
                        ],
                        read,
                    )?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        let has_more = rows.len() > limit;
        let events = rows
            .into_iter()
            .take(limit)
            .map(decode)
            .collect::<Result<Vec<_>, String>>()?;
        let latest = |kind: &str| -> Result<Option<TaskTranscriptEvent>, String> {
            transaction
                .query_row(
                    "SELECT sequence, event_json, created_at FROM research_task_events
                 WHERE task_id = ?1 AND execution_generation = ?2 AND kind = 'observation'
                   AND json_extract(event_json, '$.observation.type') = ?3
                 ORDER BY sequence DESC LIMIT 1",
                    params![task_id, generation as i64, kind],
                    read,
                )
                .optional()
                .map_err(store_error)?
                .map(decode)
                .transpose()
        };
        let runtime = latest("runtime")?;
        let usage = latest("usage")?;
        let mut coverage_gaps = vec![
            "observations.recorded_returns_do_not_prove_model_use".into(),
            "observations.external_changes_and_renames_not_attributed".into(),
            "observations.helper_reads_only_and_external_runtimes_not_collected".into(),
            "observations.transcript_is_bounded".into(),
        ];
        let source_retention_exceeded: bool = transaction
            .query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM research_task_events
                    WHERE task_id = ?1 AND execution_generation = ?2 AND kind = 'observation'
                      AND json_extract(event_json, '$.observation.type') = 'toolExecution'
                      AND json_extract(event_json, '$.observation.status') = 'done'
                      AND json_extract(event_json, '$.observation.source.path') IS NOT NULL
                      AND json_extract(event_json, '$.observation.source.snapshotRetained') = 0
                )",
                params![task_id, generation as i64],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if runtime.is_none() {
            coverage_gaps.push("observations.runtime_not_collected".into());
        }
        if task
            .isolation
            .as_ref()
            .is_some_and(|isolation| isolation.initial_git_status.is_none())
        {
            coverage_gaps.push("observations.git_status_not_collected".into());
        }
        if let Some(isolation) = &task.isolation {
            if isolation.initial_git_status.is_some() {
                match isolation.initial_git_status_complete {
                    Some(false) => coverage_gaps.push("observations.git_status_shortened".into()),
                    None => {
                        coverage_gaps.push("observations.git_status_completeness_unknown".into())
                    }
                    Some(true) => {}
                }
            }
        }
        if task
            .isolation
            .as_ref()
            .is_some_and(|isolation| !isolation.skipped.is_empty())
        {
            coverage_gaps.push("observations.baseline_has_skipped_files".into());
        }
        let changes = task
            .result
            .as_ref()
            .map(|result| result.changed_files.as_slice())
            .unwrap_or_default();
        if changes.len() > 50 {
            coverage_gaps.push("observations.file_list_shortened".into());
        }
        if source_retention_exceeded {
            coverage_gaps.push("observations.source_snapshot_not_retained".into());
        }
        let mut evidence = task.evidence;
        if let Some(report) = &mut evidence {
            if report.checks.iter().any(|check| check.items.len() > 10) {
                coverage_gaps.push("observations.check_items_shortened".into());
            }
            for check in &mut report.checks {
                check.items.truncate(10);
            }
        }
        let next_sequence = if has_more {
            events.last().expect("nonempty limited page").sequence
        } else {
            through as u64
        };
        Ok(TaskObservationView {
            summary: TaskObservationSummary {
                task_id: task_id.into(),
                project_id: project_id.into(),
                execution_generation: generation,
                status: task.status,
                goal: task.brief.goal,
                success_criteria: task.brief.success_criteria,
                runtime,
                usage,
                baseline: task.isolation.as_ref().map(Into::into),
                changed_files: changes.iter().take(50).cloned().collect(),
                changed_file_count: changes.len(),
                evidence,
                coverage_gaps,
            },
            page: TaskObservationPage {
                events,
                next_sequence,
                through_sequence: through as u64,
                has_more,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{ResearchTaskDraft, RetryMode, ToolPhase},
        observations::{content_hash, ReadSource, TaskObservation},
    };

    #[test]
    fn tool_call_recovers_exact_historical_source_without_changing_generation_or_records() {
        let directory = tempfile::tempdir().unwrap();
        let store = TaskStore::new(directory.path().join("tasks")).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Historical tool source".into(),
                prompt: "Read exact historical evidence".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let first = store.claim_next().unwrap().unwrap();
        let old_call = "member-session-a:step-0:call_0";
        let new_call = "member-session-b:step-0:call_0";
        let observation = |call: &str, bytes: &[u8]| TaskRuntimeEvent::Observation {
            observation: TaskObservation::ToolExecution {
                call_id: call.into(),
                name: "read_file".into(),
                status: "done".into(),
                input_sha256: content_hash(b"results.md"),
                output_sha256: content_hash(bytes),
                skill_id: None,
                skill_instructions_sha256: None,
                actor: Some("reviewer".into()),
                source: Some(ReadSource {
                    path: "results.md".into(),
                    file_sha256: content_hash(bytes),
                    offset: 0,
                    end_offset: bytes.len(),
                    truncated: false,
                    snapshot_retained: Some(true),
                    pdf: None,
                }),
            },
        };
        let old = store
            .append_event(
                &task.id,
                first.execution_generation,
                &observation(old_call, b"old source A"),
            )
            .unwrap()
            .unwrap();
        // Same call identity on non-execution facts must never resolve as the source.
        store
            .append_event(
                &task.id,
                first.execution_generation,
                &TaskRuntimeEvent::Tool {
                    call_id: Some("transcript-only".into()),
                    name: "read_file".into(),
                    phase: ToolPhase::Result,
                    detail: "Not a retained observation".into(),
                    status: None,
                },
            )
            .unwrap();
        store
            .append_event(
                &task.id,
                first.execution_generation,
                &TaskRuntimeEvent::Observation {
                    observation: TaskObservation::ToolRequested {
                        call_id: "request-only".into(),
                        name: "read_file".into(),
                        input_sha256: content_hash(b"request"),
                        actor: None,
                    },
                },
            )
            .unwrap();
        assert!(store
            .finish_failure(&task.id, first.execution_generation, "fixture restart")
            .unwrap());
        store.retry_with(&task.id, RetryMode::Fresh).unwrap();
        store.request_start(&task.id).unwrap();
        let second = store.claim_next().unwrap().unwrap();
        assert_ne!(first.execution_generation, second.execution_generation);
        let new = store
            .append_event(
                &task.id,
                second.execution_generation,
                &observation(new_call, b"new source B"),
            )
            .unwrap()
            .unwrap();
        let reopened = TaskStore::new(store.root().to_owned()).unwrap();
        let before = reopened.require(&task.id).unwrap();
        assert_eq!(
            reopened
                .observation_tool_call("paper", &task.id, first.execution_generation, old_call)
                .unwrap(),
            Some(old.clone())
        );
        assert_eq!(
            reopened
                .observation_tool_call("paper", &task.id, second.execution_generation, new_call)
                .unwrap(),
            Some(new)
        );
        for (generation, call) in [
            (first.execution_generation, new_call),
            (second.execution_generation, old_call),
            (first.execution_generation, "call_0"),
            (first.execution_generation, "unknown"),
            (first.execution_generation, "transcript-only"),
            (first.execution_generation, "request-only"),
        ] {
            assert!(reopened
                .observation_tool_call("paper", &task.id, generation, call)
                .unwrap()
                .is_none());
        }
        assert!(reopened
            .observation_tool_call("other", &task.id, first.execution_generation, old_call)
            .is_err());
        assert!(reopened
            .observation_tool_call(
                "paper",
                "missing-task",
                first.execution_generation,
                old_call
            )
            .is_err());
        assert!(reopened
            .observation_tool_call("paper", &task.id, u64::MAX, old_call)
            .is_err());
        // Existing session-scoped paging stays restricted to the current generation.
        assert!(reopened
            .observations("paper", &task.id, first.execution_generation, 0, 20)
            .is_err());
        assert_eq!(reopened.require(&task.id).unwrap(), before);
        assert_eq!(
            reopened
                .observation_event("paper", &task.id, first.execution_generation, old.sequence)
                .unwrap(),
            Some(old)
        );
    }
}
