use super::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn parsed<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn profile() -> native::Profile {
    parsed(json!({ "id": "code-id", "name": "Code" }))
}

fn revision_of(snapshot: impl Serialize) -> String {
    serde_json::to_value(snapshot).unwrap()["revision"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn native_edit_preserves_other_yaml_sections_and_refuses_a_stale_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Code.yaml");
    let original = "# user profile\nname: Code\nid: code-id\ntools:\n  mcp:\n    - name: local\n      transport: stdio\n      command: local-mcp\n      enable: false\n      env: {API_KEY: retained-in-native-source}\n      custom_option: kept\n  web_fetch: true\n# Skills belong to the native profile\nskills:\n  paths: [project-skills]\n";
    fs::write(&path, original).unwrap();
    let snapshot = native::read_snapshot(root.path(), &profile())
        .unwrap()
        .unwrap();
    let display = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(display["entries"][0]["enabled"], false);
    assert_eq!(display["entries"][0]["secretKeys"], json!(["API_KEY"]));
    assert!(!display.to_string().contains("retained-in-native-source"));
    let expected = revision_of(snapshot);
    native::change(
        root.path(),
        profile(),
        &expected,
        Change::Toggle {
            name: "local".into(),
            enabled: true,
        },
    )
    .unwrap();
    let written = fs::read_to_string(&path).unwrap();
    let yaml: serde_yaml::Value = serde_yaml::from_str(&written).unwrap();
    assert!(
        written
            .contains("# Skills belong to the native profile\nskills:\n  paths: [project-skills]")
    );
    assert_eq!(
        yaml["tools"]["mcp"][0]["custom_option"].as_str(),
        Some("kept")
    );
    assert_eq!(
        yaml["tools"]["mcp"][0]["env"]["API_KEY"].as_str(),
        Some("retained-in-native-source")
    );
    assert_eq!(yaml["tools"]["web_fetch"].as_bool(), Some(true));
    assert_eq!(
        native::change(
            root.path(),
            profile(),
            &expected,
            Change::Remove {
                name: "local".into()
            }
        )
        .unwrap_err(),
        CHANGED
    );
    assert_eq!(fs::read_to_string(path).unwrap(), written);
}

#[test]
fn builtin_without_a_local_profile_is_absent_and_cannot_be_written() {
    let root = tempfile::tempdir().unwrap();
    assert!(native::read_local(root.path(), "Code").unwrap().is_none());
    assert_eq!(
        native::change(
            root.path(),
            profile(),
            "stale-version",
            Change::Remove {
                name: "local".into()
            }
        )
        .unwrap_err(),
        CHANGED
    );
    assert!(!root.path().join("Code.yaml").exists());
}

#[test]
fn local_lookup_resolves_profiles_by_id_and_name_and_prefers_canonical_yaml() {
    let root = tempfile::tempdir().unwrap();
    let show = |selector| {
        serde_json::to_value(native::read_local(root.path(), selector).unwrap()).unwrap()
    };
    let code = "name: Code\ntools:\n  mcp:\n    - {name: canonical, transport: stdio}\n";
    let alias = "name: Code\nid: alias-id\ntools:\n  mcp:\n    - {name: alias, transport: stdio}\n";
    fs::write(root.path().join("old-code.yml"), alias).unwrap();
    fs::write(root.path().join("Code.yaml"), code).unwrap();
    fs::write(
        root.path().join(".ignored.yml"),
        "name: Hidden\nid: hidden-id",
    )
    .unwrap();
    assert_eq!(show("Code")["snapshot"]["entries"][0]["name"], "canonical");
    assert_eq!(show("b011c0de0001")["profile"]["name"], "Code");
    assert_eq!(show("alias-id"), Value::Null);
    assert_eq!(show("hidden-id"), Value::Null);
    let legacy_file = root.path().join("another-name.yml");
    fs::write(
        &legacy_file,
        "name: Legacy\nid: legacy-id\ntools:\n  mcp:\n    - {name: test, transport: stdio}\n",
    )
    .unwrap();
    let read = show("legacy-id");
    assert_eq!(read["profile"]["name"], "Legacy");
    native::change(
        root.path(),
        parsed(read["profile"].clone()),
        read["snapshot"]["revision"].as_str().unwrap(),
        Change::Remove {
            name: "test".into(),
        },
    )
    .unwrap();
    assert!(legacy_file.exists());
    assert_eq!(show("Legacy")["snapshot"]["entries"], json!([]));
}

#[test]
fn session_profile_uses_saved_id_then_legacy_name_and_rejects_path_components() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("0123456789ab");
    fs::create_dir(&folder).unwrap();
    let session = "01234567-89ab-cdef-0123-456789abcdef";
    let path = folder.join("session.json");
    fs::write(
        &path,
        r#"{"meta":{"agent_profile_id":"stable","agent_profile":"Previous"},"state":[1,2]}"#,
    )
    .unwrap();
    assert_eq!(
        native::session_profile(root.path(), session)
            .unwrap()
            .as_deref(),
        Some("stable")
    );
    fs::write(
        &path,
        r#"{"meta":{"agent_profile_id":"","agent_profile":"Previous"},"state":[]}"#,
    )
    .unwrap();
    assert_eq!(
        native::session_profile(root.path(), session)
            .unwrap()
            .as_deref(),
        Some("Previous")
    );
    assert_eq!(
        native::session_profile(root.path(), "../0123456789ab").unwrap(),
        None
    );
}

#[test]
fn session_profile_uses_the_effective_recovery_envelope() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("0123456789ab");
    fs::create_dir(&folder).unwrap();
    let main = folder.join("session.json");
    let recovery = folder.join("session.recovery.json");
    let id = "01234567-89ab-cdef-0123-456789abcdef";
    let newer = r#"{"meta":{"agent_profile_id":"new","updated_at":"2026-11-21T03:00:00+08:00"}}"#;
    fs::write(&recovery, newer).unwrap();
    assert_eq!(
        native::session_profile(root.path(), id).unwrap().as_deref(),
        Some("new")
    );
    fs::write(
        &main,
        r#"{"meta":{"agent_profile_id":"old","updated_at":"2026-11-20T18:30:00Z"}}"#,
    )
    .unwrap();
    assert_eq!(
        native::session_profile(root.path(), id).unwrap().as_deref(),
        Some("new")
    );
    fs::write(
        &main,
        r#"{"meta":{"agent_profile_id":"latest","updated_at":"2026-11-20T21:30:00Z"}}"#,
    )
    .unwrap();
    assert_eq!(
        native::session_profile(root.path(), id).unwrap().as_deref(),
        Some("latest")
    );
    fs::write(&main, "invalid").unwrap();
    assert_eq!(
        native::session_profile(root.path(), id).unwrap().as_deref(),
        Some("new")
    );
}

#[test]
fn test_config_preserves_literal_headers_for_native_false_spellings() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Code.yaml");
    for disabled in ["false", "\"false\"", "'Off'", "'no'", "'0'", "''"] {
        fs::write(&path, format!("name: Code\nid: code-id\ntools:\n  mcp:\n    - name: remote\n      transport: http\n      url: https://example.test/mcp\n      resolve_header_templates: {disabled}\n      bypass_proxy: 'yes'\n      headers:\n        X-Fixture: '{{{{AAW_NONEXISTENT_MCP_ENV}}}}'\n")).unwrap();
        let revision = revision_of(
            native::read_snapshot(root.path(), &profile())
                .unwrap()
                .unwrap(),
        );
        let test = native::test_draft(
            root.path(),
            &profile(),
            &revision,
            "remote".into(),
            parsed(json!({"name":"remote","transport":"http","secretChanges":{}})),
        )
        .unwrap();
        assert_eq!(test.headers["X-Fixture"], "{{AAW_NONEXISTENT_MCP_ENV}}");
        assert_eq!(test.options["bypass_proxy"], json!(true));
    }
}

#[test]
fn native_transport_switch_replaces_only_transport_fields_and_can_test_without_writing() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Code.yaml");
    let original = "name: Code\nid: code-id\ntools:\n  mcp:\n    - name: local\n      transport: stdio\n      command: local-mcp\n      args: [start]\n      cwd: work\n      env: {OLD_KEY: old}\n      enabled: false\n      load_prompts: true\n  web_fetch: true\n";
    fs::write(&path, original).unwrap();
    let read_revision = || {
        revision_of(
            native::read_snapshot(root.path(), &profile())
                .unwrap()
                .unwrap(),
        )
    };
    let draft = || json!({"name":"local","transport":"http","url":"https://example.test/mcp","secretChanges":{"X-Test":"draft-value"}});
    let revision = read_revision();
    let tested = native::test_draft(
        root.path(),
        &profile(),
        &revision,
        "local".into(),
        parsed(draft()),
    )
    .unwrap();
    assert_eq!(tested.headers["X-Test"], "draft-value");
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let save = |draft| parsed(json!({"kind":"save","previousName":"local","draft":draft}));
    native::change(root.path(), profile(), &revision, save(draft())).unwrap();
    let read_document = || -> serde_yaml::Value {
        serde_yaml::from_str(&fs::read_to_string(&path).unwrap()).unwrap()
    };
    let data = read_document();
    let entry = &data["tools"]["mcp"][0];
    for key in ["command", "args", "cwd", "env"] {
        assert!(entry.get(key).is_none(), "{key}");
    }
    assert_eq!(entry["enabled"].as_bool(), Some(false));
    assert_eq!(entry["load_prompts"].as_bool(), Some(true));
    assert_eq!(data["tools"]["web_fetch"].as_bool(), Some(true));
    let stdio = || {
        save(json!({"name":"local","transport":"stdio","command":"next-mcp","secretChanges":{}}))
    };
    assert_eq!(
        native::change(root.path(), profile(), &revision, stdio()).unwrap_err(),
        CHANGED
    );
    native::change(root.path(), profile(), &read_revision(), stdio()).unwrap();
    let data = read_document();
    let entry = &data["tools"]["mcp"][0];
    assert_eq!(entry["command"].as_str(), Some("next-mcp"));
    assert!(entry.get("url").is_none());
    assert!(entry.get("headers").is_none());
    assert_eq!(entry["enabled"].as_bool(), Some(false));
}

#[test]
fn batch_preview_and_commit_skip_duplicates_and_reject_stale_revisions() {
    let root = tempfile::tempdir().unwrap();
    let definitions = || {
        parsed(json!([
            {"name":"one","transport":"http","url":"https://example.test/mcp","headers":[]},
            {"name":"one","transport":"http","url":"https://example.test/duplicate","headers":[]},
            {"name":"two","transport":"http","url":"https://example.test/mcp","headers":[]}
        ]))
    };
    let preview =
        || managed::preview_install(root.path(), "chrys".into(), definitions(), &[]).unwrap();
    let stale = preview();
    let preview = preview();
    let preview_wire = serde_json::to_value(&preview).unwrap();
    assert_eq!(preview_wire["accepted"], json!(["one", "two"]));
    assert_eq!(preview_wire["skipped"][0]["name"], "one");
    assert_eq!(
        serde_json::to_value(managed::snapshot(root.path(), "chrys").unwrap()).unwrap()["entries"],
        json!([])
    );
    let result =
        serde_json::to_value(managed::commit_install(root.path(), preview, &[]).unwrap()).unwrap();
    assert_eq!(result["applied"], json!(["one", "two"]));
    assert_eq!(result["skipped"][0]["name"], "one");
    assert!(
        managed::commit_install(root.path(), stale, &[])
            .err()
            .unwrap()
            .contains("重新预览")
    );
    assert_eq!(
        serde_json::to_value(managed::snapshot(root.path(), "chrys").unwrap()).unwrap()["entries"]
            [0]["url"],
        "https://example.test/mcp"
    );
}

#[test]
fn only_global_entries_are_visible_and_legacy_projects_stay_inactive() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("configuration");
    fs::create_dir(&config).unwrap();
    let store = config.join("mcp-servers.json");
    let old = json!({
        "version": 1,
        "entries": [
            {"agentId":"chrys","project":null,"enabled":true,"name":"existing","transport":"http","url":"https://example.test/global","headers":[]},
            {"agentId":"chrys","project":"D:/example","enabled":false,"name":"existing","transport":"http","url":"https://example.test/project","headers":[]},
            {"agentId":"chrys","project":"D:/example","enabled":true,"name":"service","transport":"http","url":"https://example.test/project-only","headers":[]}
        ]
    });
    fs::write(&store, serde_json::to_vec(&old).unwrap()).unwrap();
    let resolve = |agent, excluded: &[_]| {
        serde_json::to_value(managed::resolve(root.path(), agent, excluded).unwrap()).unwrap()
    };
    assert_eq!(
        resolve("chrys", &[])["servers"][0]["url"],
        "https://example.test/global"
    );
    assert_eq!(
        resolve("chrys", &[])["servers"].as_array().unwrap().len(),
        1
    );
    assert_eq!(resolve("codeagent", &[])["servers"], json!([]));
    let snapshot = serde_json::to_value(managed::snapshot(root.path(), "chrys").unwrap()).unwrap();
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 1);
    let excluded = resolve("chrys", &["existing".into()]);
    assert_eq!(excluded["servers"], json!([]));
    assert_eq!(excluded["skipped"][0]["name"], "existing");
    let plan = managed::preview_install(
        root.path(),
        "chrys".into(),
        parsed(json!([
            {"name":"service","transport":"http","url":"https://example.test/new-global","headers":[]}
        ])),
        &[],
    )
    .unwrap();
    managed::commit_install(root.path(), plan, &[]).unwrap();
    assert_eq!(
        resolve("chrys", &[])["servers"][1]["url"],
        "https://example.test/new-global"
    );
    let written: Value = serde_json::from_slice(&fs::read(&store).unwrap()).unwrap();
    assert_eq!(written["entries"][1], old["entries"][1]);
    assert_eq!(written["entries"][2], old["entries"][2]);
    assert!(written["entries"][3].get("project").is_none());
}

#[test]
fn managed_storage_rejects_embedded_credentials_and_resolves_references_at_use_time() {
    let root = tempfile::tempdir().unwrap();
    let revision = revision_of(managed::snapshot(root.path(), "chrys").unwrap());
    let add = |name, url, reference| {
        parsed(json!({
            "kind": "save", "previousName": null, "draft": {
                "name": name, "transport": "http", "url": url,
                "headers": [{ "name": "X-Api-Key", "source": "environment", "reference": reference, "prefix": "" }]
            }
        }))
    };
    for (name, url) in [
        ("aaw-browser-x", "https://host/mcp"),
        ("service", "https://host/mcp?token=secret"),
    ] {
        assert!(
            managed::change(
                root.path(),
                "chrys",
                &revision,
                add(name, url, "AAW_TEST_MISSING")
            )
            .is_err()
        );
    }
    managed::change(
        root.path(),
        "chrys",
        &revision,
        add(
            "service",
            "https://host/mcp",
            "AAW_TEST_MISSING_MCP_VARIABLE",
        ),
    )
    .unwrap();
    let state = serde_json::to_value(managed::resolve(root.path(), "chrys", &[]).unwrap()).unwrap();
    assert_eq!(state["servers"], json!([]));
    assert_eq!(state["skipped"][0]["name"], "service");
    assert_eq!(
        managed::change(
            root.path(),
            "chrys",
            &revision,
            Change::Remove {
                name: "service".into()
            }
        )
        .unwrap_err(),
        CHANGED
    );
}
