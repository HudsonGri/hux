use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "0.1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        id: u64,
        version: String,
    },
    AttachSession {
        id: u64,
        name: String,
        #[serde(default)]
        create: bool,
    },
    ListSessions {
        id: u64,
    },
    CreateSession {
        id: u64,
        name: String,
    },
    KillSession {
        id: u64,
        name: String,
    },
    RenameSession {
        id: u64,
        from: String,
        to: String,
    },
    CreatePane {
        id: u64,
        pane_id: String,
        #[serde(default)]
        session: Option<String>,
        cwd: Option<String>,
        shell: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
        #[serde(default)]
        env: Vec<(String, String)>,
    },
    ClosePane {
        id: u64,
        pane_id: String,
    },
    Write {
        id: u64,
        pane_id: String,
        data: String,
    },
    Resize {
        id: u64,
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    GetGrid {
        id: u64,
        pane_id: String,
    },
    GetScrollback {
        id: u64,
        pane_id: String,
        offset: u16,
    },
    ListPanes {
        id: u64,
    },
    GetState {
        id: u64,
        #[serde(default)]
        session: Option<String>,
    },
    SetState {
        id: u64,
        #[serde(default)]
        session: Option<String>,
        version: u64,
        blob: String,
    },
    KillServer {
        id: u64,
    },
    GetScrollbackText {
        id: u64,
        pane_id: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Ack {
        id: u64,
        data: Value,
    },
    Err {
        id: u64,
        error: String,
    },
    PaneUpdate {
        pane_id: String,
        rows: u16,
        cols: u16,
        cells: Vec<Vec<Cell>>,
        cursor_x: u16,
        cursor_y: u16,
        #[serde(default, skip_serializing_if = "is_false")]
        alternate_screen: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        mouse_protocol: bool,
    },
    PaneExit {
        pane_id: String,
        exit_code: i32,
    },
    Title {
        pane_id: String,
        title: String,
    },
    Notification {
        pane_id: String,
        body: String,
    },
    Bye {
        reason: ByeReason,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ByeReason {
    Exit,
    Busy,
    Kicked,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
}

pub const RGB_FLAG: u32 = 0x0100_0000;

impl Cell {
    pub fn blank() -> Self {
        Self {
            ch: ' ',
            fg: None,
            bg: None,
            bold: false,
        }
    }
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaneInfo {
    pub id: String,
    pub session: String,
    pub alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
