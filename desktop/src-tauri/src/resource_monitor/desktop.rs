use super::Frame;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkingSet {
    pub total: Option<u64>,
    pub executable: Option<u64>,
    pub interface: Option<u64>,
    pub browser: Option<u64>,
    pub other: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MemoryPoint {
    pub at: u64,
    pub memory: WorkingSet,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionKey {
    pub scope: String,
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnMark {
    pub session: SessionKey,
    pub ordinal: u32,
    pub started_at: u64,
    pub ended_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnMemory {
    session: SessionKey,
    started_at: u64,
    ended_at: Option<u64>,
    before: Option<MemoryPoint>,
    peak: Option<MemoryPoint>,
    has_overlap: bool,
    #[serde(skip)]
    ordinal: u32,
    #[serde(skip)]
    archived_peak: Option<MemoryPoint>,
}

impl TurnMemory {
    fn contains(&self, at: u64) -> bool {
        self.started_at <= at && self.ended_at.is_none_or(|end| at <= end)
    }

    fn observe(&mut self, point: MemoryPoint) {
        if self.contains(point.at)
            && point.memory.total.is_some()
            && self
                .peak
                .is_none_or(|peak| point.memory.total > peak.memory.total)
        {
            self.peak = Some(point);
        }
    }
}

#[derive(Default)]
pub(super) struct Turns(HashMap<SessionKey, TurnMemory>);

impl Turns {
    pub fn mark(&mut self, mark: TurnMark, history: &VecDeque<Frame>) {
        let mut end = mark.ended_at.unwrap_or(u64::MAX);
        if end < mark.started_at {
            return;
        }
        if let Some(saved) = self.0.get(&mark.session) {
            if (saved.started_at, saved.ordinal) > (mark.started_at, mark.ordinal) {
                return;
            }
            if saved.started_at == mark.started_at
                && saved.ordinal == mark.ordinal
                && mark.ended_at.is_none()
            {
                return;
            }
            if saved.started_at == mark.started_at && saved.ordinal == mark.ordinal {
                end = end.min(saved.ended_at.unwrap_or(u64::MAX));
            }
        }
        let before = history
            .iter()
            .rev()
            .find(|frame| frame.at < mark.started_at)
            .and_then(|frame| frame.desktop_memory);

        let mut turn = match self.0.remove(&mark.session) {
            Some(turn) if turn.started_at == mark.started_at && turn.ordinal == mark.ordinal => {
                turn
            }
            _ => TurnMemory {
                session: mark.session.clone(),
                ordinal: mark.ordinal,
                started_at: mark.started_at,
                ended_at: None,
                before,
                peak: None,
                has_overlap: false,
                archived_peak: None,
            },
        };
        turn.ended_at = (end != u64::MAX).then_some(end);
        if turn.peak.is_some_and(|point| !turn.contains(point.at)) {
            turn.peak = turn.archived_peak.filter(|point| turn.contains(point.at));
        }
        for point in history.iter().filter_map(|frame| frame.desktop_memory) {
            turn.observe(point);
        }
        for other in self.0.values_mut() {
            if turn.started_at < other.ended_at.unwrap_or(u64::MAX) && other.started_at < end {
                turn.has_overlap = true;
                other.has_overlap = true;
            }
        }
        self.0.insert(mark.session, turn);
        if self.0.len() > 512
            && let Some(oldest) = self
                .0
                .iter()
                .min_by_key(|(_, turn)| (turn.ended_at.is_none(), turn.started_at))
                .map(|(key, _)| key.clone())
        {
            self.0.remove(&oldest);
        }
    }

    pub fn observe(&mut self, point: MemoryPoint) {
        for turn in self.0.values_mut().filter(|turn| turn.ended_at.is_none()) {
            turn.observe(point);
        }
    }

    // 轮次可能长于趋势缓冲。结束标记晚到时，仍可还原缓冲以外的峰值。
    pub fn archive(&mut self, point: MemoryPoint) {
        for turn in self.0.values_mut().filter(|turn| turn.ended_at.is_none()) {
            if turn.contains(point.at)
                && point.memory.total.is_some()
                && turn
                    .archived_peak
                    .is_none_or(|peak| point.memory.total > peak.memory.total)
            {
                turn.archived_peak = Some(point);
            }
        }
    }

    pub fn get(&self, session: &SessionKey) -> Option<&TurnMemory> {
        self.0.get(session)
    }

    pub fn end_active(&mut self, at: u64) {
        for turn in self.0.values_mut().filter(|turn| turn.ended_at.is_none()) {
            turn.ended_at = Some(at.max(turn.started_at));
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq)]
pub(super) enum WebviewRole {
    Interface,
    Browser,
}

#[cfg(windows)]
pub(super) fn summarize(
    desktop: &super::GroupSample,
    roots: &HashMap<u32, WebviewRole>,
) -> WorkingSet {
    let mut result = WorkingSet {
        total: desktop.memory_bytes,
        executable: Some(0),
        interface: Some(0),
        browser: Some(0),
        other: Some(0),
    };
    let parents: HashMap<_, _> = desktop
        .processes
        .iter()
        .map(|process| (process.pid, process.parent_pid))
        .collect();
    for process in &desktop.processes {
        let category = if process.pid == desktop.root_pid {
            &mut result.executable
        } else {
            let mut current = process.pid;
            let mut visited = std::collections::HashSet::new();
            let role = loop {
                if let Some(role) = roots.get(&current) {
                    break Some(role);
                }
                if current == desktop.root_pid || !visited.insert(current) {
                    break None;
                }
                match parents.get(&current) {
                    Some(&parent) => current = parent,
                    None => break None,
                }
            };
            match role {
                Some(WebviewRole::Interface) => &mut result.interface,
                Some(WebviewRole::Browser) => &mut result.browser,
                None => &mut result.other,
            }
        };
        *category = category
            .zip(process.memory_bytes)
            .map(|(sum, bytes)| sum.saturating_add(bytes));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(at: u64, interface: u64, browser: u64) -> MemoryPoint {
        MemoryPoint {
            at,
            memory: WorkingSet {
                total: Some(10 + interface + browser),
                executable: Some(10),
                interface: Some(interface),
                browser: Some(browser),
                other: Some(0),
            },
        }
    }

    fn mark(session: &str, ordinal: u32, start: u64, end: Option<u64>) -> TurnMark {
        TurnMark {
            session: SessionKey {
                scope: "workspace+agent".into(),
                session_id: session.into(),
            },
            ordinal,
            started_at: start,
            ended_at: end,
        }
    }

    #[test]
    fn uses_one_desktop_peak_sample_and_ignores_post_turn_growth() {
        let before = point(10, 20, 0);
        let peak = point(30, 30, 160);
        let after = point(60, 300, 0);
        let mut history = VecDeque::new();
        let mut turns = Turns::default();
        history.push_back(Frame {
            at: before.at,
            groups: vec![],
            desktop_memory: Some(before),
        });
        turns.mark(mark("a", 1, 15, None), &history);
        for sample in [point(20, 50, 20), peak, point(40, 95, 20), after] {
            history.push_back(Frame {
                at: sample.at,
                groups: vec![],
                desktop_memory: Some(sample),
            });
            turns.observe(sample);
        }
        turns.mark(mark("b", 2, 35, Some(49)), &history);
        turns.mark(mark("a", 1, 15, Some(50)), &history);
        let session = mark("a", 1, 15, None).session;
        let finished = turns.get(&session).unwrap();
        assert_eq!(finished.before, Some(before));
        assert_eq!(finished.peak, Some(peak));
        assert!(finished.has_overlap);

        history.clear();
        turns.observe(after);
        assert_eq!(turns.get(&session).unwrap().peak, Some(peak));
        // 重连复用同一逻辑会话，只有新一轮开始才替换旧记录。
        turns.mark(mark("a", 1, 70, None), &history);
        turns.mark(mark("a", 1, 15, Some(50)), &history);
        let next = turns.get(&session).unwrap();
        assert_eq!(next.started_at, 70);
        assert!(next.peak.is_none());
        assert!(!next.has_overlap);
    }

    #[test]
    fn preserves_a_long_turn_peak_when_ending_after_the_history_has_rolled() {
        let mut state = super::super::State::default();
        let peak = point(20, 30, 160);
        state.record(10, vec![], Some(point(10, 20, 0)));
        state.turns.mark(mark("a", 1, 15, None), &state.history);
        state.record(peak.at, vec![], Some(peak));
        state.record(900_030, vec![], Some(point(900_030, 20, 0)));
        state.record(900_040, vec![], Some(point(900_040, 30, 260)));
        state
            .turns
            .mark(mark("a", 1, 15, Some(900_035)), &state.history);
        let session = mark("a", 1, 15, None).session;
        assert_eq!(state.turns.get(&session).unwrap().peak, Some(peak));
    }

    #[cfg(windows)]
    #[test]
    fn attributes_webview_descendants_without_charging_them_twice() {
        use super::super::{GroupSample, ProcessSample};
        let processes = [
            (1, 0, 10),
            (2, 1, 20),
            (3, 2, 30),
            (4, 1, 40),
            (5, 4, 50),
            (6, 1, 60),
        ]
        .into_iter()
        .map(|(pid, parent_pid, bytes)| ProcessSample {
            pid,
            parent_pid,
            name: String::new(),
            cpu_percent: None,
            memory_bytes: Some(bytes),
        })
        .collect();
        let group = GroupSample {
            id: "desktop".into(),
            handle: None,
            root_pid: 1,
            cpu_percent: None,
            memory_bytes: Some(210),
            incomplete: false,
            processes,
        };
        assert_eq!(
            summarize(
                &group,
                &HashMap::from([(2, WebviewRole::Interface), (4, WebviewRole::Browser)])
            ),
            WorkingSet {
                total: Some(210),
                executable: Some(10),
                interface: Some(50),
                browser: Some(90),
                other: Some(60),
            }
        );
    }
}
