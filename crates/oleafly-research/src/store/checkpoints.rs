use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Checkpoint {
    pub execution_id: String,
    pub member_id: String,
    pub work_ids: Vec<String>,
    pub receipt_event_ids: Vec<String>,
    pub colleague_work_ids: Vec<String>,
}

pub(super) fn open_on(
    connection: &Connection,
    group: &str,
) -> Result<Option<(GroupEvent, Checkpoint)>, String> {
    let value: Option<(u64, String)> = connection
        .query_row(
            "SELECT e.rowid,e.event_json FROM collaboration_events e
             WHERE e.group_id=?1 AND json_extract(e.event_json,'$.kind')='member_checkpointed'
               AND EXISTS(SELECT 1 FROM collaboration_work w WHERE w.group_id=e.group_id
                 AND w.status='\"checkpointed\"'
                 AND w.execution_id=json_extract(e.event_json,'$.evidence.executionId'))
             ORDER BY e.rowid LIMIT 1",
            [group],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(store_error)?;
    value
        .map(|(sequence, json)| {
            let mut event: GroupEvent = decode_json(&json, "member checkpoint")?;
            event.sequence = sequence;
            let checkpoint = serde_json::from_value(
                event
                    .evidence
                    .clone()
                    .ok_or("The checkpoint has no retained inputs.")?,
            )
            .map_err(|error| error.to_string())?;
            Ok((event, checkpoint))
        })
        .transpose()
}

fn pending_colleagues_on(
    connection: &Connection,
    group: &str,
    owner: &str,
) -> Result<Vec<String>, String> {
    connection
        .prepare(
            "SELECT w.id FROM collaboration_work w JOIN collaboration_members m ON m.id=w.member_id
             WHERE w.group_id=?1 AND w.member_id<>?2 AND m.paused=0
               AND w.status='\"pending\"'
             ORDER BY w.priority DESC,w.created_at,w.id",
        )
        .and_then(|mut query| {
            query
                .query_map(params![group, owner], |row| row.get(0))?
                .collect()
        })
        .map_err(store_error)
}

fn unfinished_colleagues_on(
    connection: &Connection,
    group: &str,
    owner: &str,
    current_work_ids: &[String],
) -> Result<Vec<String>, String> {
    let work = work_on(connection, group)?;
    let paused = members_on(connection, group)?
        .into_iter()
        .filter(|member| member.paused)
        .map(|member| member.id)
        .collect::<BTreeSet<_>>();
    let mut upstream = current_work_ids.iter().cloned().collect::<BTreeSet<_>>();
    loop {
        let before = upstream.len();
        for item in work
            .iter()
            .filter(|work| work.status == WorkStatus::Waiting)
        {
            if item
                .waits
                .iter()
                .flat_map(|wait| &wait.work)
                .any(|dependency| upstream.contains(&dependency.work_id))
            {
                upstream.insert(item.id.clone());
            }
        }
        if upstream.len() == before {
            break;
        }
    }
    Ok(work
        .into_iter()
        .filter(|work| {
            work.member_id != owner
                && !paused.contains(&work.member_id)
                && !upstream.contains(&work.id)
                && (work.status == WorkStatus::Pending
                    || (work.status == WorkStatus::Waiting && !work.waits.is_empty()))
        })
        .map(|work| work.id)
        .collect())
}

pub(super) fn pending_receipts_on(
    connection: &Connection,
    checkpoint: &Checkpoint,
) -> Result<bool, String> {
    for id in &checkpoint.receipt_event_ids {
        let pending = connection.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_responsibility_receipts WHERE event_id=?1 AND assessment_id IS NULL)",[id],|row|row.get::<_,bool>(0)).map_err(store_error)?;
        if pending {
            return Ok(true);
        }
    }
    Ok(false)
}

fn receipt_work_on(
    connection: &Connection,
    group: &str,
    checkpoint: &Checkpoint,
) -> Result<Vec<GroupWork>, String> {
    let mut causes = Vec::new();
    for id in &checkpoint.receipt_event_ids {
        let event =
            event_on(connection, group, id)?.ok_or("A checkpoint input no longer exists.")?;
        let cause = if event.kind == "annotation_requested" {
            (
                "annotation",
                event
                    .evidence
                    .as_ref()
                    .and_then(|v| v["id"].as_str())
                    .ok_or("The checkpoint annotation has no retained identity.")?
                    .to_owned(),
            )
        } else {
            ("event", id.clone())
        };
        causes.push(cause);
    }
    Ok(work_on(connection, group)?
        .into_iter()
        .filter(|work| {
            work.member_id != checkpoint.member_id
                && (checkpoint.colleague_work_ids.contains(&work.id)
                    || causes
                        .iter()
                        .any(|(kind, id)| work.cause_kind == *kind && work.cause_id == *id))
        })
        .collect())
}

pub(super) fn release_ready_on(tx: &Transaction<'_>, group: &TaskGroup) -> Result<(), String> {
    let Some((event, checkpoint)) = open_on(tx, &group.id)? else {
        return Ok(());
    };
    for id in &checkpoint.receipt_event_ids {
        let pending: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM collaboration_responsibility_receipts WHERE event_id=?1 AND assessment_id IS NULL)",
            [id], |row| row.get(0),
        ).map_err(store_error)?;
        if pending {
            return Ok(());
        }
    }
    let work = receipt_work_on(tx, &group.id, &checkpoint)?;
    if work.iter().any(|work| {
        matches!(
            work.status,
            WorkStatus::Pending | WorkStatus::Running | WorkStatus::Waiting
        )
    }) {
        return Ok(());
    }
    let handoff = work
        .iter()
        .map(|work| {
            let legacy_summary = if work.resolution.is_none() {
                work.result_message_id
                    .as_deref()
                    .map(|id| message_on(tx, &group.id, id))
                    .transpose()?
                    .map(|message| message.content.body)
            } else {
                None
            };
            Ok(
                serde_json::json!({"workId":work.id,"memberId":work.member_id,"status":work.status,
            "executionId":work.execution_id,"resultMessageId":work.result_message_id,
            "summary":work.resolution.as_ref().map(|resolution|&resolution.summary)
                .or(legacy_summary.as_ref()),
            "resultRefs":work.resolution.as_ref().map(|resolution|&resolution.result_refs)}),
            )
        })
        .collect::<Result<Vec<_>, String>>()?;
    let id = fresh_id("checkpoint-resumed");
    let resumed = GroupEvent {
        sequence: 0,
        id: id.clone(),
        group_id: group.id.clone(),
        kind: "member_checkpoint_resumed".into(),
        object: GroupObject { kind: "member_checkpoint".into(), id: event.id.clone(), ..Default::default() },
        author: GroupActor { kind: ActorKind::System, id: "group-runtime".into(), execution_id: None },
        detail: "Continue the retained work after the colleague handoff. Check each result status and current sources before using its conclusion.".into(),
        evidence: Some(serde_json::json!({"checkpointId":event.id,"receiptEventIds":checkpoint.receipt_event_ids,"handoff":handoff})),
        created_at: now_ms(),
    };
    tx.execute(
        "UPDATE collaboration_work SET status='\"pending\"',execution_id=NULL,updated_at=?2 WHERE execution_id=?1 AND status='\"checkpointed\"'",
        params![checkpoint.execution_id, now_ms()],
    ).map_err(store_error)?;
    tx.execute(
        "INSERT INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?1,?3)",
        params![id, group.id, encode_json(&resumed)?],
    )
    .map_err(store_error)?;
    insert_work_on(
        tx,
        &group.id,
        &checkpoint.member_id,
        "event",
        &id,
        40,
        &[WorkReason {
            kind: "checkpoint_resume".into(),
            detail: Some(resumed.detail),
            object: Some(resumed.object),
            source_id: Some(id.clone()),
            execution_id: Some(checkpoint.execution_id),
        }],
    )?;
    Ok(())
}

impl TaskStore {
    pub fn park_member_checkpoint(&self, task: &ResearchTask) -> Result<bool, String> {
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let current = Self::require_on(&tx, &task.id)?;
        let budget_stopped = matches!(
            current.stop_reason,
            Some(
                crate::model::StopReason::BudgetTime
                    | crate::model::StopReason::BudgetCost
                    | crate::model::StopReason::BudgetRuns
            )
        );
        let Some(group) = self.task_group(&task.project_id, &task.id)? else {
            return Ok(false);
        };
        let pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_work w
                 JOIN collaboration_members m ON m.id=w.member_id
                 WHERE w.group_id=?1
                   AND (w.status IN ('\"waiting\"','\"checkpointed\"')
                        OR (w.status='\"pending\"' AND m.paused=1)))",
                [&group.id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if !pending || budget_stopped {
            return Ok(false);
        }
        let isolation = current
            .isolation
            .ok_or("The checkpoint workspace is unavailable.")?;
        let pending = PendingStart::Resume {
            isolation: Box::new(isolation),
            reason: ResumeReason::Collaboration,
            previous_native_session_id: None,
        };
        let changed=tx.execute("UPDATE research_tasks SET status='queued',start_requested=0,pending_start_json=?3,phase=NULL,updated_at=?4 WHERE id=?1 AND execution_generation=?2 AND status IN ('running','awaiting_review','completed') AND cancel_requested=0 AND apply_state IS NULL",params![task.id,task.execution_generation,encode_json(&pending)?,now_ms()]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(changed == 1)
    }
    pub fn member_checkpoint_request(
        &self,
        turn: &MemberTurn,
    ) -> Result<Option<MemberCheckpointRequest>, String> {
        let connection = self.open()?;
        let group = group_on(&connection, &turn.group.project_id, &turn.group.id)?;
        if group.status != GroupStatus::Open || open_on(&connection, &group.id)?.is_some() {
            return Ok(None);
        }
        let task_id = group
            .task_id
            .as_deref()
            .ok_or("A member checkpoint needs a task.")?;
        let task = Self::require_on(&connection, task_id)?;
        if task.status != ResearchTaskStatus::Running || task.cancel_requested {
            return Ok(None);
        }
        let running = member_turn_on(
            &connection,
            group.clone(),
            turn.member.clone(),
            turn.execution.clone(),
        )?
        .work;
        if running.is_empty()
            && super::work_settlement::execution_has_settlements_on(
                &connection,
                &turn.execution.id,
            )?
        {
            return Ok(None);
        }
        let semantic = members_on(&connection, &group.id)?.iter().any(|member| {
            member.config.coordinator && member.config.runtime_id == "builtin" && !member.paused
        });
        let batch = if semantic {
            self.responsibility_batch(&task)?
        } else {
            None
        };
        let event_ids: Vec<String> = batch
            .as_ref()
            .filter(|batch| {
                batch.inputs.iter().any(|input| {
                    input
                        .eligible_member_ids
                        .iter()
                        .any(|id| id != &turn.member.id)
                })
            })
            .map(|batch| {
                batch
                    .inputs
                    .iter()
                    .map(|input| input.event.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        if event_ids.is_empty()
            && pending_colleagues_on(&connection, &group.id, &turn.member.id)?.is_empty()
        {
            return Ok(None);
        }
        Ok(Some(MemberCheckpointRequest { event_ids }))
    }

    pub fn checkpoint_member_turn(
        &self,
        turn: &MemberTurn,
        outcome: &TaskRuntimeOutcome,
    ) -> Result<(), String> {
        let request = outcome
            .checkpoint
            .as_ref()
            .ok_or("The member did not request a checkpoint.")?;
        if outcome.waiting_for_reply || request.event_ids.len() > crate::responsibility::BATCH_SIZE
        {
            return Err("The checkpoint must be a bounded independent handoff.".into());
        }
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let group = group_on(&tx, &turn.group.project_id, &turn.group.id)?;
        let task = Self::require_on(
            &tx,
            group
                .task_id
                .as_deref()
                .ok_or("The checkpoint has no task.")?,
        )?;
        if task.status != ResearchTaskStatus::Running
            || task.execution_generation != turn.execution.task_generation
            || task.cancel_requested
        {
            return Err("This checkpoint belongs to an inactive execution.".into());
        }
        if open_on(&tx, &group.id)?.is_some() {
            return Err("The group already has a retained member checkpoint.".into());
        }
        for id in &request.event_ids {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_responsibility_receipts r JOIN collaboration_events e ON e.id=r.event_id WHERE r.event_id=?1 AND e.group_id=?2 AND r.assessment_id IS NULL)",
                params![id,group.id], |row|row.get(0),
            ).map_err(store_error)?;
            if !exists {
                return Err(
                    "A checkpoint input was already consumed or belongs to another group.".into(),
                );
            }
        }
        let work = member_turn_on(
            &tx,
            group.clone(),
            turn.member.clone(),
            turn.execution.clone(),
        )?
        .work;
        if work.is_empty() {
            if super::work_settlement::execution_has_settlements_on(&tx, &turn.execution.id)? {
                return Ok(());
            }
            return Err("The checkpoint has no running work to retain.".into());
        }
        let work_ids = work.iter().map(|work| work.id.clone()).collect::<Vec<_>>();
        let checkpoint = Checkpoint {
            execution_id: turn.execution.id.clone(),
            member_id: turn.member.id.clone(),
            work_ids: work_ids.clone(),
            receipt_event_ids: request.event_ids.clone(),
            colleague_work_ids: unfinished_colleagues_on(
                &tx,
                &group.id,
                &turn.member.id,
                &work_ids,
            )?,
        };
        let changed = tx.execute(
            "UPDATE collaboration_executions SET status='checkpointed',input_tokens=?2,output_tokens=?3,finished_at=?4 WHERE id=?1 AND status='running'",
            params![turn.execution.id,outcome.input_tokens,outcome.output_tokens,now_ms()],
        ).map_err(store_error)?;
        if changed != 1 {
            return Err("This member execution already ended.".into());
        }
        tx.execute("UPDATE collaboration_work SET status='\"checkpointed\"',updated_at=?2 WHERE execution_id=?1 AND status='\"running\"'",
            params![turn.execution.id,now_ms()]).map_err(store_error)?;
        let id = fresh_id("checkpoint");
        let event = GroupEvent { sequence:0,id:id.clone(),group_id:group.id.clone(),kind:"member_checkpointed".into(),
            object:GroupObject{kind:"member".into(),id:turn.member.id.clone(),..Default::default()},
            author:GroupActor{kind:ActorKind::System,id:"group-runtime".into(),execution_id:Some(turn.execution.id.clone())},
            detail:"A complete tool batch yielded. The original work remains unfinished while relevant colleagues run.".into(),
            evidence:Some(serde_json::to_value(checkpoint).map_err(|error|error.to_string())?),created_at:now_ms()};
        tx.execute("INSERT INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?1,?3)",params![id,group.id,encode_json(&event)?]).map_err(store_error)?;
        tx.commit().map_err(store_error)
    }
}

#[cfg(test)]
#[path = "checkpoints_tests.rs"]
mod tests;
