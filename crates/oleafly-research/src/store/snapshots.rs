use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::{store_error, TaskStore};
use crate::observations::content_hash;

pub(super) const SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS research_task_file_snapshots (
      task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
      execution_generation INTEGER NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      content BLOB NOT NULL,
      PRIMARY KEY(task_id, execution_generation, path, sha256)
    );
";

const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;

impl TaskStore {
    /// Retain a source version for the task that read it. The per-task
    /// budget bounds SQLite growth while allowing repeat reads of one version.
    pub fn retain_file_snapshot(
        &self,
        task_id: &str,
        generation: u64,
        path: &str,
        sha256: &str,
        content: &[u8],
    ) -> Result<bool, String> {
        if content_hash(content) != sha256 {
            return Err("The task file snapshot does not match its SHA-256.".into());
        }
        let mut connection = self.open()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let retained: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM research_task_file_snapshots
                 WHERE task_id = ?1 AND execution_generation = ?2 AND path = ?3 AND sha256 = ?4",
                params![task_id, generation as i64, path, sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if retained.is_some() {
            transaction.commit().map_err(store_error)?;
            return Ok(true);
        }
        let running: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM research_tasks
                 WHERE id = ?1 AND execution_generation = ?2 AND status = 'running'
                   AND cancel_requested = 0",
                params![task_id, generation as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        if running.is_none() {
            transaction.commit().map_err(store_error)?;
            return Ok(false);
        }
        let stored_bytes: u64 = transaction
            .query_row(
                "SELECT COALESCE(SUM(length(content)), 0)
                 FROM research_task_file_snapshots
                 WHERE task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if stored_bytes.saturating_add(content.len() as u64) > MAX_SNAPSHOT_BYTES {
            transaction.commit().map_err(store_error)?;
            return Ok(false);
        }
        transaction
            .execute(
                "INSERT INTO research_task_file_snapshots
                 (task_id, execution_generation, path, sha256, content)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![task_id, generation as i64, path, sha256, content],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(true)
    }

    pub fn file_snapshot(
        &self,
        task_id: &str,
        generation: u64,
        path: &str,
        sha256: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT content FROM research_task_file_snapshots
                 WHERE task_id = ?1 AND execution_generation = ?2 AND path = ?3 AND sha256 = ?4",
                params![task_id, generation as i64, path, sha256],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ResearchTaskDraft, RetryMode};

    fn running_store(root: &std::path::Path) -> (TaskStore, String, u64) {
        let store = TaskStore::new(root.to_path_buf()).unwrap();
        let task = store
            .create(ResearchTaskDraft {
                project_id: "paper".into(),
                title: "Retained source".into(),
                prompt: "Read a source".into(),
                runtime_id: "builtin".into(),
                agent_id: "fixture".into(),
                model_id: "fixture".into(),
                ..Default::default()
            })
            .unwrap();
        store.request_start(&task.id).unwrap();
        let running = store.claim_next().unwrap().unwrap();
        (store, task.id, running.execution_generation)
    }

    #[test]
    fn snapshots_are_task_scoped_hash_verified_and_deduplicated() {
        let directory = tempfile::tempdir().unwrap();
        let (store, task_id, generation) = running_store(directory.path());
        let original = "first version 🍃".as_bytes();
        let sha256 = content_hash(original);
        assert!(store
            .retain_file_snapshot(&task_id, generation, "main.tex", &sha256, original)
            .unwrap());
        assert!(store
            .retain_file_snapshot(&task_id, generation, "main.tex", &sha256, original)
            .unwrap());
        assert_eq!(
            store
                .file_snapshot(&task_id, generation, "main.tex", &sha256)
                .unwrap()
                .unwrap(),
            original
        );
        assert!(store
            .file_snapshot(&task_id, generation, "chapter.tex", &sha256)
            .unwrap()
            .is_none());
        assert!(store
            .file_snapshot(&task_id, generation + 1, "main.tex", &sha256)
            .unwrap()
            .is_none());
        assert!(store
            .file_snapshot("other-task", generation, "main.tex", &sha256)
            .unwrap()
            .is_none());
        assert!(store
            .retain_file_snapshot(
                &task_id,
                generation,
                "main.tex",
                &content_hash(b"other"),
                original
            )
            .is_err());
    }

    #[test]
    fn task_snapshot_budget_is_shared_by_paths_and_actual_generations() {
        let directory = tempfile::tempdir().unwrap();
        let (store, task_id, generation) = running_store(directory.path());
        let first = vec![b'a'; MAX_SNAPSHOT_BYTES as usize];
        let first_hash = content_hash(&first);
        assert!(store
            .retain_file_snapshot(&task_id, generation, "main.tex", &first_hash, &first)
            .unwrap());
        let second = b"additional version";
        assert!(!store
            .retain_file_snapshot(
                &task_id,
                generation,
                "chapter.tex",
                &content_hash(second),
                second,
            )
            .unwrap());
        // Existing versions remain readable even when the budget is full.
        assert!(store
            .retain_file_snapshot(&task_id, generation, "main.tex", &first_hash, &first)
            .unwrap());
        assert!(store
            .finish_failure(&task_id, generation, "fixture complete")
            .unwrap());
        store.retry_with(&task_id, RetryMode::Fresh).unwrap();
        store.request_start(&task_id).unwrap();
        let next = store.claim_next().unwrap().unwrap();
        assert_eq!(next.execution_generation, generation + 1);
        assert!(!store
            .retain_file_snapshot(
                &task_id,
                next.execution_generation,
                "main.tex",
                &content_hash(second),
                second,
            )
            .unwrap());
        assert!(store
            .file_snapshot(
                &task_id,
                next.execution_generation,
                "main.tex",
                &content_hash(second)
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn cancelled_reads_do_not_add_snapshots_and_task_deletion_cleans_retained_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let (store, task_id, generation) = running_store(directory.path());
        let content = b"retained before cancellation";
        let hash = content_hash(content);
        assert!(store
            .retain_file_snapshot(&task_id, generation, "main.tex", &hash, content)
            .unwrap());
        store.request_cancel(&task_id).unwrap();
        assert!(!store
            .retain_file_snapshot(&task_id, generation, "chapter.tex", &hash, content)
            .unwrap());
        assert_eq!(
            store
                .file_snapshot(&task_id, generation, "main.tex", &hash)
                .unwrap()
                .as_deref(),
            Some(content.as_slice())
        );
        assert!(store.finalize_cancel(&task_id, generation).unwrap());
        store.delete(&task_id).unwrap();
        assert!(store
            .file_snapshot(&task_id, generation, "main.tex", &hash)
            .unwrap()
            .is_none());
    }

    #[test]
    fn version_seven_migration_preserves_tasks_and_enables_snapshot_storage() {
        let directory = tempfile::tempdir().unwrap();
        let (store, task_id, generation) = running_store(directory.path());
        store
            .open()
            .unwrap()
            .execute_batch(
                "DROP TABLE research_task_file_snapshots;
                 ALTER TABLE collaboration_work DROP COLUMN reasons_json;
                 DROP TABLE collaboration_attentions;
                 PRAGMA user_version = 7;",
            )
            .unwrap();
        let reopened = TaskStore::new(directory.path().into()).unwrap();
        assert_eq!(
            reopened.require(&task_id).unwrap().execution_generation,
            generation
        );
        let content = b"migration fixture";
        let hash = content_hash(content);
        assert!(reopened
            .retain_file_snapshot(&task_id, generation, "main.tex", &hash, content)
            .unwrap());
        assert_eq!(
            reopened
                .file_snapshot(&task_id, generation, "main.tex", &hash)
                .unwrap()
                .as_deref(),
            Some(content.as_slice())
        );
    }
}
