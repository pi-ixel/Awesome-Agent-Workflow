use super::model::{
    BrowserRequest, BrowserSpace, ControlLease, Controller, PageSource, RequestStatus, Tab,
    TabLifecycle,
};
use std::collections::BTreeMap;

#[derive(Default)]
pub struct BrowserRuntime {
    pub spaces: BTreeMap<String, BrowserSpace>,
    pub requests: BTreeMap<String, BrowserRequest>,
}

impl BrowserRuntime {
    pub fn create_space(
        &mut self,
        window_id: &str,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<BrowserSpace, String> {
        if window_id.is_empty() {
            return Err("MISSING_WINDOW_ID".into());
        }
        if workspace_id.is_empty() {
            return Err("MISSING_WORKSPACE_ID".into());
        }
        if session_id.is_empty() {
            return Err("MISSING_SESSION_ID".into());
        }
        if self.spaces.contains_key(session_id) {
            return Err("SESSION_EXISTS".into());
        }
        let space = BrowserSpace {
            browser_id: format!("browser-{session_id}"),
            window_id: window_id.into(),
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            generation: 1,
            agent_active: false,
            manual_takeover: false,
            tabs: BTreeMap::new(),
        };
        self.spaces.insert(session_id.into(), space.clone());
        Ok(space)
    }

    pub fn invalidate_session(&mut self, session_id: &str) -> Result<BrowserSpace, String> {
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        space.generation += 1;
        for tab in space.tabs.values_mut() {
            if tab.lifecycle != TabLifecycle::Closed {
                tab.control.generation += 1;
            }
        }
        let snapshot = space.clone();
        for request in self.requests.values_mut() {
            if request.session_id == session_id && request.status == RequestStatus::Pending {
                request.status = RequestStatus::Cancelled;
            }
        }
        Ok(snapshot)
    }

    fn set_space_controller(space: &mut BrowserSpace, controller: Controller) {
        space.generation += 1;
        for tab in space.tabs.values_mut() {
            if tab.lifecycle != TabLifecycle::Closed {
                tab.control.controller = controller.clone();
                tab.control.generation += 1;
            }
        }
    }

    pub fn begin_turn(&mut self, session_id: &str) -> Result<BrowserSpace, String> {
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        space.manual_takeover = false;
        space.agent_active = false;
        Self::set_space_controller(space, Controller::User);
        let snapshot = space.clone();
        self.cancel_session_requests(session_id);
        Ok(snapshot)
    }

    pub fn begin_agent_activity(&mut self, session_id: &str) -> Result<BrowserSpace, String> {
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        if space.manual_takeover {
            return Err("CONTROL_NOT_GRANTED".into());
        }
        if space.agent_active {
            return Ok(space.clone());
        }
        space.agent_active = true;
        Self::set_space_controller(space, Controller::Agent);
        Ok(space.clone())
    }

    pub fn end_turn(&mut self, session_id: &str) -> Result<BrowserSpace, String> {
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        if !space.agent_active {
            return Ok(space.clone());
        }
        space.agent_active = false;
        Self::set_space_controller(space, Controller::User);
        Ok(space.clone())
    }

    pub fn user_takeover(
        &mut self,
        session_id: &str,
        tab_id: &str,
        control_generation: u64,
    ) -> Result<BrowserSpace, String> {
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        if !space.agent_active {
            return Err("NO_AGENT_ACTIVITY".into());
        }
        let tab = space.tabs.get(tab_id).ok_or("ACCESS_DENIED")?;
        if tab.control.generation != control_generation {
            return Err("STALE_GENERATION".into());
        }
        if tab.control.controller != Controller::Agent {
            return Err("CONTROL_NOT_GRANTED".into());
        }
        space.agent_active = false;
        space.manual_takeover = true;
        Self::set_space_controller(space, Controller::User);
        let snapshot = space.clone();
        self.cancel_session_requests(session_id);
        Ok(snapshot)
    }

    pub fn assert_session_control(
        &self,
        session_id: &str,
        source: PageSource,
    ) -> Result<(), String> {
        let space = self.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
        let allowed = match source {
            PageSource::Agent => !space.manual_takeover,
            PageSource::User => !space.agent_active,
        };
        if allowed {
            Ok(())
        } else {
            Err("CONTROL_NOT_GRANTED".into())
        }
    }

    pub fn create_tab(&mut self, session_id: &str, url: &str) -> Result<Tab, String> {
        let session_tabs = self
            .spaces
            .get(session_id)
            .ok_or("SESSION_NOT_FOUND")?
            .tabs
            .values()
            .filter(|tab| tab.lifecycle != TabLifecycle::Closed)
            .count();
        if session_tabs >= 8 {
            return Err("SESSION_TAB_BUDGET_EXCEEDED".into());
        }
        let global_tabs = self
            .spaces
            .values()
            .map(|space| {
                space
                    .tabs
                    .values()
                    .filter(|tab| tab.lifecycle != TabLifecycle::Closed)
                    .count()
            })
            .sum::<usize>();
        if global_tabs >= 16 {
            return Err("GLOBAL_TAB_BUDGET_EXCEEDED".into());
        }
        let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
        let next_id = space
            .tabs
            .keys()
            .filter_map(|id| id.strip_prefix("tab-")?.parse::<u64>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        let tab_id = format!("tab-{next_id}");
        let controller = if space.agent_active && !space.manual_takeover {
            Controller::Agent
        } else {
            Controller::User
        };
        let tab = Tab {
            tab_id: tab_id.clone(),
            session_id: session_id.into(),
            generation: 1,
            lifecycle: TabLifecycle::Ready,
            committed_url: Some(url.into()),
            control: ControlLease {
                controller,
                generation: 1,
                owner_session_id: session_id.into(),
            },
        };
        space.tabs.insert(tab_id, tab.clone());
        Ok(tab)
    }

    pub fn crash_tab(&mut self, session_id: &str, tab_id: &str) -> Result<Tab, String> {
        let crashed = {
            let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
            let tab = space.tabs.get_mut(tab_id).ok_or("ACCESS_DENIED")?;
            if tab.lifecycle == TabLifecycle::Closed {
                return Err("TAB_CLOSED".into());
            }
            tab.lifecycle = TabLifecycle::Crashed;
            tab.control.generation += 1;
            tab.clone()
        };
        for request in self.requests.values_mut() {
            if request.session_id == session_id
                && request.tab_id == tab_id
                && request.status == RequestStatus::Pending
            {
                request.status = RequestStatus::Cancelled;
            }
        }
        Ok(crashed)
    }

    pub fn recover_tab(&mut self, session_id: &str, tab_id: &str) -> Result<Tab, String> {
        let recovered = {
            let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
            let tab = space.tabs.get_mut(tab_id).ok_or("ACCESS_DENIED")?;
            if tab.lifecycle == TabLifecycle::Closed {
                return Err("TAB_CLOSED".into());
            }
            tab.generation += 1;
            tab.lifecycle = TabLifecycle::Ready;
            tab.clone()
        };
        for request in self.requests.values_mut() {
            if request.session_id == session_id
                && request.tab_id == tab_id
                && request.tab_generation != recovered.generation
                && request.status == RequestStatus::Pending
            {
                request.status = RequestStatus::Stale;
            }
        }
        Ok(recovered)
    }

    pub fn close_tab(&mut self, session_id: &str, tab_id: &str) -> Result<Tab, String> {
        let closed = {
            let space = self.spaces.get_mut(session_id).ok_or("SESSION_NOT_FOUND")?;
            let tab = space.tabs.get_mut(tab_id).ok_or("ACCESS_DENIED")?;
            tab.lifecycle = TabLifecycle::Closed;
            tab.clone()
        };
        for request in self.requests.values_mut() {
            if request.session_id == session_id
                && request.tab_id == tab_id
                && request.status == RequestStatus::Pending
            {
                request.status = RequestStatus::Cancelled;
            }
        }
        Ok(closed)
    }

    pub fn assert_agent_control(&self, session_id: &str, tab_id: &str) -> Result<(), String> {
        let tab = self
            .spaces
            .get(session_id)
            .ok_or("SESSION_NOT_FOUND")?
            .tabs
            .get(tab_id)
            .ok_or("ACCESS_DENIED")?;
        if tab.lifecycle != TabLifecycle::Ready {
            return Err("TAB_NOT_READY".into());
        }
        if tab.control.controller != Controller::Agent {
            return Err("CONTROL_NOT_GRANTED".into());
        }
        Ok(())
    }

    pub fn begin_request(
        &mut self,
        request_id: &str,
        session_id: &str,
        tab_id: &str,
    ) -> Result<BrowserRequest, String> {
        if request_id.is_empty() {
            return Err("REQUEST_ID_REQUIRED".into());
        }
        if let Some(existing) = self.requests.get(request_id) {
            if existing.session_id == session_id && existing.tab_id == tab_id {
                return Ok(existing.clone());
            }
            return Err("REQUEST_ID_CONFLICT".into());
        }
        let session_pending = self
            .requests
            .values()
            .filter(|request| {
                request.session_id == session_id && request.status == RequestStatus::Pending
            })
            .count();
        if session_pending >= 32 {
            return Err("SESSION_REQUEST_BUDGET_EXCEEDED".into());
        }
        let global_pending = self
            .requests
            .values()
            .filter(|request| request.status == RequestStatus::Pending)
            .count();
        if global_pending >= 128 {
            return Err("GLOBAL_REQUEST_BUDGET_EXCEEDED".into());
        }
        let space = self.spaces.get(session_id).ok_or("SESSION_NOT_FOUND")?;
        let tab = space.tabs.get(tab_id).ok_or("ACCESS_DENIED")?;
        if tab.lifecycle != TabLifecycle::Ready {
            return Err("TAB_NOT_READY".into());
        }
        if space.manual_takeover {
            return Err("CONTROL_NOT_GRANTED".into());
        }
        let request = BrowserRequest {
            request_id: request_id.into(),
            session_id: session_id.into(),
            tab_id: tab_id.into(),
            tab_generation: tab.generation,
            status: RequestStatus::Pending,
            side_effect: "none".into(),
            late_cancel_recorded: false,
        };
        self.requests.insert(request_id.into(), request.clone());
        Ok(request)
    }

    pub fn close_session(&mut self, session_id: &str) -> Result<Vec<String>, String> {
        let tab_ids = self
            .spaces
            .get(session_id)
            .map(|space| {
                space
                    .tabs
                    .values()
                    .filter(|tab| tab.lifecycle != super::model::TabLifecycle::Closed)
                    .map(|tab| tab.tab_id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for tab_id in &tab_ids {
            self.close_tab(session_id, tab_id)?;
        }
        Ok(tab_ids)
    }

    pub fn complete_request(&mut self, request_id: &str) -> Result<BrowserRequest, String> {
        let current_generation = {
            let request = self.requests.get(request_id).ok_or("REQUEST_NOT_FOUND")?;
            if request.status == RequestStatus::Stale {
                return Err("STALE_GENERATION".into());
            }
            if request.status != RequestStatus::Pending {
                return Err("REQUEST_ALREADY_TERMINAL".into());
            }
            self.spaces
                .get(&request.session_id)
                .and_then(|space| space.tabs.get(&request.tab_id))
                .map(|tab| tab.generation)
                .ok_or("ACCESS_DENIED")?
        };
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or("REQUEST_NOT_FOUND")?;
        if request.tab_generation != current_generation {
            request.status = RequestStatus::Stale;
            return Err("STALE_GENERATION".into());
        }
        request.status = RequestStatus::Completed;
        request.side_effect = "confirmed".into();
        Ok(request.clone())
    }

    pub fn cancel_session_requests(&mut self, session_id: &str) -> Vec<String> {
        let mut cancelled = Vec::new();
        for request in self.requests.values_mut() {
            if request.session_id == session_id && request.status == RequestStatus::Pending {
                request.status = RequestStatus::Cancelled;
                cancelled.push(request.request_id.clone());
            }
        }
        cancelled
    }

    pub fn complete_observation_request(
        &mut self,
        request_id: &str,
    ) -> Result<BrowserRequest, String> {
        self.complete_request(request_id)?;
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or("REQUEST_NOT_FOUND")?;
        request.side_effect = "none".into();
        Ok(request.clone())
    }

    pub fn cancel_request(&mut self, request_id: &str) -> Result<BrowserRequest, String> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or("REQUEST_NOT_FOUND")?;
        if request.status == RequestStatus::Completed {
            request.late_cancel_recorded = true;
            return Ok(request.clone());
        }
        if matches!(
            request.status,
            RequestStatus::Cancelled | RequestStatus::Failed
        ) {
            return Ok(request.clone());
        }
        if request.status == RequestStatus::Stale {
            return Err("STALE_GENERATION".into());
        }
        request.status = RequestStatus::Cancelled;
        Ok(request.clone())
    }

    pub fn agent_input(&mut self, session_id: &str, tab_id: &str) -> Result<Tab, String> {
        self.spaces
            .get(session_id)
            .ok_or("SESSION_NOT_FOUND")?
            .tabs
            .get(tab_id)
            .cloned()
            .ok_or_else(|| "ACCESS_DENIED".into())
    }

    pub fn timeout_request(&mut self, request_id: &str) -> Result<BrowserRequest, String> {
        let request = self
            .requests
            .get_mut(request_id)
            .ok_or("REQUEST_NOT_FOUND")?;
        if request.status != RequestStatus::Pending {
            return Err("REQUEST_ALREADY_TERMINAL".into());
        }
        request.status = RequestStatus::Failed;
        request.side_effect = "unknown".into();
        Ok(request.clone())
    }

    pub fn pending_request_count(&self) -> usize {
        self.requests
            .values()
            .filter(|request| request.status == RequestStatus::Pending)
            .count()
    }
}
