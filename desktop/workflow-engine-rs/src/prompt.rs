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
pub fn agent_request(action: &Action) -> Result<AgentRequest, String> {
    let node: Node = serde_json::from_value(action.input["__node"].clone())
        .map_err(|_| "INVALID_NODE_DEFINITION")?;
    if node.kind != "agent" {
        return Err("NOT_AN_AGENT_ACTION".into());
    }
    Ok(AgentRequest {
        prompt: format!(
            "{}\n{}\n运行上下文：{}",
            node.prompt, node.knowledge, action.input["vars"]
        ),
        schema: node.schema.unwrap_or_else(
            || json!({"type":"object","properties":{},"additionalProperties":true}),
        ),
    })
}
