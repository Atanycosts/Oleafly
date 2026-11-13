use std::path::PathBuf;
use std::sync::Arc;

use oleafly_research::mcp::{
    ApplicationTools, BridgeServices, LinkedRootInfo, LinkedRoots, McpStart, SkillSource,
};
use oleafly_research::task_tools::extra::TaskBinding;
use serde_json::{json, Value};

pub use oleafly_research::mcp::{
    serve_stdio_bridge, stdio_bridge_requested, stdio_server, ScopedResearchMcp,
};

pub async fn start(
    app: tauri::AppHandle,
    project_id: String,
    execution_root: Option<PathBuf>,
) -> Result<ScopedResearchMcp, String> {
    let pack = crate::skills_pack::pack_root(&app);
    start_inner(app, pack, project_id, execution_root, None, None).await
}

pub async fn start_restricted(
    app: tauri::AppHandle,
    project_id: String,
    execution_root: PathBuf,
    allowed_paths: Vec<String>,
    task: Option<TaskBinding>,
) -> Result<ScopedResearchMcp, String> {
    let pack = crate::skills_pack::pack_root(&app);
    start_inner(
        app,
        pack,
        project_id,
        Some(execution_root),
        Some(allowed_paths),
        task,
    )
    .await
}

pub(crate) fn linked_root(project_id: &str, root_id: &str) -> Result<PathBuf, String> {
    AppLinkedRoots.resolve(project_id, root_id)
}

fn admit(project_id: &str) -> Result<PathBuf, String> {
    crate::paths::validate_project_id(project_id)?;
    crate::trust::require_trusted(project_id, crate::trust::Capability::McpExposure)?;
    let project_root = crate::paths::project_dir(project_id)?;
    if !project_root.is_dir() {
        return Err("The research project is no longer available.".into());
    }
    Ok(project_root)
}

async fn start_inner(
    app: tauri::AppHandle,
    skills_pack: Option<PathBuf>,
    project_id: String,
    execution_root: Option<PathBuf>,
    allowed_paths: Option<Vec<String>>,
    task: Option<TaskBinding>,
) -> Result<ScopedResearchMcp, String> {
    let project_root = admit(&project_id)?;
    let root = execution_root.unwrap_or(project_root);
    let linked_roots = match crate::research_workspace::get_research_workspace(project_id.clone()) {
        Ok(workspace) => workspace
            .roots
            .into_iter()
            .map(|root| LinkedRootInfo {
                role: serde_json::to_value(root.role)
                    .ok()
                    .and_then(|role| role.as_str().map(str::to_string))
                    .unwrap_or_default(),
                id: root.id,
                label: root.label,
                canonical_path: root.canonical_path,
            })
            .collect(),
        Err(error) => {
            let _ = crate::project::append_app_log(format!(
                "Research session started without linked folders: {error}"
            ));
            Vec::new()
        }
    };
    let journal = crate::journal_workbench::tools::application_tools(
        app.clone(),
        project_id.clone(),
        task.clone(),
    );
    let application: Arc<dyn ApplicationTools> = match &task {
        Some(task) => Arc::new(TaskApplicationTools {
            journal,
            docx: crate::research_tasks::docx::application_tools(app, task.clone()),
        }),
        None => journal,
    };
    oleafly_research::mcp::serve(McpStart {
        project_id,
        root,
        allowed: allowed_paths,
        linked_roots,
        services: services(
            crate::paths::oleafly_root()?,
            skills_pack,
            Some(application),
        ),
        task,
    })
    .await
}

struct TaskApplicationTools {
    journal: Arc<dyn ApplicationTools>,
    docx: Arc<dyn ApplicationTools>,
}

impl ApplicationTools for TaskApplicationTools {
    fn definitions(&self) -> Vec<oleafly_research::mcp::protocol::ToolMeta> {
        let mut definitions = self.journal.definitions();
        definitions.extend(self.docx.definitions());
        definitions
    }

    fn call(
        &self,
        name: String,
        args: Value,
    ) -> oleafly_research::scheduler::TaskRuntimeFuture<Value> {
        if self.docx.definitions().iter().any(|tool| tool.name == name) {
            self.docx.call(name, args)
        } else {
            self.journal.call(name, args)
        }
    }
}

fn services(
    skills_root: PathBuf,
    skills_pack: Option<PathBuf>,
    application: Option<Arc<dyn ApplicationTools>>,
) -> BridgeServices {
    BridgeServices {
        skills: Arc::new(AppSkills {
            root: skills_root,
            pack: skills_pack,
        }),
        linked: Arc::new(AppLinkedRoots),
        secrets: Arc::new(crate::literature::AppSecrets),
        application,
    }
}

struct AppSkills {
    root: PathBuf,
    pack: Option<PathBuf>,
}

impl AppSkills {
    fn records(&self, project_id: &str) -> Result<Vec<crate::skills::SkillRecord>, String> {
        Ok(
            crate::skills::list_with(&self.root, self.pack.as_deref(), Some(project_id))?
                .into_iter()
                .filter(crate::skills::SkillRecord::is_valid)
                .collect(),
        )
    }

    fn enabled(&self, project_id: &str, id: &str) -> Result<crate::skills::SkillRecord, String> {
        self.records(project_id)?
            .into_iter()
            .find(|skill| skill.id == id && skill.is_available())
            .ok_or_else(|| {
                format!("The skill {id} is turned off. Enable it in Settings, AI, Skills.")
            })
    }
}

impl SkillSource for AppSkills {
    fn list(&self, project_id: &str) -> Result<Vec<Value>, String> {
        Ok(self
            .records(project_id)?
            .iter()
            .map(crate::skills::skill_tool_summary)
            .collect())
    }

    fn load(&self, project_id: &str, id: &str) -> Result<Value, String> {
        let skill = self.enabled(project_id, id)?;
        Ok(crate::skills::skill_tool_payload(&skill))
    }

    fn read_file(&self, project_id: &str, id: &str, path: &str) -> Result<Value, String> {
        let skill = self.enabled(project_id, id)?;
        let file = crate::skills::read_skill_file(&self.root, &skill.id, path)?;
        Ok(json!({"path": file.path, "content": file.content, "truncated": file.truncated}))
    }
}

struct AppLinkedRoots;

impl LinkedRoots for AppLinkedRoots {
    fn resolve(&self, project_id: &str, root_id: &str) -> Result<PathBuf, String> {
        crate::research_workspace::roots::resolve_root_path(
            project_id,
            root_id,
            "",
            crate::research_workspace::ResearchRootOperation::Read,
            crate::research_workspace::ResearchRootConsumer::Task,
            false,
        )
    }
}

#[cfg(test)]
mod tests;
