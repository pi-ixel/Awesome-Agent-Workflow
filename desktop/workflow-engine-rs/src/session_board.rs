//! 会话状态板（ADR 040）：宿主报告的会话状态在服务里的唯一落脚处。
//!
//! 宿主（Desktop）每当会话状态变化就经服务协议 `session-state` 报一份完整的
//! [`SessionState`]；运行线程在这里等自己会话的下一份。板只保留每个会话序号
//! 最大的那一份——报告丢了、重复了、乱序了，下一份到达就对齐。
//!
//! 宿主换代（WebView 重载）时 [`SessionBoard::reset`] 让等待者以 HOST_RESET
//! 醒来：新宿主要按会话 id 重新接上会话，之后的报告才会到。已有的状态保留，
//! 运行线程据此判断换代那一刻会话是不是正在跑一轮。
use crate::session_host::SessionState;
use std::{
    collections::HashMap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
struct Inner {
    states: HashMap<String, SessionState>,
    /// 宿主换代次数。
    generation: u64,
}

#[derive(Default)]
pub struct SessionBoard {
    inner: Mutex<Inner>,
    changed: Condvar,
}

/// 等待时多久看一次取消标志。
const CANCEL_POLL: Duration = Duration::from_millis(100);

pub fn session_scope(run_id: &str, session_id: &str) -> String {
    format!("{run_id}\0{session_id}")
}

impl SessionBoard {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 记下一份会话状态；比已有的旧（序号不更大）就丢弃。返回是否采用。
    pub fn report(&self, session_id: &str, state: SessionState) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.states.get(session_id).is_some_and(|known| known.seq >= state.seq) {
            return false;
        }
        inner.states.insert(session_id.to_owned(), state);
        drop(inner);
        self.changed.notify_all();
        true
    }

    pub fn state(&self, session_id: &str) -> Option<SessionState> {
        self.inner.lock().ok()?.states.get(session_id).cloned()
    }

    /// 宿主换代：唤醒全部等待者（以 HOST_RESET）。
    pub fn reset(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.generation += 1;
        }
        self.changed.notify_all();
    }

    pub fn generation(&self) -> u64 {
        self.inner.lock().map(|inner| inner.generation).unwrap_or(0)
    }

    /// 等 `session_id` 出现序号大于 `after` 的状态。`generation` 是调用方接上
    /// 会话时的换代次数，变了就返回 HOST_RESET；取消返回 RUN_CANCELLED。
    pub fn wait(
        &self,
        session_id: &str,
        after: u64,
        generation: u64,
        cancel: &AtomicBool,
    ) -> Result<SessionState, String> {
        let mut inner = self.inner.lock().map_err(|_| "SESSION_BOARD_LOCKED")?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("RUN_CANCELLED".into());
            }
            if inner.generation != generation {
                return Err(crate::remote_host::HOST_RESET.into());
            }
            if let Some(state) = inner.states.get(session_id).filter(|state| state.seq > after) {
                return Ok(state.clone());
            }
            inner = self
                .changed
                .wait_timeout(inner, CANCEL_POLL)
                .map_err(|_| "SESSION_BOARD_LOCKED")?
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_host::{EndedTurn, TurnOutcome};

    fn state(seq: u64, running: Option<u64>) -> SessionState {
        SessionState { seq, running, ended: None }
    }

    #[test]
    fn keeps_only_the_newest_report() {
        let board = SessionBoard::new();
        assert!(board.report("s", state(5, Some(5))));
        assert!(!board.report("s", state(4, None)), "旧的一份丢弃");
        assert!(!board.report("s", state(5, None)), "重复的一份丢弃");
        assert_eq!(board.state("s"), Some(state(5, Some(5))));
        let ended = SessionState { seq: 7, running: None, ended: Some(EndedTurn { turn: 5, outcome: TurnOutcome::Cancelled, error: None }) };
        assert!(board.report("s", ended.clone()));
        assert_eq!(board.state("s"), Some(ended));
    }

    #[test]
    fn waiters_wake_on_a_newer_report_on_cancel_and_on_host_reset() {
        let board = SessionBoard::new();
        board.report("s", state(1, None));
        let cancel = Arc::new(AtomicBool::new(false));
        assert_eq!(board.wait("s", 0, 0, &cancel).unwrap().seq, 1, "已有更新的一份立即返回");

        let waiter = {
            let (board, cancel) = (board.clone(), cancel.clone());
            std::thread::spawn(move || board.wait("s", 1, 0, &cancel))
        };
        std::thread::sleep(Duration::from_millis(30));
        board.report("s", state(2, Some(2)));
        assert_eq!(waiter.join().unwrap().unwrap().seq, 2);

        let waiter = {
            let (board, cancel) = (board.clone(), cancel.clone());
            std::thread::spawn(move || board.wait("s", 2, 0, &cancel))
        };
        board.reset();
        assert_eq!(waiter.join().unwrap().unwrap_err(), crate::remote_host::HOST_RESET);

        let waiter = {
            let (board, cancel) = (board.clone(), cancel.clone());
            std::thread::spawn(move || board.wait("s", 2, 1, &cancel))
        };
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(waiter.join().unwrap().unwrap_err(), "RUN_CANCELLED");
    }
}
