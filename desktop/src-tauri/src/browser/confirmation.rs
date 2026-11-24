use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ActionKind {
    Fill,
    Click,
    Press,
    Scroll,
    Navigate,
    History,
    Reload,
    Stop,
    Tab,
    Submit,
    Upload,
    Script,
    Wait,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExpectationKind {
    UrlIncludes,
    TextIncludes,
    SelectorPresent,
    ValueEquals,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expectation {
    pub kind: ExpectationKind,
    pub value: String,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionFacts {
    pub url: Option<String>,
    pub title: Option<String>,
    pub navigation_committed: bool,
    pub navigation_started: bool,
    pub target_connected: Option<bool>,
    pub target_removed: bool,
    pub value: Option<String>,
    pub expected_value: Option<String>,
    pub readonly: bool,
    pub disabled: bool,
    pub focused: bool,
    pub value_changed: bool,
    pub scroll_before: Option<f64>,
    pub scroll_after: Option<f64>,
    pub download_started: bool,
    pub dialog_opened: bool,
    pub change_observed: bool,
    pub visual_only: bool,
    pub unobserved: bool,
    pub is_loading: Option<bool>,
    pub validation: Option<String>,
    pub match_count: Option<usize>,
    pub visible_text: Option<String>,
    pub active_tab_id: Option<String>,
    pub session_id: Option<String>,
    pub tab_id: Option<String>,
    pub condition_met: bool,
    pub timed_out: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFact {
    pub error: Option<String>,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectationEvaluation {
    pub matched: bool,
    pub timed_out: bool,
    pub actual_url: Option<String>,
    pub actual_text: Option<String>,
    pub actual_value: Option<String>,
    pub match_count: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfirmationLevel {
    Confirmed,
    Changed,
    Unchanged,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestedAction {
    Continue,
    Snapshot,
    Screenshot,
    Relocate,
    Retry,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub level: ConfirmationLevel,
    pub suggested_action: SuggestedAction,
    pub reason: String,
    pub effect_scope: Option<String>,
    pub timed_out: bool,
    pub unobserved: bool,
}

pub fn parse_expectation(arguments: &Value) -> Result<Option<Expectation>, String> {
    let Some(raw) = arguments.get("expect") else {
        return Ok(None);
    };
    let object = raw.as_object().ok_or("INVALID_ARGUMENT")?;
    if object.len() != 1 {
        return Err("INVALID_ARGUMENT".into());
    }
    let (name, raw_value) = object.iter().next().ok_or("INVALID_ARGUMENT")?;
    let value = raw_value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("INVALID_ARGUMENT")?;
    let kind = match name.as_str() {
        "urlIncludes" => ExpectationKind::UrlIncludes,
        "textIncludes" => ExpectationKind::TextIncludes,
        "selectorPresent" => ExpectationKind::SelectorPresent,
        "valueEquals" => ExpectationKind::ValueEquals,
        _ => return Err("INVALID_ARGUMENT".into()),
    };
    let timeout_ms = arguments
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(5000);
    if timeout_ms == 0 || timeout_ms > 30000 {
        return Err("INVALID_ARGUMENT".into());
    }
    Ok(Some(Expectation {
        kind,
        value: value.into(),
        timeout_ms,
    }))
}

pub fn evaluate_expectation(
    expectation: &Expectation,
    facts: &ActionFacts,
) -> ExpectationEvaluation {
    let matched = match expectation.kind {
        ExpectationKind::UrlIncludes => facts
            .url
            .as_ref()
            .is_some_and(|url| url.contains(&expectation.value)),
        ExpectationKind::TextIncludes => facts
            .visible_text
            .as_ref()
            .is_some_and(|text| text.contains(&expectation.value)),
        ExpectationKind::SelectorPresent => facts.match_count.unwrap_or(0) > 0,
        ExpectationKind::ValueEquals => facts.value.as_ref() == Some(&expectation.value),
    };
    ExpectationEvaluation {
        matched,
        timed_out: false,
        actual_url: facts.url.clone(),
        actual_text: facts.visible_text.clone(),
        actual_value: facts.value.clone(),
        match_count: facts.match_count,
    }
}

pub fn decide_confirmation(
    action: ActionKind,
    execution: &ExecutionFact,
    facts: &ActionFacts,
    expectation: Option<&ExpectationEvaluation>,
) -> Confirmation {
    let mut result = Confirmation {
        level: ConfirmationLevel::Failed,
        suggested_action: SuggestedAction::Retry,
        reason: String::new(),
        effect_scope: None,
        timed_out: false,
        unobserved: facts.unobserved,
    };
    if execution.error.as_deref() == Some("ELEMENT_READONLY") {
        result.level = ConfirmationLevel::Unchanged;
        result.suggested_action = SuggestedAction::Relocate;
        result.reason = "目标只读，填值未生效".into();
        return result;
    }
    if execution.error.is_some() || execution.cancelled {
        result.reason = execution
            .error
            .clone()
            .unwrap_or_else(|| "CANCELLED".into());
        return result;
    }
    if facts.unobserved && !facts.dialog_opened && !facts.download_started {
        result.level = ConfirmationLevel::Changed;
        result.suggested_action = SuggestedAction::Snapshot;
        result.reason = "必要事实未观察".into();
        return result;
    }
    if let Some(evaluation) = expectation {
        if evaluation.matched {
            result.level = ConfirmationLevel::Confirmed;
            result.suggested_action = SuggestedAction::Continue;
            result.reason = "期望条件已满足".into();
        } else if evaluation.timed_out {
            result.level = ConfirmationLevel::Changed;
            result.suggested_action = SuggestedAction::Snapshot;
            result.timed_out = true;
            result.reason = "期望条件等待超时".into();
        } else if facts.change_observed || facts.navigation_committed {
            result.level = ConfirmationLevel::Changed;
            result.suggested_action = SuggestedAction::Snapshot;
            result.reason = "页面有变化但期望未满足".into();
        } else {
            result.level = ConfirmationLevel::Unchanged;
            result.suggested_action = SuggestedAction::Relocate;
            result.reason = "期望条件未满足".into();
        }
        return result;
    }

    let objective_effect = facts.navigation_committed
        || facts.target_removed
        || facts.dialog_opened
        || facts.download_started;
    let (level, suggested_action, reason) = match action {
        ActionKind::Fill => {
            if facts.readonly
                || facts.disabled
                || (facts.expected_value.is_some() && facts.expected_value != facts.value)
            {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "填后值未生效",
                )
            } else {
                (ConfirmationLevel::Confirmed, SuggestedAction::Continue, "填后值一致")
            }
        }
        ActionKind::Click => {
            if objective_effect {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "点击产生客观效果",
                )
            } else if facts.change_observed {
                (
                    ConfirmationLevel::Changed,
                    if facts.visual_only {
                        SuggestedAction::Screenshot
                    } else {
                        SuggestedAction::Snapshot
                    },
                    "点击后有未明变化",
                )
            } else {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "点击后无效果证据",
                )
            }
        }
        ActionKind::Press => {
            if facts.condition_met || (facts.focused && facts.value_changed) {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "按键已作用于焦点元素",
                )
            } else {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "按键未产生目标效果",
                )
            }
        }
        ActionKind::Scroll => {
            if facts.scroll_before != facts.scroll_after {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "滚动位置已变化",
                )
            } else {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "已到滚动边界",
                )
            }
        }
        ActionKind::Navigate
        | ActionKind::History
        | ActionKind::Reload
        | ActionKind::Stop
        | ActionKind::Tab => {
            if facts.timed_out {
                result.timed_out = true;
                (
                    ConfirmationLevel::Changed,
                    SuggestedAction::Snapshot,
                    "提交等待超时",
                )
            } else if facts.navigation_committed || facts.condition_met {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "页面或标签事实已达成",
                )
            } else {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "页面或标签事实未达成",
                )
            }
        }
        ActionKind::Submit => {
            if facts.validation.is_some() {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "原生校验未通过",
                )
            } else if facts.navigation_committed {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "提交已产生导航效果",
                )
            } else if facts.change_observed {
                (
                    ConfirmationLevel::Changed,
                    SuggestedAction::Snapshot,
                    "提交后有未明变化",
                )
            } else {
                (
                    ConfirmationLevel::Unchanged,
                    SuggestedAction::Relocate,
                    "提交无效果证据",
                )
            }
        }
        ActionKind::Upload => {
            result.effect_scope = Some("binding_only".into());
            (
                ConfirmationLevel::Changed,
                SuggestedAction::Snapshot,
                "仅证明文件已绑定，未证明上传完成",
            )
        }
        ActionKind::Script => {
            if facts.change_observed {
                (
                    ConfirmationLevel::Changed,
                    SuggestedAction::Snapshot,
                    "脚本后有未明页面变化",
                )
            } else {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "脚本已返回表达式结果",
                )
            }
        }
        ActionKind::Wait => {
            if facts.condition_met {
                (
                    ConfirmationLevel::Confirmed,
                    SuggestedAction::Continue,
                    "等待条件已满足",
                )
            } else {
                (
                    ConfirmationLevel::Failed,
                    SuggestedAction::Retry,
                    "等待条件未满足",
                )
            }
        }
    };
    result.level = level;
    result.suggested_action = suggested_action;
    result.reason = reason.into();
    result
}
