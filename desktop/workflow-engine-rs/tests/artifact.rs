use aaw_workflow_core::{Workflow, artifact, graph::Definition, journal::Journal};
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::TcpListener,
};

#[test]
fn local_and_remote_artifacts_are_pinned_and_run_scoped() {
    let root = std::env::temp_dir().join(format!("aaw-artifact-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("design.md");
    std::fs::write(&file, "first version").unwrap();
    let mut journal = Journal::open(root.join("journal.sqlite")).unwrap();
    let definition: Definition =
        serde_json::from_str(include_str!("../definitions/aaw-dev.json")).unwrap();
    journal
        .create(
            "one",
            root.to_str().unwrap(),
            &Workflow::from_definition(
                definition.clone(),
                serde_json::json!({"requirement":"task"}),
            )
            .unwrap(),
        )
        .unwrap();
    journal
        .create(
            "two",
            root.to_str().unwrap(),
            &Workflow::from_definition(definition, serde_json::json!({"requirement":"task"}))
                .unwrap(),
        )
        .unwrap();
    let captured = artifact::capture(&root, "design.md").unwrap();
    let handle = journal
        .store_artifact("one", root.to_str().unwrap(), &captured)
        .unwrap();
    let id = handle["uri"]
        .as_str()
        .unwrap()
        .strip_prefix("workflow-artifact://")
        .unwrap();
    std::fs::write(&file, "second version").unwrap();
    let read = journal
        .read_artifact("one", root.to_str().unwrap(), id, 0, 1024)
        .unwrap();
    assert_eq!(read["text"], "first version");
    assert_eq!(read["sha256"], handle["sha256"]);
    assert!(
        journal
            .read_artifact("two", root.to_str().unwrap(), id, 0, 1024)
            .is_err()
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let _ = socket.read(&mut request);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nremote text").unwrap();
    });
    let remote = artifact::capture(&root, &format!("http://{address}/doc?secret=hide")).unwrap();
    server.join().unwrap();
    assert_eq!(remote.content, b"remote text");
    assert!(!remote.source.contains("secret"));
    let remote: Value = journal
        .store_artifact("one", root.to_str().unwrap(), &remote)
        .unwrap();
    assert_eq!(remote["size"], 11);
    drop(journal);
    std::fs::remove_dir_all(root).unwrap();
}
