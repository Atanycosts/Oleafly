use super::{AssetFile, FontPack};
use crate::proc::NoConsole;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Clone, Deserialize, Serialize)]
pub struct FontPackage {
    pub id: String,
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub steps: Vec<ArchiveMember>,
    pub member_format: ArchiveFormat,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ArchiveMember {
    pub format: ArchiveFormat,
    pub member: String,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFormat {
    #[serde(rename = "7z")]
    SevenZip,
    Tar,
}

pub(super) fn matches_checksum(path: &Path, expected: Option<&str>) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Some(expected) = expected else {
        return true;
    };
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => return super::checksum_matches(Some(expected), &digest.finalize()),
            Ok(count) => digest.update(&buffer[..count]),
            Err(_) => return false,
        }
    }
}

pub(super) fn verify_font(path: &Path, file: &AssetFile) -> Result<(), String> {
    if !matches_checksum(path, file.sha256.as_deref()) {
        return Err(format!("Font {} does not match its checksum", file.name));
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if !crate::system_fonts::standalone_static_font(&bytes, 0) {
        return Err(format!(
            "Font {} is not a static standalone font",
            file.name
        ));
    }
    let mut database = fontdb::Database::new();
    database.load_font_data(bytes.clone());
    let face = database
        .faces()
        .next()
        .ok_or_else(|| format!("Font {} has no readable face", file.name))?;
    let family = file
        .family
        .as_deref()
        .ok_or("Missing font family metadata")?;
    if !face
        .families
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case(family))
        || file.postscript.as_deref() != Some(face.post_script_name.as_str())
        || file.weight != Some(face.weight.0)
        || file.style != Some(face.style.into())
        || file.version != crate::system_fonts::font_version(&bytes, 0)
    {
        return Err(format!(
            "Font {} does not match its declared identity",
            file.name
        ));
    }
    Ok(())
}

fn source_receipt(pack: &FontPack, package: &FontPackage) -> serde_json::Value {
    serde_json::json!({ "package": package, "files": pack.files })
}

pub(super) fn receipt_matches(pack: &FontPack, package: &FontPackage, directory: &Path) -> bool {
    std::fs::read(directory.join("source.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|receipt| receipt == source_receipt(pack, package))
}

fn write_receipt(pack: &FontPack, package: &FontPackage, directory: &Path) -> Result<(), String> {
    std::fs::write(
        directory.join("source.json"),
        serde_json::to_vec_pretty(&source_receipt(pack, package))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn sevenzip() -> Result<PathBuf, String> {
    for name in ["7zz", "7z"] {
        if let Some(located) = crate::program_locator::locate_native(name) {
            return Ok(located.path);
        }
    }
    Err("Extracting this font package requires 7-Zip. On macOS install it with brew install sevenzip.".into())
}

async fn extract_member(
    archive: &Path,
    format: ArchiveFormat,
    member: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut command = match format {
        ArchiveFormat::SevenZip => {
            let mut command = tokio::process::Command::new(sevenzip()?);
            command.args(["x", "-so", "-bd", "-y"]);
            command.arg(archive).arg(member);
            command
        }
        ArchiveFormat::Tar => {
            let located = crate::program_locator::locate_native("tar")
                .ok_or("Extracting this font package requires tar.")?;
            let mut command = tokio::process::Command::new(located.path);
            command.arg("-xOf").arg(archive).arg(member);
            command
        }
    };
    let output = std::fs::File::create(destination).map_err(|error| error.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(output)
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_console();
    let child = command.spawn().map_err(|error| error.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| format!("Extracting font package member {member} timed out"))?
        .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "Could not extract font package member {member}: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(())
}

pub(super) async fn install(
    app: &AppHandle,
    pack: &FontPack,
    package: &FontPackage,
    destination: &Path,
) -> Result<(), String> {
    if !super::is_valid_id(&package.id) || !super::is_simple_filename(&package.name) {
        return Err("Invalid font package cache identity".into());
    }
    if !package.url.starts_with("https://") || package.sha256.len() != 64 {
        return Err("Font packages require an HTTPS source and a SHA-256 checksum".into());
    }
    if pack
        .files
        .iter()
        .all(|file| verify_font(&destination.join(&file.name), file).is_ok())
    {
        if !receipt_matches(pack, package, destination) {
            write_receipt(pack, package, destination)?;
        }
        return Ok(());
    }
    if package.member_format == ArchiveFormat::SevenZip
        || package
            .steps
            .iter()
            .any(|step| step.format == ArchiveFormat::SevenZip)
    {
        sevenzip()?;
    }
    let cache = crate::paths::assets_root()?.join("font-packages");
    tokio::fs::create_dir_all(&cache)
        .await
        .map_err(|error| error.to_string())?;
    let archive = cache.join(format!("{}-{}", package.sha256, package.name));
    let download = AssetFile {
        name: package.name.clone(),
        url: package.url.clone(),
        sha256: Some(package.sha256.clone()),
        ..Default::default()
    };
    super::download_file(app, pack, &download, &archive, 1, 1).await?;
    if std::fs::metadata(&archive)
        .map_err(|error| error.to_string())?
        .len()
        != package.size
    {
        return Err("Font package size differs from the catalog".into());
    }
    let work = tempfile::tempdir_in(&cache).map_err(|error| error.to_string())?;
    let mut input = archive;
    for (index, step) in package.steps.iter().enumerate() {
        let output = work.path().join(format!("member-{index}"));
        extract_member(&input, step.format, &step.member, &output).await?;
        input = output;
    }
    let staged = work.path().join("fonts");
    std::fs::create_dir(&staged).map_err(|error| error.to_string())?;
    for file in &pack.files {
        if !super::is_simple_filename(&file.name) {
            return Err(format!("Invalid font filename: {}", file.name));
        }
        let member = file
            .member
            .as_deref()
            .ok_or("Missing font package member")?;
        let output = staged.join(&file.name);
        extract_member(&input, package.member_format, member, &output).await?;
        verify_font(&output, file)?;
    }
    write_receipt(pack, package, &staged)?;
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for file in &pack.files {
        std::fs::rename(staged.join(&file.name), destination.join(&file.name))
            .map_err(|error| error.to_string())?;
    }
    std::fs::rename(staged.join("source.json"), destination.join("source.json"))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_rechecks_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("font.ttf");
        std::fs::write(&path, b"font bytes").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"font bytes"));
        assert!(matches_checksum(&path, Some(&expected)));
        std::fs::write(&path, b"damaged").unwrap();
        assert!(!matches_checksum(&path, Some(&expected)));
    }

    #[test]
    fn source_receipt_must_match_the_current_package_and_faces() {
        let packs: Vec<FontPack> =
            serde_json::from_str(include_str!("../../resources/font-packs.json")).unwrap();
        let pack = packs
            .iter()
            .find(|pack| pack.id == "microsoft-simsun")
            .unwrap();
        let package = pack.package.as_ref().unwrap();
        let root = tempfile::tempdir().unwrap();
        assert!(!receipt_matches(pack, package, root.path()));
        write_receipt(pack, package, root.path()).unwrap();
        assert!(receipt_matches(pack, package, root.path()));
        let mut wrong = source_receipt(pack, package);
        wrong["files"][0]["version"] = "Other version".into();
        std::fs::write(
            root.path().join("source.json"),
            serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        assert!(!receipt_matches(pack, package, root.path()));
        write_receipt(pack, package, root.path()).unwrap();
        assert!(receipt_matches(pack, package, root.path()));
    }

    #[tokio::test]
    async fn exact_archive_member_is_streamed_and_missing_member_fails() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("fonts.tar");
        let mut tar = tar::Builder::new(std::fs::File::create(&archive).unwrap());
        let mut header = tar::Header::new_gnu();
        header.set_size(10);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, "inside/font.ttf", &b"font bytes"[..])
            .unwrap();
        tar.finish().unwrap();
        let destination = root.path().join("chosen.ttf");
        extract_member(
            &archive,
            ArchiveFormat::Tar,
            "inside/font.ttf",
            &destination,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"font bytes");
        assert!(
            extract_member(&archive, ArchiveFormat::Tar, "missing.ttf", &destination)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[ignore = "uses locally retained Microsoft packages and Homebrew 7zz"]
    async fn retained_microsoft_packages_extract_and_validate_real_faces() {
        let root = PathBuf::from(std::env::var("OLEAFLY_FONT_SOURCE_EVIDENCE").unwrap());
        let catalog: Vec<FontPack> =
            serde_json::from_str(include_str!("../../resources/font-packs.json")).unwrap();
        let work = tempfile::tempdir().unwrap();
        for name in ["office-preview.pkg", "eadengfontpack.exe"] {
            let pack = catalog
                .iter()
                .find(|pack| {
                    pack.package
                        .as_ref()
                        .is_some_and(|package| package.name == name)
                })
                .unwrap();
            let package = pack.package.as_ref().unwrap();
            assert!(matches_checksum(&root.join(name), Some(&package.sha256)));
            let mut input = root.join(name);
            for (index, step) in package.steps.iter().enumerate() {
                let output = work.path().join(format!("{name}-{index}"));
                extract_member(&input, step.format, &step.member, &output)
                    .await
                    .unwrap();
                input = output;
            }
            for target in catalog
                .iter()
                .filter(|target| target.package.as_ref().is_some_and(|p| p.id == package.id))
            {
                for file in &target.files {
                    let output = work.path().join(&file.name);
                    extract_member(
                        &input,
                        package.member_format,
                        file.member.as_ref().unwrap(),
                        &output,
                    )
                    .await
                    .unwrap();
                    verify_font(&output, file).unwrap();
                    let mut wrong_identity = file.clone();
                    wrong_identity.family = Some("Other Family".into());
                    assert!(verify_font(&output, &wrong_identity).is_err());
                }
            }
        }
    }
}
