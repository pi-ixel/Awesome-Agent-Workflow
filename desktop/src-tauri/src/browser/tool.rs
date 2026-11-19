use serde_json::{Map, Value, json};

#[derive(Clone, Copy)]
enum FieldKind {
    String,
    Number,
    Boolean,
}

struct Field {
    name: &'static str,
    kind: FieldKind,
    required: bool,
}

const fn string(name: &'static str, required: bool) -> Field {
    Field {
        name,
        kind: FieldKind::String,
        required,
    }
}
const fn number(name: &'static str) -> Field {
    Field {
        name,
        kind: FieldKind::Number,
        required: false,
    }
}
const fn boolean(name: &'static str, required: bool) -> Field {
    Field {
        name,
        kind: FieldKind::Boolean,
        required,
    }
}

fn fields(name: &str) -> Option<&'static [Field]> {
    const TAB: &[Field] = &[string("tabId", true)];
    const NONE: &[Field] = &[];
    const OPEN: &[Field] = &[string("url", false)];
    const NAVIGATE: &[Field] = &[string("tabId", true), string("url", true)];
    const CLICK: &[Field] = &[string("tabId", true), string("selector", true)];
    const FILL: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("value", true),
    ];
    const SCROLL: &[Field] = &[string("tabId", true), number("deltaX"), number("deltaY")];
    const PRESS: &[Field] = &[string("tabId", true), string("key", true)];
    const SUBMIT: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("approvalId", false),
    ];
    const VISIBILITY: &[Field] = &[boolean("visible", true)];
    const SCRIPT: &[Field] = &[
        string("tabId", true),
        string("script", true),
        string("approvalId", false),
    ];
    const UPLOAD: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("path", true),
        string("approvalId", false),
    ];
    const DIALOG: &[Field] = &[
        string("tabId", true),
        string("dialogId", true),
        boolean("accept", true),
        string("promptText", false),
    ];
    const WAIT: &[Field] = &[
        string("tabId", true),
        string("selector", false),
        number("timeoutMs"),
    ];
    Some(match name {
        "browser_open" => OPEN,
        "browser_request_control" => TAB,
        "browser_handoff" | "browser_snapshot" | "browser_screenshot" | "browser_diagnostics" => {
            TAB
        }
        "browser_list_tabs" | "browser_dialogs" | "browser_capabilities" => NONE,
        "browser_handle_dialog" => DIALOG,
        "browser_wait" => WAIT,
        "browser_locate" => CLICK,
        "browser_navigate" => NAVIGATE,
        "browser_select_tab" | "browser_close_tab" | "browser_back" | "browser_forward"
        | "browser_reload" | "browser_stop" => TAB,
        "browser_click" => CLICK,
        "browser_fill" => FILL,
        "browser_scroll" => SCROLL,
        "browser_press" => PRESS,
        "browser_submit" => SUBMIT,
        "browser_set_visibility" => VISIBILITY,
        "browser_execute_script" => SCRIPT,
        "browser_upload" => UPLOAD,
        _ => return None,
    })
}

pub fn validate_tool_arguments(name: &str, arguments: &Value) -> Result<(), String> {
    let fields = fields(name).ok_or("TOOL_NOT_SUPPORTED")?;
    let object = arguments.as_object().ok_or("INVALID_ARGUMENT")?;
    for key in object.keys() {
        if !fields.iter().any(|field| field.name == key) {
            return Err("INVALID_ARGUMENT".into());
        }
    }
    for field in fields {
        let value = object.get(field.name);
        if field.required && value.is_none() {
            return Err("INVALID_ARGUMENT".into());
        }
        let Some(value) = value else { continue };
        let valid = match field.kind {
            FieldKind::String => value.as_str().is_some_and(|text| {
                (field.name == "value" || !text.is_empty()) && text.len() <= 16_384
            }),
            FieldKind::Number => value
                .as_f64()
                .is_some_and(|number| number.is_finite() && number.abs() <= 1_000_000.0),
            FieldKind::Boolean => value.is_boolean(),
        };
        if !valid {
            return Err("INVALID_ARGUMENT".into());
        }
    }
    Ok(())
}

const PUBLISHED_TOOLS: &[&str] = &[
    "browser_open",
    "browser_request_control",
    "browser_handoff",
    "browser_list_tabs",
    "browser_dialogs",
    "browser_handle_dialog",
    "browser_snapshot",
    "browser_navigate",
    "browser_click",
    "browser_fill",
    "browser_scroll",
    "browser_press",
    "browser_submit",
    "browser_screenshot",
    "browser_set_visibility",
    "browser_execute_script",
    "browser_upload",
    "browser_diagnostics",
    "browser_capabilities",
    "browser_select_tab",
    "browser_close_tab",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_wait",
    "browser_locate",
];

fn description(name: &str) -> &'static str {
    match name {
        "browser_capabilities" => "读取当前实例有效工具、限制和恢复文档",
        "browser_select_tab" => "选择当前会话后续操作的标签",
        "browser_close_tab" => "关闭当前会话的指定标签",
        "browser_back" => "后退到上一页",
        "browser_forward" => "前进到下一页",
        "browser_reload" => "刷新当前页面",
        "browser_stop" => "停止当前页面加载",
        "browser_wait" => "在有界时间内等待元素或固定时长",
        "browser_locate" => "严格定位唯一且可操作的页面元素",
        _ => "执行 AAW 内嵌浏览器契约动作",
    }
}

pub fn tool_definitions() -> Value {
    let tools = PUBLISHED_TOOLS
        .iter()
        .map(|name| {
            let mut properties = Map::new();
            let mut required = Vec::new();
            for field in fields(name).unwrap_or(&[]) {
                let kind = match field.kind {
                    FieldKind::String => "string",
                    FieldKind::Number => "number",
                    FieldKind::Boolean => "boolean",
                };
                properties.insert(field.name.into(), json!({"type":kind}));
                if field.required {
                    required.push(json!(field.name));
                }
            }
            json!({"name":name,"description":description(name),"inputSchema":{
                "type":"object","properties":properties,"required":required,"additionalProperties":false
            }})
        })
        .collect::<Vec<_>>();
    json!({"tools":tools})
}
