use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SCHEMA_VERSION: u32 = 1;
const RECOVERY_DIRECTORY: &str = "docx-recovery";
static RECOVERY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryMetadata {
    recovery_key: String,
    app_project_id: String,
    workbench_project_id: String,
    base_baseline_id: String,
    source_sha256: String,
    revision: u64,
    updated_at: String,
    content_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoverySaveRequest {
    recovery_key: String,
    app_project_id: String,
    workbench_project_id: String,
    base_baseline_id: String,
    source_sha256: String,
    revision: u64,
    updated_at: String,
    content_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryReadRequest {
    recovery_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocxRecoveryClearRequest {
    recovery_key: String,
    content_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocxRecovery {
    schema_version: u32,
    #[serde(flatten)]
    metadata: DocxRecoveryMetadata,
    content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoverySnapshot {
    #[serde(flatten)]
    metadata: DocxRecoveryMetadata,
    bytes_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoveryFailure {
    recovery_key: String,
    error: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxRecoveryListing {
    snapshots: Vec<DocxRecoveryMetadata>,
    failures: Vec<DocxRecoveryFailure>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label} must be a lowercase SHA-256 hex digest"));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.contains('\0') {
        return Err(format!("{label} must be a non-empty string"));
    }
    Ok(())
}

fn recovery_key_for(
    app_project_id: &str,
    workbench_project_id: &str,
    base_baseline_id: &str,
    source_sha256: &str,
) -> String {
    let identity = [
        app_project_id,
        workbench_project_id,
        base_baseline_id,
        source_sha256,
    ]
    .into_iter()
    .map(|value| format!("{}:{value}", value.len()))
    .collect::<Vec<_>>()
    .join("\n");
    sha256_hex(identity.as_bytes())
}

fn validate_updated_at(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let separators = [4, 7, 10, 13, 16, 19, 23];
    if bytes.len() != 24
        || !separators.iter().all(|&index| {
            bytes[index]
                == match index {
                    4 | 7 => b'-',
                    10 => b'T',
                    13 | 16 => b':',
                    19 => b'.',
                    _ => b'Z',
                }
        })
        || separators.contains(&bytes.len())
    {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| !separators.contains(&index) && !byte.is_ascii_digit())
    {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    let number = |range: std::ops::Range<usize>| {
        value[range].parse::<u32>().map_err(|_| {
            "updatedAt must be an ISO-8601 UTC timestamp with milliseconds".to_string()
        })
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    if hour > 23 || minute > 59 || second > 59 {
        return Err("updatedAt must be an ISO-8601 UTC timestamp with milliseconds".into());
    }
    Ok(())
}

fn validate_metadata(metadata: &DocxRecoveryMetadata) -> Result<(), String> {
    validate_sha256(&metadata.recovery_key, "recoveryKey")?;
    validate_id(&metadata.app_project_id, "appProjectId")?;
    validate_id(&metadata.workbench_project_id, "workbenchProjectId")?;
    validate_id(&metadata.base_baseline_id, "baseBaselineId")?;
    validate_sha256(&metadata.source_sha256, "sourceSha256")?;
    validate_updated_at(&metadata.updated_at)?;
    validate_sha256(&metadata.content_sha256, "contentSha256")
}

fn recovery_path(root: &Path, recovery_key: &str) -> Result<PathBuf, String> {
    validate_sha256(recovery_key, "recoveryKey")?;
    Ok(root
        .join(RECOVERY_DIRECTORY)
        .join(format!("{recovery_key}.json")))
}

fn save_at(root: &Path, request: DocxRecoverySaveRequest) -> Result<DocxRecoveryMetadata, String> {
    validate_sha256(&request.recovery_key, "recoveryKey")?;
    validate_id(&request.app_project_id, "appProjectId")?;
    validate_id(&request.workbench_project_id, "workbenchProjectId")?;
    validate_id(&request.base_baseline_id, "baseBaselineId")?;
    validate_sha256(&request.source_sha256, "sourceSha256")?;
    validate_updated_at(&request.updated_at)?;
    if request.recovery_key
        != recovery_key_for(
            &request.app_project_id,
            &request.workbench_project_id,
            &request.base_baseline_id,
            &request.source_sha256,
        )
    {
        return Err("DOCX recovery key does not match its working-copy metadata".into());
    }
    let bytes = STANDARD
        .decode(request.content_base64.trim())
        .map_err(|error| format!("failed to decode DOCX recovery bytes: {error}"))?;
    if bytes.is_empty() {
        return Err("DOCX recovery bytes are empty".into());
    }
    let metadata = DocxRecoveryMetadata {
        recovery_key: request.recovery_key,
        app_project_id: request.app_project_id,
        workbench_project_id: request.workbench_project_id,
        base_baseline_id: request.base_baseline_id,
        source_sha256: request.source_sha256,
        revision: request.revision,
        updated_at: request.updated_at,
        content_sha256: sha256_hex(&bytes),
    };
    let stored = StoredDocxRecovery {
        schema_version: SCHEMA_VERSION,
        metadata: metadata.clone(),
        content_base64: STANDARD.encode(bytes),
    };
    let encoded = serde_json::to_vec(&stored)
        .map_err(|error| format!("failed to encode DOCX recovery snapshot: {error}"))?;
    let path = recovery_path(root, &metadata.recovery_key)?;
    let directory = path
        .parent()
        .expect("DOCX recovery path always has a parent");
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("failed to create DOCX recovery directory: {error}"))?;
    crate::sandbox::atomic_write(&path, &encoded)
        .map_err(|error| format!("failed to write DOCX recovery snapshot: {error}"))?;
    Ok(metadata)
}

fn load_stored_at(root: &Path, recovery_key: &str) -> Result<Option<StoredDocxRecovery>, String> {
    let path = recovery_path(root, recovery_key)?;
    let encoded = match std::fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read DOCX recovery snapshot: {error}")),
    };
    let stored: StoredDocxRecovery = serde_json::from_slice(&encoded)
        .map_err(|error| format!("failed to decode DOCX recovery snapshot: {error}"))?;
    if stored.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported DOCX recovery schema version {}",
            stored.schema_version
        ));
    }
    validate_metadata(&stored.metadata)?;
    if stored.metadata.recovery_key != recovery_key {
        return Err("DOCX recovery key does not match its file".into());
    }
    if stored.metadata.recovery_key
        != recovery_key_for(
            &stored.metadata.app_project_id,
            &stored.metadata.workbench_project_id,
            &stored.metadata.base_baseline_id,
            &stored.metadata.source_sha256,
        )
    {
        return Err("DOCX recovery key does not match its working-copy metadata".into());
    }
    let bytes = STANDARD
        .decode(stored.content_base64.trim())
        .map_err(|error| format!("failed to decode stored DOCX recovery bytes: {error}"))?;
    if bytes.is_empty() {
        return Err("stored DOCX recovery bytes are empty".into());
    }
    if sha256_hex(&bytes) != stored.metadata.content_sha256 {
        return Err("stored DOCX recovery content hash does not match its metadata".into());
    }
    Ok(Some(stored))
}

fn read_at(
    root: &Path,
    request: DocxRecoveryReadRequest,
) -> Result<Option<DocxRecoverySnapshot>, String> {
    let Some(stored) = load_stored_at(root, &request.recovery_key)? else {
        return Ok(None);
    };
    Ok(Some(DocxRecoverySnapshot {
        metadata: stored.metadata,
        bytes_base64: stored.content_base64,
    }))
}

fn list_at(root: &Path) -> Result<DocxRecoveryListing, String> {
    let entries = match std::fs::read_dir(root.join(RECOVERY_DIRECTORY)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DocxRecoveryListing::default());
        }
        Err(error) => return Err(format!("failed to list DOCX recovery directory: {error}")),
    };
    let mut listing = DocxRecoveryListing::default();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to list DOCX recovery directory: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let recovery_key = path
            .file_stem()
            .expect("JSON recovery path has a file stem")
            .to_string_lossy()
            .into_owned();
        match load_stored_at(root, &recovery_key) {
            Ok(Some(stored)) => listing.snapshots.push(stored.metadata),
            Ok(None) => {}
            Err(error) => listing.failures.push(DocxRecoveryFailure {
                recovery_key,
                error,
            }),
        }
    }
    listing.snapshots.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.recovery_key.cmp(&right.recovery_key))
    });
    listing
        .failures
        .sort_by(|left, right| left.recovery_key.cmp(&right.recovery_key));
    Ok(listing)
}

fn clear_at(root: &Path, request: DocxRecoveryClearRequest) -> Result<bool, String> {
    validate_sha256(&request.content_sha256, "contentSha256")?;
    let Some(stored) = load_stored_at(root, &request.recovery_key)? else {
        return Ok(false);
    };
    if stored.metadata.content_sha256 != request.content_sha256 {
        return Ok(false);
    }
    let path = recovery_path(root, &request.recovery_key)?;
    std::fs::remove_file(&path)
        .map_err(|error| format!("failed to clear DOCX recovery snapshot: {error}"))?;
    Ok(true)
}

fn recovery_root() -> Result<PathBuf, String> {
    crate::paths::oleafly_root()
}

#[tauri::command]
pub async fn docx_recovery_save(
    request: DocxRecoverySaveRequest,
) -> Result<DocxRecoveryMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        save_at(&recovery_root()?, request)
    })
    .await
    .map_err(|error| format!("DOCX recovery save task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_read(
    request: DocxRecoveryReadRequest,
) -> Result<Option<DocxRecoverySnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        read_at(&recovery_root()?, request)
    })
    .await
    .map_err(|error| format!("DOCX recovery read task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_list() -> Result<DocxRecoveryListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        list_at(&recovery_root()?)
    })
    .await
    .map_err(|error| format!("DOCX recovery list task failed: {error}"))?
}

#[tauri::command]
pub async fn docx_recovery_clear(request: DocxRecoveryClearRequest) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RECOVERY_LOCK
            .lock()
            .map_err(|_| "DOCX recovery store lock is unavailable".to_string())?;
        clear_at(&recovery_root()?, request)
    })
    .await
    .map_err(|error| format!("DOCX recovery clear task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: &str, content: &[u8]) -> DocxRecoverySaveRequest {
        let app_project_id = "app-project";
        let workbench_project_id = "workbench-project";
        let base_baseline_id = "baseline-7";
        let source_sha256 = "a".repeat(64);
        DocxRecoverySaveRequest {
            recovery_key: if key.is_empty() {
                recovery_key_for(
                    app_project_id,
                    workbench_project_id,
                    base_baseline_id,
                    &source_sha256,
                )
            } else {
                key.into()
            },
            app_project_id: app_project_id.into(),
            workbench_project_id: workbench_project_id.into(),
            base_baseline_id: base_baseline_id.into(),
            source_sha256,
            revision: 4,
            updated_at: "2026-11-11T08:30:15.123Z".into(),
            content_base64: STANDARD.encode(content),
        }
    }

    #[test]
    fn derives_the_shared_recovery_key_contract() {
        assert_eq!(
            recovery_key_for(
                "app-project",
                "workbench-project",
                "baseline-7",
                &"a".repeat(64),
            ),
            "296d8e392fc181f4ec387ea8ee341712f3c45bd12762dbf3dfc93bf0ca8dbabc"
        );
    }

    #[test]
    fn save_and_read_replace_the_latest_snapshot_with_verified_hashes() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        save_at(temporary.path(), request(&key, b"first")).unwrap();
        let metadata = save_at(temporary.path(), request(&key, b"latest")).unwrap();

        let snapshot = read_at(
            temporary.path(),
            DocxRecoveryReadRequest { recovery_key: key },
        )
        .unwrap()
        .unwrap();

        assert_eq!(snapshot.metadata, metadata);
        assert_eq!(STANDARD.decode(snapshot.bytes_base64).unwrap(), b"latest");
        assert_eq!(metadata.content_sha256, sha256_hex(b"latest"));
    }

    #[test]
    fn lists_verified_metadata_by_latest_update_then_key() {
        let temporary = tempfile::tempdir().unwrap();
        let mut expected = Vec::new();
        for (baseline, updated_at) in [
            ("baseline-old", "2026-11-10T08:30:15.123Z"),
            ("baseline-new-a", "2026-11-11T08:30:15.123Z"),
            ("baseline-new-b", "2026-11-11T08:30:15.123Z"),
        ] {
            let mut save_request = request("", baseline.as_bytes());
            save_request.base_baseline_id = baseline.into();
            save_request.updated_at = updated_at.into();
            save_request.recovery_key = recovery_key_for(
                &save_request.app_project_id,
                &save_request.workbench_project_id,
                baseline,
                &save_request.source_sha256,
            );
            expected.push(save_at(temporary.path(), save_request).unwrap());
        }
        expected[1..].sort_by(|left, right| left.recovery_key.cmp(&right.recovery_key));
        expected.rotate_left(1);
        std::fs::write(
            temporary
                .path()
                .join(RECOVERY_DIRECTORY)
                .join("pending.tmp"),
            b"unfinished atomic write",
        )
        .unwrap();

        let listing = list_at(temporary.path()).unwrap();

        assert_eq!(listing.snapshots, expected);
        assert!(listing.failures.is_empty());
        let encoded = serde_json::to_value(listing).unwrap();
        assert!(encoded["snapshots"][0].get("contentBase64").is_none());
        assert!(encoded["snapshots"][0].get("bytesBase64").is_none());
    }

    #[test]
    fn listing_isolates_invalid_records_and_keeps_them_for_diagnosis() {
        let temporary = tempfile::tempdir().unwrap();
        let saved = save_at(temporary.path(), request("", b"healthy")).unwrap();
        let directory = temporary.path().join(RECOVERY_DIRECTORY);
        let malformed_key = "b".repeat(64);
        let changed_key = "c".repeat(64);
        std::fs::write(directory.join(format!("{malformed_key}.json")), b"not JSON").unwrap();
        let mut changed: StoredDocxRecovery = serde_json::from_slice(
            &std::fs::read(recovery_path(temporary.path(), &saved.recovery_key).unwrap()).unwrap(),
        )
        .unwrap();
        changed.content_base64 = STANDARD.encode(b"tampered");
        let changed_path = recovery_path(temporary.path(), &saved.recovery_key).unwrap();
        std::fs::write(&changed_path, serde_json::to_vec(&changed).unwrap()).unwrap();
        std::fs::write(directory.join(format!("{changed_key}.json")), b"{}").unwrap();
        std::fs::write(directory.join("invalid-key.json"), b"{}").unwrap();
        let mut healthy_request = request("", b"healthy second record");
        healthy_request.source_sha256 = "d".repeat(64);
        healthy_request.recovery_key = recovery_key_for(
            &healthy_request.app_project_id,
            &healthy_request.workbench_project_id,
            &healthy_request.base_baseline_id,
            &healthy_request.source_sha256,
        );
        let healthy = save_at(temporary.path(), healthy_request).unwrap();

        let listing = list_at(temporary.path()).unwrap();

        assert_eq!(listing.snapshots, vec![healthy]);
        assert_eq!(listing.failures.len(), 4);
        assert!(listing.failures.iter().any(|failure| {
            failure.recovery_key == saved.recovery_key
                && failure.error.contains("content hash does not match")
        }));
        for failure in listing.failures {
            assert!(directory
                .join(format!("{}.json", failure.recovery_key))
                .exists());
        }
    }

    #[test]
    fn listing_returns_empty_for_missing_directory_but_fails_directory_io_errors() {
        let temporary = tempfile::tempdir().unwrap();
        let listing = list_at(temporary.path()).unwrap();
        assert!(listing.snapshots.is_empty());
        assert!(listing.failures.is_empty());

        std::fs::write(
            temporary.path().join(RECOVERY_DIRECTORY),
            b"not a directory",
        )
        .unwrap();
        assert!(list_at(temporary.path())
            .unwrap_err()
            .contains("failed to list DOCX recovery directory"));
    }

    #[test]
    fn discard_from_a_listing_does_not_clear_a_newer_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let selected = save_at(temporary.path(), request("", b"selected")).unwrap();
        let latest = save_at(temporary.path(), request("", b"newer edit")).unwrap();

        assert!(!clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: selected.recovery_key.clone(),
                content_sha256: selected.content_sha256,
            },
        )
        .unwrap());
        assert_eq!(list_at(temporary.path()).unwrap().snapshots, vec![latest]);
    }

    #[test]
    fn read_rejects_content_that_no_longer_matches_its_metadata_hash() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        save_at(temporary.path(), request(&key, b"original")).unwrap();
        let path = recovery_path(temporary.path(), &key).unwrap();
        let mut stored: StoredDocxRecovery =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored.content_base64 = STANDARD.encode(b"tampered");
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();

        let error = read_at(
            temporary.path(),
            DocxRecoveryReadRequest { recovery_key: key },
        )
        .unwrap_err();

        assert!(error.contains("content hash does not match"));
        assert!(path.exists());
    }

    #[test]
    fn read_rejects_invalid_metadata_and_clear_preserves_a_different_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        let key = recovery_key_for(
            "app-project",
            "workbench-project",
            "baseline-7",
            &"a".repeat(64),
        );
        let saved = save_at(temporary.path(), request(&key, b"working copy")).unwrap();

        let cleared = clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: key.clone(),
                content_sha256: sha256_hex(b"committed baseline"),
            },
        )
        .unwrap();

        assert!(!cleared);
        assert!(recovery_path(temporary.path(), &key).unwrap().exists());
        assert!(clear_at(
            temporary.path(),
            DocxRecoveryClearRequest {
                recovery_key: key.clone(),
                content_sha256: saved.content_sha256,
            },
        )
        .unwrap());
        assert!(!recovery_path(temporary.path(), &key).unwrap().exists());

        let mut invalid = request(&key, b"next");
        invalid.app_project_id.clear();
        assert!(save_at(temporary.path(), invalid)
            .unwrap_err()
            .contains("appProjectId"));

        let mut mismatched = request(&key, b"next");
        mismatched.app_project_id = "other-app-project".into();
        assert!(save_at(temporary.path(), mismatched)
            .unwrap_err()
            .contains("key does not match"));
    }
}
