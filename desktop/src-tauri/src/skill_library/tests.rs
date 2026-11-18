use super::*;
use changes::{Action, apply};
use serde_json::json;

fn setup(provider: Provider) -> (tempfile::TempDir, Locations, Query) {
    let tmp = tempfile::tempdir().unwrap();
    let loc = Locations {
        home: tmp.path().join("home"),
        chrys: tmp.path().join("config/chrys"),
        trash: tmp.path().join("app/trash/skills"),
    };
    let project = tmp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    (
        tmp,
        loc,
        Query {
            provider,
            profile: None,
            projects: vec![project],
        },
    )
}
fn skill(path: &Path, name: &str) {
    fs::create_dir_all(path).unwrap();
    fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: >\n  样例技能\n---\n正文"),
    )
    .unwrap();
}
fn action(json: serde_json::Value) -> Action {
    serde_json::from_value(json).unwrap()
}
fn delete(loc: &Locations, q: &Query, e: &Entry) -> String {
    apply(loc, q, action(json!({"type":"delete","items":[e]})))
        .unwrap()
        .remove(0)
}
fn check_recycled_description(loc: &Locations, q: &Query, entry: &Entry) {
    let trash = catalog::list(loc, q).unwrap().trash;
    assert_eq!(trash[0].description, entry.description);
    let path = loc.trash.join(&trash[0].id).join("record.json");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        record.as_object_mut().unwrap().remove("description"),
        Some(json!(entry.description))
    );
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        catalog::list(loc, q).unwrap().trash[0].description,
        entry.description
    );
}
#[test]
fn home_and_project_remain_separate_and_conflicts_skip() {
    let (tmp, loc, q) = setup(Provider::CodeAgent);
    let global = loc.home.join(".cac/skills");
    let project = q.projects[0].join(".cac/skills");
    skill(&global.join("alpha"), "alpha");
    skill(&project.join("alpha"), "alpha");
    let c = catalog::list(&loc, &q).unwrap();
    assert_eq!(c.entries.len(), 2);
    let original = c.entries.iter().find(|e| e.source == global).unwrap();
    assert!(delete(&loc, &q, original).contains("已移入"));
    check_recycled_description(&loc, &q, original);
    assert!(project.join("alpha/SKILL.md").is_file());
    let from = tmp.path().join("import");
    skill(&from.join("alpha"), "alpha");
    skill(&from.join("beta"), "beta");
    let args = || {
        action(
            json!({"type":"import","from":from,"destination":global,"enable":false,"names":["alpha","beta"]}),
        )
    };
    assert_eq!(apply(&loc, &q, args()).unwrap().len(), 2);
    assert!(
        apply(&loc, &q, args())
            .unwrap()
            .iter()
            .all(|line| line.contains("跳过"))
    );
    let recycle = catalog::list(&loc, &q).unwrap();
    let restore = || action(json!({"type":"restore","ids":[recycle.trash[0].id]}));
    assert!(apply(&loc, &q, restore()).unwrap()[0].contains("跳过"));
    fs::rename(global.join("alpha"), tmp.path().join("existing")).unwrap();
    assert!(apply(&loc, &q, restore()).unwrap()[0].contains("已恢复"));
    assert!(catalog::list(&loc, &q).unwrap().trash.is_empty());
}
#[test]
fn inline_delete_restore_preserves_independent_profile_changes() {
    let (_tmp, loc, q) = setup(Provider::ICode);
    let path = loc.chrys.join("agents/Code.yaml");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path,"name: Code # 注释\nskills:\n  paths: [extras]\n  inline:\n    - name: sample\n      description: one\n      instructions: hello\n").unwrap();
    skill(&q.projects[0].join("extras/category/nested"), "nested");
    let c = catalog::list(&loc, &q).unwrap();
    assert_eq!(c.profile.as_deref(), Some("Code.yaml"));
    assert_eq!(c.entries.len(), 2);
    let item = c.entries.iter().find(|e| e.kind == Kind::Inline).unwrap();
    assert!(delete(&loc, &q, item).contains("已移入"));
    check_recycled_description(&loc, &q, item);
    let text = fs::read_to_string(&path).unwrap() + "other: retained\n";
    fs::write(&path, text).unwrap();
    let trash = catalog::list(&loc, &q).unwrap().trash;
    apply(
        &loc,
        &q,
        action(json!({"type":"restore","ids":[trash[0].id]})),
    )
    .unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("other: retained") && text.contains("# 注释"));
    assert_eq!(
        profiles::read(&path).unwrap()["skills"]["inline"][0]["instructions"],
        "hello"
    );
}
#[test]
fn link_recovery_keeps_the_original_target_and_sibling_intact() {
    let (tmp, loc, q) = setup(Provider::CodeAgent);
    let target = tmp.path().join("outside");
    skill(&target, "linked");
    let root = loc.home.join(".cac/skills");
    fs::create_dir_all(&root).unwrap();
    let link = root.join("linked");
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap()
            .status
            .success()
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let item = catalog::list(&loc, &q).unwrap().entries.remove(0);
    assert!(item.is_link);
    assert!(delete(&loc, &q, &item).contains("已移入"));
    check_recycled_description(&loc, &q, &item);
    assert!(target.join("SKILL.md").exists() && !present(&link).unwrap());
    let trash = catalog::list(&loc, &q).unwrap().trash;
    let out = apply(
        &loc,
        &q,
        action(json!({"type":"restore","ids":[trash[0].id]})),
    )
    .unwrap();
    assert!(out[0].contains("已恢复"), "{out:?}");
    assert_eq!(link.canonicalize().unwrap(), target.canonicalize().unwrap());
}

#[test]
fn usage_requires_exact_skill_path_and_source_activation_is_explicit() {
    let (tmp, loc, q) = setup(Provider::ICode);
    let profile = loc.chrys.join("agents/Code.yaml");
    fs::create_dir_all(profile.parent().unwrap()).unwrap();
    fs::write(
        &profile,
        "name: Code\nskills:\n  auto_load_user_agents_skills: false\n",
    )
    .unwrap();
    let from = tmp.path().join("sample");
    skill(&from, "sample");
    let dest = loc.home.join(".agents/skills");
    let args = |enable| {
        action(
            json!({"type":"import","from":from,"destination":dest,"names":["sample"],"enable":enable}),
        )
    };
    apply(&loc, &q, args(false)).unwrap();
    assert!(profiles::read(&profile).unwrap()["skills"]["paths"].is_null());
    let entry = catalog::list(&loc, &q).unwrap().entries.remove(0);
    delete(&loc, &q, &entry);
    apply(&loc, &q, args(true)).unwrap();
    assert!(
        catalog::list(&loc, &q)
            .unwrap()
            .sources
            .iter()
            .any(|s| s.path == dest && s.enabled == Some(true))
    );
    let ca = Query {
        provider: Provider::CodeAgent,
        ..q
    };
    fs::create_dir_all(loc.home.join(".cac")).unwrap();
    fs::write(
        loc.home.join(".cac/skill-usage.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"type":"active","name":"sample"}),
            json!({"type":"active","skillPath":from})
        ),
    )
    .unwrap();
    assert!(
        catalog::list(&loc, &ca).unwrap().entries[0]
            .usage_count
            .is_none()
    );
    fs::write(
        loc.home.join(".cac/skill-usage.jsonl"),
        json!({"type":"active","skillPath":dest.join("sample")}).to_string(),
    )
    .unwrap();
    assert_eq!(
        catalog::list(&loc, &ca).unwrap().entries[0].usage_count,
        Some(1)
    );
}
#[test]
fn changed_skill_and_manufactured_paths_are_rejected() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let path = loc.home.join(".cac/skills/one");
    skill(&path, "one");
    let item = catalog::list(&loc, &q).unwrap().entries.remove(0);
    fs::write(path.join("SKILL.md"), "changed").unwrap();
    assert!(delete(&loc, &q, &item).contains("已变化"));
    let forged = Entry {
        path: loc.home.clone(),
        ..item
    };
    assert!(delete(&loc, &q, &forged).contains("已变化"));
    assert!(path.is_dir());
}
