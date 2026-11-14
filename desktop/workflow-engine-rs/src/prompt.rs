//! Agent requests are assembled from the node definition captured for this run.
use crate::{Action, graph::Node};
use serde_json::{Value, json};

#[derive(Debug)]
pub struct AgentRequest {
    pub prompt: String,
    pub schema: Value,
}
impl AgentRequest {
    /// The only engine-side contract with the Agent: how to hand over the
    /// result. Working method, tool usage and user interaction belong to the
    /// node's own prompt and knowledge.
    pub fn workflow_prompt(&self) -> String {
        format!(
            "{}\n\n完成本次工作后，请调用 submit_workflow_result 工具，将本次动作的实际结果对象放在 result 参数中交付。",
            self.prompt
        )
    }
}
/// 宿主换代（WebView 重载）后续跑的轮次文本：会话按原 id 恢复，Agent 看得到
/// 自己之前的进展；只提醒它把这一步做完并经结果工具交付。
pub const RESUME_AFTER_HOST_RESET_PROMPT: &str = "（工作流提示）会话刚刚重新连接，上一轮可能被中断。如果本次工作已经完成，请直接调用 submit_workflow_result 工具提交结果；否则继续完成剩余工作后再提交。";

pub fn agent_request(action: &Action) -> Result<AgentRequest, String> {
    let node: Node = serde_json::from_value(action.input["__node"].clone())
        .map_err(|_| "INVALID_NODE_DEFINITION")?;
    if node.kind != "agent" {
        return Err("NOT_AN_AGENT_ACTION".into());
    }
    let note = action.input["__note"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\n（工作流提示）{s}"))
        .unwrap_or_default();
    Ok(AgentRequest {
        prompt: format!(
            "{}\n{}\n运行上下文：{}{note}",
            node.prompt, node.knowledge, action.input["vars"]
        ),
        schema: node.schema.unwrap_or_else(
            || json!({"type":"object","properties":{},"additionalProperties":true}),
        ),
    })
}
