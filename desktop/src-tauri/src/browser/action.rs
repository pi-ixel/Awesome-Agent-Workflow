use serde_json::{Value, json};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Locator {
    pub strategy: String,
    pub value: String,
}

pub fn parse_locator(input: &str) -> Result<Locator, String> {
    let Some((strategy, value)) = input.split_once(':') else {
        return Ok(Locator {
            strategy: "css".into(),
            value: input.into(),
        });
    };
    if value.is_empty() || value.len() > 1000 {
        return Err("INVALID_LOCATOR".into());
    }
    if ![
        "css",
        "role",
        "text",
        "label",
        "placeholder",
        "test-id",
        "ref",
    ]
    .contains(&strategy)
    {
        return Err("INVALID_LOCATOR".into());
    }
    if strategy == "ref" && value.parse::<usize>().is_err() {
        return Err("INVALID_LOCATOR".into());
    }
    Ok(Locator {
        strategy: strategy.into(),
        value: value.into(),
    })
}

pub fn normalize_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn infer_role(tag: &str, explicit_role: Option<&str>, input_type: Option<&str>) -> String {
    if let Some(role) = explicit_role.filter(|role| !role.is_empty()) {
        return role.into();
    }
    match tag.to_ascii_lowercase().as_str() {
        "button" => "button",
        "a" => "link",
        "select" => "combobox",
        "textarea" => "textbox",
        "input" => match input_type.unwrap_or("text") {
            "checkbox" => "checkbox",
            "radio" => "radio",
            "range" => "slider",
            "submit" | "button" => "button",
            _ => "textbox",
        },
        _ => "",
    }
    .into()
}

pub fn validate_action_target(visible: bool, disabled: bool) -> Result<(), String> {
    if !visible {
        return Err("NOT_VISIBLE".into());
    }
    if disabled {
        return Err("ELEMENT_DISABLED".into());
    }
    Ok(())
}

pub fn stable_position(positions: &[(f64, f64)], tolerance: f64) -> bool {
    if positions.len() < 2 || !tolerance.is_finite() || tolerance < 0.0 {
        return false;
    }
    let first = positions[0];
    positions
        .iter()
        .skip(1)
        .all(|(x, y)| (x - first.0).abs() <= tolerance && (y - first.1).abs() <= tolerance)
}

pub fn classify_action_result(evidence: &str) -> Value {
    match evidence {
        "satisfied" => json!({"status":"completed","sideEffect":"confirmed"}),
        "executed" => json!({"status":"unconfirmed","sideEffect":"confirmed"}),
        "failed" => json!({"status":"failed","sideEffect":"none"}),
        "cancelled" => json!({"status":"cancelled","sideEffect":"unknown"}),
        _ => json!({"status":"unknown","sideEffect":"unknown"}),
    }
}

pub fn locator_query(locator: &Locator) -> Result<String, String> {
    let value = serde_json::to_string(&locator.value).map_err(|error| error.to_string())?;
    let query = match locator.strategy.as_str() {
        "css" => format!("Array.from(document.querySelectorAll({value}))"),
        "ref" => format!(
            "(window.__aawSnapshotRefs?.[{value}] ? [window.__aawSnapshotRefs[{value}]] : [])"
        ),
        "role" => format!(
            "Array.from(document.body.querySelectorAll('*')).filter(el=>{{const tag=el.tagName.toLowerCase();const type=el.getAttribute('type')||'text';const explicit=el.getAttribute('role');const implicit=tag==='button'?'button':tag==='a'?'link':tag==='select'?'combobox':tag==='textarea'?'textbox':tag==='input'?(type==='checkbox'?'checkbox':type==='radio'?'radio':type==='range'?'slider':['submit','button'].includes(type)?'button':'textbox'):'';return (explicit||implicit)==={value};}})"
        ),
        "text" => format!(
            "Array.from(document.body.querySelectorAll('*')).filter(el=>el.children.length===0&&(el.textContent||'').trim().split(/\\s+/).join(' ')==={value}.trim().split(/\\s+/).join(' '))"
        ),
        "label" => format!(
            "Array.from(document.querySelectorAll('input,select,textarea')).filter(el=>{{const labels=el.labels?Array.from(el.labels).map(label=>(label.textContent||'').trim().split(/\\s+/).join(' ')):[];return el.getAttribute('aria-label')==={value}||labels.includes({value});}})"
        ),
        "placeholder" => format!(
            "Array.from(document.querySelectorAll('[placeholder]')).filter(el=>el.getAttribute('placeholder')==={value})"
        ),
        "test-id" => format!(
            "Array.from(document.querySelectorAll('[data-testid]')).filter(el=>el.getAttribute('data-testid')==={value})"
        ),
        _ => return Err("INVALID_LOCATOR".into()),
    };
    Ok(query)
}
