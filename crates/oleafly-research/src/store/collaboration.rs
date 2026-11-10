use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::{decode_json, encode_json, fresh_id, store_error, validate_text, TaskStore};
use crate::collaboration::*;
use crate::model::{
    now_ms, PendingStart, ResearchTask, ResearchTaskStatus, ResumeReason, TaskRuntimeOutcome,
};

#[path = "attention.rs"]
mod attention;
pub(super) use attention::record_handling_on;
pub(super) use attention::SCHEMA_SQL as ATTENTION_SCHEMA_SQL;

#[path = "responsibility.rs"]
mod responsibility;
pub(super) use responsibility::SCHEMA_SQL as RESPONSIBILITY_SCHEMA_SQL;

#[path = "checkpoints.rs"]
mod checkpoints;

pub(super) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS collaboration_groups (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
 task_id TEXT UNIQUE REFERENCES research_tasks(id) ON DELETE SET NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_groups_project ON collaboration_groups(project_id,updated_at);
CREATE TABLE IF NOT EXISTS collaboration_members (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
 config_json TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_members_group ON collaboration_members(group_id);
CREATE TABLE IF NOT EXISTS collaboration_interests (
 member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(member_id,kind,value)
);
CREATE TABLE IF NOT EXISTS collaboration_messages (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
 author_json TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_messages_group ON collaboration_messages(group_id,sequence);
CREATE TABLE IF NOT EXISTS collaboration_events (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
 dedupe_key TEXT NOT NULL, event_json TEXT NOT NULL, UNIQUE(group_id,dedupe_key)
);
CREATE TABLE IF NOT EXISTS collaboration_executions (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES collaboration_members(id), task_generation INTEGER NOT NULL,
 session_id TEXT NOT NULL, runtime_id TEXT NOT NULL, agent_id TEXT NOT NULL, model_id TEXT NOT NULL,
 provider_id TEXT, status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
 conversation_json TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS collaboration_one_execution ON collaboration_executions(group_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS collaboration_work (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES collaboration_members(id), cause_kind TEXT NOT NULL,
 cause_id TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL,
 execution_id TEXT REFERENCES collaboration_executions(id), result_message_id TEXT REFERENCES collaboration_messages(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(member_id,cause_kind,cause_id)
);
CREATE INDEX IF NOT EXISTS collaboration_work_pending ON collaboration_work(group_id,status,priority,created_at);
";

fn group_on(connection: &Connection, project: &str, id: &str) -> Result<TaskGroup, String> {
    connection.query_row("SELECT id,task_id,project_id,status,created_at,updated_at FROM collaboration_groups WHERE id=?1 AND project_id=?2", params![id,project], |row| {
        Ok((row.get::<_,String>(0)?, row.get::<_,Option<String>>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,i64>(4)?, row.get::<_,i64>(5)?))
    }).optional().map_err(store_error)?.map(|(id,task_id,project_id,status,created_at,updated_at)| -> Result<TaskGroup,String> { Ok(TaskGroup {id,task_id,project_id,status: decode_json(&format!("\"{status}\""),"group status")?,created_at,updated_at}) }).transpose()?.ok_or("Task group not found in this project.".into())
}
fn members_on(connection: &Connection, group: &str) -> Result<Vec<GroupMember>, String> {
    connection.prepare("SELECT id,config_json,paused,joined_at FROM collaboration_members WHERE group_id=?1 ORDER BY joined_at,id").and_then(|mut query| query.query_map([group], |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?,row.get::<_,bool>(2)?,row.get::<_,i64>(3)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?.into_iter().map(|(id,config,paused,joined_at)| Ok(GroupMember {id,group_id: group.into(),config: decode_json(&config,"group member")?,paused,joined_at})).collect()
}
fn interests_on(connection: &Connection, group: &str) -> Result<Vec<MemberInterest>, String> {
    connection.prepare("SELECT i.member_id,i.kind,i.value FROM collaboration_interests i JOIN collaboration_members m ON m.id=i.member_id WHERE m.group_id=?1 ORDER BY i.member_id,i.kind,i.value").and_then(|mut q| q.query_map([group], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?.into_iter().map(|(member_id,kind,value)| Ok(MemberInterest {member_id,kind:decode_json(&kind,"interest kind")?,value})).collect()
}
fn message_on(connection: &Connection, group: &str, id: &str) -> Result<GroupMessage, String> {
    connection.query_row("SELECT sequence,id,author_json,content_json,created_at FROM collaboration_messages WHERE id=?1 AND group_id=?2",params![id,group],|r| Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?))).optional().map_err(store_error)?.map(|(sequence,id,author,content,created_at)| -> Result<GroupMessage,String> { Ok(GroupMessage {sequence,id,group_id:group.into(),author:decode_json(&author,"message author")?,content:decode_json(&content,"message")?,created_at}) }).transpose()?.ok_or("The reply or message belongs to another group.".into())
}
fn work_on(connection: &Connection, group: &str) -> Result<Vec<GroupWork>, String> {
    connection.prepare("SELECT id,member_id,cause_kind,cause_id,priority,status,execution_id,result_message_id,reasons_json,created_at,updated_at FROM collaboration_work WHERE group_id=?1 ORDER BY priority DESC,created_at,id").and_then(|mut q|q.query_map([group],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u32>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,String>(8)?,r.get::<_,i64>(9)?,r.get::<_,i64>(10)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?.into_iter().map(|(id,member_id,cause_kind,cause_id,priority,status,execution_id,result_message_id,reasons,created_at,updated_at)|Ok(GroupWork {id,group_id:group.into(),member_id,cause_kind,cause_id,priority,status:decode_json(&status,"work status")?,execution_id,result_message_id,reasons:decode_json(&reasons,"work reasons")?,created_at,updated_at})).collect()
}
fn execution_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemberExecution> {
    Ok(MemberExecution {
        id: row.get(0)?,
        group_id: row.get(1)?,
        member_id: row.get(2)?,
        task_generation: row.get(3)?,
        session_id: row.get(4)?,
        runtime_id: row.get(5)?,
        agent_id: row.get(6)?,
        model_id: row.get(7)?,
        provider_id: row.get(8)?,
        status: row.get(9)?,
        input_tokens: row.get(10)?,
        output_tokens: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
    })
}
const EXECUTION_COLUMNS:&str="id,group_id,member_id,task_generation,session_id,runtime_id,agent_id,model_id,provider_id,status,input_tokens,output_tokens,started_at,finished_at";
const GROUP_UI_PAGE_SIZE: usize = 100;

fn event_on(connection: &Connection, group: &str, id: &str) -> Result<Option<GroupEvent>, String> {
    connection
        .query_row(
            "SELECT rowid,event_json FROM collaboration_events WHERE id=?1 AND group_id=?2",
            params![id, group],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(store_error)?
        .map(|(sequence, json)| {
            let mut event: GroupEvent = decode_json(&json, "group event")?;
            event.sequence = sequence;
            Ok(event)
        })
        .transpose()
}

fn event_page_on(
    connection: &Connection,
    group: &str,
    before_sequence: Option<u64>,
    limit: usize,
) -> Result<GroupEventPage, String> {
    let limit = limit.clamp(1, GROUP_UI_PAGE_SIZE);
    let rows = connection
        .prepare(
            "SELECT rowid,event_json FROM collaboration_events
             WHERE group_id=?1 AND (?2 IS NULL OR rowid<?2)
             ORDER BY rowid DESC LIMIT ?3",
        )
        .and_then(|mut query| {
            query
                .query_map(params![group, before_sequence, (limit + 1) as i64], |row| {
                    Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(store_error)?;
    let has_more = rows.len() > limit;
    let mut events = rows
        .into_iter()
        .take(limit)
        .map(|(sequence, json)| {
            let mut event: GroupEvent = decode_json(&json, "group event")?;
            event.sequence = sequence;
            Ok(event)
        })
        .collect::<Result<Vec<_>, String>>()?;
    events.reverse();
    Ok(GroupEventPage { events, has_more })
}

fn event_after_page_on(
    connection: &Connection,
    group: &str,
    after_sequence: u64,
    limit: usize,
) -> Result<GroupEventPage, String> {
    let limit = limit.clamp(1, GROUP_UI_PAGE_SIZE);
    let rows = connection
        .prepare(
            "SELECT rowid,event_json FROM collaboration_events
             WHERE group_id=?1 AND rowid>?2
             ORDER BY rowid LIMIT ?3",
        )
        .and_then(|mut query| {
            query
                .query_map(params![group, after_sequence, (limit + 1) as i64], |row| {
                    Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(store_error)?;
    let has_more = rows.len() > limit;
    let events = rows
        .into_iter()
        .take(limit)
        .map(|(sequence, json)| {
            let mut event: GroupEvent = decode_json(&json, "group event")?;
            event.sequence = sequence;
            Ok(event)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(GroupEventPage { events, has_more })
}

fn execution_page_on(
    connection: &Connection,
    group: &str,
    before_started_at: Option<i64>,
    before_id: Option<&str>,
    limit: usize,
) -> Result<GroupExecutionPage, String> {
    if before_started_at.is_some() != before_id.is_some() {
        return Err("An execution cursor needs both its start time and stable ID.".into());
    }
    let limit = limit.clamp(1, GROUP_UI_PAGE_SIZE);
    let executions = connection
        .prepare(&format!(
            "SELECT {EXECUTION_COLUMNS} FROM collaboration_executions
             WHERE group_id=?1
               AND (?2 IS NULL OR started_at<?2 OR (started_at=?2 AND id<?3))
             ORDER BY started_at DESC,id DESC LIMIT ?4"
        ))
        .and_then(|mut query| {
            query
                .query_map(
                    params![group, before_started_at, before_id, (limit + 1) as i64],
                    execution_row,
                )?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(store_error)?;
    let has_more = executions.len() > limit;
    let executions = executions.into_iter().take(limit).collect::<Vec<_>>();
    Ok(GroupExecutionPage {
        executions,
        has_more,
    })
}

fn execution_after_page_on(
    connection: &Connection,
    group: &str,
    after_started_at: i64,
    after_id: &str,
    limit: usize,
) -> Result<GroupExecutionPage, String> {
    let limit = limit.clamp(1, GROUP_UI_PAGE_SIZE);
    let executions = connection
        .prepare(&format!(
            "SELECT {EXECUTION_COLUMNS} FROM collaboration_executions
             WHERE group_id=?1
               AND (started_at>?2 OR (started_at=?2 AND id>?3))
             ORDER BY started_at,id LIMIT ?4"
        ))
        .and_then(|mut query| {
            query
                .query_map(
                    params![group, after_started_at, after_id, (limit + 1) as i64],
                    execution_row,
                )?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(store_error)?;
    let has_more = executions.len() > limit;
    let executions = executions.into_iter().take(limit).collect::<Vec<_>>();
    Ok(GroupExecutionPage {
        executions,
        has_more,
    })
}

pub(super) fn insert_work_on(
    tx: &Transaction<'_>,
    group: &str,
    member: &str,
    kind: &str,
    cause: &str,
    priority: u32,
    reasons: &[WorkReason],
) -> Result<(), String> {
    let existing: Option<(String, String)> = tx.query_row(
        "SELECT id,reasons_json FROM collaboration_work WHERE member_id=?1 AND cause_kind=?2 AND cause_id=?3",
        params![member,kind,cause], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(store_error)?;
    if let Some((id, saved)) = existing {
        let mut merged: Vec<WorkReason> = decode_json(&saved, "work reasons")?;
        for reason in reasons {
            if !merged.contains(reason) {
                merged.push(reason.clone());
            }
        }
        tx.execute("UPDATE collaboration_work SET reasons_json=?2,priority=MAX(priority,?3),updated_at=?4 WHERE id=?1",params![id,encode_json(&merged)?,priority,now_ms()]).map_err(store_error)?;
        return Ok(());
    }
    tx.execute("INSERT INTO collaboration_work(id,group_id,member_id,cause_kind,cause_id,priority,status,reasons_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'\"pending\"',?7,?8,?8) ON CONFLICT(member_id,cause_kind,cause_id) DO NOTHING",params![fresh_id("work"),group,member,kind,cause,priority,encode_json(reasons)?,now_ms()]).map_err(store_error)?;
    Ok(())
}
fn validate_actor(tx: &Transaction<'_>, group: &str, actor: &GroupActor) -> Result<(), String> {
    if actor.kind == ActorKind::Member {
        let valid: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_members WHERE id=?1 AND group_id=?2)",
                params![actor.id, group],
                |r| r.get(0),
            )
            .map_err(store_error)?;
        if !valid {
            return Err("The author is not a member of this group.".into());
        }
        if let Some(execution) = &actor.execution_id {
            let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_executions WHERE id=?1 AND member_id=?2 AND group_id=?3)",params![execution,actor.id,group],|r|r.get(0)).map_err(store_error)?;
            if !valid {
                return Err("The execution does not belong to the author.".into());
            }
        }
    }
    Ok(())
}
fn interest_reasons(
    member: &str,
    interests: &[MemberInterest],
    kind: &str,
    object: &GroupObject,
) -> Vec<WorkReason> {
    interests
        .iter()
        .filter(|i| i.member_id == member)
        .filter_map(|i| {
            let (matches, reason) = match i.kind {
                InterestKind::Path => (
                    object
                        .path
                        .as_ref()
                        .is_some_and(|path| path_matches(&i.value, path)),
                    "interest_path",
                ),
                InterestKind::Object => (
                    i.value == format!("{}:{}", object.kind, object.id),
                    "interest_object",
                ),
                InterestKind::Event => (i.value == kind, "interest_event"),
            };
            matches.then(|| work_reason(reason, Some(object), None, None))
        })
        .collect()
}

fn work_reason(
    kind: &str,
    object: Option<&GroupObject>,
    source: Option<&str>,
    execution: Option<&str>,
) -> WorkReason {
    WorkReason {
        kind: kind.into(),
        detail: None,
        object: object.cloned(),
        source_id: source.map(str::to_owned),
        execution_id: execution.map(str::to_owned),
    }
}

fn route(routes: &mut BTreeMap<String, Vec<WorkReason>>, member: &str, reason: WorkReason) {
    let reasons = routes.entry(member.into()).or_default();
    if !reasons.contains(&reason) {
        reasons.push(reason);
    }
}

fn insert_message_on(
    tx: &Transaction<'_>,
    group: &TaskGroup,
    actor: &GroupActor,
    draft: &MessageDraft,
) -> Result<GroupMessage, String> {
    validate_text(&draft.body, "Message", 1, 32_000)?;
    validate_actor(tx, &group.id, actor)?;
    let members = members_on(tx, &group.id)?;
    let interests = interests_on(tx, &group.id)?;
    let attentions = attention::list_on(tx, &group.id)?;
    let mut routes = BTreeMap::new();
    for id in &draft.recipients {
        route(
            &mut routes,
            id,
            work_reason("explicit_recipient", draft.object.as_ref(), None, None),
        );
    }
    if let Some(reply) = &draft.reply_to {
        let parent = message_on(tx, &group.id, reply)?;
        if parent.author.kind == ActorKind::Member {
            route(
                &mut routes,
                &parent.author.id,
                work_reason(
                    "reply",
                    parent.content.object.as_ref(),
                    Some(&parent.id),
                    parent.author.execution_id.as_deref(),
                ),
            );
        }
    }
    for member in &members {
        let mentioned = draft.body.contains(&format!("@{}", member.config.name))
            || draft.body.contains(&format!("@{}", member.id));
        if mentioned {
            route(
                &mut routes,
                &member.id,
                work_reason("mention", draft.object.as_ref(), None, None),
            );
        }
        if let Some(object) = &draft.object {
            for reason in interest_reasons(&member.id, &interests, "message", object) {
                route(&mut routes, &member.id, reason);
            }
            if draft.request_work {
                for reason in attention::matching_reasons(&member.id, &attentions, object, false) {
                    route(&mut routes, &member.id, reason);
                }
            }
        }
    }
    routes.remove(&actor.id);
    if routes.is_empty() && draft.request_work {
        if let Some(member) = members.iter().find(|m| m.config.coordinator) {
            if member.id != actor.id {
                route(
                    &mut routes,
                    &member.id,
                    work_reason("coordinator", draft.object.as_ref(), None, None),
                );
            }
        }
    }
    save_routed_message_on(tx, group, actor, draft, routes, None)
}

fn save_routed_message_on(
    tx: &Transaction<'_>,
    group: &TaskGroup,
    actor: &GroupActor,
    draft: &MessageDraft,
    routes: BTreeMap<String, Vec<WorkReason>>,
    annotation: Option<&str>,
) -> Result<GroupMessage, String> {
    validate_text(&draft.body, "Message", 1, 32_000)?;
    validate_actor(tx, &group.id, actor)?;
    let members = members_on(tx, &group.id)?;
    if routes.keys().any(|id| !members.iter().any(|m| &m.id == id)) {
        return Err("A recipient is not in this group.".into());
    }
    let now = now_ms();
    let id = fresh_id("message");
    let mut content = draft.clone();
    content.recipients = routes.keys().cloned().collect();
    tx.execute("INSERT INTO collaboration_messages(id,group_id,author_json,content_json,created_at) VALUES(?1,?2,?3,?4,?5)",params![id,group.id,encode_json(actor)?,encode_json(&content)?,now]).map_err(store_error)?;
    let sequence = tx.last_insert_rowid() as u64;
    let user_request = actor.kind == ActorKind::User && draft.request_work;
    if group.status != GroupStatus::Closed || user_request {
        if group.status == GroupStatus::Closed && user_request {
            tx.execute(
                "UPDATE collaboration_groups SET status='open',updated_at=?2 WHERE id=?1",
                params![group.id, now],
            )
            .map_err(store_error)?;
        }
        if draft.request_work || !content.recipients.is_empty() {
            for (member, reasons) in routes {
                insert_work_on(
                    tx,
                    &group.id,
                    &member,
                    if annotation.is_some() {
                        "annotation"
                    } else {
                        "message"
                    },
                    annotation.unwrap_or(&id),
                    if actor.kind == ActorKind::User {
                        100
                    } else {
                        50
                    },
                    &reasons,
                )?;
            }
        }
    }
    tx.execute(
        "UPDATE collaboration_groups SET updated_at=?2 WHERE id=?1",
        params![group.id, now],
    )
    .map_err(store_error)?;
    Ok(GroupMessage {
        sequence,
        id,
        group_id: group.id.clone(),
        author: actor.clone(),
        content,
        created_at: now,
    })
}

fn member_turn_on(
    connection: &Connection,
    group: TaskGroup,
    member: GroupMember,
    execution: MemberExecution,
) -> Result<MemberTurn, String> {
    let work = work_on(connection, &group.id)?
        .into_iter()
        .filter(|w| {
            w.execution_id.as_ref() == Some(&execution.id) && w.status == WorkStatus::Running
        })
        .collect::<Vec<_>>();
    let mut messages = Vec::new();
    let mut events = Vec::new();
    let mut annotations = Vec::new();
    for item in &work {
        match item.cause_kind.as_str() {
            "message" => messages.push(message_on(connection, &group.id, &item.cause_id)?),
            "event" => {
                let (sequence, json): (u64, String) = connection
                    .query_row(
                        "SELECT rowid,event_json FROM collaboration_events WHERE id=?1 AND group_id=?2",
                        params![item.cause_id, group.id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(store_error)?;
                let mut event: GroupEvent = decode_json(&json, "group event")?;
                event.sequence = sequence;
                events.push(event);
            }
            "annotation" => {
                let json:String=connection.query_row("SELECT annotation_json FROM research_task_annotations WHERE id=?1 AND project_id=?2",params![item.cause_id,group.project_id],|r|r.get(0)).map_err(store_error)?;
                annotations.push(decode_json(&json, "annotation")?);
            }
            _ => {}
        }
    }
    Ok(MemberTurn {
        group,
        member,
        execution,
        work,
        messages,
        events,
        annotations,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn record_group_event_on(
    tx: &Transaction<'_>,
    project: &str,
    group: &str,
    key: &str,
    kind: &str,
    object: &GroupObject,
    actor: &GroupActor,
    detail: &str,
) -> Result<Vec<String>, String> {
    record_event_with_evidence_on(tx, project, group, key, kind, object, actor, detail, None)
}

#[allow(clippy::too_many_arguments)]
fn record_event_with_evidence_on(
    tx: &Transaction<'_>,
    project: &str,
    group: &str,
    key: &str,
    kind: &str,
    object: &GroupObject,
    actor: &GroupActor,
    detail: &str,
    evidence: Option<serde_json::Value>,
) -> Result<Vec<String>, String> {
    let g = group_on(tx, project, group)?;
    validate_actor(tx, group, actor)?;
    let task = g
        .task_id
        .as_deref()
        .map(|id| TaskStore::require_on(tx, id))
        .transpose()?;
    let coordination_update = task.as_ref().is_some_and(|task| {
        kind == "file_changed"
            && object.kind == "file"
            && object
                .path
                .as_deref()
                .is_some_and(|path| crate::record::is_coordination_file(&task.record_slug, path))
    });
    let event = GroupEvent {
        sequence: 0,
        id: fresh_id("event"),
        group_id: group.into(),
        kind: kind.into(),
        object: object.clone(),
        author: actor.clone(),
        detail: detail.into(),
        evidence: if kind == "annotation_requested" {
            serde_json::from_str(detail).ok()
        } else {
            evidence
        },
        created_at: now_ms(),
    };
    if tx.execute("INSERT OR IGNORE INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?3,?4)",params![event.id,group,key,encode_json(&event)?]).map_err(store_error)?==0{return Ok(Vec::new());}
    if !coordination_update && crate::responsibility::assesses_event(kind) {
        tx.execute(
            "INSERT INTO collaboration_responsibility_receipts(event_id) VALUES(?1)",
            [&event.id],
        )
        .map_err(store_error)?;
    }
    let mut routed = Vec::new();
    if g.status != GroupStatus::Closed && kind != "annotation_requested" {
        let interests = interests_on(tx, group)?;
        let attentions = attention::list_on(tx, group)?;
        for member in members_on(tx, group)? {
            if member.id == actor.id {
                continue;
            }
            let mut reasons = interest_reasons(&member.id, &interests, kind, object);
            if !coordination_update {
                reasons.extend(attention::matching_reasons(
                    &member.id,
                    &attentions,
                    object,
                    true,
                ));
            }
            if !reasons.is_empty() {
                insert_work_on(tx, group, &member.id, "event", &event.id, 25, &reasons)?;
                routed.push(member.id);
            }
        }
    }
    Ok(routed)
}

impl TaskStore {
    pub fn task_member_turn(
        &self,
        task_id: &str,
        generation: u64,
    ) -> Result<Option<MemberTurn>, String> {
        let c = self.open()?;
        let execution=c.query_row(&format!("SELECT {EXECUTION_COLUMNS} FROM collaboration_executions WHERE group_id=(SELECT id FROM collaboration_groups WHERE task_id=?1) AND task_generation=?2 AND status='running'"),params![task_id,generation],execution_row).optional().map_err(store_error)?;
        let Some(execution) = execution else {
            return Ok(None);
        };
        let task = Self::require_on(&c, task_id)?;
        let group = group_on(&c, &task.project_id, &execution.group_id)?;
        let member = members_on(&c, &group.id)?
            .into_iter()
            .find(|m| m.id == execution.member_id)
            .ok_or("Member not found.")?;
        Ok(Some(member_turn_on(&c, group, member, execution)?))
    }

    /// Fold newly routed causes into the current member's execution at a provider boundary.
    pub fn refresh_member_inbox(
        &self,
        task_id: &str,
        generation: u64,
    ) -> Result<Option<MemberTurn>, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let execution = tx.query_row(
            &format!("SELECT {EXECUTION_COLUMNS} FROM collaboration_executions WHERE group_id=(SELECT id FROM collaboration_groups WHERE task_id=?1) AND task_generation=?2 AND status='running'"),
            params![task_id, generation], execution_row,
        ).optional().map_err(store_error)?;
        let Some(execution) = execution else {
            return Ok(None);
        };
        let task = Self::require_on(&tx, task_id)?;
        if task.status != ResearchTaskStatus::Running
            || task.execution_generation != generation
            || task.cancel_requested
        {
            return Ok(None);
        }
        let group = group_on(&tx, &task.project_id, &execution.group_id)?;
        let member = members_on(&tx, &group.id)?
            .into_iter()
            .find(|member| member.id == execution.member_id)
            .ok_or("Member not found.")?;
        tx.execute(
            "UPDATE collaboration_work SET status='\"running\"',execution_id=?3,updated_at=?4 WHERE group_id=?1 AND member_id=?2 AND status='\"pending\"'",
            params![group.id, member.id, execution.id, now_ms()],
        ).map_err(store_error)?;
        let turn = member_turn_on(&tx, group, member, execution)?;
        tx.commit().map_err(store_error)?;
        Ok(Some(turn))
    }

    pub fn group_annotation(
        &self,
        group_id: &str,
        draft: &crate::annotations::AnnotationDraft,
    ) -> Result<crate::annotations::Annotation, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let group = group_on(&tx, &draft.target.project_id, group_id)?;
        if draft
            .target
            .task_id
            .as_ref()
            .is_some_and(|id| Some(id) != group.task_id.as_ref())
        {
            return Err("The annotation belongs to another task.".into());
        }
        let annotation = super::annotations::insert_annotation_on(&tx, draft)?;
        let actor = GroupActor {
            kind: match draft.author.kind {
                crate::annotations::AnnotationAuthorKind::User => ActorKind::User,
                crate::annotations::AnnotationAuthorKind::Member => ActorKind::Member,
                _ => ActorKind::System,
            },
            id: draft.author.id.clone(),
            execution_id: None,
        };
        // A small message links the durable original without creating another copy of its text.
        let message = MessageDraft {
            body: format!(
                "Annotation {} on {}:{}",
                annotation.id, draft.target.object_kind, draft.target.object_id
            ),
            recipients: draft.mentions.clone(),
            reply_to: None,
            object: Some(GroupObject {
                kind: draft.target.object_kind.clone(),
                id: draft.target.object_id.clone(),
                revision: draft.target.object_revision.clone(),
                path: draft.target.path.clone(),
            }),
            request_work: draft.explicit_request,
        };
        let mut routes = BTreeMap::new();
        for member in &draft.mentions {
            route(
                &mut routes,
                member,
                work_reason(
                    "mention",
                    message.object.as_ref(),
                    Some(&annotation.id),
                    None,
                ),
            );
        }
        if draft.explicit_request {
            let interests = interests_on(&tx, group_id)?;
            let attentions = attention::list_on(&tx, group_id)?;
            for member in members_on(&tx, group_id)? {
                for reason in interest_reasons(
                    &member.id,
                    &interests,
                    "annotation",
                    message.object.as_ref().unwrap(),
                )
                .into_iter()
                .chain(attention::matching_reasons(
                    &member.id,
                    &attentions,
                    message.object.as_ref().unwrap(),
                    false,
                )) {
                    route(&mut routes, &member.id, reason);
                }
            }
            if let Some(parent) = &annotation.parent_id {
                for handling in super::annotations::handlings_on(&tx, parent)? {
                    if handling.author.kind == crate::annotations::AnnotationAuthorKind::Member
                        && members_on(&tx, group_id)?
                            .iter()
                            .any(|m| m.id == handling.author.id)
                    {
                        route(
                            &mut routes,
                            &handling.author.id,
                            work_reason(
                                "parent_handling",
                                message.object.as_ref(),
                                Some(&handling.id),
                                None,
                            ),
                        );
                    }
                }
            }
            routes.remove(&actor.id);
            if routes.is_empty() {
                if let Some(member) = members_on(&tx, group_id)?
                    .iter()
                    .find(|m| m.config.coordinator && m.id != actor.id)
                {
                    route(
                        &mut routes,
                        &member.id,
                        work_reason(
                            "coordinator",
                            message.object.as_ref(),
                            Some(&annotation.id),
                            None,
                        ),
                    );
                }
            }
        }
        routes.remove(&actor.id);
        save_routed_message_on(&tx, &group, &actor, &message, routes, Some(&annotation.id))?;
        if draft.explicit_request {
            record_group_event_on(
                &tx,
                &draft.target.project_id,
                group_id,
                &format!("annotation:{}", annotation.id),
                "annotation_requested",
                message.object.as_ref().unwrap(),
                &actor,
                &annotation.context_reference().to_string(),
            )?;
        }
        tx.commit().map_err(store_error)?;
        Ok(annotation)
    }

    pub fn create_task_group(
        &self,
        project: &str,
        task_id: Option<&str>,
        drafts: &[MemberDraft],
    ) -> Result<GroupSnapshot, String> {
        if drafts.is_empty()
            || drafts.len() > 8
            || drafts.iter().filter(|m| m.coordinator).count() != 1
        {
            return Err("A group needs one coordinator and up to eight members.".into());
        }
        for member in drafts {
            validate_text(&member.name, "Member name", 1, 80)?;
            validate_text(&member.responsibility, "Member responsibility", 1, 4000)?;
            validate_text(&member.runtime_id, "Runtime", 1, 80)?;
        }
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        if let Some(task) = task_id {
            if Self::require_on(&tx, task)?.project_id != project {
                return Err("This task is outside the project.".into());
            }
        }
        let id = fresh_id("group");
        let now = now_ms();
        tx.execute("INSERT INTO collaboration_groups(id,project_id,task_id,status,created_at,updated_at) VALUES(?1,?2,?3,'open',?4,?4)",params![id,project,task_id,now]).map_err(store_error)?;
        for config in drafts {
            tx.execute("INSERT INTO collaboration_members(id,group_id,config_json,joined_at) VALUES(?1,?2,?3,?4)",params![fresh_id("member"),id,encode_json(config)?,now]).map_err(store_error)?;
        }
        tx.commit().map_err(store_error)?;
        self.group_snapshot(project, &id, 0)
    }
    pub fn task_group(&self, project: &str, task: &str) -> Result<Option<TaskGroup>, String> {
        let c = self.open()?;
        let id: Option<String> = c
            .query_row(
                "SELECT id FROM collaboration_groups WHERE task_id=?1 AND project_id=?2",
                params![task, project],
                |r| r.get(0),
            )
            .optional()
            .map_err(store_error)?;
        id.map(|id| group_on(&c, project, &id)).transpose()
    }
    pub fn group_snapshot(
        &self,
        project: &str,
        id: &str,
        after: u64,
    ) -> Result<GroupSnapshot, String> {
        let mut c = self.open()?;
        let tx = c.transaction().map_err(store_error)?;
        let group = group_on(&tx, project, id)?;
        let ids=tx.prepare("SELECT id FROM collaboration_messages WHERE group_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 100").and_then(|mut q|q.query_map(params![id,after],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let messages = ids
            .into_iter()
            .map(|mid| message_on(&tx, id, &mid))
            .collect::<Result<Vec<_>, String>>()?;
        let executions=tx.prepare(&format!("SELECT {EXECUTION_COLUMNS} FROM collaboration_executions WHERE group_id=?1 ORDER BY started_at DESC,id DESC")).and_then(|mut q|q.query_map([id],execution_row)?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let events = tx
            .prepare(
                "SELECT rowid,event_json FROM collaboration_events WHERE group_id=?1 ORDER BY rowid",
            )
            .and_then(|mut q| {
                q.query_map([id], |r| {
                    Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?
            .into_iter()
            .map(|(sequence, json)| {
                let mut event: GroupEvent = decode_json(&json, "group event")?;
                event.sequence = sequence;
                Ok(event)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(GroupSnapshot {
            next_sequence: messages.last().map_or(after, |m| m.sequence),
            members: members_on(&tx, id)?,
            interests: interests_on(&tx, id)?,
            attentions: attention::list_on(&tx, id)?,
            messages,
            events,
            work: work_on(&tx, id)?,
            executions,
            events_has_more: false,
            executions_has_more: false,
            group,
        })
    }

    /// The panel needs a bounded first view. Runtime tools keep using
    /// `group_snapshot`, whose complete execution history is part of their
    /// observable context. Historical records outside this page are resolved
    /// through the exact lookup and keyset page methods below.
    pub fn group_ui_snapshot(
        &self,
        project: &str,
        task: &str,
        id: &str,
        after: u64,
    ) -> Result<GroupSnapshot, String> {
        let mut c = self.open()?;
        let tx = c.transaction().map_err(store_error)?;
        let group = group_on(&tx, project, id)?;
        if group.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        let ids = tx
            .prepare(
                "SELECT id FROM collaboration_messages
                 WHERE group_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 100",
            )
            .and_then(|mut query| {
                query
                    .query_map(params![id, after], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(store_error)?;
        let messages = ids
            .into_iter()
            .map(|message_id| message_on(&tx, id, &message_id))
            .collect::<Result<Vec<_>, _>>()?;
        let events = event_page_on(&tx, id, None, GROUP_UI_PAGE_SIZE)?;
        let executions = execution_page_on(&tx, id, None, None, GROUP_UI_PAGE_SIZE)?;
        Ok(GroupSnapshot {
            next_sequence: messages.last().map_or(after, |message| message.sequence),
            members: members_on(&tx, id)?,
            interests: interests_on(&tx, id)?,
            attentions: attention::list_on(&tx, id)?,
            messages,
            events: events.events,
            work: work_on(&tx, id)?,
            executions: executions.executions,
            events_has_more: events.has_more,
            executions_has_more: executions.has_more,
            group,
        })
    }

    pub fn group_events_page(
        &self,
        project: &str,
        task: &str,
        group: &str,
        before_sequence: Option<u64>,
        limit: usize,
    ) -> Result<GroupEventPage, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        event_page_on(&connection, group, before_sequence, limit)
    }

    pub fn group_executions_page(
        &self,
        project: &str,
        task: &str,
        group: &str,
        before_started_at: Option<i64>,
        before_id: Option<&str>,
        limit: usize,
    ) -> Result<GroupExecutionPage, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        execution_page_on(&connection, group, before_started_at, before_id, limit)
    }

    pub fn group_events_after_page(
        &self,
        project: &str,
        task: &str,
        group: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<GroupEventPage, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        event_after_page_on(&connection, group, after_sequence, limit)
    }

    pub fn group_executions_after_page(
        &self,
        project: &str,
        task: &str,
        group: &str,
        after_started_at: i64,
        after_id: &str,
        limit: usize,
    ) -> Result<GroupExecutionPage, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        execution_after_page_on(&connection, group, after_started_at, after_id, limit)
    }

    pub fn group_event(
        &self,
        project: &str,
        task: &str,
        group: &str,
        id: &str,
    ) -> Result<Option<GroupEvent>, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        event_on(&connection, group, id)
    }

    pub fn group_execution(
        &self,
        project: &str,
        task: &str,
        group: &str,
        id: &str,
    ) -> Result<Option<MemberExecution>, String> {
        let connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        if group_record.task_id.as_deref() != Some(task) {
            return Err("This task group belongs to another task.".into());
        }
        connection
            .query_row(
                &format!(
                    "SELECT {EXECUTION_COLUMNS} FROM collaboration_executions
                     WHERE id=?1 AND group_id=?2"
                ),
                params![id, group],
                execution_row,
            )
            .optional()
            .map_err(store_error)
    }
    pub fn group_message(
        &self,
        project: &str,
        id: &str,
        actor: &GroupActor,
        draft: &MessageDraft,
    ) -> Result<GroupMessage, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let group = group_on(&tx, project, id)?;
        let msg = insert_message_on(&tx, &group, actor, draft)?;
        tx.commit().map_err(store_error)?;
        Ok(msg)
    }
    pub fn set_group_status(
        &self,
        project: &str,
        id: &str,
        status: GroupStatus,
    ) -> Result<(), String> {
        let c = self.open()?;
        group_on(&c, project, id)?;
        c.execute(
            "UPDATE collaboration_groups SET status=?3,updated_at=?4 WHERE id=?1 AND project_id=?2",
            params![
                id,
                project,
                match status {
                    GroupStatus::Open => "open",
                    GroupStatus::Paused => "paused",
                    GroupStatus::Closed => "closed",
                },
                now_ms()
            ],
        )
        .map_err(store_error)?;
        Ok(())
    }
    pub fn set_member_paused(
        &self,
        project: &str,
        group: &str,
        member: &str,
        paused: bool,
    ) -> Result<(), String> {
        let c = self.open()?;
        group_on(&c, project, group)?;
        if c.execute(
            "UPDATE collaboration_members SET paused=?3 WHERE id=?1 AND group_id=?2",
            params![member, group, paused],
        )
        .map_err(store_error)?
            != 1
        {
            return Err("Member not found in this group.".into());
        }
        Ok(())
    }
    pub fn set_member_interest(
        &self,
        project: &str,
        group: &str,
        interest: &MemberInterest,
        active: bool,
    ) -> Result<(), String> {
        validate_text(&interest.value, "Interest", 1, 1024)?;
        let c = self.open()?;
        group_on(&c, project, group)?;
        if !members_on(&c, group)?
            .iter()
            .any(|m| m.id == interest.member_id)
        {
            return Err("Member not found in this group.".into());
        }
        if active {c.execute("INSERT OR IGNORE INTO collaboration_interests(member_id,kind,value) VALUES(?1,?2,?3)",params![interest.member_id,encode_json(&interest.kind)?,interest.value])}else{c.execute("DELETE FROM collaboration_interests WHERE member_id=?1 AND kind=?2 AND value=?3",params![interest.member_id,encode_json(&interest.kind)?,interest.value])}.map_err(store_error)?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn record_group_event(
        &self,
        project: &str,
        group: &str,
        key: &str,
        kind: &str,
        object: &GroupObject,
        actor: &GroupActor,
        detail: &str,
    ) -> Result<Vec<String>, String> {
        let mut c = self.open()?;
        let evidence = if kind == "run_finished" {
            group_on(&c, project, group)?.task_id.as_deref().map(|task| {
                match self.run(task,&object.id) {
                    Ok(run) => {
                        let log=crate::runs::log::answer(&std::path::Path::new(&run.run_dir).join("stdout.log"), &crate::runs::LogQuery::Tail{lines:40});
                        serde_json::json!({"availability":"available","run":run,"logTail":log.as_ref().ok().map(|text|text.chars().take(6000).collect::<String>()),"logError":log.err()})
                    },
                    Err(error) => serde_json::json!({"availability":"unavailable","reason":error}),
                }
            })
        } else {
            None
        };
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let routed = record_event_with_evidence_on(
            &tx, project, group, key, kind, object, actor, detail, evidence,
        )?;
        tx.commit().map_err(store_error)?;
        Ok(routed)
    }

    /// A file hash identifies content, not a unique change. Compare with the
    /// last observed file event so a later rollback to the same bytes is new
    /// work, while repeated scans of one state remain idempotent.
    pub fn record_group_file_change(
        &self,
        project: &str,
        group: &str,
        object: &GroupObject,
    ) -> Result<Vec<String>, String> {
        let mut connection = self.open()?;
        let group_record = group_on(&connection, project, group)?;
        let task = group_record
            .task_id
            .as_deref()
            .map(|id| Self::require_on(&connection, id))
            .transpose()?;
        let evidence = task
            .as_ref()
            .filter(|task| {
                !object.path.as_deref().is_some_and(|path| {
                    crate::record::is_coordination_file(&task.record_slug, path)
                })
            })
            .map(|task| crate::responsibility::file_evidence(task, object));
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        group_on(&tx, project, group)?;
        let previous: Option<String> = tx.query_row(
            "SELECT event_json FROM collaboration_events WHERE group_id=?1 AND json_extract(event_json,'$.kind')='file_changed' AND json_extract(event_json,'$.object.kind')=?2 AND json_extract(event_json,'$.object.id')=?3 ORDER BY rowid DESC LIMIT 1",
            params![group,object.kind,object.id], |row|row.get(0),
        ).optional().map_err(store_error)?;
        if let Some(previous) = previous {
            let previous: GroupEvent = decode_json(&previous, "group file event")?;
            if previous.object == *object {
                return Ok(Vec::new());
            }
        }
        let routed = record_event_with_evidence_on(
            &tx,
            project,
            group,
            &fresh_id("file-change"),
            "file_changed",
            object,
            &GroupActor {
                kind: ActorKind::System,
                id: "workspace-observer".into(),
                execution_id: None,
            },
            "The task workspace changed; inspect this revision if it affects your responsibility.",
            evidence,
        )?;
        tx.commit().map_err(store_error)?;
        Ok(routed)
    }
    /// One member at a time uses a task's shared workspace and budget. The same transaction
    /// closes the idle/claim gap and assigns all currently pending causes for that member.
    pub fn claim_member_turn(&self, task: &ResearchTask) -> Result<Option<MemberTurn>, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let current = Self::require_on(&tx, &task.id)?;
        if current.status != ResearchTaskStatus::Running
            || current.execution_generation != task.execution_generation
            || current.cancel_requested
        {
            return Ok(None);
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
            return Ok(None);
        };
        let group = group_on(&tx, &task.project_id, &group_id)?;
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_executions WHERE group_id=?1 AND status='running')",[&group_id],|r|r.get(0)).map_err(store_error)?;
        if active {
            return Ok(None);
        }
        checkpoints::release_ready_on(&tx, &group)?;
        let member_id:Option<String>=tx.query_row("SELECT w.member_id FROM collaboration_work w JOIN collaboration_members m ON m.id=w.member_id WHERE w.group_id=?1 AND w.status='\"pending\"' AND m.paused=0 ORDER BY w.priority DESC,w.created_at,w.id LIMIT 1",[&group_id],|r|r.get(0)).optional().map_err(store_error)?;
        let Some(member_id) = member_id else {
            return Ok(None);
        };
        let member = members_on(&tx, &group_id)?
            .into_iter()
            .find(|m| m.id == member_id)
            .ok_or("The member no longer exists.")?;
        let execution = MemberExecution {
            id: fresh_id("execution"),
            group_id: group_id.clone(),
            member_id: member_id.clone(),
            task_generation: task.execution_generation,
            session_id: fresh_id("member-session"),
            runtime_id: member.config.runtime_id.clone(),
            agent_id: member.config.agent_id.clone(),
            model_id: member.config.model_id.clone(),
            provider_id: None,
            status: "running".into(),
            input_tokens: None,
            output_tokens: None,
            started_at: now_ms(),
            finished_at: None,
        };
        tx.execute("INSERT INTO collaboration_executions(id,group_id,member_id,task_generation,session_id,runtime_id,agent_id,model_id,status,started_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'running',?9)",params![execution.id,group_id,member_id,task.execution_generation,execution.session_id,execution.runtime_id,execution.agent_id,execution.model_id,execution.started_at]).map_err(store_error)?;
        tx.execute("UPDATE collaboration_work SET status='\"running\"',execution_id=?3,updated_at=?4 WHERE group_id=?1 AND member_id=?2 AND status IN ('\"pending\"','\"waiting\"')",params![group_id,member_id,execution.id,now_ms()]).map_err(store_error)?;
        let turn = member_turn_on(&tx, group, member, execution)?;
        tx.commit().map_err(store_error)?;
        Ok(Some(turn))
    }
    pub fn finish_member_turn(
        &self,
        turn: &MemberTurn,
        outcome: &TaskRuntimeOutcome,
        error: Option<&str>,
    ) -> Result<GroupMessage, String> {
        if outcome.checkpoint.is_some() {
            return Err("Settle a member checkpoint without completing its work.".into());
        }
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let group = group_on(&tx, &turn.group.project_id, &turn.group.id)?;
        let status = if error.is_some() {
            "failed"
        } else if outcome.waiting_for_reply {
            "waiting"
        } else {
            "completed"
        };
        let changed=tx.execute("UPDATE collaboration_executions SET status=?2,input_tokens=?3,output_tokens=?4,finished_at=?5 WHERE id=?1 AND status='running'",params![turn.execution.id,status,outcome.input_tokens,outcome.output_tokens,now_ms()]).map_err(store_error)?;
        if changed != 1 {
            return Err("This member execution already ended.".into());
        }
        let actor = GroupActor {
            kind: ActorKind::Member,
            id: turn.member.id.clone(),
            execution_id: Some(turn.execution.id.clone()),
        };
        let claimed = member_turn_on(
            &tx,
            group.clone(),
            turn.member.clone(),
            turn.execution.clone(),
        )?;
        let body = error.map(str::to_owned).unwrap_or_else(|| {
            if outcome.summary.trim().is_empty() {
                "Execution finished without a text summary.".into()
            } else {
                outcome.summary.clone()
            }
        });
        let requests: Vec<_> = claimed
            .messages
            .iter()
            .filter(|message| {
                !outcome.waiting_for_reply
                    && message.content.request_work
                    && message.author.kind == ActorKind::Member
                    && message.author.id != turn.member.id
            })
            .map(|message| {
                let replied: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM collaboration_messages m
                     WHERE m.group_id=?1 AND json_extract(m.author_json,'$.executionId')=?2
                       AND json_extract(m.content_json,'$.replyTo')=?3
                       AND json_extract(m.content_json,'$.requestWork')=0
                       AND json_extract(m.content_json,'$.body')=?5
                       AND EXISTS(SELECT 1 FROM json_each(m.content_json,'$.recipients') r WHERE r.value=?4))",
                    params![group.id, turn.execution.id, message.id, message.author.id, body],
                    |row| row.get(0),
                ).map_err(store_error)?;
                Ok((message, replied))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .filter_map(|(message, replied)| (!replied).then_some(message))
            .collect();
        let mut recipients: Vec<_> = requests
            .iter()
            .map(|message| message.author.id.clone())
            .collect();
        recipients.sort();
        recipients.dedup();
        let content = MessageDraft {
            body,
            recipients,
            reply_to: (requests.len() == 1).then(|| requests[0].id.clone()),
            request_work: false,
            ..Default::default()
        };
        let message = insert_message_on(&tx, &group, &actor, &content)?;
        let work_status = if error.is_some() {
            WorkStatus::Failed
        } else if outcome.waiting_for_reply {
            WorkStatus::Waiting
        } else {
            WorkStatus::Completed
        };
        tx.execute("UPDATE collaboration_work SET status=?2,result_message_id=?3,updated_at=?4 WHERE execution_id=?1 AND status='\"running\"'",params![turn.execution.id,encode_json(&work_status)?,message.id,now_ms()]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(message)
    }
    /// A pause, cancellation, or budget stop does not complete the claimed causes.
    /// Retain any reported usage and let an explicit resume pick up the same work.
    pub fn interrupt_member_turn(
        &self,
        turn: &MemberTurn,
        outcome: Option<&TaskRuntimeOutcome>,
    ) -> Result<(), String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let changed = tx.execute(
            "UPDATE collaboration_executions SET status='interrupted',input_tokens=?2,output_tokens=?3,finished_at=?4 WHERE id=?1 AND status='running'",
            params![turn.execution.id, outcome.and_then(|o| o.input_tokens), outcome.and_then(|o| o.output_tokens), now_ms()],
        ).map_err(store_error)?;
        if changed != 1 {
            return Err("This member execution already ended.".into());
        }
        tx.execute(
            "UPDATE collaboration_work SET status='\"pending\"',execution_id=NULL,updated_at=?2 WHERE execution_id=?1 AND status='\"running\"'",
            params![turn.execution.id, now_ms()],
        ).map_err(store_error)?;
        tx.commit().map_err(store_error)
    }
    pub fn member_conversation(
        &self,
        member: &str,
        runtime: &str,
        model: &str,
    ) -> Result<Option<Vec<oleafly_agent::Message>>, String> {
        self.open()?.query_row("SELECT conversation_json FROM collaboration_executions WHERE member_id=?1 AND runtime_id=?2 AND model_id=?3 AND conversation_json IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1",params![member,runtime,model],|r|r.get::<_,String>(0)).optional().map_err(store_error)?.map(|j|decode_json(&j,"member conversation")).transpose()
    }
    pub fn save_member_conversation(
        &self,
        execution: &str,
        messages: &[oleafly_agent::Message],
    ) -> Result<(), String> {
        self.open()?
            .execute(
                "UPDATE collaboration_executions SET conversation_json=?2 WHERE id=?1",
                params![execution, encode_json(messages)?],
            )
            .map_err(store_error)?;
        Ok(())
    }
    pub fn bind_member_provider(
        &self,
        execution: &str,
        provider: &str,
        model: &str,
    ) -> Result<(), String> {
        self.open()?.execute("UPDATE collaboration_executions SET provider_id=?2,model_id=?3 WHERE id=?1 AND status='running'",params![execution,provider,model]).map_err(store_error)?;
        Ok(())
    }
    pub fn recover_member_turns(&self) -> Result<usize, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let ids=tx.prepare("SELECT e.id,t.owner_pid,t.owner_started FROM collaboration_executions e JOIN collaboration_groups g ON g.id=e.group_id LEFT JOIN research_tasks t ON t.id=g.task_id WHERE e.status='running'").and_then(|mut q|q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,Option<i64>>(2)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let mut n = 0;
        for (id, pid, started) in ids {
            if self.owner_gone(pid, started) {
                tx.execute("UPDATE collaboration_executions SET status='interrupted',finished_at=?2 WHERE id=?1 AND status='running'",params![id,now_ms()]).map_err(store_error)?;
                tx.execute("UPDATE collaboration_work SET status='\"pending\"',execution_id=NULL,updated_at=?2 WHERE execution_id=?1 AND status='\"running\"'",params![id,now_ms()]).map_err(store_error)?;
                n += 1;
            }
        }
        tx.commit().map_err(store_error)?;
        Ok(n)
    }
    pub fn group_has_pending(&self, group: &str) -> Result<bool, String> {
        self.open()?.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_work w JOIN collaboration_members m ON m.id=w.member_id JOIN collaboration_groups g ON g.id=w.group_id WHERE w.group_id=?1 AND w.status='\"pending\"' AND m.paused=0 AND g.status='open')",[group],|r|r.get(0)).map_err(store_error)
    }

    pub(crate) fn message_has_work(&self, group: &str, message: &str) -> Result<bool, String> {
        self.open()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM collaboration_work WHERE group_id=?1 AND cause_kind='message' AND cause_id=?2)",
            params![group, message], |row| row.get(0),
        ).map_err(store_error)
    }
    pub fn seed_group_work(&self, task: &ResearchTask) -> Result<(), String> {
        let Some(group) = self.task_group(&task.project_id, &task.id)? else {
            return Ok(());
        };
        let snapshot = self.group_snapshot(&task.project_id, &group.id, 0)?;
        if snapshot.work.is_empty() {
            let coordinator = snapshot
                .members
                .iter()
                .find(|m| m.config.coordinator)
                .ok_or("The group has no coordinator.")?;
            self.group_message(
                &task.project_id,
                &group.id,
                &GroupActor::user(),
                &MessageDraft {
                    body: task.prompt.clone(),
                    recipients: vec![coordinator.id.clone()],
                    request_work: true,
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    /// Reconcile durable pending work after a message commit, a completed task,
    /// or restart. This also closes the last-empty-inbox to review-ready race.
    pub fn queue_group_followups(&self) -> Result<Vec<ResearchTask>, String> {
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let checkpoint_groups = tx.prepare(
            "SELECT DISTINCT g.project_id,g.id FROM collaboration_groups g
             JOIN collaboration_work w ON w.group_id=g.id
             JOIN research_tasks t ON t.id=g.task_id
             WHERE g.status='open' AND w.status='\"checkpointed\"'
               AND t.status IN ('running','queued','awaiting_review','completed')
               AND t.cancel_requested=0 AND t.stop_reason IS NULL AND t.apply_state IS NULL
               AND NOT EXISTS(SELECT 1 FROM collaboration_executions e WHERE e.group_id=g.id AND e.status='running')",
        ).and_then(|mut query|query.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        for (project, group) in checkpoint_groups {
            checkpoints::release_ready_on(&tx, &group_on(&tx, &project, &group)?)?;
        }
        let ids = tx.prepare("SELECT DISTINCT g.task_id FROM collaboration_groups g JOIN research_tasks t ON t.id=g.task_id WHERE g.status='open' AND (EXISTS(SELECT 1 FROM collaboration_work w JOIN collaboration_members m ON m.id=w.member_id WHERE w.group_id=g.id AND w.status='\"pending\"' AND m.paused=0) OR (EXISTS(SELECT 1 FROM collaboration_responsibility_receipts r JOIN collaboration_events e ON e.id=r.event_id WHERE e.group_id=g.id AND r.assessment_id IS NULL) AND EXISTS(SELECT 1 FROM collaboration_members m WHERE m.group_id=g.id AND m.paused=0 AND json_extract(m.config_json,'$.coordinator')=1 AND json_extract(m.config_json,'$.runtimeId')='builtin'))) AND (t.status IN ('awaiting_review','completed') OR (t.status='queued' AND t.start_requested=0)) AND t.apply_state IS NULL")
            .and_then(|mut q|q.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let mut queued = Vec::new();
        for id in ids {
            let task = Self::require_on(&tx, &id)?;
            if matches!(
                task.stop_reason,
                Some(
                    crate::model::StopReason::BudgetTime
                        | crate::model::StopReason::BudgetCost
                        | crate::model::StopReason::BudgetRuns
                )
            ) {
                continue;
            }
            let group_id: String = tx
                .query_row(
                    "SELECT id FROM collaboration_groups WHERE task_id=?1",
                    [&id],
                    |row| row.get(0),
                )
                .map_err(store_error)?;
            if let Some((_, checkpoint)) = checkpoints::open_on(&tx, &group_id)? {
                let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_work w JOIN collaboration_members m ON m.id=w.member_id WHERE w.group_id=?1 AND w.status='\"pending\"' AND m.paused=0)",[&group_id],|row|row.get(0)).map_err(store_error)?;
                if !pending && !checkpoints::pending_receipts_on(&tx, &checkpoint)? {
                    continue;
                }
            }
            if task.status == ResearchTaskStatus::Queued {
                tx.execute(
                    "UPDATE research_tasks SET start_requested=1,updated_at=?2 WHERE id=?1 AND status='queued' AND start_requested=0",
                    params![id, now_ms()],
                ).map_err(store_error)?;
                queued.push(id);
                continue;
            }
            let Some(isolation) = task.isolation else {
                continue;
            };
            let pending = PendingStart::Resume {
                isolation: Box::new(isolation),
                reason: ResumeReason::Collaboration,
                previous_native_session_id: None,
            };
            tx.execute("UPDATE research_tasks SET status='queued',start_requested=1,pending_start_json=?2,cancel_requested=0,updated_at=?3,finished_at=NULL WHERE id=?1 AND status IN ('awaiting_review','completed') AND apply_state IS NULL",params![id,encode_json(&pending)?,now_ms()]).map_err(store_error)?;
            queued.push(id);
        }
        tx.commit().map_err(store_error)?;
        queued.into_iter().map(|id| self.require(&id)).collect()
    }
}

#[cfg(test)]
#[path = "collaboration_tests.rs"]
mod tests;
