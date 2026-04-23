use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, Mutex};

use crate::pane::PaneHandle;
use crate::protocol::ServerMsg;

pub const DEFAULT_SESSION: &str = "default";

#[derive(Default, Clone)]
pub struct SessionEntry {
    pub version: u64,
    pub blob: Option<String>,
    pub attached: u64,
    pub last_active_ms: u64,
}

pub struct SharedServer {
    pub panes: Mutex<HashMap<String, PaneHandle>>,
    pub event_tx: broadcast::Sender<ServerMsg>,
    pub sessions: Mutex<HashMap<String, SessionEntry>>,
    pub shutdown_tx: broadcast::Sender<()>,
}

impl SharedServer {
    pub fn new() -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(64);
        let (shutdown_tx, _) = broadcast::channel(1);
        let mut sessions = HashMap::new();
        sessions.insert(
            DEFAULT_SESSION.to_string(),
            SessionEntry {
                last_active_ms: now_ms(),
                ..Default::default()
            },
        );
        Arc::new(Self {
            panes: Mutex::new(HashMap::new()),
            event_tx,
            sessions: Mutex::new(sessions),
            shutdown_tx,
        })
    }

    pub fn trigger_shutdown(&self) {
        let _ = self.shutdown_tx.send(());
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
