use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::app_error::AppError;
use crate::proc::NoConsole;
use crate::toolchain_download::{
    ArchiveKind, CancelToken, DownloadTimeouts, InstallPhase, InstallProgress,
    ToolchainInstallError, ToolchainInstallErrorKind, TreeInstallRequest,
};

const MANIFEST_JSON: &str = include_str!("../resources/notebook-toolchains.json");
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

static INSTALLING: Mutex<BTreeSet<NotebookTool>> = Mutex::new(BTreeSet::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NotebookTool {
    Quarto,
    Calepin,
}

impl NotebookTool {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "quarto" => Some(Self::Quarto),
            "calepin" => Some(Self::Calepin),
            _ => None,
        }
    }

    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Quarto => "quarto",
            Self::Calepin => "calepin",
        }
    }

    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Quarto => "Quarto",
            Self::Calepin => "Calepin",
        }
    }

    pub(crate) const fn missing_code(self) -> &'static str {
        match self {
            Self::Quarto => "notebook.quarto_missing",
            Self::Calepin => "notebook.calepin_missing",
        }
    }

    fn release(self) -> &'static ToolRelease {
        match self {
            Self::Quarto => &manifest().tools.quarto,
            Self::Calepin => &manifest().tools.calepin,
        }
    }

    fn artifact(self) -> Option<&'static ToolArtifact> {
        let target = oleafly_core::typst_toolchain::host_target()?;
        self.release().targets.get(target)
    }

    fn executable_name(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.name())
        } else {
            self.name().to_owned()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    allowed_download_hosts: Vec<String>,
    tools: ManifestTools,
}

#[derive(Deserialize)]
struct ManifestTools {
    quarto: ToolRelease,
    calepin: ToolRelease,
}

#[derive(Deserialize)]
struct ToolRelease {
    version: String,
    license: String,
    targets: BTreeMap<String, ToolArtifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolArtifact {
    archive_type: String,
    archive_sha256: String,
    archive_size: u64,
    executables: Vec<String>,
    url: String,
}

fn parse_manifest(text: &str) -> Result<Manifest, String> {
    serde_json::from_str(text)
        .map_err(|error| format!("invalid notebook toolchain manifest: {error}"))
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        parse_manifest(MANIFEST_JSON).expect("the bundled notebook toolchain manifest is valid")
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ToolSource {
    System,
    Managed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolInstall {
    path: String,
    version: Option<String>,
    source: ToolSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolStatus {
    tool: NotebookTool,
    pinned_version: String,
    active: Option<ToolInstall>,
    system: Option<ToolInstall>,
    managed: Option<ToolInstall>,
    offered: bool,
    download_bytes: Option<u64>,
    license: String,
    installing: bool,
    superseded_versions: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeName {
    R,
    Python,
    Julia,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LanguageRuntime {
    name: RuntimeName,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotebookToolchainStatus {
    quarto: ToolStatus,
    calepin: ToolStatus,
    runtimes: Vec<LanguageRuntime>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotebookInstallProgress {
    tool: NotebookTool,
    phase: InstallPhase,
    received_bytes: u64,
    total_bytes: u64,
}

fn tools_root() -> Result<PathBuf, String> {
    Ok(oleafly_core::typst_toolchain::toolchains_root(
        &crate::paths::oleafly_root()?,
    ))
}

fn install_root(tool: NotebookTool) -> Result<PathBuf, String> {
    Ok(tools_root()?.join(tool.name()))
}

fn install_dir(tool: NotebookTool) -> Result<PathBuf, String> {
    Ok(install_root(tool)?.join(&tool.release().version))
}

fn managed_tool(tool: NotebookTool) -> Option<PathBuf> {
    let artifact = tool.artifact()?;
    let candidates = crate::toolchain_download::tree_executable_candidates(&artifact.executables);
    crate::toolchain_download::installed_tree(
        &install_dir(tool).ok()?,
        &artifact.archive_sha256,
        &candidates,
    )
}

fn superseded_in(root: &Path, pinned: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name != pinned && !name.starts_with('.'))
        .collect();
    versions.sort();
    versions
}

fn remove_superseded_in(root: &Path, pinned: &str) {
    for version in superseded_in(root, pinned) {
        let path = root.join(version);
        if let Err(error) = std::fs::remove_dir_all(&path) {
            let _ = crate::project::append_app_log(format!(
                "Could not remove the unused download {}: {error}",
                path.display()
            ));
        }
    }
}

fn superseded_versions(tool: NotebookTool) -> Vec<String> {
    install_root(tool)
        .map(|root| superseded_in(&root, &tool.release().version))
        .unwrap_or_default()
}

fn remove_superseded(tool: NotebookTool) {
    if let Ok(root) = install_root(tool) {
        remove_superseded_in(&root, &tool.release().version);
    }
}

fn known_locations(tool: NotebookTool, home: Option<&Path>) -> Vec<PathBuf> {
    let name = tool.executable_name();
    let mut paths = Vec::new();
    match tool {
        NotebookTool::Quarto if cfg!(target_os = "macos") => {
            paths.push(PathBuf::from("/Applications/quarto/bin/quarto"));
            if let Some(home) = home {
                paths.push(home.join("Applications/quarto/bin/quarto"));
            }
            paths.push(PathBuf::from(
                "/Applications/RStudio.app/Contents/Resources/app/quarto/bin/quarto",
            ));
        }
        NotebookTool::Quarto if cfg!(windows) => {
            for variable in ["LOCALAPPDATA", "ProgramFiles"] {
                if let Some(root) = std::env::var_os(variable) {
                    let root = PathBuf::from(root);
                    let programs = if variable == "LOCALAPPDATA" {
                        root.join("Programs")
                    } else {
                        root
                    };
                    paths.push(programs.join("Quarto").join("bin").join(&name));
                }
            }
        }
        NotebookTool::Quarto => {
            paths.push(PathBuf::from("/opt/quarto/bin/quarto"));
        }
        NotebookTool::Calepin => {
            if let Some(home) = home {
                paths.push(home.join(".cargo").join("bin").join(&name));
                paths.push(home.join(".local").join("bin").join(&name));
            }
        }
    }
    paths
}

fn system_tool(tool: NotebookTool) -> Option<PathBuf> {
    let managed = tools_root().ok();
    let outside_managed = |path: &PathBuf| {
        let resolved = path.canonicalize().unwrap_or_else(|_| path.clone());
        !managed.as_ref().is_some_and(|root| {
            let root = root.canonicalize().unwrap_or_else(|_| root.clone());
            resolved.starts_with(root)
        })
    };
    crate::program_locator::locate_native(tool.name())
        .map(|located| located.path)
        .filter(outside_managed)
        .or_else(|| {
            known_locations(tool, dirs::home_dir().as_deref())
                .into_iter()
                .find(|path| path.is_file() && outside_managed(path))
        })
}

pub(crate) fn find_tool(tool: NotebookTool) -> Option<PathBuf> {
    system_tool(tool).or_else(|| managed_tool(tool))
}

pub(crate) fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token
            .trim_start_matches(['v', 'V', '('])
            .trim_end_matches(|character: char| !character.is_ascii_alphanumeric());
        let mut parts = token.split('.');
        let first = parts.next()?;
        let second = parts.next()?;
        let numeric = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
        (numeric(first) && second.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .then(|| token.to_owned())
    })
}

fn probe_command(path: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(path);
    command.arg("--version").no_console();
    crate::proc::clear_appimage_env(&mut command);
    command
}

fn probe_version(path: &Path) -> Option<String> {
    let output =
        crate::proc::output_contained_with_timeout(probe_command(path), PROBE_TIMEOUT).ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| parse_version(&String::from_utf8_lossy(&output.stderr)))
}

fn install_info(path: PathBuf, source: ToolSource) -> ToolInstall {
    ToolInstall {
        version: probe_version(&path),
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn installing(tool: NotebookTool) -> bool {
    INSTALLING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(&tool)
}

fn tool_status(tool: NotebookTool) -> ToolStatus {
    let release = tool.release();
    let artifact = tool.artifact();
    let system = system_tool(tool).map(|path| install_info(path, ToolSource::System));
    let managed = managed_tool(tool).map(|path| install_info(path, ToolSource::Managed));
    ToolStatus {
        tool,
        pinned_version: release.version.clone(),
        active: system.clone().or_else(|| managed.clone()),
        system,
        managed,
        offered: artifact.is_some(),
        download_bytes: artifact.map(|artifact| artifact.archive_size),
        license: release.license.clone(),
        installing: installing(tool),
        superseded_versions: superseded_versions(tool),
    }
}

fn locate(name: &str) -> Option<PathBuf> {
    crate::program_locator::locate_native(name).map(|located| located.path)
}

fn windows_r_installations() -> Vec<PathBuf> {
    let Some(programs) = std::env::var_os("ProgramFiles") else {
        return Vec::new();
    };
    let root = PathBuf::from(programs).join("R");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path().join("bin").join("Rscript.exe"))
        .filter(|path| path.is_file())
        .collect();
    found.sort();
    found.reverse();
    found
}

pub(crate) fn rscript() -> Option<PathBuf> {
    locate("Rscript").or_else(|| {
        if cfg!(target_os = "macos") {
            Some(PathBuf::from(
                "/Library/Frameworks/R.framework/Resources/bin/Rscript",
            ))
            .filter(|path| path.is_file())
        } else if cfg!(windows) {
            windows_r_installations().into_iter().next()
        } else {
            None
        }
    })
}

pub(crate) fn python() -> Option<PathBuf> {
    if cfg!(windows) {
        locate("python").or_else(|| locate("python3"))
    } else {
        locate("python3").or_else(|| locate("python"))
    }
}

pub(crate) fn julia() -> Option<PathBuf> {
    locate("julia").or_else(|| {
        let name = if cfg!(windows) { "julia.exe" } else { "julia" };
        dirs::home_dir()
            .map(|home| home.join(".juliaup").join("bin").join(name))
            .filter(|path| path.is_file())
    })
}

fn runtime(name: RuntimeName, path: Option<PathBuf>) -> LanguageRuntime {
    LanguageRuntime {
        name,
        version: path.as_deref().and_then(probe_version),
        path: path.map(|path| path.to_string_lossy().into_owned()),
    }
}

fn runtimes() -> Vec<LanguageRuntime> {
    vec![
        runtime(RuntimeName::R, rscript()),
        runtime(RuntimeName::Python, python()),
        runtime(RuntimeName::Julia, julia()),
    ]
}

fn unset(name: &str) -> bool {
    std::env::var_os(name).is_none_or(|value| value.is_empty())
}

pub(crate) fn quarto_runtime_variables() -> Vec<(&'static str, String)> {
    let mut variables = Vec::new();
    if unset("QUARTO_R") {
        if let Some(path) = rscript() {
            variables.push(("QUARTO_R", path.to_string_lossy().into_owned()));
        }
    }
    if unset("QUARTO_PYTHON") {
        if let Some(path) = python() {
            variables.push(("QUARTO_PYTHON", path.to_string_lossy().into_owned()));
        }
    }
    variables
}

pub(crate) fn calepin_runtime_variables(project_dir: &Path) -> Vec<(&'static str, String)> {
    let mut variables = Vec::new();
    if unset("CALEPIN_PYTHON") && !project_dir.join(".venv").is_dir() {
        if let Some(path) = python() {
            variables.push(("CALEPIN_PYTHON", path.to_string_lossy().into_owned()));
        }
    }
    variables
}

fn current_status() -> NotebookToolchainStatus {
    NotebookToolchainStatus {
        quarto: tool_status(NotebookTool::Quarto),
        calepin: tool_status(NotebookTool::Calepin),
        runtimes: runtimes(),
    }
}

fn tool_error(code: &'static str, tool: NotebookTool) -> String {
    AppError::new(code).param("tool", tool.label()).into()
}

fn parse_tool(value: &str) -> Result<NotebookTool, String> {
    NotebookTool::parse(value).ok_or_else(|| {
        AppError::new("notebook.unknown_tool")
            .param("tool", value.trim())
            .into()
    })
}

struct InstallClaim(NotebookTool);

impl InstallClaim {
    fn take(tool: NotebookTool) -> Result<Self, String> {
        let mut installing = INSTALLING.lock().unwrap_or_else(PoisonError::into_inner);
        if !installing.insert(tool) {
            return Err(tool_error("notebook.busy", tool));
        }
        Ok(Self(tool))
    }
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        INSTALLING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

fn install_request(tool: NotebookTool) -> Result<TreeInstallRequest, String> {
    let artifact = tool
        .artifact()
        .ok_or_else(|| tool_error("notebook.not_offered", tool))?;
    let archive_kind = ArchiveKind::parse(&artifact.archive_type)
        .ok_or_else(|| tool_error("notebook.not_offered", tool))?;
    Ok(TreeInstallRequest {
        urls: vec![artifact.url.clone()],
        allowed_hosts: manifest().allowed_download_hosts.clone(),
        archive_kind,
        archive_size: artifact.archive_size,
        archive_sha256: artifact.archive_sha256.clone(),
        install_dir: install_dir(tool)?,
        executables: artifact.executables.clone(),
        timeouts: DownloadTimeouts::default(),
    })
}

fn install_failure(tool: NotebookTool, error: &ToolchainInstallError) -> String {
    match error.kind() {
        ToolchainInstallErrorKind::AlreadyInstalling => tool_error("notebook.busy", tool),
        ToolchainInstallErrorKind::IntegrityFailure => {
            tool_error("notebook.install_unverified", tool)
        }
        _ => error.message().to_owned(),
    }
}

fn throttled<F>(
    tool: NotebookTool,
    cancel: CancelToken,
    send: F,
) -> impl Fn(InstallProgress) + Send + Sync
where
    F: Fn(NotebookInstallProgress) -> bool + Send + Sync,
{
    let last: Mutex<Option<(InstallPhase, Option<u64>)>> = Mutex::new(None);
    move |progress: InstallProgress| {
        let percent = (progress.total_bytes > 0).then(|| {
            progress.received_bytes.min(progress.total_bytes) * 100 / progress.total_bytes
        });
        let mark = (progress.phase, percent);
        {
            let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
            if *last == Some(mark) {
                return;
            }
            *last = Some(mark);
        }
        let delivered = send(NotebookInstallProgress {
            tool,
            phase: progress.phase,
            received_bytes: progress.received_bytes,
            total_bytes: progress.total_bytes,
        });
        if !delivered {
            cancel.cancel();
        }
    }
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("the notebook toolchain task stopped: {error}"))?
}

fn remove_blocking(tool: NotebookTool) -> Result<NotebookToolchainStatus, String> {
    let _claim = InstallClaim::take(tool)?;
    let root = install_root(tool)?;
    match std::fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&root)
            .map_err(|error| format!("Could not remove {}: {error}", root.display()))?,
        _ => return Err(tool_error("notebook.not_managed", tool)),
    }
    Ok(current_status())
}

fn compiled_html(project_id: &str) -> Result<PathBuf, String> {
    let build = crate::paths::existing_build_dir(project_id)?
        .ok_or_else(|| String::from(AppError::new("notebook.no_html_output")))?;
    let html = build.join(format!("{}.html", crate::paths::ENTRY_STEM));
    if !std::fs::symlink_metadata(&html).is_ok_and(|metadata| metadata.is_file()) {
        return Err(AppError::new("notebook.no_html_output").into());
    }
    Ok(html)
}

#[tauri::command]
pub async fn notebook_toolchain_status() -> Result<NotebookToolchainStatus, String> {
    blocking(|| Ok(current_status())).await
}

#[tauri::command]
pub async fn install_notebook_tool(
    tool: String,
    on_progress: tauri::ipc::Channel<NotebookInstallProgress>,
) -> Result<NotebookToolchainStatus, String> {
    let tool = parse_tool(&tool)?;
    let request = blocking(move || install_request(tool)).await?;
    let claim = InstallClaim::take(tool)?;
    let cancel = CancelToken::new();
    let progress = throttled(tool, cancel.clone(), move |event| {
        on_progress.send(event).is_ok()
    });
    crate::toolchain_download::install_tree(request, cancel, progress)
        .await
        .map_err(|error| install_failure(tool, &error))?;
    blocking(move || {
        remove_superseded(tool);
        Ok(())
    })
    .await?;
    drop(claim);
    blocking(|| Ok(current_status())).await
}

#[tauri::command]
pub async fn remove_notebook_tool(tool: String) -> Result<NotebookToolchainStatus, String> {
    let tool = parse_tool(&tool)?;
    blocking(move || remove_blocking(tool)).await
}

#[tauri::command]
pub async fn open_compiled_html(project_id: String) -> Result<(), String> {
    let html = blocking(move || compiled_html(&project_id)).await?;
    open::that_detached(&html)
        .map_err(|error| format!("Oleafly could not open the HTML output: {error}"))
}

const HTML_BUNDLE_LIMIT: usize = 64 * 1024 * 1024;
static HTML_PREVIEWS: OnceLock<Mutex<BTreeMap<String, tokio::task::JoinHandle<()>>>> =
    OnceLock::new();

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlBundle {
    version: u8,
    entry: String,
    files: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewSnapshot {
    url: String,
    bundle: String,
    revision: String,
    path: String,
}

fn html_resource_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "json" | "map" => Some("application/json"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "svg" => Some("image/svg+xml"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "wasm" => Some("application/wasm"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "ogg" => Some("audio/ogg"),
        "csv" | "tsv" | "txt" => Some("text/plain; charset=utf-8"),
        _ => None,
    }
}

fn encode_html_path(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(byte) {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn decode_html_path(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let pair = [input.next()?, input.next()?];
            bytes.push(u8::from_str_radix(std::str::from_utf8(&pair).ok()?, 16).ok()?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

fn valid_html_resource(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && !part.starts_with('.'))
        && !Path::new(path).is_absolute()
        && !path.contains(':')
}

fn html_local_references(text: &str) -> Vec<String> {
    use std::cell::RefCell;

    use html5ever::tokenizer::{
        states::RawKind, BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
    };

    #[derive(Default)]
    struct References {
        values: RefCell<Vec<String>>,
        inline: RefCell<Option<(html5ever::LocalName, String)>>,
    }

    impl References {
        fn finish_inline(&self) {
            if let Some((_, text)) = self.inline.borrow_mut().take() {
                self.values
                    .borrow_mut()
                    .extend(code_local_references(&text));
            }
        }
    }

    impl TokenSink for References {
        type Handle = ();

        fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
            match token {
                Token::TagToken(tag) if tag.kind == TagKind::StartTag => {
                    for attr in tag.attrs {
                        match attr.name.local.as_ref() {
                            "src" | "href" | "poster" => {
                                self.values.borrow_mut().push(attr.value.to_string());
                            }
                            "style" => self
                                .values
                                .borrow_mut()
                                .extend(code_local_references(&attr.value)),
                            _ => {}
                        }
                    }
                    let raw = match tag.name.as_ref() {
                        "script" => Some(RawKind::ScriptData),
                        "style" | "xmp" | "iframe" | "noembed" | "noframes" => {
                            Some(RawKind::Rawtext)
                        }
                        "title" | "textarea" => Some(RawKind::Rcdata),
                        "plaintext" => return TokenSinkResult::Plaintext,
                        _ => None,
                    };
                    if matches!(tag.name.as_ref(), "script" | "style") {
                        *self.inline.borrow_mut() = Some((tag.name, String::new()));
                    }
                    if let Some(raw) = raw {
                        return TokenSinkResult::RawData(raw);
                    }
                }
                Token::TagToken(tag) if tag.kind == TagKind::EndTag => {
                    let closes_inline = self
                        .inline
                        .borrow()
                        .as_ref()
                        .is_some_and(|(name, _)| *name == tag.name);
                    if closes_inline {
                        self.finish_inline();
                    }
                }
                Token::CharacterTokens(text) => {
                    if let Some((_, inline)) = self.inline.borrow_mut().as_mut() {
                        inline.push_str(&text);
                    }
                }
                _ => {}
            }
            TokenSinkResult::Continue
        }

        fn end(&self) {
            self.finish_inline();
        }
    }

    let tokenizer = Tokenizer::new(References::default(), Default::default());
    let input = BufferQueue::default();
    input.push_back(text.into());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.values.into_inner()
}

fn code_local_references(text: &str) -> Vec<String> {
    let mut references = Vec::new();
    let mut chars = text.char_indices();
    while let Some((start, quote)) = chars.next() {
        if quote == '\'' || quote == '"' || quote == '`' {
            let mut end = None;
            for (index, next) in chars.by_ref() {
                if next == quote {
                    end = Some(index);
                    break;
                }
            }
            if let Some(end) = end {
                let prefix = text[..start].trim_end();
                let local = [
                    "from", "import", "import(", "fetch(", "url(", "@import", "new URL(",
                ]
                .iter()
                .any(|marker| prefix.ends_with(marker));
                if local {
                    references.push(text[start + quote.len_utf8()..end].to_string());
                }
            }
        }
    }
    for part in text.split("url(").skip(1) {
        if let Some((value, _)) = part.split_once(')') {
            references.push(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    references
}

fn resolve_html_dependency(owner: &str, reference: &str) -> Option<String> {
    let reference = reference.split(['?', '#']).next()?.trim();
    if reference.is_empty()
        || reference.starts_with('/')
        || reference.contains(':')
        || reference.contains('\\')
    {
        return None;
    }
    let reference = decode_html_path(reference)?;
    let parent = owner
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut parts: Vec<&str> = parent.split('/').filter(|part| !part.is_empty()).collect();
    for part in reference.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.starts_with('.') => return None,
            part => parts.push(part),
        }
    }
    let path = parts.join("/");
    valid_html_resource(&path).then_some(path)
}

fn capture_html_bundle(project_id: &str, path: Option<&str>) -> Result<String, String> {
    let (root, html) = if let Some(path) = path {
        if !valid_html_resource(path)
            || !Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| {
                    matches!(extension.to_ascii_lowercase().as_str(), "html" | "htm")
                })
        {
            return Err("Choose an HTML file inside this project".into());
        }
        let project = crate::paths::project_dir(project_id)?;
        let html = project
            .join(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !html.starts_with(&project) || !html.is_file() {
            return Err("HTML file escapes the project".into());
        }
        (project, html)
    } else {
        let html = compiled_html(project_id)?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let root = crate::paths::existing_build_dir(project_id)?
            .ok_or("No HTML output")?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !html.starts_with(&root) {
            return Err("HTML output escapes its build directory".into());
        }
        (root, html)
    };
    capture_html_bundle_at(&root, &html)
}

fn capture_html_bundle_at(root: &Path, html: &Path) -> Result<String, String> {
    fn collect(
        root: &Path,
        relative: &str,
        files: &mut BTreeMap<String, String>,
        total: &mut usize,
    ) -> Result<(), String> {
        use base64::Engine;
        if files.contains_key(relative) {
            return Ok(());
        }
        let path = root.join(relative);
        let resolved = path.canonicalize().map_err(|error| error.to_string())?;
        if !resolved.starts_with(root)
            || !resolved
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .is_some_and(|path| valid_html_resource(&path.replace('\\', "/")))
        {
            return Err("HTML resource escapes its resource root".into());
        }
        let size = std::fs::metadata(&resolved)
            .map_err(|error| error.to_string())?
            .len();
        if size > HTML_BUNDLE_LIMIT as u64 || *total + size as usize > HTML_BUNDLE_LIMIT {
            return Err("HTML resources exceed 64 MiB".into());
        }
        let bytes = std::fs::read(resolved).map_err(|error| error.to_string())?;
        *total += bytes.len();
        files.insert(
            relative.to_string(),
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        );
        if matches!(
            html_resource_type(relative),
            Some(
                "text/html; charset=utf-8"
                    | "text/css; charset=utf-8"
                    | "text/javascript; charset=utf-8"
            )
        ) {
            let text = String::from_utf8_lossy(&bytes);
            let references = if html_resource_type(relative) == Some("text/html; charset=utf-8") {
                html_local_references(&text)
            } else {
                code_local_references(&text)
            };
            for reference in references {
                if let Some(dependency) = resolve_html_dependency(relative, &reference) {
                    if html_resource_type(&dependency).is_some() && root.join(&dependency).is_file()
                    {
                        collect(root, &dependency, files, total)?;
                    }
                }
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    let entry = html
        .strip_prefix(root)
        .map_err(|_| "HTML entry escapes its resource root")?
        .to_string_lossy()
        .replace('\\', "/");
    if !valid_html_resource(&entry) {
        return Err("HTML entry is outside the public resource scope".into());
    }
    collect(root, &entry, &mut files, &mut 0)?;
    if !files.contains_key(&entry) {
        return Err("HTML entry is unavailable".into());
    }
    serde_json::to_string(&HtmlBundle {
        version: 1,
        entry,
        files,
    })
    .map_err(|error| error.to_string())
}

const HTML_SELECTION_BRIDGE: &str = r#"<script>(()=>{const send=()=>{const s=getSelection();const q=s?.toString()||'';let e=s?.anchorNode;if(e?.nodeType!==1)e=e?.parentElement;const p=[];while(e&&e!==document.documentElement){let i=1,n=e;while((n=n.previousElementSibling))if(n.tagName===e.tagName)i++;p.unshift(e.tagName.toLowerCase()+':nth-of-type('+i+')');e=e.parentElement}parent.postMessage({type:'oleafly-html-selection',selector:'html>'+p.join('>'),quote:q},'*')};document.addEventListener('selectionchange',send);document.addEventListener('mouseup',send);for(const type of ['pointerdown','wheel','keydown','beforeinput'])document.addEventListener(type,event=>{if(event.isTrusted)parent.postMessage({type:'oleafly-html-interaction'},'*')},{capture:true,passive:true});addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='oleafly-html-anchor')return;try{const e=document.querySelector(event.data.selector);if(e){e.style.outline='2px solid #6366f1';e.scrollIntoView({block:'center'})}}catch{}})})();</script>"#;

async fn serve_html_bundle(bundle: String) -> Result<HtmlPreviewSnapshot, String> {
    use axum::{
        body::Body,
        http::{Request, Response, StatusCode},
        Router,
    };
    use base64::Engine;
    use sha2::{Digest, Sha256};
    if bundle.len() > HTML_BUNDLE_LIMIT * 2 {
        return Err("HTML bundle is too large".into());
    }
    let parsed: HtmlBundle = serde_json::from_str(&bundle).map_err(|error| error.to_string())?;
    if parsed.version != 1
        || !valid_html_resource(&parsed.entry)
        || !parsed.files.contains_key(&parsed.entry)
    {
        return Err("Invalid HTML bundle entry".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for (path, encoded) in parsed.files {
        if !valid_html_resource(&path) || html_resource_type(&path).is_none() {
            return Err("Invalid HTML resource path".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())?;
        total += bytes.len();
        if total > HTML_BUNDLE_LIMIT {
            return Err("HTML bundle is too large".into());
        }
        files.insert(path, bytes);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let token = format!("{:032x}", rand::random::<u128>());
    let prefix = format!("/{token}/");
    let origin = format!("http://{address}");
    let url = format!(
        "{origin}{prefix}{}",
        parsed
            .entry
            .split('/')
            .map(encode_html_path)
            .collect::<Vec<_>>()
            .join("/")
    );
    let files = std::sync::Arc::new(files);
    let csp = format!("default-src 'none'; script-src {origin} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src {origin} 'unsafe-inline'; img-src {origin} data: blob:; font-src {origin} data:; media-src {origin} blob:; connect-src {origin} data: blob:; worker-src {origin} blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts");
    let app = Router::new().fallback(move |request: Request<Body>| {
        let files = files.clone();
        let prefix = prefix.clone();
        let csp = csp.clone();
        async move {
            let path = request.uri().path().strip_prefix(&prefix).unwrap_or("");
            let decoded = decode_html_path(path).unwrap_or_default();
            let Some(bytes) = files.get(&decoded) else {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap();
            };
            let media_type = html_resource_type(&decoded).unwrap();
            let body = if media_type.starts_with("text/html") {
                let mut html = String::from_utf8_lossy(bytes).into_owned();
                let lower = html.to_ascii_lowercase();
                let insert = lower
                    .find("</head>")
                    .or_else(|| lower.find("<body"))
                    .unwrap_or(html.len());
                html.insert_str(insert, HTML_SELECTION_BRIDGE);
                html.into_bytes()
            } else {
                bytes.clone()
            };
            Response::builder()
                .header("Content-Type", media_type)
                .header("Content-Security-Policy", csp)
                .header("Access-Control-Allow-Origin", "*")
                .header("Cache-Control", "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .body(Body::from(body))
                .unwrap()
        }
    });
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    HTML_PREVIEWS
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .insert(url.clone(), task);
    Ok(HtmlPreviewSnapshot {
        url,
        revision: format!("{:x}", Sha256::digest(bundle.as_bytes())),
        bundle,
        path: parsed.entry,
    })
}

#[tauri::command]
pub async fn read_html_preview(
    project_id: String,
    path: Option<String>,
) -> Result<HtmlPreviewSnapshot, String> {
    let bundle = blocking(move || capture_html_bundle(&project_id, path.as_deref())).await?;
    serve_html_bundle(bundle).await
}

fn capture_task_html_bundle(
    task: &oleafly_research::model::ResearchTask,
    path: &str,
    execution_generation: u64,
    expected_sha256: &str,
) -> Result<String, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    if task.execution_generation != execution_generation {
        return Err("The requested artifact generation is no longer retained.".into());
    }
    if !valid_html_resource(path)
        || !Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "html" | "htm")
            })
    {
        return Err("Choose an HTML result inside the task workspace.".into());
    }
    let result = task
        .result
        .as_ref()
        .ok_or("This task has no saved result to preview.")?;
    let reviewed = result
        .changed_files
        .iter()
        .find(|change| change.path == path)
        .and_then(|change| change.after_sha256.as_deref())
        .ok_or("That HTML result has no reviewed file hash.")?;
    if reviewed != expected_sha256 {
        return Err("The requested HTML result does not match its reviewed version.".into());
    }
    let isolation = task
        .isolation
        .as_ref()
        .ok_or("This task has no saved workspace to preview.")?;
    let root = Path::new(&isolation.execution_root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let html = root
        .join(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !html.starts_with(&root) {
        return Err("HTML result escapes the task workspace.".into());
    }
    let bundle = capture_html_bundle_at(&root, &html)?;
    let captured: HtmlBundle = serde_json::from_str(&bundle).map_err(|error| error.to_string())?;
    for (resource, encoded) in &captured.files {
        let expected = match result
            .changed_files
            .iter()
            .find(|change| change.path == *resource)
        {
            Some(change) => change.after_sha256.as_deref(),
            None => isolation
                .baseline
                .iter()
                .find(|entry| entry.path == *resource)
                .map(|entry| entry.sha256.as_str()),
        }
        .ok_or_else(|| format!("HTML resource has no recorded task version: {resource}"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err(format!(
                "The saved HTML resource changed after the task finished: {resource}"
            ));
        }
    }
    Ok(bundle)
}

#[tauri::command]
pub async fn read_task_html_preview(
    tasks_state: tauri::State<'_, crate::research_tasks::ResearchTaskState>,
    task_id: String,
    path: String,
    execution_generation: u64,
    expected_sha256: String,
) -> Result<HtmlPreviewSnapshot, String> {
    let state = tasks_state.inner().clone();
    let bundle = blocking(move || {
        let task = state.store()?.require(&task_id)?;
        capture_task_html_bundle(&task, &path, execution_generation, &expected_sha256)
    })
    .await?;
    serve_html_bundle(bundle).await
}

#[tauri::command]
pub async fn restore_html_preview(bundle: String) -> Result<HtmlPreviewSnapshot, String> {
    serve_html_bundle(bundle).await
}

#[tauri::command]
pub fn close_html_preview(url: String) -> Result<(), String> {
    if let Some(task) = HTML_PREVIEWS
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&url)
    {
        task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn html_preview_serves_frozen_resources_and_rejects_other_paths() {
        use base64::Engine;
        let encode = |value: &str| base64::engine::general_purpose::STANDARD.encode(value);
        let bundle = serde_json::to_string(&HtmlBundle { version: 1, entry: "report.html".into(), files: BTreeMap::from([
            ("report.html".into(), encode("<link href='assets/style.css'><button onclick='this.textContent=42'>Run</button>")),
            ("assets/style.css".into(), encode("body{color:red}")),
        ]) }).unwrap();
        let preview = serve_html_bundle(bundle.clone()).await.unwrap();
        assert_eq!(preview.bundle, bundle);
        let response = reqwest::get(&preview.url).await.unwrap();
        let policy = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(policy.contains("sandbox allow-scripts"));
        assert!(!policy.contains("allow-same-origin"));
        assert!(response
            .text()
            .await
            .unwrap()
            .contains("oleafly-html-selection"));
        let css = preview.url.replace("report.html", "assets/style.css");
        assert_eq!(
            reqwest::get(css).await.unwrap().text().await.unwrap(),
            "body{color:red}"
        );
        assert_eq!(
            reqwest::get(preview.url.replace("report.html", ".private/input.txt"))
                .await
                .unwrap()
                .status(),
            404
        );
        close_html_preview(preview.url).unwrap();
    }

    #[tokio::test]
    async fn html_capture_serves_attributes_and_recursive_static_dependencies() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("assets/nested")).unwrap();
        std::fs::create_dir(root.join(".private")).unwrap();
        let resources = [
            (
                "assets/chart.js",
                "import data from './nested/module.js'; import './side.js'; import('./lazy.js'); fetch('../data.json'); new URL('./marker.svg', import.meta.url);",
            ),
            ("assets/nested/module.js", "export { value } from '../reexport.js';"),
            ("assets/reexport.js", "export const value = 42;"),
            ("assets/side.js", "export const value = 42;"),
            ("assets/lazy.js", "export default 42;"),
            ("data.json", "{\"value\":42}"),
            ("assets/marker.svg", "<svg></svg>"),
            (
                "assets/style.css",
                "@import './nested/theme.css'; body { background: url(background.svg); }",
            ),
            ("assets/background.svg", "<svg></svg>"),
            (
                "assets/nested/theme.css",
                "@font-face { src: url(../font.woff2); }",
            ),
            ("assets/font.woff2", "font fixture"),
            ("assets/poster.png", "poster fixture"),
            ("assets/inline.png", "inline fixture"),
            ("assets/embedded.png", "embedded fixture"),
            ("assets/a&b.svg", "<svg></svg>"),
            ("inline.json", "{\"inline\":true}"),
            (
                "assets/nested/detail.html",
                "<script src='../detail.js'></script><p>Details</p>",
            ),
            ("assets/detail.js", "console.log('details');"),
        ];
        for (path, bytes) in resources {
            std::fs::write(root.join(path), bytes).unwrap();
        }
        for path in ["unrelated.txt", "comment.js", ".private/input.txt"] {
            std::fs::write(root.join(path), "not a captured dependency").unwrap();
        }

        for script in [
            r#"<script src="assets/chart.js"></script>"#,
            r#"<SCRIPT SRC="assets/chart.js"></SCRIPT>"#,
            "<script src  = \n 'assets/chart.js'></script>",
            "<script src=assets/chart.js></script>",
        ] {
            let html = format!(
                r#"<h1>Here's the report</h1>{script}
<LINK HREF = "assets/style.css"><video POSTER='assets/poster.png'></video>
<img src="assets/a&amp;b.svg"><p title="unrelated.txt" style="background:url('assets/inline.png')">Report</p>
<style>p {{ background: url(assets/embedded.png); }}</style>
<script>if (1 < 2) {{ fetch('inline.json'); }}</script>
<a href='assets/nested/detail.html'>Details</a>
<!-- <script src="comment.js"></script> -->
<textarea><script src="comment.js"></script></textarea>
<img src='.private/input.txt'><img src='../outside.txt'>
<script src='https://remote.test/chart.js'></script>"#
            );
            std::fs::write(root.join("report.html"), &html).unwrap();
            let bundle = capture_html_bundle_at(&root, &root.join("report.html")).unwrap();
            let captured: HtmlBundle = serde_json::from_str(&bundle).unwrap();
            let mut expected: Vec<_> = resources.iter().map(|(path, _)| *path).collect();
            expected.push("report.html");
            expected.sort_unstable();
            assert_eq!(
                captured
                    .files
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                expected,
                "{script}"
            );

            let preview = serve_html_bundle(bundle).await.unwrap();
            let response = reqwest::get(&preview.url).await.unwrap();
            assert_eq!(response.status(), 200);
            assert!(response.text().await.unwrap().contains("Here's the report"));
            for (path, bytes) in resources {
                let response = reqwest::get(preview.url.replace("report.html", path))
                    .await
                    .unwrap();
                assert_eq!(response.status(), 200, "{path}: {script}");
                let body = response.text().await.unwrap();
                if path.ends_with(".html") {
                    assert!(body.contains(bytes), "{path}: {script}");
                    assert!(body.contains("oleafly-html-selection"));
                } else {
                    assert_eq!(body, bytes, "{path}: {script}");
                }
            }
            for path in [
                "unrelated.txt",
                "comment.js",
                ".private/input.txt",
                "outside.txt",
            ] {
                assert_eq!(
                    reqwest::get(preview.url.replace("report.html", path))
                        .await
                        .unwrap()
                        .status(),
                    404,
                    "{path}: {script}"
                );
            }
            close_html_preview(preview.url).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn html_capture_rejects_dependencies_linked_outside_the_resource_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("public");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::write(temp.path().join("outside.js"), "private fixture").unwrap();
        std::os::unix::fs::symlink(temp.path().join("outside.js"), root.join("linked.js")).unwrap();
        std::fs::write(
            root.join("report.html"),
            "<h1>Here's the report</h1><script SRC = 'linked.js'></script>",
        )
        .unwrap();
        assert!(capture_html_bundle_at(&root, &root.join("report.html"))
            .unwrap_err()
            .contains("escapes its resource root"));
    }

    #[test]
    fn html_task_preview_pins_generation_hash_and_execution_resources() {
        use base64::Engine;
        use oleafly_research::model::{
            ResearchTaskDraft, TaskFileChange, TaskFileChangeKind, TaskIsolation,
            TaskIsolationKind, TaskResultMetadata,
        };
        use sha2::{Digest, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let execution = temp.path().join("execution");
        let original = temp.path().join("original");
        std::fs::create_dir_all(execution.join("assets")).unwrap();
        std::fs::create_dir_all(original.join("assets")).unwrap();
        let html = "<link href='assets/style.css'><p>Task result</p>";
        std::fs::write(execution.join("report.HTML"), html).unwrap();
        std::fs::write(execution.join("assets/style.css"), "task version").unwrap();
        std::fs::write(original.join("assets/style.css"), "current project version").unwrap();
        let hash = format!("{:x}", Sha256::digest(html.as_bytes()));
        let store = oleafly_research::store::TaskStore::new(temp.path().join("store")).unwrap();
        let mut task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "HTML".into(),
                prompt: "HTML".into(),
                runtime_id: "fixture".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        task.execution_generation = 3;
        task.isolation = Some(TaskIsolation {
            kind: TaskIsolationKind::StagedProject,
            execution_root: execution.to_string_lossy().into_owned(),
            baseline_root: original.to_string_lossy().into_owned(),
            source_revision: "base".into(),
            baseline_hash: "base".into(),
            baseline: vec![oleafly_research::model::ManifestEntry {
                path: "assets/style.css".into(),
                sha256: format!("{:x}", Sha256::digest(b"task version")),
                size: 12,
                resolved_link: false,
            }],
            allowed_paths: vec!["report.HTML".into()],
            created_at: 0,
            skipped: vec![],
            initial_git_status: None,
            initial_git_status_complete: None,
        });
        task.result = Some(TaskResultMetadata {
            summary: "done".into(),
            changed_files: vec![TaskFileChange {
                path: "report.HTML".into(),
                kind: TaskFileChangeKind::Added,
                before_sha256: None,
                after_sha256: Some(hash.clone()),
                before_size: None,
                after_size: Some(html.len() as u64),
            }],
            artifacts: vec![],
            native_session_id: None,
            input_tokens: None,
            output_tokens: None,
        });
        let bundle = capture_task_html_bundle(&task, "report.HTML", 3, &hash).unwrap();
        let captured: HtmlBundle = serde_json::from_str(&bundle).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&captured.files["assets/style.css"])
                .unwrap(),
            b"task version"
        );
        assert!(capture_task_html_bundle(&task, "report.HTML", 2, &hash).is_err());
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, "wrong").is_err());
        assert!(capture_task_html_bundle(&task, "../original/report.HTML", 3, &hash).is_err());
        assert!(capture_task_html_bundle(&task, "unrecorded.html", 3, &hash).is_err());
        std::fs::write(execution.join("assets/style.css"), "tampered CSS").unwrap();
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash)
            .unwrap_err()
            .contains("assets/style.css"));
        std::fs::write(execution.join("assets/style.css"), "task version").unwrap();
        let css_baseline = task.isolation.as_mut().unwrap().baseline.pop().unwrap();
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash)
            .unwrap_err()
            .contains("no recorded task version"));
        task.isolation.as_mut().unwrap().baseline.push(css_baseline);
        task.result
            .as_mut()
            .unwrap()
            .changed_files
            .push(TaskFileChange {
                path: "assets/style.css".into(),
                kind: TaskFileChangeKind::Modified,
                before_sha256: None,
                after_sha256: Some(format!("{:x}", Sha256::digest(b"updated CSS"))),
                before_size: None,
                after_size: Some(11),
            });
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash).is_err());
        std::fs::write(execution.join("assets/style.css"), "updated CSS").unwrap();
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash).is_ok());
        task.result
            .as_mut()
            .unwrap()
            .changed_files
            .last_mut()
            .unwrap()
            .after_sha256 = None;
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash)
            .unwrap_err()
            .contains("no recorded task version"));
        task.result.as_mut().unwrap().changed_files.pop();
        std::fs::write(execution.join("assets/style.css"), "task version").unwrap();
        std::fs::write(execution.join("report.HTML"), "changed").unwrap();
        assert!(capture_task_html_bundle(&task, "report.HTML", 3, &hash).is_err());
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&captured.files["report.HTML"])
                .unwrap(),
            html.as_bytes()
        );
    }

    #[test]
    fn html_dependencies_follow_only_static_local_references() {
        let refs = html_local_references(
            r#"<link href="assets/a.css"><script src='assets/a.js'></script><p title="unrelated.txt">x</p>"#,
        );
        assert_eq!(refs, vec!["assets/a.css", "assets/a.js"]);
        assert_eq!(
            resolve_html_dependency("reports/a.html", "../figures/p.png?v=1"),
            Some("figures/p.png".into())
        );
        assert_eq!(
            resolve_html_dependency("reports/a.html", "../../secret.json"),
            None
        );
        assert_eq!(
            resolve_html_dependency("a.html", "https://remote.test/a.js"),
            None
        );
        assert_eq!(
            code_local_references(
                "import x from './lib.js'; fetch('data.json'); const unused='notes.txt';"
            ),
            vec!["./lib.js", "data.json"]
        );
    }

    #[tokio::test]
    async fn html_restore_rejects_paths_outside_the_captured_bundle() {
        let bundle = serde_json::to_string(&HtmlBundle {
            version: 1,
            entry: "../private.html".into(),
            files: BTreeMap::from([("../private.html".into(), "AA==".into())]),
        })
        .unwrap();
        assert!(serve_html_bundle(bundle).await.is_err());
        assert!(!valid_html_resource(".private/a.html"));
        assert!(!valid_html_resource("assets/../../a.js"));
        assert_eq!(
            decode_html_path("assets/a%20b.js"),
            Some("assets/a b.js".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_probes_drop_the_appimage_launcher_paths_for_host_programs() {
        let image = crate::proc::SimulatedAppImage::start();
        let applied = |program: &Path| -> BTreeMap<String, Option<std::ffi::OsString>> {
            probe_command(program)
                .get_envs()
                .map(|(name, value)| {
                    (
                        name.to_string_lossy().into_owned(),
                        value.map(std::ffi::OsStr::to_os_string),
                    )
                })
                .collect()
        };
        let rscript = applied(Path::new("/usr/bin/Rscript"));
        assert_eq!(rscript["PYTHONHOME"], None);
        assert_eq!(rscript["LD_LIBRARY_PATH"], None);
        assert!(applied(&image.root.join("usr/bin/tectonic")).is_empty());
    }

    #[test]
    fn the_bundled_manifest_pins_both_tools_for_every_release_target() {
        let manifest = parse_manifest(MANIFEST_JSON).unwrap();
        assert_eq!(manifest.tools.quarto.version, "1.10.19");
        assert_eq!(manifest.tools.calepin.version, "0.0.61");
        for release in [&manifest.tools.quarto, &manifest.tools.calepin] {
            assert_eq!(release.license, "MIT");
            for target in [
                "aarch64-apple-darwin",
                "x86_64-apple-darwin",
                "aarch64-unknown-linux-gnu",
                "x86_64-unknown-linux-gnu",
                "x86_64-pc-windows-msvc",
            ] {
                let artifact = release.targets.get(target).unwrap();
                assert_eq!(artifact.archive_sha256.len(), 64, "{target}");
                assert!(artifact
                    .archive_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()));
                assert!(artifact.archive_size > 1_000_000, "{target}");
                assert!(ArchiveKind::parse(&artifact.archive_type).is_some());
                assert!(artifact.url.starts_with("https://github.com/"), "{target}");
                assert!(!artifact.executables.is_empty());
                assert_eq!(
                    crate::toolchain_download::tree_executable_candidates(&artifact.executables)
                        .len(),
                    artifact.executables.len()
                );
                if target.contains("windows") {
                    assert_eq!(artifact.archive_type, "zip", "{target}");
                    assert!(artifact
                        .executables
                        .iter()
                        .all(|path| path.ends_with(".exe")));
                }
            }
        }
        assert!(manifest
            .allowed_download_hosts
            .iter()
            .any(|host| host == "github.com"));
    }

    #[test]
    fn versions_are_read_from_each_tools_version_line() {
        assert_eq!(parse_version("1.10.19\n").as_deref(), Some("1.10.19"));
        assert_eq!(parse_version("calepin 0.0.61\n").as_deref(), Some("0.0.61"));
        assert_eq!(
            parse_version("Rscript (R) version 4.4.1 (2024-06-14)\n").as_deref(),
            Some("4.4.1")
        );
        assert_eq!(parse_version("Python 3.12.4\n").as_deref(), Some("3.12.4"));
        assert_eq!(
            parse_version("julia version 1.11.1\n").as_deref(),
            Some("1.11.1")
        );
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn tool_names_round_trip() {
        for tool in [NotebookTool::Quarto, NotebookTool::Calepin] {
            assert_eq!(NotebookTool::parse(tool.name()), Some(tool));
        }
        assert_eq!(NotebookTool::parse(" Quarto "), Some(NotebookTool::Quarto));
        assert_eq!(NotebookTool::parse("pandoc"), None);
        assert!(parse_tool("pandoc")
            .unwrap_err()
            .contains("notebook.unknown_tool"));
    }

    #[test]
    fn known_locations_cover_the_usual_installers() {
        let home = Path::new("/home/writer");
        let quarto = known_locations(NotebookTool::Quarto, Some(home));
        assert!(!quarto.is_empty());
        let calepin = known_locations(NotebookTool::Calepin, Some(home));
        assert!(calepin
            .iter()
            .any(|path| path.starts_with(home.join(".cargo"))));
    }

    #[test]
    fn a_download_left_by_an_older_pin_is_reported_and_removed_without_touching_the_pinned_one() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for folder in ["1.10.18/bin", "1.10.19/bin", "1.9.0", ".staging"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        std::fs::write(root.join("1.10.18/bin/quarto"), "old").unwrap();
        std::fs::write(root.join("1.10.19/bin/quarto"), "pinned").unwrap();
        std::fs::write(root.join("notes"), "not a version").unwrap();

        assert_eq!(superseded_in(root, "1.10.19"), ["1.10.18", "1.9.0"]);

        remove_superseded_in(root, "1.10.19");

        assert!(superseded_in(root, "1.10.19").is_empty());
        assert!(root.join("1.10.19/bin/quarto").is_file());
        assert!(root.join(".staging").is_dir());
        assert!(root.join("notes").is_file());
        assert!(!root.join("1.10.18").exists());
        assert!(superseded_in(&root.join("missing"), "1.10.19").is_empty());
    }

    #[test]
    fn a_second_install_of_the_same_tool_is_refused_while_one_runs() {
        let first = InstallClaim::take(NotebookTool::Calepin).unwrap();
        assert!(InstallClaim::take(NotebookTool::Calepin)
            .err()
            .unwrap()
            .contains("notebook.busy"));
        assert!(installing(NotebookTool::Calepin));
        drop(first);
        assert!(!installing(NotebookTool::Calepin));
    }
}
