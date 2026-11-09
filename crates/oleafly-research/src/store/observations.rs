use rusqlite::{params, OptionalExtension};

use super::{decode_json, store_error, TaskStore};
use crate::model::{TaskRuntimeEvent, TaskTranscriptEvent};
use crate::observations::{TaskObservationPage, TaskObservationSummary, TaskObservationView};

impl TaskStore {
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
            "observations.helpers_and_external_runtimes_not_collected".into(),
            "observations.transcript_is_bounded".into(),
            "observations.intermediate_source_versions_not_retained".into(),
        ];
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
