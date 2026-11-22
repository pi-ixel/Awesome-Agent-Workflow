//! Agent requests are assembled from the node definition captured for this run.
//!
//! 开场白是一张工单（ADR 041）：在造什么、在哪个阶段、这一步是什么、需要的
//! 东西去哪拿、怎么交活。运行变量的内容不贴进来——Agent 用 `get_workflow_step`
//! 按名字取；同一个工具不带参数时返回这张工单本身。
use crate::{Action, graph::Node};
use serde_json::{Value, json};

/// 交结果的约定：引擎对 Agent 的唯一硬性要求。
const DELIVERY: &str = "完成本次工作后，请调用 submit_workflow_result 工具，将本次动作的实际结果对象放在 result 参数中交付。";

#[derive(Debug)]
pub struct AgentRequest {
    /// 这一步的工单（不含交结果的约定）。
    pub prompt: String,
    pub schema: Value,
    /// 节点名称（返工提示里称呼这一步）。
    pub label: String,
    /// 工作流给这次执行的提示（回退、改道时引擎写下：为什么重做、成果怎么处理、
    /// 用户意见），没有为空。
    pub note: String,
}
impl AgentRequest {
    /// 会话第一次收到这个节点的工单时发的开场白。
    pub fn workflow_prompt(&self) -> String {
        format!("{}\n\n{DELIVERY}", self.prompt)
    }
    /// 这个会话收到过这个节点的工单，这是新的一次执行（ADR 041）：只说又回到了
    /// 这一步、第几次、工作流的提示（为什么重做、用户意见），请 Agent 先查这一步
    /// 现在的工单。
    pub fn rework_prompt(&self, attempt: u32) -> String {
        let note = if self.note.is_empty() { String::new() } else { format!("{}\n", self.note) };
        format!(
            "工作流又回到了「{}」这一步，这是你在本会话里第 {attempt} 次做它。\n{note}之前的说明和材料可能已经过时：请先调用 get_workflow_step 工具查看这一步现在的工单，按里面列出的内容用同一个工具读取需要的材料，再开始做。\n{DELIVERY}",
            self.label
        )
    }
}

/// 接着做这一步的说明（ADR 040）：上一轮没正常结束（运行被停止后继续、页面
/// 重载打断了 Agent）。会话按原 id 恢复，Agent 看得到自己之前的说明和进展，
/// 不再把整段说明重发一遍。
pub const CONTINUE_PROMPT: &str = "工作流已恢复，请接着完成这一步（需要时可用 get_workflow_step 工具重新查看这一步的工单）。完成后调用 submit_workflow_result 工具，将本次动作的实际结果对象放在 result 参数中交付。";

fn text(value: &Value) -> &str {
    value.as_str().map(str::trim).unwrap_or_default()
}

/// 「标题：说明」，说明为空时只有标题。
fn titled(out: &mut String, head: &str, title: &str, description: &str) {
    if title.is_empty() {
        return;
    }
    out.push_str(&format!("【{head}】{title}"));
    if !description.is_empty() {
        out.push_str(&format!("：{description}"));
    }
    out.push('\n');
}

/// 这一步的工单（ADR 041）。
fn brief(node: &Node, action: &Action, note: &str) -> String {
    let mut out = String::new();
    let context = &action.input["__brief"];
    titled(&mut out, "工作流", text(&context["workflow"]["name"]), text(&context["workflow"]["description"]));
    let vars = &action.input["vars"];
    if let Some(input) = vars.get("input").filter(|v| !v.is_null()) {
        out.push_str(&format!("【本次运行的输入】{input}\n"));
    }
    titled(&mut out, "当前阶段", text(&context["stage"]["label"]), text(&context["stage"]["description"]));
    titled(&mut out, "这一步", text(&node.ui["label"]), "");
    for (head, key) in [("为什么有这一步", "purpose"), ("要交出", "delivers")] {
        let value = text(&node.ui[key]);
        if !value.is_empty() {
            out.push_str(&format!("{head}：{value}\n"));
        }
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(node.prompt.trim_end());
    if !node.knowledge.trim().is_empty() {
        out.push_str("\n\n");
        out.push_str(node.knowledge.trim());
    }
    if let Some(first) = node.reads.first() {
        out.push_str(&format!(
            "\n\n【这一步需要读的内容】用 get_workflow_step 工具按名字读取当前版本，如 {{\"read\":\"{}\"}}：",
            first.name
        ));
        for read in &node.reads {
            out.push_str(&format!("\n- {}", read.name));
            if !read.purpose.is_empty() {
                out.push_str(&format!("：{}", read.purpose));
            }
        }
    }
    out.push_str(&result_fields(node));
    if !note.is_empty() {
        out.push_str(&format!("\n\n（工作流提示）{note}"));
    }
    out
}

/// 怎么交活（ADR 041 第 5 块）：`submit_workflow_result` 的 result 要填哪些字段——
/// 字段名、作者起的显示名、取值，可省略的标出来。流程按这些字段往下走，只靠工具
/// 参数里的格式 Agent 容易自己另起字段。
fn result_fields(node: &Node) -> String {
    let Some(schema) = &node.schema else { return String::new() };
    let Some(properties) = schema["properties"].as_object().filter(|p| !p.is_empty()) else {
        return String::new();
    };
    let required: Vec<&str> = schema["required"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut out = String::from("\n\n【要交的结果】调用 submit_workflow_result 时，result 按下面的字段填写（字段名照写，不要另起字段）：");
    for (name, spec) in properties {
        let label = text(&node.ui["labels"][name.as_str()]);
        let kind = match (spec["enum"].as_array(), spec["type"].as_str()) {
            (Some(options), _) => format!("取 {}", options.iter().map(|o| o.as_str().map(str::to_owned).unwrap_or_else(|| o.to_string())).collect::<Vec<_>>().join(" / ")),
            (None, Some("string")) => "文字".into(),
            (None, Some("boolean")) => "true / false".into(),
            (None, Some("integer" | "number")) => "数字".into(),
            (None, Some("array")) => "列表".into(),
            (None, Some("object")) => "对象".into(),
            _ => "任意".into(),
        };
        let label = if label.is_empty() { String::new() } else { format!("（{label}）") };
        let optional = if required.contains(&name.as_str()) { "" } else { "，可省略" };
        out.push_str(&format!("\n- {name}{label}：{kind}{optional}"));
    }
    out
}

pub fn agent_request(action: &Action) -> Result<AgentRequest, String> {
    let node: Node = serde_json::from_value(action.input["__node"].clone())
        .map_err(|_| "INVALID_NODE_DEFINITION")?;
    if node.kind != "agent" {
        return Err("NOT_AN_AGENT_ACTION".into());
    }
    let note = text(&action.input["__note"]).to_owned();
    let label = Some(text(&node.ui["label"]))
        .filter(|label| !label.is_empty())
        .unwrap_or(&action.site)
        .to_owned();
    Ok(AgentRequest {
        prompt: brief(&node, action, &note),
        schema: node.schema.clone().unwrap_or_else(
            || json!({"type":"object","properties":{},"additionalProperties":true}),
        ),
        label,
        note,
    })
}

/// `get_workflow_step` 看到的这一步（ADR 041）：工单全文，加上可按名字读取的
/// 运行变量（动作派发时的版本，与工单一致）。
pub fn step_view(action: &Action) -> Result<crate::result_channel::StepView, String> {
    let request = agent_request(action)?;
    Ok(crate::result_channel::StepView {
        brief: request.workflow_prompt(),
        vars: action.input["vars"].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(note: Option<&str>) -> Action {
        let mut input = json!({
            "vars": {"input": {"requirement": "坦克大战"}, "design": {"evidence": "很长很长的设计证据"}, "plan": {"tasks": []}},
            "__node": {
                "kind": "agent", "actor": "检查员", "prompt": "检查本次变更", "knowledge": "检查方法",
                "reads": [{"name": "design", "purpose": "对照设计"}],
                "ui": {"label": "代码检查", "purpose": "发现明显缺陷", "delivers": "一份检查结论", "labels": {"reference": "检查报告"}},
                "schema": {"type": "object", "properties": {"decision": {"enum": ["pass", "revise"]}, "reference": {"type": "string"}, "files": {"type": "object"}}, "required": ["decision"]}
            },
            "__brief": {"workflow": {"name": "轻量开发", "description": "小需求从设计到交付"}, "stage": {"label": "评审", "description": "独立检查改动"}}
        });
        if let Some(note) = note {
            input["__note"] = json!(note);
        }
        Action { site: "scan".into(), ordinal: 2, actor: "检查员".into(), input }
    }

    #[test]
    fn the_opening_is_a_work_order_without_the_run_contents() {
        let prompt = agent_request(&action(None)).unwrap().workflow_prompt();
        for part in [
            "【工作流】轻量开发：小需求从设计到交付",
            "【本次运行的输入】{\"requirement\":\"坦克大战\"}",
            "【当前阶段】评审：独立检查改动",
            "【这一步】代码检查",
            "为什么有这一步：发现明显缺陷",
            "要交出：一份检查结论",
            "检查本次变更",
            "检查方法",
            "- design：对照设计",
            "【要交的结果】",
            "- decision：取 pass / revise\n",
            "- reference（检查报告）：文字，可省略",
            "- files：对象，可省略",
            "submit_workflow_result",
        ] {
            assert!(prompt.contains(part), "缺「{part}」：{prompt}");
        }
        assert!(!prompt.contains("很长很长的设计证据"), "运行变量的内容不贴进开场白");
        // 工位只看到作者写的必读清单，不列整个运行有哪些内容。
        assert!(!prompt.contains("plan"), "{prompt}");
    }

    #[test]
    fn a_rework_prompt_names_the_step_the_attempt_and_the_note_and_points_to_the_tool() {
        // 回退时引擎写下的提示（为什么重做、用户意见）原样带上，不再另加称呼。
        let note = "这是一次返工：成果仍保留在原处。\n用户意见：边界再查一遍";
        let request = agent_request(&action(Some(note))).unwrap();
        let rework = request.rework_prompt(2);
        for part in ["「代码检查」", "第 2 次", note, "get_workflow_step", "submit_workflow_result"] {
            assert!(rework.contains(part), "缺「{part}」：{rework}");
        }
        assert!(!rework.contains("用户的意见"), "{rework}");
        assert!(!rework.contains("检查方法"), "返工提示不重发工单");
        // 工具里的工单带着用户意见。
        assert!(step_view(&action(Some("边界再查一遍"))).unwrap().brief.contains("（工作流提示）边界再查一遍"));
    }
}
