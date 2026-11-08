use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use super::{decode_json, encode_json, fresh_id, store_error, validate_text, TaskStore};
use crate::collaboration::*;
use crate::model::{
    now_ms, PendingStart, ResearchTask, ResearchTaskStatus, ResumeReason, TaskRuntimeOutcome,
};

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
    connection.prepare("SELECT id,member_id,cause_kind,cause_id,priority,status,execution_id,result_message_id,created_at,updated_at FROM collaboration_work WHERE group_id=?1 ORDER BY priority DESC,created_at,id").and_then(|mut q|q.query_map([group],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,u32>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?)))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?.into_iter().map(|(id,member_id,cause_kind,cause_id,priority,status,execution_id,result_message_id,created_at,updated_at)|Ok(GroupWork {id,group_id:group.into(),member_id,cause_kind,cause_id,priority,status:decode_json(&status,"work status")?,execution_id,result_message_id,created_at,updated_at})).collect()
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

pub(super) fn insert_work_on(
    tx: &Transaction<'_>,
    group: &str,
    member: &str,
    kind: &str,
    cause: &str,
    priority: u32,
) -> Result<(), String> {
    tx.execute("INSERT INTO collaboration_work(id,group_id,member_id,cause_kind,cause_id,priority,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'\"pending\"',?7,?7) ON CONFLICT(member_id,cause_kind,cause_id) DO NOTHING",params![fresh_id("work"),group,member,kind,cause,priority,now_ms()]).map_err(store_error)?;
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
fn interested(
    member: &str,
    interests: &[MemberInterest],
    kind: &str,
    object: &GroupObject,
) -> bool {
    interests
        .iter()
        .filter(|i| i.member_id == member)
        .any(|i| match i.kind {
            InterestKind::Path => object
                .path
                .as_ref()
                .is_some_and(|path| path_matches(&i.value, path)),
            InterestKind::Object => i.value == format!("{}:{}", object.kind, object.id),
            InterestKind::Event => i.value == kind,
        })
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
    let mut recipients: BTreeSet<String> = draft.recipients.iter().cloned().collect();
    for id in &recipients {
        if !members.iter().any(|m| &m.id == id) {
            return Err("A recipient is not in this group.".into());
        }
    }
    if let Some(reply) = &draft.reply_to {
        let parent = message_on(tx, &group.id, reply)?;
        if parent.author.kind == ActorKind::Member {
            recipients.insert(parent.author.id);
        }
    }
    for member in &members {
        let mentioned = draft.body.contains(&format!("@{}", member.config.name))
            || draft.body.contains(&format!("@{}", member.id));
        let relevant = draft
            .object
            .as_ref()
            .is_some_and(|object| interested(&member.id, &interests, "message", object));
        if mentioned || relevant {
            recipients.insert(member.id.clone());
        }
    }
    if recipients.is_empty() && draft.request_work {
        if let Some(member) = members.iter().find(|m| m.config.coordinator) {
            recipients.insert(member.id.clone());
        }
    }
    recipients.remove(&actor.id);
    let now = now_ms();
    let id = fresh_id("message");
    let mut content = draft.clone();
    content.recipients = recipients.iter().cloned().collect();
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
            for member in recipients {
                insert_work_on(
                    tx,
                    &group.id,
                    &member,
                    "message",
                    &id,
                    if actor.kind == ActorKind::User {
                        100
                    } else {
                        50
                    },
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
                let json: String = connection
                    .query_row(
                        "SELECT event_json FROM collaboration_events WHERE id=?1 AND group_id=?2",
                        params![item.cause_id, group.id],
                        |r| r.get(0),
                    )
                    .map_err(store_error)?;
                events.push(decode_json(&json, "group event")?);
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
        let sent = insert_message_on(&tx, &group, &actor, &message)?;
        tx.execute("UPDATE collaboration_work SET cause_kind='annotation',cause_id=?2 WHERE cause_kind='message' AND cause_id=?1",params![sent.id,annotation.id]).map_err(store_error)?;
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
            .collect::<Result<Vec<_>, _>>()?;
        let executions=tx.prepare(&format!("SELECT {EXECUTION_COLUMNS} FROM collaboration_executions WHERE group_id=?1 ORDER BY started_at DESC LIMIT 100")).and_then(|mut q|q.query_map([id],execution_row)?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        Ok(GroupSnapshot {
            next_sequence: messages.last().map_or(after, |m| m.sequence),
            members: members_on(&tx, id)?,
            interests: interests_on(&tx, id)?,
            messages,
            work: work_on(&tx, id)?,
            executions,
            group,
        })
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
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let g = group_on(&tx, project, group)?;
        validate_actor(&tx, group, actor)?;
        let event = GroupEvent {
            id: fresh_id("event"),
            group_id: group.into(),
            kind: kind.into(),
            object: object.clone(),
            author: actor.clone(),
            detail: detail.into(),
            created_at: now_ms(),
        };
        if tx.execute("INSERT OR IGNORE INTO collaboration_events(id,group_id,dedupe_key,event_json) VALUES(?1,?2,?3,?4)",params![event.id,group,key,encode_json(&event)?]).map_err(store_error)?==0{return Ok(Vec::new());}
        let mut routed = Vec::new();
        if g.status != GroupStatus::Closed {
            let interests = interests_on(&tx, group)?;
            for member in members_on(&tx, group)? {
                if member.id != actor.id && interested(&member.id, &interests, kind, object) {
                    insert_work_on(&tx, group, &member.id, "event", &event.id, 25)?;
                    routed.push(member.id);
                }
            }
        }
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
        tx.execute("UPDATE collaboration_work SET status='\"running\"',execution_id=?3,updated_at=?4 WHERE group_id=?1 AND member_id=?2 AND status='\"pending\"'",params![group_id,member_id,execution.id,now_ms()]).map_err(store_error)?;
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
        let mut c = self.open()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let group = group_on(&tx, &turn.group.project_id, &turn.group.id)?;
        let status = if error.is_some() {
            "failed"
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
        let content = MessageDraft {
            body: error.map(str::to_owned).unwrap_or_else(|| {
                if outcome.summary.trim().is_empty() {
                    "Execution finished without a text summary.".into()
                } else {
                    outcome.summary.clone()
                }
            }),
            request_work: false,
            ..Default::default()
        };
        let message = insert_message_on(&tx, &group, &actor, &content)?;
        tx.execute("UPDATE collaboration_work SET status=?2,result_message_id=?3,updated_at=?4 WHERE execution_id=?1 AND status='\"running\"'",params![turn.execution.id,encode_json(&if error.is_some(){WorkStatus::Failed}else{WorkStatus::Completed})?,message.id,now_ms()]).map_err(store_error)?;
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
        let ids = tx.prepare("SELECT DISTINCT g.task_id FROM collaboration_groups g JOIN collaboration_work w ON w.group_id=g.id JOIN collaboration_members m ON m.id=w.member_id JOIN research_tasks t ON t.id=g.task_id WHERE g.status='open' AND w.status='\"pending\"' AND m.paused=0 AND (t.status IN ('awaiting_review','completed') OR (t.status='queued' AND t.start_requested=0)) AND t.apply_state IS NULL")
            .and_then(|mut q|q.query_map([],|r|r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()).map_err(store_error)?;
        let mut queued = Vec::new();
        for id in ids {
            let task = Self::require_on(&tx, &id)?;
            if task.status == ResearchTaskStatus::Queued {
                tx.execute(
                    "UPDATE research_tasks SET start_requested=1,updated_at=?2 WHERE id=?1 AND status='queued' AND start_requested=0",
                    params![id, now_ms()],
                ).map_err(store_error)?;
                queued.push(id);
                continue;
            }
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
