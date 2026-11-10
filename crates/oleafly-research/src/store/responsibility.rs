use super::*;
use crate::responsibility::{
    ResponsibilityAssessment, ResponsibilityBatch, ResponsibilityInput, BATCH_SIZE, MAX_BATCH_BYTES,
};

pub(in crate::store) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS collaboration_responsibility_receipts (
 event_id TEXT PRIMARY KEY REFERENCES collaboration_events(id) ON DELETE CASCADE,
 assessment_id TEXT REFERENCES collaboration_events(id)
);
";

fn eligible_on(
    connection: &Connection,
    group: &str,
    event: &GroupEvent,
    members: &[GroupMember],
) -> Result<Vec<String>, String> {
    let work = work_on(connection, group)?;
    let attentions = attention::list_on(connection, group)?;
    let checkpoint = checkpoints::open_on(connection, group)?;
    Ok(members
        .iter()
        .filter(|member| {
            !member.paused
                && checkpoint
                    .as_ref()
                    .is_none_or(|(_, checkpoint)| checkpoint.member_id != member.id)
                && member.id != event.author.id
                && !work.iter().any(|w| {
                    w.member_id == member.id && w.cause_kind == "event" && w.cause_id == event.id
                })
                && !work.iter().any(|w| {
                    w.member_id == member.id
                        && w.cause_kind == "annotation"
                        && event.evidence.as_ref().and_then(|v| v["id"].as_str())
                            == Some(w.cause_id.as_str())
                })
                && !(event.kind == "file_changed"
                    && attentions.iter().any(|a| {
                        a.member_id == member.id
                            && a.object == event.object
                            && matches!(a.relation.as_str(), "read" | "wrote")
                    }))
        })
        .map(|member| member.id.clone())
        .collect())
}

impl TaskStore {
    pub fn responsibility_batch(
        &self,
        task: &ResearchTask,
    ) -> Result<Option<ResponsibilityBatch>, String> {
        let connection = self.open()?;
        let Some(group) = self.task_group(&task.project_id, &task.id)? else {
            return Ok(None);
        };
        if group.status != GroupStatus::Open {
            return Ok(None);
        }
        let members = members_on(&connection, &group.id)?;
        let checkpoint = checkpoints::open_on(&connection, &group.id)?;
        if members
            .iter()
            .any(|member| member.config.coordinator && member.paused)
        {
            return Ok(None);
        }
        let rows = connection.prepare("SELECT e.rowid,e.event_json FROM collaboration_events e JOIN collaboration_responsibility_receipts r ON r.event_id=e.id WHERE e.group_id=?1 AND r.assessment_id IS NULL ORDER BY e.rowid LIMIT ?2")
            .and_then(|mut q|q.query_map(params![group.id,BATCH_SIZE as i64],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let inputs = rows
            .into_iter()
            .map(|(sequence, value)| {
                let mut event: GroupEvent = decode_json(&value, "responsibility event")?;
                event.sequence = sequence;
                let eligible_member_ids = eligible_on(&connection, &group.id, &event, &members)?;
                Ok(ResponsibilityInput {
                    event,
                    eligible_member_ids,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut batch = ResponsibilityBatch {
            members,
            inputs: Vec::new(),
        };
        for input in inputs {
            if checkpoint.as_ref().is_some_and(|(_, checkpoint)| {
                !checkpoint.receipt_event_ids.contains(&input.event.id)
            }) {
                continue;
            }
            batch.inputs.push(input);
            if encode_json(&batch)?.len() > MAX_BATCH_BYTES {
                batch.inputs.pop();
                if batch.inputs.is_empty() {
                    return Err("A responsibility input exceeds the bounded context limit.".into());
                }
                break;
            }
        }
        Ok((!batch.inputs.is_empty()).then_some(batch))
    }

    /// Commit interpretation, every input receipt and routed work together.
    /// An incomplete model call leaves all inputs available for an explicit retry.
    pub fn commit_responsibility_assessment(
        &self,
        task: &ResearchTask,
        batch: &ResponsibilityBatch,
        assessment: &ResponsibilityAssessment,
    ) -> Result<bool, String> {
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let current = Self::require_on(&tx, &task.id)?;
        if current.execution_generation != task.execution_generation
            || current.status != ResearchTaskStatus::Running
            || current.cancel_requested
        {
            return Err("Responsibility assessment belongs to an inactive execution.".into());
        }
        let group_id: Option<String> = tx
            .query_row(
                "SELECT id FROM collaboration_groups WHERE task_id=?1 AND status='open'",
                [&task.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_error)?;
        let Some(group_id) = group_id else {
            return Ok(false);
        };
        let members = members_on(&tx, &group_id)?;
        if members
            .iter()
            .any(|member| member.config.coordinator && member.paused)
        {
            return Ok(false);
        }
        for input in &batch.inputs {
            let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_responsibility_receipts r JOIN collaboration_events e ON e.id=r.event_id WHERE r.event_id=?1 AND e.group_id=?2 AND r.assessment_id IS NULL)",params![input.event.id,group_id],|r|r.get(0)).map_err(store_error)?;
            if !pending {
                return Err(
                    "A responsibility input was already consumed or belongs to another group."
                        .into(),
                );
            }
            if event_on(&tx, &group_id, &input.event.id)?.as_ref() != Some(&input.event) {
                return Err("The responsibility input does not match its retained event.".into());
            }
        }
        if assessment.error.is_some() {
            let id = fresh_id("assessment-failed");
            let event = GroupEvent {
                sequence: 0,
                id: id.clone(),
                group_id: group_id.clone(),
                kind: "responsibility_assessment_failed".into(),
                object: GroupObject {
                    kind: "responsibility_batch".into(),
                    id: id.clone(),
                    ..Default::default()
                },
                author: GroupActor {
                    kind: ActorKind::System,
                    id: "responsibility-runtime".into(),
                    execution_id: None,
                },
                detail: assessment.error.clone().unwrap(),
                evidence: Some(
                    serde_json::json!({"inputEventIds":batch.inputs.iter().map(|i|&i.event.id).collect::<Vec<_>>(),"assessment":assessment}),
                ),
                created_at: now_ms(),
            };
            tx.execute("INSERT INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?1,?3)",params![id,group_id,encode_json(&event)?]).map_err(store_error)?;
            tx.commit().map_err(store_error)?;
            return Ok(true);
        }
        if assessment.response.decisions.len() > batch.inputs.len() * members.len() {
            return Err("The responsibility response has too many decisions.".into());
        }
        for decision in &assessment.response.decisions {
            let input = batch
                .inputs
                .iter()
                .find(|input| input.event.id == decision.event_id)
                .ok_or("The responsibility response references an event outside this batch.")?;
            if !input.eligible_member_ids.contains(&decision.member_id) {
                return Err("The responsibility response references an ineligible member.".into());
            }
            validate_text(&decision.reason, "Responsibility reason", 1, 1200)?;
        }
        let id = fresh_id("assessment");
        let delivered = assessment
            .response
            .decisions
            .iter()
            .filter(|decision| {
                batch
                    .inputs
                    .iter()
                    .find(|i| i.event.id == decision.event_id)
                    .is_some_and(|input| {
                        eligible_on(&tx, &group_id, &input.event, &members)
                            .is_ok_and(|ids| ids.contains(&decision.member_id))
                    })
            })
            .count();
        let event = GroupEvent {
            sequence: 0,
            id: id.clone(),
            group_id: group_id.clone(),
            kind: "responsibility_assessed".into(),
            object: GroupObject {
                kind: "responsibility_batch".into(),
                id: id.clone(),
                ..Default::default()
            },
            author: GroupActor {
                kind: ActorKind::System,
                id: "responsibility-runtime".into(),
                execution_id: None,
            },
            detail: format!(
                "{} retained changes assessed, {} proposed matches, {} new deliveries.",
                batch.inputs.len(),
                assessment.response.decisions.len(),
                delivered
            ),
            evidence: Some(
                serde_json::json!({"inputEventIds":batch.inputs.iter().map(|i|&i.event.id).collect::<Vec<_>>(),"requestSha256":crate::observations::content_hash(encode_json(batch)?.as_bytes()),"assessment":assessment}),
            ),
            created_at: now_ms(),
        };
        tx.execute("INSERT INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?1,?3)",params![id,group_id,encode_json(&event)?]).map_err(store_error)?;
        for decision in &assessment.response.decisions {
            let input = batch
                .inputs
                .iter()
                .find(|input| input.event.id == decision.event_id)
                .unwrap();
            if eligible_on(&tx, &group_id, &input.event, &members)?.contains(&decision.member_id) {
                let priority = if input.event.author.kind == ActorKind::User {
                    100
                } else {
                    30
                };
                let (kind, cause) = if input.event.kind == "annotation_requested" {
                    (
                        "annotation",
                        input
                            .event
                            .evidence
                            .as_ref()
                            .and_then(|v| v["id"].as_str())
                            .ok_or("The annotation event has no retained annotation identity.")?,
                    )
                } else {
                    ("event", decision.event_id.as_str())
                };
                insert_work_on(
                    &tx,
                    &group_id,
                    &decision.member_id,
                    kind,
                    cause,
                    priority,
                    &[WorkReason {
                        kind: "responsibility".into(),
                        detail: Some(decision.reason.clone()),
                        object: Some(input.event.object.clone()),
                        source_id: Some(id.clone()),
                        execution_id: None,
                    }],
                )?;
            }
        }
        for input in &batch.inputs {
            tx.execute("UPDATE collaboration_responsibility_receipts SET assessment_id=?2 WHERE event_id=?1",params![input.event.id,id]).map_err(store_error)?;
        }
        tx.commit().map_err(store_error)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::responsibility::{ResponsibilityDecision, ResponsibilityResponse};

    fn fixture() -> (tempfile::TempDir, TaskStore, ResearchTask, GroupSnapshot) {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::new(root.path().join("tasks")).unwrap();
        let task = store
            .create(crate::test_support::draft(
                "project",
                "Responsibility participation",
            ))
            .unwrap();
        store.request_start(&task.id).unwrap();
        let task = store.claim_next().unwrap().unwrap();
        let group = store
            .create_task_group(
                "project",
                Some(&task.id),
                &[true, false].map(|coordinator| MemberDraft {
                    name: if coordinator {
                        "Coordinator"
                    } else {
                        "Methods"
                    }
                    .into(),
                    responsibility: if coordinator {
                        "Deliver the change"
                    } else {
                        "Check experimental validity and counterexamples"
                    }
                    .into(),
                    runtime_id: "builtin".into(),
                    agent_id: "fixture".into(),
                    model_id: "fixture".into(),
                    coordinator,
                    ..Default::default()
                }),
            )
            .unwrap();
        (root, store, task, group)
    }
    fn file(revision: &str) -> GroupObject {
        GroupObject {
            kind: "file".into(),
            id: "main.tex".into(),
            revision: Some(revision.into()),
            path: Some("main.tex".into()),
        }
    }
    fn assessment(batch: &ResponsibilityBatch, member: &str) -> ResponsibilityAssessment {
        ResponsibilityAssessment {
            provider_id: Some("fixture".into()),
            model_id: Some("fixture".into()),
            effort: None,
            response: ResponsibilityResponse {
                decisions: vec![ResponsibilityDecision {
                    event_id: batch.inputs[0].event.id.clone(),
                    member_id: member.into(),
                    reason: "The new comparison uses a different dataset split.".into(),
                }],
            },
            input_tokens: Some(40),
            output_tokens: Some(8),
            error: None,
        }
    }

    #[test]
    fn responsibility_routes_an_unmentioned_unread_member_once_and_survives_reopen() {
        let (_root, store, task, group) = fixture();
        let member = &group
            .members
            .iter()
            .find(|m| !m.config.coordinator)
            .unwrap()
            .id;
        store
            .record_group_file_change("project", &group.group.id, &file("h1"))
            .unwrap();
        let batch = store.responsibility_batch(&task).unwrap().unwrap();
        assert!(batch.inputs[0].eligible_member_ids.contains(member));
        store
            .commit_responsibility_assessment(&task, &batch, &assessment(&batch, member))
            .unwrap();
        let reopened = TaskStore::new(store.root().to_path_buf()).unwrap();
        assert!(reopened.responsibility_batch(&task).unwrap().is_none());
        let snapshot = reopened
            .group_snapshot("project", &group.group.id, 0)
            .unwrap();
        let work = snapshot
            .work
            .iter()
            .find(|w| w.member_id == *member)
            .unwrap();
        assert_eq!(work.reasons[0].kind, "responsibility");
        assert!(work.reasons[0]
            .detail
            .as_ref()
            .unwrap()
            .contains("dataset split"));
        assert!(snapshot.attentions.is_empty());
        assert!(reopened
            .commit_responsibility_assessment(&task, &batch, &assessment(&batch, member))
            .is_err());
        for revision in ["h2", "h1"] {
            reopened
                .record_group_file_change("project", &group.group.id, &file(revision))
                .unwrap();
        }
        assert_eq!(
            reopened
                .responsibility_batch(&task)
                .unwrap()
                .unwrap()
                .inputs
                .len(),
            2
        );
    }

    #[test]
    fn responsibility_invalid_model_targets_roll_back_and_coordination_is_not_an_input() {
        let (_root, store, task, group) = fixture();
        let path = format!("{}/handoff.md", task.record_dir());
        store
            .record_group_file_change(
                "project",
                &group.group.id,
                &GroupObject {
                    kind: "file".into(),
                    id: path.clone(),
                    revision: Some("h1".into()),
                    path: Some(path),
                },
            )
            .unwrap();
        assert!(store.responsibility_batch(&task).unwrap().is_none());
        store
            .record_group_file_change("project", &group.group.id, &file("h1"))
            .unwrap();
        let batch = store.responsibility_batch(&task).unwrap().unwrap();
        let before = store.group_snapshot("project", &group.group.id, 0).unwrap();
        assert!(store
            .commit_responsibility_assessment(&task, &batch, &assessment(&batch, "foreign-member"))
            .is_err());
        let after = store.group_snapshot("project", &group.group.id, 0).unwrap();
        assert_eq!(before.events.len(), after.events.len());
        assert_eq!(before.work, after.work);
        assert_eq!(
            store
                .responsibility_batch(&task)
                .unwrap()
                .unwrap()
                .inputs
                .len(),
            1
        );
    }

    #[test]
    fn responsibility_commit_rechecks_group_and_coordinator_pause_in_transaction() {
        let (_root, store, task, group) = fixture();
        let coordinator = group.members.iter().find(|m| m.config.coordinator).unwrap();
        let member = group
            .members
            .iter()
            .find(|m| !m.config.coordinator)
            .unwrap();
        store
            .record_group_file_change("project", &group.group.id, &file("h1"))
            .unwrap();
        let batch = store.responsibility_batch(&task).unwrap().unwrap();
        let response = assessment(&batch, &member.id);
        for status in [GroupStatus::Paused, GroupStatus::Closed] {
            store
                .set_group_status("project", &group.group.id, status)
                .unwrap();
            assert!(!store
                .commit_responsibility_assessment(&task, &batch, &response)
                .unwrap());
        }
        store
            .set_group_status("project", &group.group.id, GroupStatus::Open)
            .unwrap();
        store
            .set_member_paused("project", &group.group.id, &coordinator.id, true)
            .unwrap();
        assert!(!store
            .commit_responsibility_assessment(&task, &batch, &response)
            .unwrap());
        let retained = store.group_snapshot("project", &group.group.id, 0).unwrap();
        assert!(retained.work.is_empty());
        assert!(!retained
            .events
            .iter()
            .any(|e| e.kind.starts_with("responsibility_")));
        store
            .set_member_paused("project", &group.group.id, &coordinator.id, false)
            .unwrap();
        assert_eq!(
            store.responsibility_batch(&task).unwrap().unwrap().inputs[0]
                .event
                .id,
            batch.inputs[0].event.id
        );
        assert!(store
            .commit_responsibility_assessment(&task, &batch, &response)
            .unwrap());
        assert!(store.responsibility_batch(&task).unwrap().is_none());
    }

    #[test]
    fn responsibility_annotation_work_keeps_original_user_request_and_priority() {
        let (_root, store, task, group) = fixture();
        let member = &group
            .members
            .iter()
            .find(|m| !m.config.coordinator)
            .unwrap()
            .id;
        let annotation = store
            .group_annotation(
                &group.group.id,
                &crate::annotations::AnnotationDraft::new(
                    crate::annotations::AnnotationTarget::new("project", "file", "main.tex")
                        .task(&task.id)
                        .at_path("main.tex"),
                    crate::annotations::AnnotationAuthor::user("user"),
                    "This old decision missed a counterexample. Recheck it.",
                )
                .request(),
            )
            .unwrap();
        let batch = store.responsibility_batch(&task).unwrap().unwrap();
        assert!(batch.inputs[0].event.detail.contains("counterexample"));
        store
            .commit_responsibility_assessment(&task, &batch, &assessment(&batch, member))
            .unwrap();
        let turn = store.claim_member_turn(&task).unwrap().unwrap();
        assert_eq!(turn.work[0].priority, 100);
        // Whichever equal-priority member claims first, its cause must resolve the original annotation.
        assert!(turn
            .annotations
            .iter()
            .any(|a| a.id == annotation.id && a.is_user_request()));
        assert!(
            store
                .group_snapshot("project", &group.group.id, 0)
                .unwrap()
                .work
                .iter()
                .filter(|w| w.cause_id == annotation.id)
                .count()
                >= 2
        );
    }
}
