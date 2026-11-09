use std::sync::{Arc, Barrier};

use super::*;

fn files(root: &Path) -> TaskFiles {
    TaskFiles::open(root, &["main.tex".into(), "analysis".into()]).unwrap()
}

#[test]
fn a_stale_read_version_cannot_overwrite_a_later_external_edit() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.tex"), "version zero").unwrap();
    let files = files(root.path());
    let read = files.read_window("main.tex", 0, MAX_OUTPUT_BYTES).unwrap();
    let expected = read["fileSha256"].as_str().unwrap();
    std::fs::write(root.path().join("main.tex"), "external version one").unwrap();

    assert!(files
        .write_if_unchanged("main.tex", "stale member proposal", Some(expected))
        .is_err());
    assert_eq!(files.read("main.tex").unwrap(), "external version one");
    let current = files.read_window("main.tex", 0, MAX_OUTPUT_BYTES).unwrap();
    files
        .write_if_unchanged(
            "main.tex",
            "reconciled version two",
            current["fileSha256"].as_str(),
        )
        .unwrap();
    assert_eq!(files.read("main.tex").unwrap(), "reconciled version two");
}

#[test]
fn creating_an_absent_file_compares_absence_and_does_not_replace_new_content() {
    let root = tempfile::tempdir().unwrap();
    let files = files(root.path());
    assert!(!files.exists("analysis/new.md").unwrap());
    files
        .write_if_unchanged("analysis/new.md", "first creation", None)
        .unwrap();
    assert!(files
        .write_if_unchanged("analysis/new.md", "late creation", None)
        .is_err());
    assert_eq!(files.read("analysis/new.md").unwrap(), "first creation");
}

#[test]
fn two_members_writing_the_same_read_version_have_exactly_one_winner() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("main.tex"), "shared baseline").unwrap();
    let expected = files(root.path())
        .read_window("main.tex", 0, MAX_OUTPUT_BYTES)
        .unwrap()["fileSha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let barrier = Arc::new(Barrier::new(2));
    let handles = ["member one proposal", "member two proposal"]
        .into_iter()
        .map(|proposal| {
            let files = files(root.path());
            let expected = expected.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (
                    proposal,
                    files.write_if_unchanged("main.tex", proposal, Some(&expected)),
                )
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_err()).count(),
        1
    );
    let winner = results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
    assert_eq!(
        std::fs::read_to_string(root.path().join("main.tex")).unwrap(),
        winner
    );
}
