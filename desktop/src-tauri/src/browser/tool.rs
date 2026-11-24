use serde_json::{Map, Value, json};

#[derive(Clone, Copy)]
enum FieldKind {
    String,
    Number,
    Boolean,
    Object,
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
const fn object(name: &'static str, required: bool) -> Field {
    Field {
        name,
        kind: FieldKind::Object,
        required,
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
    const TAB: &[Field] = &[string("tabId", true), object("expect", false), number("timeoutMs")];
    const NONE: &[Field] = &[];
    const OPEN: &[Field] = &[string("url", false), object("expect", false), number("timeoutMs")];
    const NAVIGATE: &[Field] = &[string("tabId", true), string("url", true), object("expect", false), number("timeoutMs")];
    const CLICK: &[Field] = &[string("tabId", true), string("selector", true), object("expect", false), number("timeoutMs")];
    const FILL: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("value", true),
        object("expect", false),
        number("timeoutMs"),
        object("expect", false),
    ];
    const SCROLL: &[Field] = &[string("tabId", true), number("deltaX"), number("deltaY"), object("expect", false), number("timeoutMs")];
    const PRESS: &[Field] = &[string("tabId", true), string("key", true), object("expect", false), number("timeoutMs")];
    const SUBMIT: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("approvalId", false),
        object("expect", false),
        number("timeoutMs"),
        object("expect", false),
    ];
    const VISIBILITY: &[Field] = &[boolean("visible", true)];
    const SCRIPT: &[Field] = &[
        string("tabId", true),
        string("script", true),
        string("approvalId", false),
        object("expect", false),
        number("timeoutMs"),
        object("expect", false),
    ];
    const UPLOAD: &[Field] = &[
        string("tabId", true),
        string("selector", true),
        string("path", true),
        string("approvalId", false),
        object("expect", false),
        number("timeoutMs"),
        object("expect", false),
    ];
    const DIALOG: &[Field] = &[
        string("tabId", true),
        string("dialogId", true),
        boolean("accept", true),
        string("promptText", false),
        object("expect", false),
        number("timeoutMs"),
        object("expect", false),
    ];
    const WAIT: &[Field] = &[
        string("tabId", true),
        string("selector", false),
        number("timeoutMs"),
        object("expect", false),
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
        FieldKind::Object => value.is_object(),
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
        "browser_open" => "为当前会话新建浏览器标签。没有可用任务标签、需要保留原页或并排查看时使用。同一查询链优先列出标签并在原任务标签内导航。",
        "browser_request_control" => "请求获得指定标签的 Agent 控制权",
        "browser_handoff" => "将指定标签交给用户控制",
        "browser_list_tabs" => "列出当前会话的标签与页面状态",
        "browser_dialogs" => "查看当前会话中等待处理的网页对话框",
        "browser_handle_dialog" => "确认或取消指定的网页对话框",
        "browser_snapshot" => "读取页面结构与可交互元素",
        "browser_navigate" => "在当前会话的指定标签打开目标地址。同一查询链优先复用本任务的可用标签。",
        "browser_click" => "点击指定页面元素",
        "browser_fill" => "为页面输入控件填写内容",
        "browser_scroll" => "滚动指定标签的页面视口",
        "browser_press" => "向指定标签发送按键",
        "browser_screenshot" => "截取指定标签的页面视口",
        "browser_set_visibility" => "切换浏览器面板的可见状态",
        "browser_diagnostics" => "读取指定标签的浏览器诊断信息",
        "browser_capabilities" => "读取当前实例有效工具、限制和恢复文档",
        "browser_execute_script" => {
            "执行受限页面脚本；缺少 approvalId 时创建审批并等待决策，批准后在同一调用内执行，超时返回 APPROVAL_REQUIRED，需携带同一 approvalId 重试"
        }
        "browser_submit" => {
            "提交表单；缺少 approvalId 时创建审批并等待决策，超时返回 APPROVAL_REQUIRED，需携带同一 approvalId 重试"
        }
        "browser_upload" => {
            "上传文件；缺少 approvalId 时创建审批并等待决策，超时返回 APPROVAL_REQUIRED，需携带同一 approvalId 重试"
        }
        "browser_select_tab" => "选择当前会话后续操作的标签",
        "browser_close_tab" => "关闭当前会话的指定标签",
        "browser_back" => "后退到上一页",
        "browser_forward" => "前进到下一页",
        "browser_reload" => "刷新当前页面",
        "browser_stop" => "停止当前页面加载",
        "browser_wait" => "在有界时间内等待元素或固定时长",
        "browser_locate" => "严格定位唯一且可操作的页面元素",
        _ => "",
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
                    FieldKind::Object => "object",
                };
                properties.insert(field.name.into(), json!({"type":kind}));
                if field.required {
                    required.push(json!(field.name));
                }
            }
            let read_only = matches!(*name, "browser_list_tabs" | "browser_dialogs" | "browser_snapshot"
                | "browser_screenshot" | "browser_diagnostics" | "browser_capabilities" | "browser_wait" | "browser_locate");
            json!({"name":name,"description":description(name),"annotations":{"readOnlyHint":read_only},"inputSchema":{
                "type":"object","properties":properties,"required":required,"additionalProperties":false
            }})
        })
        .collect::<Vec<_>>();
    json!({"tools":tools})
}
