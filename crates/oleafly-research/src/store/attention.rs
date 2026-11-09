use super::*;

pub(crate) const SCHEMA_SQL: &str = "
ALTER TABLE collaboration_work ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE collaboration_attentions (
 member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
 object_kind TEXT NOT NULL, object_id TEXT NOT NULL, relation TEXT NOT NULL,
 attention_json TEXT NOT NULL,
 PRIMARY KEY(member_id,object_kind,object_id,relation)
);
";

pub(super) fn list_on(
    connection: &Connection,
    group: &str,
) -> Result<Vec<MemberAttention>, String> {
    connection.prepare("SELECT a.attention_json FROM collaboration_attentions a JOIN collaboration_members m ON m.id=a.member_id WHERE m.group_id=?1 ORDER BY a.rowid")
        .and_then(|mut query| query.query_map([group], |row| row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>())
        .map_err(store_error)?.into_iter().map(|value| decode_json(&value,"member attention")).collect()
}

fn save_on(tx: &Transaction<'_>, attention: &MemberAttention) -> Result<(), String> {
    tx.execute(
        "DELETE FROM collaboration_attentions WHERE member_id=?1 AND object_kind=?2 AND object_id=?3 AND relation=?4",
        params![
            attention.member_id,
            attention.object.kind,
            attention.object.id,
            attention.relation
        ],
    )
    .map_err(store_error)?;
    tx.execute(
        "INSERT INTO collaboration_attentions(member_id,object_kind,object_id,relation,attention_json) VALUES(?1,?2,?3,?4,?5)",
        params![
            attention.member_id,
            attention.object.kind,
            attention.object.id,
            attention.relation,
            encode_json(attention)?
        ],
    )
    .map_err(store_error)?;
    Ok(())
}

pub(super) fn matching_reasons(
    member: &str,
    attentions: &[MemberAttention],
    object: &GroupObject,
    changed_only: bool,
) -> Vec<WorkReason> {
    let matching = attentions
        .iter()
        .filter(|attention| {
            attention.member_id == member
                && ((attention.object.kind == object.kind && attention.object.id == object.id)
                    || (object.kind == "file"
                        && object.path.is_some()
                        && attention.object.path == object.path))
        })
        .collect::<Vec<_>>();
    let known_revision = matching
        .iter()
        .rfind(|attention| matches!(attention.relation.as_str(), "read" | "wrote"))
        .and_then(|attention| attention.object.revision.as_deref());
    if changed_only && object.revision.is_some() && known_revision == object.revision.as_deref() {
        return Vec::new();
    }
    matching
        .into_iter()
        .map(|attention| WorkReason {
            kind: attention.relation.clone(),
            object: Some(attention.object.clone()),
            source_id: Some(attention.source_id.clone()),
            execution_id: attention.execution_id.clone(),
        })
        .collect()
}

pub(in crate::store) fn record_handling_on(
    tx: &Transaction<'_>,
    annotation: &crate::annotations::Annotation,
    handling: &crate::annotations::AnnotationHandling,
) -> Result<(), String> {
    if handling.author.kind != crate::annotations::AnnotationAuthorKind::Member {
        return Ok(());
    }
    let Some(task) = annotation.target.task_id.as_deref() else {
        return Ok(());
    };
    let group: Option<String> = tx.query_row("SELECT g.id FROM collaboration_groups g JOIN collaboration_members m ON m.group_id=g.id WHERE g.task_id=?1 AND g.project_id=?2 AND m.id=?3",params![task,annotation.target.project_id,handling.author.id],|row|row.get(0)).optional().map_err(store_error)?;
    let Some(group) = group else {
        return Ok(());
    };
    let execution: Option<String> = tx.query_row("SELECT id FROM collaboration_executions WHERE group_id=?1 AND member_id=?2 AND status='running'",params![group,handling.author.id],|row|row.get(0)).optional().map_err(store_error)?;
    let target = &annotation.target;
    save_on(
        tx,
        &MemberAttention {
            member_id: handling.author.id.clone(),
            object: GroupObject {
                kind: target.object_kind.clone(),
                id: target.object_id.clone(),
                revision: target.object_revision.clone(),
                path: target.path.clone(),
            },
            relation: "handled".into(),
            source_id: handling.id.clone(),
            execution_id: execution,
            updated_at: handling.created_at,
        },
    )?;
    Ok(())
}

impl TaskStore {
    /// Called only after a successful managed operation by this actual member.
    /// No model call or wake-up is caused by recording the relationship itself.
    pub fn record_member_attention(
        &self,
        task_id: &str,
        generation: u64,
        object: &GroupObject,
        relation: &str,
        source_id: &str,
    ) -> Result<(), String> {
        if !matches!(relation, "read" | "wrote") {
            return Err("Record a managed read or write relationship.".into());
        }
        let mut connection = self.open()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let task = Self::require_on(&tx, task_id)?;
        if task.execution_generation != generation
            || task.status != ResearchTaskStatus::Running
            || task.cancel_requested
        {
            return Err("This attention belongs to an inactive task execution.".into());
        }
        let actor:Option<(String,String)>=tx.query_row("SELECT e.member_id,e.id FROM collaboration_executions e JOIN collaboration_groups g ON g.id=e.group_id WHERE g.task_id=?1 AND e.task_generation=?2 AND e.status='running'",params![task_id,generation],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(store_error)?;
        if let Some((member, execution)) = actor {
            save_on(
                &tx,
                &MemberAttention {
                    member_id: member,
                    object: object.clone(),
                    relation: relation.into(),
                    source_id: source_id.into(),
                    execution_id: Some(execution),
                    updated_at: now_ms(),
                },
            )?;
        }
        tx.commit().map_err(store_error)
    }
}

#[cfg(test)]
#[path = "attention_tests.rs"]
mod tests;
