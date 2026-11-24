use super::confirmation::{
    ActionFacts, ActionKind, ConfirmationLevel, ExecutionFact, ExpectationEvaluation,
    ExpectationKind, SuggestedAction, decide_confirmation, evaluate_expectation, parse_expectation,
};
use serde_json::json;

fn facts() -> ActionFacts {
    ActionFacts::default()
}

fn execution() -> ExecutionFact {
    ExecutionFact::default()
}

fn evaluation(matched: bool) -> ExpectationEvaluation {
    ExpectationEvaluation {
        matched,
        ..Default::default()
    }
}

#[test]
fn td_10_u01_absent_expectation_returns_none() {
    assert_eq!(parse_expectation(&json!({})).unwrap(), None);
}

#[test]
fn td_10_u02_parse_all_supported_conditions() {
    let cases = [
        ("urlIncludes", ExpectationKind::UrlIncludes),
        ("textIncludes", ExpectationKind::TextIncludes),
        ("selectorPresent", ExpectationKind::SelectorPresent),
        ("valueEquals", ExpectationKind::ValueEquals),
    ];
    for (key, kind) in cases {
        let parsed = parse_expectation(&json!({"expect": {key: "target"}}))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.kind, kind);
        assert_eq!(parsed.value, "target");
        assert_eq!(parsed.timeout_ms, 5000);
    }
}

#[test]
fn td_10_u03_reject_unknown_multiple_empty_and_overbudget() {
    for arguments in [
        json!({"expect": {"unknown": "x"}}),
        json!({"expect": {"urlIncludes": "a", "textIncludes": "b"}}),
        json!({"expect": {"urlIncludes": ""}}),
        json!({"expect": {"urlIncludes": "a"}, "timeoutMs": 30001}),
        json!({"expect": {"urlIncludes": 42}}),
    ] {
        assert_eq!(
            parse_expectation(&arguments).unwrap_err(),
            "INVALID_ARGUMENT"
        );
    }
}

#[test]
fn td_10_u04_budget_defaults_and_boundaries() {
    assert_eq!(
        parse_expectation(&json!({"expect": {"urlIncludes": "a"}, "timeoutMs": 1}))
            .unwrap()
            .unwrap()
            .timeout_ms,
        1
    );
    assert_eq!(
        parse_expectation(&json!({"expect": {"urlIncludes": "a"}, "timeoutMs": 30000}))
            .unwrap()
            .unwrap()
            .timeout_ms,
        30000
    );
}

#[test]
fn td_10_u05_url_match_returns_actual_url() {
    let expectation = parse_expectation(&json!({"expect": {"urlIncludes": "/result"}}))
        .unwrap()
        .unwrap();
    let mut page = facts();
    page.url = Some("https://local.test/result?q=1".into());
    let hit = evaluate_expectation(&expectation, &page);
    assert!(hit.matched);
    assert_eq!(hit.actual_url, page.url);
    let expectation = parse_expectation(&json!({"expect": {"urlIncludes": "/other"}}))
        .unwrap()
        .unwrap();
    assert!(!evaluate_expectation(&expectation, &page).matched);
}

#[test]
fn td_10_u06_text_and_value_match() {
    let text_expectation = parse_expectation(&json!({"expect": {"textIncludes": "结果"}}))
        .unwrap()
        .unwrap();
    let mut page = facts();
    page.visible_text = Some("搜索结果一".into());
    assert!(evaluate_expectation(&text_expectation, &page).matched);
    let value_expectation = parse_expectation(&json!({"expect": {"valueEquals": "abc"}}))
        .unwrap()
        .unwrap();
    page.value = Some("abc".into());
    assert!(evaluate_expectation(&value_expectation, &page).matched);
    page.value = Some("ab".into());
    assert!(!evaluate_expectation(&value_expectation, &page).matched);
}

#[test]
fn td_10_u07_selector_present_counts_matches() {
    let expectation = parse_expectation(&json!({"expect": {"selectorPresent": ".item"}}))
        .unwrap()
        .unwrap();
    let mut page = facts();
    page.match_count = Some(2);
    let result = evaluate_expectation(&expectation, &page);
    assert!(result.matched);
    assert_eq!(result.match_count, Some(2));
}

#[test]
fn td_10_u08_fill_confirmation() {
    let mut matching = facts();
    matching.value = Some("abc".into());
    matching.expected_value = Some("abc".into());
    let confirmed = decide_confirmation(ActionKind::Fill, &execution(), &matching, None);
    assert_eq!(confirmed.level, ConfirmationLevel::Confirmed);
    let mut readonly = matching.clone();
    readonly.readonly = true;
    assert_eq!(
        decide_confirmation(ActionKind::Fill, &execution(), &readonly, None).level,
        ConfirmationLevel::Unchanged
    );
}

#[test]
fn td_10_u09_click_navigation_and_no_effect() {
    let mut navigation = facts();
    navigation.navigation_committed = true;
    assert_eq!(
        decide_confirmation(ActionKind::Click, &execution(), &navigation, None).level,
        ConfirmationLevel::Confirmed
    );
    assert_eq!(
        decide_confirmation(ActionKind::Click, &execution(), &facts(), None).level,
        ConfirmationLevel::Unchanged
    );
}

#[test]
fn td_10_u10_click_with_unresolved_change_suggests_snapshot() {
    let mut changing = facts();
    changing.change_observed = true;
    let result = decide_confirmation(ActionKind::Click, &execution(), &changing, None);
    assert_eq!(result.level, ConfirmationLevel::Changed);
    assert_eq!(result.suggested_action, SuggestedAction::Snapshot);
}

#[test]
fn td_10_u11_native_validation_is_not_submit_success() {
    let mut invalid = facts();
    invalid.validation = Some("请填写必填项".into());
    let result = decide_confirmation(ActionKind::Submit, &execution(), &invalid, None);
    assert_eq!(result.level, ConfirmationLevel::Unchanged);
    assert_eq!(result.suggested_action, SuggestedAction::Relocate);
}

#[test]
fn td_10_u12_upload_is_binding_only() {
    let result = decide_confirmation(ActionKind::Upload, &execution(), &facts(), None);
    assert_eq!(result.effect_scope.as_deref(), Some("binding_only"));
    assert_eq!(result.suggested_action, SuggestedAction::Snapshot);
    assert_ne!(result.level, ConfirmationLevel::Confirmed);
}

#[test]
fn td_10_u13_timed_out_expectation_is_not_confirmed() {
    let mut timeout = evaluation(false);
    timeout.timed_out = true;
    let result = decide_confirmation(
        ActionKind::Click,
        &execution(),
        &facts(),
        Some(&timeout),
    );
    assert_ne!(result.level, ConfirmationLevel::Confirmed);
    assert!(result.timed_out);
}

#[test]
fn td_10_u14_failures_take_priority() {
    let mut stale = execution();
    stale.error = Some("TAB_NOT_FOUND".into());
    let mut changed = facts();
    changed.change_observed = true;
    assert_eq!(
        decide_confirmation(ActionKind::Click, &stale, &changed, None).level,
        ConfirmationLevel::Failed
    );
}

#[test]
fn td_10_u15_unobserved_facts_degrade_to_snapshot() {
    let mut unobserved = facts();
    unobserved.unobserved = true;
    let result = decide_confirmation(ActionKind::Click, &execution(), &unobserved, None);
    assert_eq!(result.level, ConfirmationLevel::Changed);
    assert_eq!(result.suggested_action, SuggestedAction::Snapshot);
    assert!(result.unobserved);
}
