//! ADR 023（docs/workflow/adr.md；原文 docs/history/skillsplice/023-engine-session-hosting-adr.md）的宿主接缝。
//! P1 落地 spawn/stop；P2 把用户消息中继与会话事件缓冲划归宿主一侧；P3 把
//! 权限/问答中继也划归宿主；二期-2（§9 第 2、3 条）把接缝收口为轮次边界；
//! ADR 040 再把轮次边界换成**会话状态**：宿主每次变化报一份完整的会话状态
//! （在跑哪一轮、上一轮怎么结束的），引擎只照着记录和推进。用户消息直接进
//! 宿主原生会话流，排队/送达语义、会话事件缓冲与反向请求全部是宿主的职责。
use crate::Action;
pub use crate::result_channel::ResultChannelOffer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
};

/// 问题池 tracker 的启动参数（ADR 023 §4/§9 第 4 条）：需求单携带、宿主
/// 负责 spawn 并持有进程生命周期——引擎只解析路径与指定 runId 作用域，
/// 不再管理任何进程（二期-3：`QuestionPool::start` 的进程职责移除）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackerStartParams {
    /// tracker 可执行文件路径（引擎按既有规则解析：服务 exe 同目录，
    /// 开发态回落仓库 skills/question-tracker-mcp/bin）。
    pub executable: PathBuf,
    /// tracker 进程的工作目录：池子状态文件路径规则按 cwd 派生，必须与
    /// 迁移前一致（`QUESTION_TRACKER_HOME/<cwd 派生名>`）。
    pub cwd: PathBuf,
    /// QUESTION_TRACKER_HOME 覆盖（None＝tracker 自带默认规则；生产路径
    /// 恒为 None，测试经它圈定池子目录）。
    pub home: Option<PathBuf>,
    /// 本运行的会话作用域（runId）：create_session 与后续调用按它隔离。
    pub session: String,
}

/// 节点需求单：拉起一个节点会话所需的全部输入。字段是信封（动作身份与
/// 配置），不含会话内容；serde 化后即是后续阶段的 hook 帧载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRequirement {
    /// 该会话承接的首个动作（信封：身份与需求单输入）。会话生命周期内
    /// 的后续动作经 [`NodeSession::prompt_turn`] 逐轮下发。
    pub action: Action,
    /// Agent 进程的工作目录（项目目录）。
    pub cwd: PathBuf,
    /// Agent 启动命令（按角色指定时是该角色的 Agent）。
    pub command: Vec<String>,
    /// 按角色指定的模型（ADR 036）；宿主建新会话后设置，Agent 没有这个模型时节点失败并说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub profile: Option<String>,
    /// 调用方配置的 MCP 服务清单（标准 ACP `McpServer` 元素，原样下发）。
    /// 不含结果通道——结果通道见 `result_channel`。
    pub mcp_servers: Value,
    /// 结果通道的全部可达方式（ADR 024 §9-3）。宿主握手后按 Agent 声明的
    /// `mcpCapabilities` 以 [`ResultChannelOffer::mcp_server`] 选定一种，追加
    /// 到 `mcp_servers` 之后下发；选择规则只有这一处定义。
    #[serde(default)]
    pub result_channel: Option<ResultChannelOffer>,
    /// 恢复既有会话时的 ACP session id。
    pub resume_session_id: Option<String>,
    /// `resume_session_id` 是发起运行的会话（ADR 039），不是这个角色原有的会话：
    /// 宿主接不上它时可以改开新会话，引擎按宿主给回的会话 id 关联。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub entry_session: bool,
    /// 问题池 tracker 启动参数（仅 agent 节点的运行携带）：宿主按它确保
    /// tracker 进程已 spawn（幂等）。
    pub question_tracker: Option<TrackerStartParams>,
}

/// 一轮标准工作流轮次的请求：动作信封 + 引擎从需求单渲染的 prompt。
/// prompt 是引擎生成的调度文本（需求单内容），不是用户会话消息。
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub action: Action,
    pub prompt: String,
}

/// 一轮是怎么结束的：宿主的会话里看得到的事实，引擎照着记，不推断（ADR 040）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    /// Agent 正常停下（交了结果，或停下来问用户）。
    Completed,
    /// 被打断（用户在会话里点了停止、运行被停止）。
    Cancelled,
    /// 出错（网络断开、Agent 报错等），用户可以在会话里重试。
    Failed,
}

impl TurnOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// 最近结束的一轮。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndedTurn {
    /// 轮次编号：这一轮开始时会话状态的序号。
    pub turn: u64,
    pub outcome: TurnOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 宿主报告的会话状态（ADR 040：会话是唯一来源）。每次报完整的一份，引擎只认
/// 序号更大的那份，所以漏收、重复、乱序都不影响结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionState {
    /// 宿主给的序号，跨页面重载单调递增。
    pub seq: u64,
    /// 正在跑的那一轮的编号；空闲时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<u64>,
    /// 最近结束的一轮；宿主不知道（例如页面刚重载）时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<EndedTurn>,
}

/// 一个已建立、可驱动轮次的节点会话。引擎对会话的感知只有宿主报告的会话
/// 状态（[`SessionState`]）：消息的排队、送达、内容都不过引擎；轮次怎么结束
/// 的由宿主如实报告，引擎不猜（ADR 040）。
pub trait NodeSession: Send {
    fn session_id(&self) -> &str;
    /// 引擎已把会话与动作落账（actor_sessions 关联完成）。宿主此刻公开
    /// 会话并回放缓冲的早期事件；未调用前到达的事件由宿主自行缓冲。
    fn session_linked(&mut self) -> Result<(), String>;
    /// 在会话里发出工作流的说明；这一轮开始即返回它的轮次编号。之后这一轮
    /// 怎么结束的从 [`NodeSession::wait_state`] 看。
    fn prompt_turn(
        &mut self,
        request: &TurnRequest,
        cancel: Arc<AtomicBool>,
    ) -> Result<u64, String>;
    /// 等会话状态出现比 `after` 更新的一份并返回它。取消以 `RUN_CANCELLED`
    /// 唤醒；宿主换代以 [`crate::remote_host::HOST_RESET`] 唤醒。
    fn wait_state(&mut self, after: u64, cancel: Arc<AtomicBool>) -> Result<SessionState, String>;
}

/// 宿主接口（ADR 023 §2.2）。引擎只依赖此抽象，不感知会话由谁承载：
/// 会话连接、用户消息、事件与历史、权限/问答都是宿主（Desktop）自己的
/// 职责，不经引擎。引擎只在轮次边界上感知会话。
pub trait SessionHost: Send + Sync + 'static {
    /// 按需求单拉起（或恢复）节点会话。会话通知与交互（session/update、
    /// session/request_permission 等）由宿主自己处理，不进入引擎。
    fn spawn_node_session(
        &self,
        requirement: &SessionRequirement,
        cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn NodeSession>, String>;

    /// 停止运行时唤醒挂起的等待（服务协议 stop / 服务收尾）。
    fn cancel_waiting(&self) {}

    /// 问题池 tracker 启动（二期-3）：按需求单参数确保 tracker 进程已由
    /// 宿主 spawn 并完成握手（initialize + 运行作用域 create_session），
    /// 幂等（同作用域重复调用是 no-op）。引擎不持有任何进程句柄。
    fn start_question_tracker(&self, _params: &TrackerStartParams) -> Result<(), String> {
        Err("QUESTION_TRACKER_UNAVAILABLE".into())
    }

    /// 问题池 tracker 的 JSON-RPC 中继（二期-3）：引擎侧 [`crate::question_pool::QuestionPool`]
    /// 的 tools/list 与 tools/call 经此到达宿主持有的 tracker 进程。载荷是
    /// MCP 工具调用信封（会话作用域由引擎注入），宿主不解析工具语义。
    fn question_tracker_request(&self, _method: &str, _params: Value) -> Result<Value, String> {
        Err("QUESTION_TRACKER_UNAVAILABLE".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OfferCase {
        agent_supports_http: bool,
        expected: Value,
    }

    #[derive(Deserialize)]
    struct OfferFixture {
        offer: ResultChannelOffer,
        cases: Vec<OfferCase>,
    }

    /// Shared with the Desktop host's tests: one file pins the transport rule.
    fn offer_fixture() -> OfferFixture {
        serde_json::from_str(include_str!("../tests/fixtures/result_channel_offer.json")).unwrap()
    }

    #[test]
    fn result_channel_transport_rule_matches_the_shared_fixture() {
        let fixture = offer_fixture();
        assert_eq!(fixture.cases.len(), 2);
        for case in fixture.cases {
            assert_eq!(
                fixture.offer.mcp_server(case.agent_supports_http),
                case.expected,
                "agentSupportsHttp={}",
                case.agent_supports_http
            );
        }
    }

    fn requirement() -> SessionRequirement {
        SessionRequirement {
            action: Action {
                site: "ask#1".into(),
                ordinal: 1,
                actor: "设计".into(),
                input: json!({"__node":{"kind":"agent"}}),
            },
            cwd: PathBuf::from(r"D:\dev\tmp\project"),
            command: vec!["agent".into(), "--stdio".into()],
            model: None,
            profile: Some("default".into()),
            mcp_servers: json!([
                {"name":"caller-tools","command":"caller.exe","args":[],"env":[]}
            ]),
            result_channel: Some(offer_fixture().offer),
            resume_session_id: Some("sess-1".into()),
            entry_session: false,
            question_tracker: Some(TrackerStartParams {
                executable: PathBuf::from("question-tracker.exe"),
                cwd: PathBuf::from(r"D:\dev\tmp\project"),
                home: None,
                session: "run-1".into(),
            }),
        }
    }

    /// 需求单是后续 hook 帧的线格式：serde 往返必须无损，且字段集合
    /// 就是信封本身（动作身份与配置，无会话内容字段）。
    #[test]
    fn session_requirement_round_trips_as_the_hook_envelope() {
        let text = serde_json::to_string(&requirement()).unwrap();
        let parsed: SessionRequirement = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.action.actor, "设计");
        assert_eq!(parsed.action.site, "ask#1");
        assert_eq!(parsed.cwd, PathBuf::from(r"D:\dev\tmp\project"));
        assert_eq!(parsed.resume_session_id.as_deref(), Some("sess-1"));
        assert_eq!(parsed.mcp_servers[0]["name"], "caller-tools");
        assert_eq!(parsed.result_channel, Some(offer_fixture().offer));
        // 二期-3：tracker 启动参数随需求单过线（路径/runId 作用域）。
        let tracker = parsed.question_tracker.expect("tracker params ride the envelope");
        assert_eq!(tracker.executable, PathBuf::from("question-tracker.exe"));
        assert_eq!(tracker.cwd, PathBuf::from(r"D:\dev\tmp\project"));
        assert_eq!(tracker.home, None);
        assert_eq!(tracker.session, "run-1");
    }
}
