use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::{
    encode_json, group_on, insert_message_on, members_on, message_on, store_error, validate_text,
    work_on,
};
use crate::collaboration::{
    ActorKind, GroupActor, GroupMessage, GroupStatus, GroupWork, MemberTurn, MessageDraft,
    TaskGroup, WorkResolution, WorkSettlementDraft, WorkStatus, WorkWait, WorkWaitResult,
};
use crate::model::ResearchTaskStatus;

pub(super) fn active_member_on(tx: &Transaction<'_>, turn: &MemberTurn) -> Result<(), String> {
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    if group.status != GroupStatus::Open {
        return Err("This member turn is not in an open task group.".into());
    }
    let task = super::TaskStore::require_on(
        tx,
        group
            .task_id
            .as_deref()
            .ok_or("A member execution needs a task.")?,
    )?;
    if task.status != ResearchTaskStatus::Running
        || task.execution_generation != turn.execution.task_generation
        || task.cancel_requested
    {
        return Err("This member turn belongs to an inactive task generation.".into());
    }
    let execution = tx
        .query_row(
            &format!(
                "SELECT {} FROM collaboration_executions WHERE id=?1",
                super::EXECUTION_COLUMNS
            ),
            [&turn.execution.id],
            super::execution_row,
        )
        .optional()
        .map_err(store_error)?
        .ok_or("This member execution no longer exists.")?;
    if execution.status != "running"
        || execution.group_id != group.id
        || execution.member_id != turn.member.id
        || execution.task_generation != task.execution_generation
    {
        return Err("This member execution is no longer active for the turn.".into());
    }
    Ok(())
}

pub(super) fn execution_has_settlements_on(
    connection: &Connection,
    execution: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collaboration_work
             WHERE settled_execution_id=?1)",
            [execution],
            |row| row.get(0),
        )
        .map_err(store_error)
}

pub(super) fn request_work_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    draft: &MessageDraft,
    work_ids: &[String],
) -> Result<GroupMessage, String> {
    if !draft.request_work {
        return Err("A work binding request must set requestWork=true.".into());
    }
    if work_ids.is_empty() {
        return Err("A work binding request needs at least one running work ID.".into());
    }
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    let actor = GroupActor {
        kind: ActorKind::Member,
        id: turn.member.id.clone(),
        execution_id: Some(turn.execution.id.clone()),
    };
    let message = insert_message_on(tx, &group, &actor, draft)?;
    bind_waiting_on(tx, turn, &message, work_ids)?;
    Ok(message)
}

pub(super) fn settle_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    draft: &WorkSettlementDraft,
) -> Result<Vec<GroupWork>, String> {
    if draft.work_ids.is_empty() {
        return Err("Work settlement needs at least one work ID.".into());
    }
    if !matches!(
        draft.status,
        WorkStatus::Completed | WorkStatus::Failed | WorkStatus::Waiting
    ) {
        return Err("Work can only be settled as completed, failed, or waiting.".into());
    }
    validate_text(&draft.summary, "Work resolution summary", 1, 32_000)?;
    for reference in &draft.result_refs {
        reference.validate()?;
        if reference.project_id != turn.group.project_id
            || reference
                .task_id
                .as_ref()
                .is_some_and(|id| Some(id) != turn.group.task_id.as_ref())
        {
            return Err("A work result must belong to this project and task.".into());
        }
    }
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    let selected = selected_work_on(tx, turn, &draft.work_ids)?;
    if draft.status == WorkStatus::Waiting {
        if draft.wait_for.is_empty() {
            return Err("Explicit waiting work needs at least one request dependency.".into());
        }
    } else {
        ensure_waits_resolved(&selected)?;
    }
    let now = super::now_ms();
    for work in &selected {
        let actor = GroupActor {
            kind: ActorKind::Member,
            id: turn.member.id.clone(),
            execution_id: Some(turn.execution.id.clone()),
        };
        let result_message_id =
            if matches!(draft.status, WorkStatus::Completed | WorkStatus::Failed) {
                original_request_on(tx, &group.id, turn, work)?
                    .map(|request| {
                        let recipients = members_on(tx, &group.id)?
                            .into_iter()
                            .any(|member| member.id == request.author.id)
                            .then_some(request.author.id)
                            .into_iter()
                            .collect();
                        insert_message_on(
                            tx,
                            &group,
                            &actor,
                            &MessageDraft {
                                body: draft.summary.clone(),
                                recipients,
                                reply_to: Some(request.id),
                                request_work: false,
                                ..Default::default()
                            },
                        )
                        .map(|message| message.id)
                    })
                    .transpose()?
            } else {
                None
            };
        let resolution = WorkResolution {
            summary: draft.summary.clone(),
            result_refs: draft.result_refs.clone(),
        };
        let waits = if draft.status == WorkStatus::Waiting {
            wait_set_on(tx, turn, &group, &draft.wait_for)?
        } else {
            work.waits.clone()
        };
        tx.execute(
            "UPDATE collaboration_work
             SET status=?2,execution_id=?3,result_message_id=?4,
                 resolution_json=?5,waits_json=?6,settled_execution_id=?3,updated_at=?7
             WHERE id=?1",
            params![
                work.id,
                encode_json(&draft.status)?,
                turn.execution.id,
                result_message_id,
                encode_json(&resolution)?,
                encode_json(&waits)?,
                now
            ],
        )
        .map_err(store_error)?;
    }
    refresh_wait_snapshots_on(tx, &group.id)?;
    release_ready_waits_on(tx, &group.id)?;
    Ok(work_on(tx, &group.id)?
        .into_iter()
        .filter(|work| draft.work_ids.contains(&work.id))
        .collect())
}

fn selected_work_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    ids: &[String],
) -> Result<Vec<GroupWork>, String> {
    let unique = ids.iter().cloned().collect::<BTreeSet<_>>();
    if unique.len() != ids.len() {
        return Err("A work settlement cannot list the same work twice.".into());
    }
    let work = work_on(tx, &turn.group.id)?;
    ids.iter()
        .map(|id| {
            let item = work
                .iter()
                .find(|work| &work.id == id)
                .ok_or_else(|| format!("Work {id} is not in this group."))?;
            if item.member_id != turn.member.id {
                return Err(format!("Work {id} belongs to another member."));
            }
            let selectable = (item.status == WorkStatus::Running
                && item.execution_id.as_deref() == Some(&turn.execution.id))
                || (item.status == WorkStatus::Waiting && item.member_id == turn.member.id);
            if !selectable {
                return Err(format!(
                    "Work {id} is not running in this execution or waiting for this member."
                ));
            }
            Ok(item.clone())
        })
        .collect()
}

fn ensure_waits_resolved(work: &[GroupWork]) -> Result<(), String> {
    for work in work {
        for wait in &work.waits {
            if wait
                .work
                .iter()
                .any(|result| !matches!(result.status, WorkStatus::Completed | WorkStatus::Failed))
            {
                return Err(format!(
                    "Work cannot complete before request {} dependencies finish.",
                    wait.request_message_id
                ));
            }
        }
    }
    Ok(())
}

fn wait_set_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    group: &TaskGroup,
    request_ids: &[String],
) -> Result<Vec<WorkWait>, String> {
    if request_ids.is_empty() {
        return Ok(Vec::new());
    }
    let unique = request_ids.iter().cloned().collect::<BTreeSet<_>>();
    if unique.len() != request_ids.len() {
        return Err("A waiting settlement cannot repeat a request message.".into());
    }
    request_ids
        .iter()
        .map(|request_id| {
            let request = message_on(tx, &group.id, request_id)?;
            if !request.content.request_work
                || request.author.kind != ActorKind::Member
                || request.author.id != turn.member.id
                || request.author.execution_id.as_deref() != Some(&turn.execution.id)
            {
                return Err(
                    "A wait must reference a requestWork message sent by this execution.".into(),
                );
            }
            let work = colleague_work_on(tx, group, request_id, &turn.member.id)?;
            if work.is_empty() {
                return Err("A waiting request has no colleague work.".into());
            }
            Ok(WorkWait {
                request_message_id: request_id.clone(),
                work,
            })
        })
        .collect()
}

fn bind_waiting_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    request: &GroupMessage,
    work_ids: &[String],
) -> Result<(), String> {
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    let selected = selected_work_on(tx, turn, work_ids)?;
    if selected.iter().any(|work| {
        !matches!(work.status, WorkStatus::Running | WorkStatus::Waiting)
            || work.execution_id.as_deref() != Some(&turn.execution.id)
    }) {
        return Err(
            "request_member_work can only bind running or waiting work in this execution.".into(),
        );
    }
    let wait = WorkWait {
        request_message_id: request.id.clone(),
        work: colleague_work_on(tx, &group, &request.id, &turn.member.id)?,
    };
    if wait.work.is_empty() {
        return Err("The request did not create colleague work.".into());
    }
    for work in selected {
        let mut waits = work.waits.clone();
        waits.push(wait.clone());
        let resolution = WorkResolution {
            summary: request.content.body.clone(),
            result_refs: Vec::new(),
        };
        tx.execute(
            "UPDATE collaboration_work
             SET status='\"waiting\"',execution_id=?2,result_message_id=?3,
                 resolution_json=?4,waits_json=?5,settled_execution_id=?2,updated_at=?6
             WHERE id=?1 AND status IN ('\"running\"','\"waiting\"') AND execution_id=?2",
            params![
                work.id,
                turn.execution.id,
                request.id,
                encode_json(&resolution)?,
                encode_json(&waits)?,
                super::now_ms()
            ],
        )
        .map_err(store_error)?;
    }
    Ok(())
}

fn original_request_on(
    tx: &Transaction<'_>,
    group: &str,
    turn: &MemberTurn,
    work: &GroupWork,
) -> Result<Option<GroupMessage>, String> {
    if work.cause_kind != "message" {
        return Ok(None);
    }
    let message = message_on(tx, group, &work.cause_id)?;
    Ok(is_terminal_reply_request(&message, &turn.member.id).then_some(message))
}

fn is_terminal_reply_request(message: &GroupMessage, member_id: &str) -> bool {
    message.content.request_work && message.author.id != member_id
}

fn colleague_work_on(
    tx: &Transaction<'_>,
    group: &TaskGroup,
    request_id: &str,
    owner: &str,
) -> Result<Vec<WorkWaitResult>, String> {
    let work = work_on(tx, &group.id)?
        .into_iter()
        .filter(|work| {
            work.member_id != owner
                && ((work.cause_kind == "message" && work.cause_id == request_id)
                    || (work.cause_kind == "annotation"
                        && work
                            .reasons
                            .iter()
                            .any(|reason| reason.source_id.as_deref() == Some(request_id))))
        })
        .map(|work| WorkWaitResult {
            work_id: work.id,
            member_id: work.member_id,
            status: work.status,
            result_message_id: work.result_message_id,
        })
        .collect::<Vec<_>>();
    Ok(work)
}

pub(super) fn release_ready_waits_on(tx: &Transaction<'_>, group: &str) -> Result<(), String> {
    let work = work_on(tx, group)?;
    let statuses = work
        .iter()
        .map(|work| (work.id.as_str(), work.status))
        .collect::<BTreeMap<_, _>>();
    for item in work
        .iter()
        .filter(|work| work.status == WorkStatus::Waiting)
    {
        if item.waits.is_empty() {
            continue;
        }
        if item
            .waits
            .iter()
            .flat_map(|wait| &wait.work)
            .any(|dependency| !statuses.contains_key(dependency.work_id.as_str()))
        {
            continue;
        }
        let ready = item.waits.iter().all(|wait| {
            wait.work.iter().all(|dependency| {
                statuses
                    .get(dependency.work_id.as_str())
                    .is_some_and(|status| {
                        matches!(status, WorkStatus::Completed | WorkStatus::Failed)
                    })
            })
        });
        if ready {
            tx.execute(
                "UPDATE collaboration_work
                 SET status='\"pending\"',execution_id=NULL,updated_at=?2
                 WHERE id=?1 AND status='\"waiting\"'",
                params![item.id, super::now_ms()],
            )
            .map_err(store_error)?;
        }
    }
    Ok(())
}

pub(super) fn bind_running_to_execution_requests_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    summary: &str,
) -> Result<(), String> {
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    let request_ids = tx
        .prepare(
            "SELECT id FROM collaboration_messages
             WHERE group_id=?1 AND json_extract(author_json,'$.executionId')=?2
               AND json_extract(content_json,'$.requestWork')=1
             ORDER BY sequence",
        )
        .and_then(|mut query| {
            query
                .query_map(params![group.id, turn.execution.id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(store_error)?;
    let mut waits = Vec::new();
    for request_id in &request_ids {
        let work = colleague_work_on(tx, &group, request_id, &turn.member.id)?;
        if !work.is_empty() {
            waits.push(WorkWait {
                request_message_id: request_id.clone(),
                work,
            });
        }
    }
    let resolution = WorkResolution {
        summary: summary.to_owned(),
        result_refs: Vec::new(),
    };
    tx.execute(
        "UPDATE collaboration_work
         SET status='\"waiting\"',resolution_json=?2,waits_json=?3,updated_at=?4
         WHERE execution_id=?1 AND status='\"running\"'",
        params![
            turn.execution.id,
            encode_json(&resolution)?,
            encode_json(&waits)?,
            super::now_ms()
        ],
    )
    .map_err(store_error)?;
    Ok(())
}

pub(super) fn fail_running_on(
    tx: &Transaction<'_>,
    turn: &MemberTurn,
    summary: &str,
) -> Result<(), String> {
    let group = group_on(tx, &turn.group.project_id, &turn.group.id)?;
    let actor = GroupActor {
        kind: ActorKind::Member,
        id: turn.member.id.clone(),
        execution_id: Some(turn.execution.id.clone()),
    };
    let running = work_on(tx, &group.id)?
        .into_iter()
        .filter(|work| {
            work.execution_id.as_deref() == Some(&turn.execution.id)
                && work.status == WorkStatus::Running
        })
        .collect::<Vec<_>>();
    let resolution = WorkResolution {
        summary: summary.to_owned(),
        result_refs: Vec::new(),
    };
    for work in running {
        let requests = if work.cause_kind == "message" {
            vec![message_on(tx, &group.id, &work.cause_id)?]
        } else {
            let mut requests = Vec::new();
            for wait in &work.waits {
                requests.push(message_on(tx, &group.id, &wait.request_message_id)?);
            }
            requests.sort_by_key(|message| message.sequence);
            requests.dedup_by(|left, right| left.id == right.id);
            requests
        }
        .into_iter()
        .filter(|request| is_terminal_reply_request(request, &turn.member.id));
        let mut result_message_id = None;
        for request in requests {
            let recipients = members_on(tx, &group.id)?
                .into_iter()
                .any(|member| member.id == request.author.id)
                .then_some(request.author.id.clone())
                .into_iter()
                .collect();
            let reply = insert_message_on(
                tx,
                &group,
                &actor,
                &MessageDraft {
                    body: summary.to_owned(),
                    recipients,
                    reply_to: Some(request.id),
                    request_work: false,
                    ..Default::default()
                },
            )?;
            result_message_id.get_or_insert(reply.id);
        }
        tx.execute(
            "UPDATE collaboration_work
             SET status='\"failed\"',execution_id=?2,result_message_id=?3,
                 resolution_json=?4,settled_execution_id=?2,updated_at=?5
             WHERE id=?1 AND status='\"running\"' AND execution_id=?2",
            params![
                work.id,
                turn.execution.id,
                result_message_id,
                encode_json(&resolution)?,
                super::now_ms()
            ],
        )
        .map_err(store_error)?;
    }
    refresh_wait_snapshots_on(tx, &group.id)?;
    release_ready_waits_on(tx, &group.id)?;
    Ok(())
}

pub(super) fn refresh_wait_snapshots_on(tx: &Transaction<'_>, group: &str) -> Result<(), String> {
    let work = work_on(tx, group)?;
    let by_id = work
        .iter()
        .map(|work| (work.id.as_str(), work))
        .collect::<BTreeMap<_, _>>();
    for item in work
        .iter()
        .filter(|work| work.status == WorkStatus::Waiting)
    {
        let mut changed = false;
        let waits = item
            .waits
            .iter()
            .map(|wait| WorkWait {
                request_message_id: wait.request_message_id.clone(),
                work: wait
                    .work
                    .iter()
                    .map(|dependency| {
                        let current = by_id.get(dependency.work_id.as_str());
                        let next = WorkWaitResult {
                            work_id: dependency.work_id.clone(),
                            member_id: dependency.member_id.clone(),
                            status: current.map_or(dependency.status, |work| work.status),
                            result_message_id: current
                                .and_then(|work| work.result_message_id.clone())
                                .or_else(|| dependency.result_message_id.clone()),
                        };
                        changed |= next != *dependency;
                        next
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        if changed {
            tx.execute(
                "UPDATE collaboration_work SET waits_json=?2,updated_at=?3 WHERE id=?1",
                params![item.id, encode_json(&waits)?, super::now_ms()],
            )
            .map_err(store_error)?;
        }
    }
    Ok(())
}
