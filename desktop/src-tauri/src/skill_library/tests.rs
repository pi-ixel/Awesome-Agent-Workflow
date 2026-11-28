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

#[test]
fn listing_does_not_read_usage_logs_or_serialize_usage_statistics() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    skill(&loc.home.join(".cac/skills/sample"), "sample");
    fs::create_dir_all(loc.home.join(".cac/skill-usage.jsonl")).unwrap();
    let data = catalog::list(&loc, &q).unwrap();
    assert!(data.warnings.is_empty());
    assert_eq!(data.entries.len(), 1);
    assert!(data.entries[0].preview.is_empty());
    assert!(!data.entries[0].revision.is_empty());
    assert!(
        serde_json::to_value(data).unwrap()["entries"][0]
            .get("usageCount")
            .is_none()
    );
}

#[test]
fn permanent_removal_only_reads_the_selected_skill_and_checks_its_revision() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills");
    for i in 0..20 {
        skill(&root.join(format!("skill-{i}")), &format!("skill-{i}"));
    }
    let data = catalog::list(&loc, &q).unwrap();
    let entry = data.entries.iter().find(|e| e.name == "skill-0").unwrap();
    catalog::PREVIEW_READS.with(|reads| reads.borrow_mut().clear());
    let action = serde_json::from_value(json!({"type":"deletePermanent","item":entry})).unwrap();
    let results = changes::remove_selected(&loc, &q, action).unwrap();
    assert!(results[0].ok);
    assert!(!entry.path.exists());
    catalog::PREVIEW_READS.with(|reads| {
        let reads = reads.borrow();
        assert!(!reads.is_empty());
        assert!(reads.len() <= 2);
        assert!(reads.iter().all(|path| path == &entry.path));
    });
    let stale = &data.entries[1];
    fs::write(stale.path.join("SKILL.md"), "changed").unwrap();
    let action = serde_json::from_value(json!({"type":"deletePermanent","item":stale})).unwrap();
    assert!(!changes::remove_selected(&loc, &q, action).unwrap()[0].ok);
    assert!(stale.path.exists());
    catalog::PREVIEW_READS.with(|reads| reads.borrow_mut().clear());
    let action = serde_json::from_value(json!({"type":"deletePermanent","item":{
        "path":root.join("../../.."), "name":"forged", "revision":"forged"
    }}))
    .unwrap();
    assert!(!changes::remove_selected(&loc, &q, action).unwrap()[0].ok);
    catalog::PREVIEW_READS.with(|reads| assert!(reads.borrow().is_empty()));
    assert!(root.is_dir());
}

#[test]
fn targeted_purge_reports_partial_failure_and_unknown_versions_retry() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills");
    skill(&root.join("sample"), "sample");
    let entry = catalog::list(&loc, &q).unwrap().entries.remove(0);
    delete(&loc, &q, &entry);
    let id = catalog::list(&loc, &q).unwrap().trash[0].id.clone();
    let action = serde_json::from_value(json!({"type":"purge","ids":[id,"../forged"]})).unwrap();
    let results = changes::remove_selected(&loc, &q, action).unwrap();
    assert!(results[0].ok);
    assert!(!results[1].ok);
    for _ in 0..2 {
        skill(&root.join("mr-review"), "mr-review");
        assert!(cleanup::run(&loc, "codeagent", None).unwrap()[0].ok);
    }
}

#[test]
fn builtin_cleanup_is_exact_global_only_and_does_not_stage_or_copy() {
    let (tmp, loc, q) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills");
    let package = loc.home.join(".cac/plugins/cache/local/tools/1/skills");
    for name in cleanup::NAMES {
        skill(&root.join(name), "display-name");
        skill(&package.join(name), name);
    }
    let shared = loc.home.join(".agents/skills/mr-review");
    let claude = loc.home.join(".claude/skills/mr-review");
    let project = q.projects[0].join(".cac/skills/mr-review");
    let icode = loc.chrys.join("skills/mr-review");
    for path in [
        &shared,
        &claude,
        &project,
        &icode,
        &root.join("mr-review-copy"),
    ] {
        skill(path, "mr-review");
    }
    let outside = tmp.path().join("outside");
    skill(&outside, "outside");
    link_directory(&root.join("mr-review/templates"), &outside);
    let results = cleanup::run(&loc, "codeagent", Some("1")).unwrap();
    assert_eq!(results.len(), 42);
    assert!(results.iter().all(|r| r.ok));
    for path in [
        &shared,
        &claude,
        &project,
        &icode,
        &outside,
        &root.join("mr-review-copy"),
    ] {
        assert!(path.join("SKILL.md").exists());
    }
    assert!(!loc.trash.exists());
}

#[test]
fn builtin_cleanup_retries_partial_failures_and_remembers_only_completed_versions() {
    let (_tmp, loc, _q) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills");
    skill(&root.join("auto-verify"), "auto-verify");
    fs::write(root.join("mr-review"), "blocked").unwrap();
    let first = cleanup::run(&loc, "codeagent", Some("1")).unwrap();
    assert!(first.iter().any(|r| r.ok));
    assert!(first.iter().any(|r| !r.ok));
    fs::remove_file(root.join("mr-review")).unwrap();
    // 失败重试也能清理缺少 SKILL.md 的残留目录。
    fs::create_dir(root.join("mr-review")).unwrap();
    let second = cleanup::run(&loc, "codeagent", Some("1")).unwrap();
    assert!(second.iter().all(|r| r.ok));
    skill(&root.join("mr-review"), "mr-review");
    assert!(
        cleanup::run(&loc, "codeagent", Some("1"))
            .unwrap()
            .is_empty()
    );
    assert!(root.join("mr-review").exists());
    assert!(cleanup::run(&loc, "codeagent", Some("2")).unwrap()[0].ok);
    skill(&root.join("mr-review"), "mr-review");
    assert!(cleanup::run(&loc, "another-codeagent", Some("2")).unwrap()[0].ok);
}

#[test]
fn builtin_cleanup_rejects_linked_sources_and_unlinks_only_selected_skill_links() {
    let (tmp, loc, _q) = setup(Provider::CodeAgent);
    let shared = tmp.path().join("shared");
    skill(&shared.join("mr-review"), "mr-review");
    fs::create_dir_all(loc.home.join(".cac")).unwrap();
    let source = loc.home.join(".cac/skills");
    link_directory(&source, &shared);
    assert!(
        cleanup::run(&loc, "codeagent", Some("1"))
            .unwrap()
            .iter()
            .any(|r| !r.ok)
    );
    assert!(shared.join("mr-review/SKILL.md").exists());
    changes::remove_tree(&source).unwrap();
    fs::create_dir(&source).unwrap();
    link_directory(&source.join("mr-review"), &shared.join("mr-review"));
    assert!(cleanup::run(&loc, "codeagent", Some("1")).unwrap()[0].ok);
    assert!(!source.join("mr-review").exists());
    assert!(shared.join("mr-review/SKILL.md").exists());
}

#[test]
fn toggle_returns_only_the_affected_entry_and_rejects_a_stale_revision() {
    let (_tmp, loc, query) = setup(Provider::CodeAgent);
    let source = loc.home.join(".cac/skills");
    let path = source.join("toggle");
    skill(&path, "toggle");
    skill(&source.join("other"), "other");
    let entry = catalog::list(&loc, &query)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.name == "toggle")
        .unwrap();
    let request = |revision: &str| {
        serde_json::from_value(json!({
            "type":"disable","name":entry.name,"path":entry.path,"realPath":entry.real_path,
            "source":entry.source,"revision":revision
        }))
        .unwrap()
    };
    assert!(changes::toggle(&loc, &query, request("stale")).is_err());
    let disabled =
        serde_json::to_value(changes::toggle(&loc, &query, request(&entry.revision)).unwrap())
            .unwrap();
    assert!(!path.exists());
    assert!(source.join("other/SKILL.md").is_file());
    assert_eq!(disabled["stopped"]["name"], "toggle");
    let enable =
        serde_json::from_value(json!({"type":"enable","id":disabled["stopped"]["id"]})).unwrap();
    let enabled = serde_json::to_value(changes::toggle(&loc, &query, enable).unwrap()).unwrap();
    assert_eq!(enabled["entry"]["name"], "toggle");
    assert!(path.is_dir());
}

#[cfg(any(windows, unix))]
fn link_directory(link: &Path, target: &Path) {
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
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(any(windows, unix))]
#[test]
fn skill_detail_reads_selected_directory_and_exact_text() {
    use files::{Request, browse};

    let (_tmp, loc, query) = setup(Provider::CodeAgent);
    let root = query.projects[0].join(".cac/skills/sample");
    skill(&root, "sample");
    let templates = root.join("templates");
    fs::create_dir(&templates).unwrap();
    let text = "# 模板\r\n\r\n正文\r\n";
    fs::write(templates.join("模板.md"), text).unwrap();
    let catalog = catalog::list(&loc, &query).unwrap();
    let entry = catalog
        .entries
        .iter()
        .find(|item| item.path == root)
        .unwrap();
    let selection = serde_json::from_value(serde_json::to_value(entry).unwrap()).unwrap();
    let response = browse(
        &loc,
        &query,
        &selection,
        Request::Directory {
            path: "templates".into(),
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({
            "type": "directory",
            "entries": [{ "name": "模板.md", "kind": "file", "bytes": text.len() }],
            "truncated": false
        })
    );
    let response = browse(
        &loc,
        &query,
        &selection,
        Request::Read {
            path: "templates/模板.md".into(),
        },
    )
    .unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(response["type"], "text");
    assert_eq!(response["text"], text);
    assert!(response["modifiedAt"].is_u64());
}

#[test]
fn skill_detail_rejects_outside_paths_stale_roots_and_unreadable_content() {
    use files::{Request, browse};

    let (tmp, loc, query) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills/sample");
    skill(&root, "sample");
    let outside = tmp.path().join("outside.txt");
    fs::write(&outside, "外部文档").unwrap();
    fs::write(root.join("binary"), [0, 1, 2]).unwrap();
    fs::write(root.join("oversize.md"), vec![b'x'; 256 * 1024 + 1]).unwrap();
    let catalog = catalog::list(&loc, &query).unwrap();
    let entry = catalog
        .entries
        .iter()
        .find(|item| item.path == root)
        .unwrap();
    let identity = serde_json::to_value(entry).unwrap();
    let selection = serde_json::from_value(identity.clone()).unwrap();

    for path in [
        outside.clone(),
        "../outside.txt".into(),
        "SKILL.md:stream".into(),
        "binary".into(),
        "oversize.md".into(),
    ] {
        assert!(browse(&loc, &query, &selection, Request::Read { path }).is_err());
    }

    let mut changed_identity = identity;
    changed_identity["realPath"] = json!(tmp.path());
    let changed = serde_json::from_value(changed_identity).unwrap();
    assert!(
        browse(
            &loc,
            &query,
            &changed,
            Request::Read {
                path: "SKILL.md".into()
            }
        )
        .is_err()
    );

    let link = root.join("outside-link.txt");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(outside, link).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(outside, link).is_ok();
    if linked {
        let response = browse(
            &loc,
            &query,
            &selection,
            Request::Directory {
                path: PathBuf::new(),
            },
        )
        .unwrap();
        let response = serde_json::to_value(response).unwrap();
        assert!(response["entries"].as_array().unwrap().iter().any(|entry| {
            entry["name"] == "outside-link.txt" && entry["kind"] == "unavailable"
        }));
        assert!(
            browse(
                &loc,
                &query,
                &selection,
                Request::Read {
                    path: "outside-link.txt".into()
                }
            )
            .is_err()
        );
    }
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
    assert!(delete(&loc, &q, original).contains("已停用"));
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
fn recycles_only_the_selected_skill_in_a_codeagent_package() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let package = loc.home.join(".cac/plugins/cache/local/tools/1.0");
    let selected = package.join("skills/selected");
    let sibling = package.join("skills/sibling");
    skill(&selected, "selected");
    skill(&sibling, "sibling");
    let manifest = package.join("plugin.json");
    fs::write(&manifest, "{}").unwrap();
    let library = catalog::list(&loc, &q).unwrap();
    let item = library.entries.iter().find(|e| e.path == selected).unwrap();
    assert_eq!(item.kind, Kind::Package);

    assert!(delete(&loc, &q, item).contains("已停用"));
    assert!(!selected.exists());
    assert!(sibling.join("SKILL.md").is_file());
    assert!(manifest.is_file());
    let trash = catalog::list(&loc, &q).unwrap().trash;
    assert_eq!(trash[0].description, item.description);
    let restore = action(json!({"type":"restore","ids":[trash[0].id]}));
    assert!(apply(&loc, &q, restore).unwrap()[0].contains("已恢复"));
    assert!(selected.join("SKILL.md").is_file());

    let restored = catalog::list(&loc, &q).unwrap();
    let item = restored
        .entries
        .iter()
        .find(|e| e.path == selected)
        .unwrap();
    assert!(delete(&loc, &q, item).contains("已停用"));
    let trash = catalog::list(&loc, &q).unwrap().trash;
    let purge = action(json!({"type":"purge","ids":[trash[0].id]}));
    assert!(apply(&loc, &q, purge).unwrap()[0].contains("已永久删除"));
    assert!(!selected.exists());
    assert!(sibling.join("SKILL.md").is_file());
    assert!(manifest.is_file());
    assert!(catalog::list(&loc, &q).unwrap().trash.is_empty());
}

#[test]
fn reads_disabled_files_by_record_and_permanently_deletes_only_the_selected_skill() {
    use super::files::{Request, Selection, browse};

    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let root = q.projects[0].join(".agents/skills");
    let chosen = root.join("chosen");
    let sibling = root.join("sibling");
    skill(&chosen, "chosen");
    skill(&sibling, "sibling");
    let catalog = catalog::list(&loc, &q).unwrap();
    let item = catalog.entries.iter().find(|e| e.path == chosen).unwrap();
    assert!(delete(&loc, &q, item).contains("已停用"));
    let stopped = catalog::list(&loc, &q).unwrap().trash;
    let id = &stopped[0].id;
    let selection: Selection = serde_json::from_value(json!({
        "source": root, "path": chosen, "realPath": chosen, "disabledId": id
    }))
    .unwrap();
    let request = |name: &str| Request::Read { path: name.into() };
    let file = browse(&loc, &q, &selection, request("SKILL.md")).unwrap();
    assert!(
        serde_json::to_value(file).unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("chosen")
    );
    assert!(browse(&loc, &q, &selection, request("../record.json")).is_err());
    let other = Query {
        provider: Provider::ICode,
        ..q.clone()
    };
    assert!(browse(&loc, &other, &selection, request("SKILL.md")).is_err());
    assert!(
        apply(&loc, &q, action(json!({"type":"restore","ids":[id]}))).unwrap()[0]
            .contains("已恢复")
    );
    let current = catalog::list(&loc, &q).unwrap();
    let item = current.entries.iter().find(|e| e.path == chosen).unwrap();
    let destroy = action(json!({"type":"deletePermanent","item":item}));
    assert!(apply(&loc, &q, destroy).unwrap()[0].contains("已永久删除"));
    assert!(!chosen.exists());
    assert!(sibling.join("SKILL.md").is_file());
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
    assert!(delete(&loc, &q, item).contains("已停用"));
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
    #[cfg(any(windows, unix))]
    link_directory(&link, &target);
    let item = catalog::list(&loc, &q).unwrap().entries.remove(0);
    assert!(item.is_link);
    assert!(delete(&loc, &q, &item).contains("已停用"));
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
fn source_activation_is_explicit() {
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
}
#[test]
fn codeagent_catalog_exposes_short_issue_labels_and_original_details() {
    let (_tmp, loc, q) = setup(Provider::CodeAgent);
    let root = loc.home.join(".cac/skills");
    for (name, markdown) in [
        (
            "bad-yaml",
            "---\nname: bad-yaml\ndescription: words: more\n---\n",
        ),
        (
            "missing-description",
            "---\nname: missing-description\n---\n",
        ),
        ("missing-header", "# 无文件头\n"),
        ("unclosed-header", "---\nname: unclosed-header\n"),
    ] {
        let path = root.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), markdown).unwrap();
    }

    let catalog = catalog::list(&loc, &q).unwrap();
    let entry = |name: &str| catalog.entries.iter().find(|e| e.name == name).unwrap();
    assert_eq!(
        entry("bad-yaml").status_label.as_deref(),
        Some("YAML 格式错误")
    );
    assert!(entry("bad-yaml").status.contains("line 2"));
    assert_eq!(
        entry("missing-description").status_label.as_deref(),
        Some("名称或描述不完整")
    );
    assert_eq!(
        entry("missing-header").status_label.as_deref(),
        Some("缺少 YAML 文件头")
    );
    assert_eq!(
        entry("unclosed-header").status_label.as_deref(),
        Some("YAML 文件头未结束")
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
