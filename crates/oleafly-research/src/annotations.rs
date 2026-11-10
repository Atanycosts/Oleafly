//! Durable annotations, scoped requirements, and second-pass distillation.
//!
//! An annotation is the original human or agent utterance tied to a stable
//! object.  It is deliberately separate from a task transcript: old
//! annotations remain addressable after a task has finished and can create new
//! work without rewriting the original decision.  Requirements are the
//! checked, enduring part of that discussion; their lifecycle is independent
//! of the annotation's discussion status.

use serde::{Deserialize, Serialize};

use crate::model::now_ms;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationAuthorKind {
    User,
    Member,
    Model,
    System,
}

impl AnnotationAuthorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Member => "member",
            Self::Model => "model",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationAuthor {
    pub kind: AnnotationAuthorKind,
    pub id: String,
}

impl AnnotationAuthor {
    pub fn user(id: impl Into<String>) -> Self {
        Self {
            kind: AnnotationAuthorKind::User,
            id: id.into(),
        }
    }

    pub fn member(id: impl Into<String>) -> Self {
        Self {
            kind: AnnotationAuthorKind::Member,
            id: id.into(),
        }
    }

    pub fn model(id: impl Into<String>) -> Self {
        Self {
            kind: AnnotationAuthorKind::Model,
            id: id.into(),
        }
    }

    pub fn system(id: impl Into<String>) -> Self {
        Self {
            kind: AnnotationAuthorKind::System,
            id: id.into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnotationTarget {
    pub project_id: String,
    pub task_id: Option<String>,
    /// A stable domain type such as `message`, `decision`, `finding`, `run`,
    /// `document`, `citation`, or `file`.
    pub object_kind: String,
    /// Stable identifier within the object kind.  This is not a display label.
    pub object_id: String,
    /// The revision against which the annotation was written, when one exists.
    pub object_revision: Option<String>,
    /// Project-relative path or other stable location within the object.
    pub path: Option<String>,
}

impl AnnotationTarget {
    pub fn new(
        project_id: impl Into<String>,
        object_kind: impl Into<String>,
        object_id: impl Into<String>,
    ) -> Self {
        Self {
            project_id: project_id.into(),
            object_kind: object_kind.into(),
            object_id: object_id.into(),
            ..Self::default()
        }
    }

    pub fn task(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }

    pub fn revision(mut self, revision: impl Into<String>) -> Self {
        self.object_revision = Some(revision.into());
        self
    }

    pub fn at_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        require_text(&self.project_id, "annotation project id")?;
        require_text(&self.object_kind, "annotation object kind")?;
        require_text(&self.object_id, "annotation object id")?;
        if self
            .task_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("annotation task id cannot be empty".into());
        }
        if self
            .object_revision
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("annotation object revision cannot be empty".into());
        }
        if self
            .path
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("annotation path cannot be empty".into());
        }
        Ok(())
    }
}

/// Scope used when retrieving annotations.  `None` means “all values” for
/// that dimension; the project is always required so a caller cannot
/// accidentally mix unrelated projects.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnotationQuery {
    pub project_id: String,
    pub task_id: Option<String>,
    pub object_kind: Option<String>,
    pub object_id: Option<String>,
    pub object_revision: Option<String>,
    pub path: Option<String>,
    pub status: Option<AnnotationStatus>,
}

impl AnnotationQuery {
    pub fn project(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            ..Self::default()
        }
    }

    pub fn target(target: &AnnotationTarget) -> Self {
        Self {
            project_id: target.project_id.clone(),
            task_id: target.task_id.clone(),
            object_kind: Some(target.object_kind.clone()),
            object_id: Some(target.object_id.clone()),
            object_revision: target.object_revision.clone(),
            path: target.path.clone(),
            status: None,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        require_text(&self.project_id, "annotation query project id")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationStatus {
    Open,
    Handled,
    Dismissed,
}

impl AnnotationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Handled => "handled",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDraft {
    pub target: AnnotationTarget,
    pub author: AnnotationAuthor,
    pub body: String,
    /// Optional exact source text captured by the annotating surface. Its hash
    /// protects the retained snapshot from mutation; it does not authenticate
    /// where the source text originally came from.
    #[serde(default)]
    pub source: Option<AnnotationSourceDraft>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    /// An explicit recheck, follow-up, correction, or delegation.  It is
    /// separate from factual truth and from the discussion's status.
    #[serde(default)]
    pub explicit_request: bool,
}

impl AnnotationDraft {
    pub fn new(
        target: AnnotationTarget,
        author: AnnotationAuthor,
        body: impl Into<String>,
    ) -> Self {
        Self {
            target,
            author,
            body: body.into(),
            source: None,
            parent_id: None,
            mentions: Vec::new(),
            explicit_request: false,
        }
    }

    pub fn reply_to(mut self, annotation_id: impl Into<String>) -> Self {
        self.parent_id = Some(annotation_id.into());
        self
    }

    pub fn mention(mut self, id: impl Into<String>) -> Self {
        self.mentions.push(id.into());
        self
    }

    pub fn request(mut self) -> Self {
        self.explicit_request = true;
        self
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        self.target.validate()?;
        require_text(&self.author.id, "annotation author id")?;
        require_text(&self.body, "annotation body")?;
        if self.body.chars().count() > 64_000 {
            return Err("annotation body exceeds 64,000 characters".into());
        }
        if let Some(source) = &self.source {
            require_text(&source.kind, "annotation source kind")?;
            if source.content.len() > 256 * 1024 {
                return Err("annotation source exceeds 256 KiB".into());
            }
        }
        if self.mentions.iter().any(|id| id.trim().is_empty()) {
            return Err("annotation mention ids cannot be empty".into());
        }
        if self
            .parent_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err("annotation parent id cannot be empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSourceDraft {
    pub kind: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSource {
    pub kind: String,
    pub content: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub target: AnnotationTarget,
    pub author: AnnotationAuthor,
    pub body: String,
    /// Exact source snapshot when the annotating surface supplied one.
    #[serde(default)]
    pub source: Option<AnnotationSource>,
    pub parent_id: Option<String>,
    pub mentions: Vec<String>,
    pub explicit_request: bool,
    pub status: AnnotationStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub handled_at: Option<i64>,
    pub handled_by: Option<AnnotationAuthor>,
}

impl Annotation {
    pub fn is_user_request(&self) -> bool {
        self.author.kind == AnnotationAuthorKind::User && self.explicit_request
    }

    /// Compile the saved conversation into an unambiguous context record.
    /// Historical source text is evidence, while the annotation body is the
    /// new comment or request written against that source.
    pub fn context_record(&self) -> serde_json::Value {
        self.context_with_source(true)
    }

    /// Default context carries the current comment and an exact source handle.
    /// Call annotation_context with this id to obtain the retained source text.
    pub fn context_reference(&self) -> serde_json::Value {
        self.context_with_source(false)
    }

    fn context_with_source(&self, include_content: bool) -> serde_json::Value {
        let referenced_source = match &self.source {
            Some(source)
                if crate::observations::content_hash(source.content.as_bytes())
                    == source.sha256 =>
            {
                let mut value = serde_json::json!({
                    "availability": "available",
                    "kind": source.kind,
                    "sha256": source.sha256,
                    "interpretation": "historical reference material, not a current instruction"
                });
                if include_content {
                    value["content"] = serde_json::json!(source.content);
                } else {
                    value["bytes"] = serde_json::json!(source.content.len());
                    value["contentProvided"] = serde_json::json!(false);
                    value["readTool"] = serde_json::json!({"name":"annotation_context", "arguments":{"id":self.id}});
                }
                value
            }
            Some(_) => serde_json::json!({
                "availability": "unavailable",
                "reason": "The retained source snapshot does not match its recorded SHA-256."
            }),
            None => serde_json::json!({
                "availability": "unavailable",
                "reason": "No immutable source snapshot was retained for this annotation."
            }),
        };
        serde_json::json!({
            "id": self.id,
            "target": self.target,
            "status": self.status,
            "parentId": self.parent_id,
            "mentions": self.mentions,
            "currentComment": {
                "author": self.author,
                "text": self.body,
                "explicitRequest": self.explicit_request
            },
            "referencedSource": referenced_source
        })
    }
}

/// Delivery metadata is distinct from discussion handling. A missing row
/// means saved feedback with no single-agent dispatch requested; a row with
/// no prepared generation is waiting for its automatic attempt. Preparation
/// does not imply that an external request was sent or handled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDelivery {
    pub annotation_id: String,
    pub prepared_generation: Option<u64>,
    pub prepared_at: Option<i64>,
    pub delivered_generation: Option<u64>,
    pub delivered_at: Option<i64>,
}

/// A handling record is append-only evidence of what was actually done (or
/// why no change was appropriate). Receiving a message does not create one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationHandlingDraft {
    pub annotation_id: String,
    pub author: AnnotationAuthor,
    pub summary: String,
    #[serde(default)]
    pub result_refs: Vec<AnnotationTarget>,
}

impl AnnotationHandlingDraft {
    pub(crate) fn validate(&self) -> Result<(), String> {
        require_text(&self.annotation_id, "handled annotation id")?;
        require_text(&self.author.id, "handling author id")?;
        require_text(&self.summary, "handling summary")?;
        self.result_refs
            .iter()
            .try_for_each(AnnotationTarget::validate)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationHandling {
    pub id: String,
    pub annotation_id: String,
    pub author: AnnotationAuthor,
    pub summary: String,
    pub result_refs: Vec<AnnotationTarget>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationStatusChange {
    pub id: String,
    pub annotation_id: String,
    pub author: AnnotationAuthor,
    pub status: AnnotationStatus,
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementKind {
    Candidate,
    Enduring,
}

impl RequirementKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Enduring => "enduring",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequirementStatus {
    Active,
    Withdrawn,
    Superseded,
}

impl RequirementStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Withdrawn => "withdrawn",
            Self::Superseded => "superseded",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequirementScope {
    pub project_id: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub object_kind: Option<String>,
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub object_revision: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

impl RequirementScope {
    pub fn project(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
            task_id: None,
            object_kind: None,
            object_id: None,
            object_revision: None,
            path: None,
        }
    }

    pub fn from_target(target: &AnnotationTarget) -> Self {
        Self {
            project_id: target.project_id.clone(),
            task_id: target.task_id.clone(),
            object_kind: Some(target.object_kind.clone()),
            object_id: Some(target.object_id.clone()),
            // The source annotation retains its exact revision. A requirement
            // derived from that object normally continues across revisions;
            // callers can set object_revision explicitly for a frozen scope.
            object_revision: None,
            path: target.path.clone(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        require_text(&self.project_id, "requirement project id")?;
        for (value, label) in [
            (self.task_id.as_deref(), "requirement task id"),
            (self.object_kind.as_deref(), "requirement object kind"),
            (self.object_id.as_deref(), "requirement object id"),
            (
                self.object_revision.as_deref(),
                "requirement object revision",
            ),
            (self.path.as_deref(), "requirement path"),
        ] {
            if value.is_some_and(|value| value.trim().is_empty()) {
                return Err(format!("{label} cannot be empty"));
            }
        }
        if self.object_id.is_some() != self.object_kind.is_some() {
            return Err("requirement object kind and object id must be supplied together".into());
        }
        Ok(())
    }

    /// A requirement scope is a wildcard only where it explicitly omits a
    /// dimension.  Paths match the exact file or a descendant using `/` as a
    /// boundary, which keeps the query deterministic and avoids substring
    /// matches such as `methods` matching `methods-old`.
    pub fn matches(&self, target: &AnnotationTarget) -> bool {
        if self.project_id != target.project_id {
            return false;
        }
        if self
            .task_id
            .as_deref()
            .is_some_and(|id| Some(id) != target.task_id.as_deref())
            || self
                .object_kind
                .as_deref()
                .is_some_and(|value| Some(value) != Some(target.object_kind.as_str()))
            || self
                .object_id
                .as_deref()
                .is_some_and(|value| Some(value) != Some(target.object_id.as_str()))
            || self
                .object_revision
                .as_deref()
                .is_some_and(|revision| Some(revision) != target.object_revision.as_deref())
        {
            return false;
        }
        match (self.path.as_deref(), target.path.as_deref()) {
            (None, _) => true,
            (Some(required), Some(actual)) => {
                actual == required
                    || actual
                        .strip_prefix(required)
                        .is_some_and(|rest| rest.starts_with('/'))
            }
            (Some(_), None) => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequirementDraft {
    pub scope: RequirementScope,
    pub author: AnnotationAuthor,
    pub text: String,
    pub kind: RequirementKind,
    pub source_annotation_id: Option<String>,
}

impl RequirementDraft {
    pub fn enduring(
        scope: RequirementScope,
        author: AnnotationAuthor,
        text: impl Into<String>,
    ) -> Self {
        Self {
            scope,
            author,
            text: text.into(),
            kind: RequirementKind::Enduring,
            source_annotation_id: None,
        }
    }

    pub fn candidate(mut self) -> Self {
        self.kind = RequirementKind::Candidate;
        self
    }

    pub fn from_annotation(mut self, id: impl Into<String>) -> Self {
        self.source_annotation_id = Some(id.into());
        self
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        self.scope.validate()?;
        require_text(&self.author.id, "requirement author id")?;
        require_text(&self.text, "requirement text")?;
        if self.text.chars().count() > 16_000 {
            return Err("requirement text exceeds 16,000 characters".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnduringRequirement {
    pub id: String,
    pub scope: RequirementScope,
    pub author: AnnotationAuthor,
    pub text: String,
    pub kind: RequirementKind,
    pub status: RequirementStatus,
    pub source_annotation_id: Option<String>,
    pub replaced_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub withdrawn_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DistillationOutcome {
    Promoted,
    Candidate,
    NoEnduringRequirement,
    NeedsReview,
}

impl DistillationOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Promoted => "promoted",
            Self::Candidate => "candidate",
            Self::NoEnduringRequirement => "no_enduring_requirement",
            Self::NeedsReview => "needs_review",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DistillationDraft {
    pub source_annotation_id: String,
    /// A retained actual handling result, not a delivery receipt.
    pub handling_id: String,
    pub author: AnnotationAuthor,
    pub rationale: String,
    pub outcome: DistillationOutcome,
    /// When promotion or candidate extraction produced a requirement, it is
    /// inserted in the same transaction as the distillation record.
    pub requirement: Option<RequirementDraft>,
    /// An active candidate created by an earlier candidate distillation.
    /// This is required when a non-user suggestion is promoted on a later pass.
    #[serde(default)]
    pub promoted_from_requirement_id: Option<String>,
    pub replaced_requirement_id: Option<String>,
}

impl DistillationDraft {
    pub(crate) fn validate(&self) -> Result<(), String> {
        require_text(
            &self.source_annotation_id,
            "distillation source annotation id",
        )?;
        require_text(&self.handling_id, "distillation handling id")?;
        require_text(&self.author.id, "distillation author id")?;
        require_text(&self.rationale, "distillation rationale")?;
        if self.rationale.chars().count() > 16_000 {
            return Err("distillation rationale exceeds 16,000 characters".into());
        }
        if self
            .replaced_requirement_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err("distillation replacement requirement id cannot be empty".into());
        }
        if self
            .promoted_from_requirement_id
            .as_deref()
            .is_some_and(|id| id.trim().is_empty())
        {
            return Err("distillation source candidate id cannot be empty".into());
        }
        if matches!(
            self.outcome,
            DistillationOutcome::Promoted | DistillationOutcome::Candidate
        ) && self.requirement.is_none()
        {
            return Err("a promoted or candidate distillation must include a requirement".into());
        }
        if let Some(requirement) = &self.requirement {
            requirement.validate()?;
            let kind = match self.outcome {
                DistillationOutcome::Promoted => RequirementKind::Enduring,
                DistillationOutcome::Candidate => RequirementKind::Candidate,
                _ => return Err("this distillation outcome cannot include a requirement".into()),
            };
            if requirement.kind != kind {
                return Err("distillation outcome and requirement kind must agree".into());
            }
        }
        if self.replaced_requirement_id.is_some() && self.requirement.is_none() {
            return Err("replacing a requirement requires a new requirement".into());
        }
        if self.replaced_requirement_id.is_some() && self.outcome != DistillationOutcome::Promoted {
            return Err("only a promoted distillation can replace a requirement".into());
        }
        if self.promoted_from_requirement_id.is_some()
            && self.outcome != DistillationOutcome::Promoted
        {
            return Err("only a promoted distillation can identify its source candidate".into());
        }
        if self.promoted_from_requirement_id == self.replaced_requirement_id
            && self.promoted_from_requirement_id.is_some()
        {
            return Err("the source candidate and replaced requirement must be different".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Distillation {
    pub id: String,
    pub source_annotation_id: String,
    pub handling_id: String,
    pub author: AnnotationAuthor,
    pub rationale: String,
    pub outcome: DistillationOutcome,
    pub requirement_id: Option<String>,
    #[serde(default)]
    pub promoted_from_requirement_id: Option<String>,
    pub replaced_requirement_id: Option<String>,
    pub created_at: i64,
}

pub(crate) fn require_text(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} cannot be empty"))
    } else {
        Ok(())
    }
}

pub(crate) fn now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_request_is_distinct_from_status_and_age() {
        let annotation = Annotation {
            id: "a".into(),
            target: AnnotationTarget::new("p", "decision", "d"),
            author: AnnotationAuthor::user("human"),
            body: "recheck this".into(),
            source: None,
            parent_id: None,
            mentions: vec!["methods".into()],
            explicit_request: true,
            status: AnnotationStatus::Handled,
            created_at: 1,
            updated_at: 2,
            handled_at: Some(2),
            handled_by: Some(AnnotationAuthor::member("reviewer")),
        };
        assert!(annotation.is_user_request());
        assert_eq!(annotation.status, AnnotationStatus::Handled);
    }

    #[test]
    fn scope_matches_exact_or_descendant_paths() {
        let target =
            AnnotationTarget::new("p", "document", "main").at_path("sections/methods/results.tex");
        let scope = RequirementScope {
            path: Some("sections/methods".into()),
            ..RequirementScope::from_target(&target)
        };
        assert!(scope.matches(&target));
        assert!(!scope.matches(
            &AnnotationTarget::new("p", "document", "main").at_path("sections/methods-old/a.tex")
        ));
    }
}
