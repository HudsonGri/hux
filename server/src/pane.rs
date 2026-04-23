use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Arc, Mutex as StdMutex,
};

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant, MissedTickBehavior};
use tracing::{info, warn};

use crate::protocol::{Cell, ServerMsg};

pub const EXIT_PENDING: i32 = i32::MIN;
pub const SCROLLBACK_LINES: usize = 1000;

pub struct PaneConfig {
    pub id: String,
    pub session: String,
    pub cwd: Option<String>,
    pub shell: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
}

pub struct TitleCallback {
    title: Arc<StdMutex<String>>,
}

impl vt100::Callbacks for TitleCallback {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        if let Ok(s) = std::str::from_utf8(title) {
            if let Ok(mut t) = self.title.lock() {
                *t = s.to_string();
            }
        }
    }
}

pub type ConfiguredParser = vt100::Parser<TitleCallback>;

pub struct PaneHandle {
    pub alive: Arc<AtomicBool>,
    pub exit_code: Arc<AtomicI32>,
    pub title: Arc<StdMutex<String>>,
    pub parser: Arc<Mutex<ConfiguredParser>>,
    pub write_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u16, u16)>,
    pub close_tx: mpsc::Sender<()>,
    pub session: String,
    // Held so the pane's background task lives as long as the handle.
    #[allow(dead_code)]
    pub task: JoinHandle<()>,
}

pub struct PaneSnapshot {
    pub rows: u16,
    pub cols: u16,
    pub grid: Vec<Vec<Cell>>,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub alt_screen: bool,
    pub mouse_protocol: bool,
}

pub struct ScrollbackSnapshot {
    pub rows: u16,
    pub cols: u16,
    pub grid: Vec<Vec<Cell>>,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub offset: u16,
    pub alt_screen: bool,
    pub mouse_protocol: bool,
}

const OSC_SNIFF_CAP: usize = 4096;

#[derive(Clone, Copy)]
enum CsiNormState {
    Normal,
    AfterEsc,
    InCsi {
        has_private: bool,
        has_intermediate: bool,
    },
}

// vt100 0.16 has no HVP handler (`CSI ... f`), only CUP (`CSI ... H`). They are
// supposed to be equivalent, and many TUIs (btop, less, etc.) use `f`. Rewrite
// the final byte in-place before feeding the stream to vt100.
struct CsiNormalizer {
    state: CsiNormState,
}

impl CsiNormalizer {
    fn new() -> Self {
        Self {
            state: CsiNormState::Normal,
        }
    }

    fn rewrite(&mut self, buf: &mut [u8]) {
        for b in buf.iter_mut() {
            if *b == 0x1b {
                self.state = CsiNormState::AfterEsc;
                continue;
            }
            match self.state {
                CsiNormState::Normal => {}
                CsiNormState::AfterEsc => {
                    if *b == b'[' {
                        self.state = CsiNormState::InCsi {
                            has_private: false,
                            has_intermediate: false,
                        };
                    } else {
                        self.state = CsiNormState::Normal;
                    }
                }
                CsiNormState::InCsi {
                    has_private,
                    has_intermediate,
                } => match *b {
                    0x3c..=0x3f => {
                        self.state = CsiNormState::InCsi {
                            has_private: true,
                            has_intermediate,
                        };
                    }
                    0x30..=0x3b => {}
                    0x20..=0x2f => {
                        self.state = CsiNormState::InCsi {
                            has_private,
                            has_intermediate: true,
                        };
                    }
                    0x40..=0x7e => {
                        if *b == b'f' && !has_private && !has_intermediate {
                            *b = b'H';
                        }
                        self.state = CsiNormState::Normal;
                    }
                    _ => {
                        self.state = CsiNormState::Normal;
                    }
                },
            }
        }
    }
}

enum SniffState {
    Idle,
    SawEsc,
    InOsc,
    InOscSawEsc,
}

struct OscSniffer {
    state: SniffState,
    buf: Vec<u8>,
}

impl OscSniffer {
    fn new() -> Self {
        Self {
            state: SniffState::Idle,
            buf: Vec::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8], mut on_complete: impl FnMut(&[u8])) {
        for &b in bytes {
            match self.state {
                SniffState::Idle => {
                    if b == 0x1b {
                        self.state = SniffState::SawEsc;
                    }
                }
                SniffState::SawEsc => match b {
                    b']' => {
                        self.state = SniffState::InOsc;
                        self.buf.clear();
                    }
                    0x1b => {}
                    _ => self.state = SniffState::Idle,
                },
                SniffState::InOsc => match b {
                    0x07 => {
                        on_complete(&self.buf);
                        self.buf.clear();
                        self.state = SniffState::Idle;
                    }
                    0x1b => self.state = SniffState::InOscSawEsc,
                    _ => {
                        if self.buf.len() < OSC_SNIFF_CAP {
                            self.buf.push(b);
                        } else {
                            self.buf.clear();
                            self.state = SniffState::Idle;
                        }
                    }
                },
                SniffState::InOscSawEsc => match b {
                    b'\\' => {
                        on_complete(&self.buf);
                        self.buf.clear();
                        self.state = SniffState::Idle;
                    }
                    b']' => {
                        self.buf.clear();
                        self.state = SniffState::InOsc;
                    }
                    0x1b => {}
                    _ => {
                        if self.buf.len() + 2 <= OSC_SNIFF_CAP {
                            self.buf.push(0x1b);
                            self.buf.push(b);
                            self.state = SniffState::InOsc;
                        } else {
                            self.buf.clear();
                            self.state = SniffState::Idle;
                        }
                    }
                },
            }
        }
    }
}

fn extract_osc9(buf: &[u8]) -> Option<String> {
    let rest = buf.strip_prefix(b"9;")?;
    let s = std::str::from_utf8(rest).ok()?;
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

fn screen_flags(screen: &vt100::Screen) -> (bool, bool) {
    let alt = screen.alternate_screen();
    let mode = screen.mouse_protocol_mode();
    let mouse = !matches!(mode, vt100::MouseProtocolMode::None);
    (alt, mouse)
}

// These snapshot helpers take the parser Arc directly so the caller can drop
// the `server.panes` HashMap lock before taking the per-pane lock. Otherwise a
// slow pane would block every other pane operation on every connection.
pub async fn snapshot_parser(parser: &Mutex<ConfiguredParser>) -> PaneSnapshot {
    let parser = parser.lock().await;
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let (cy, cx) = screen.cursor_position();
    let grid = build_grid(screen);
    let (alt, mouse) = screen_flags(screen);
    PaneSnapshot {
        rows,
        cols,
        grid,
        cursor_x: cx,
        cursor_y: cy,
        alt_screen: alt,
        mouse_protocol: mouse,
    }
}

pub async fn snapshot_scrollback_parser(
    parser: &Mutex<ConfiguredParser>,
    offset: u16,
) -> ScrollbackSnapshot {
    let mut parser = parser.lock().await;
    parser.screen_mut().set_scrollback(offset as usize);
    let actual = parser.screen().scrollback() as u16;
    let (rows, cols) = parser.screen().size();
    let (cy, cx) = parser.screen().cursor_position();
    let grid = build_grid(parser.screen());
    let (alt, mouse) = screen_flags(parser.screen());
    parser.screen_mut().set_scrollback(0);
    ScrollbackSnapshot {
        rows,
        cols,
        grid,
        cursor_x: cx,
        cursor_y: cy,
        offset: actual,
        alt_screen: alt,
        mouse_protocol: mouse,
    }
}

pub async fn all_text_parser(parser: &Mutex<ConfiguredParser>) -> Vec<String> {
    let mut parser = parser.lock().await;
    parser.screen_mut().set_scrollback(usize::MAX);
    // vt100 caps scrollback at the buffer size passed to Parser::new (see
    // spawn_pane), so this value is bounded — but clamp anyway so this
    // function never becomes a DoS vector if that cap changes.
    let max_scrollback = parser.screen().scrollback().min(SCROLLBACK_LINES);
    let (rows, cols) = parser.screen().size();
    let total = max_scrollback.saturating_add(rows as usize);
    let mut lines = Vec::with_capacity(total);

    parser.screen_mut().set_scrollback(max_scrollback);
    {
        let screen = parser.screen();
        for r in 0..rows {
            lines.push(row_text(screen, r, cols));
        }
    }
    for k in (0..max_scrollback).rev() {
        parser.screen_mut().set_scrollback(k);
        let screen = parser.screen();
        lines.push(row_text(screen, rows - 1, cols));
    }
    parser.screen_mut().set_scrollback(0);
    lines
}

pub fn spawn_pane(cfg: PaneConfig, event_tx: broadcast::Sender<ServerMsg>) -> Result<PaneHandle> {
    let title = Arc::new(StdMutex::new(String::new()));
    let callbacks = TitleCallback {
        title: Arc::clone(&title),
    };
    let parser = Arc::new(Mutex::new(vt100::Parser::new_with_callbacks(
        cfg.rows,
        cfg.cols,
        SCROLLBACK_LINES,
        callbacks,
    )));
    let alive = Arc::new(AtomicBool::new(true));
    let exit_code = Arc::new(AtomicI32::new(EXIT_PENDING));

    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(128);
    let (resize_tx, resize_rx) = mpsc::channel::<(u16, u16)>(16);
    let (close_tx, close_rx) = mpsc::channel::<()>(1);

    let (pty, pts) = pty_process::open().context("open pty")?;
    pty.resize(pty_process::Size::new(cfg.rows, cfg.cols))
        .context("pty resize")?;

    let mut cmd = pty_process::Command::new(&cfg.shell);
    cmd = cmd.args(&cfg.args);
    if let Some(d) = &cfg.cwd {
        cmd = cmd.current_dir(d);
    }
    let mut has_term = false;
    let mut has_colorterm = false;
    for (k, v) in &cfg.env {
        cmd = cmd.env(k, v);
        if k == "TERM" {
            has_term = true;
        }
        if k == "COLORTERM" {
            has_colorterm = true;
        }
    }
    if !has_term {
        cmd = cmd.env("TERM", "xterm-256color");
    }
    if !has_colorterm {
        cmd = cmd.env("COLORTERM", "truecolor");
    }

    let child = cmd.spawn(pts).context("spawn shell")?;

    let id_task = cfg.id;
    let parser_task = Arc::clone(&parser);
    let alive_task = Arc::clone(&alive);
    let exit_task = Arc::clone(&exit_code);
    let title_task = Arc::clone(&title);

    let task = tokio::spawn(async move {
        run_pane(
            id_task,
            pty,
            child,
            parser_task,
            alive_task,
            exit_task,
            title_task,
            write_rx,
            resize_rx,
            close_rx,
            event_tx,
        )
        .await;
    });

    Ok(PaneHandle {
        alive,
        exit_code,
        title,
        parser,
        write_tx,
        resize_tx,
        close_tx,
        session: cfg.session,
        task,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_pane(
    id: String,
    pty: pty_process::Pty,
    mut child: tokio::process::Child,
    parser: Arc<Mutex<ConfiguredParser>>,
    alive: Arc<AtomicBool>,
    exit_code: Arc<AtomicI32>,
    title_state: Arc<StdMutex<String>>,
    mut write_rx: mpsc::Receiver<Vec<u8>>,
    mut resize_rx: mpsc::Receiver<(u16, u16)>,
    mut close_rx: mpsc::Receiver<()>,
    event_tx: broadcast::Sender<ServerMsg>,
) {
    let (mut reader, mut writer) = pty.into_split();
    let mut read_buf = vec![0u8; 8192];
    let mut last_broadcast_title = String::new();
    let mut sniffer = OscSniffer::new();
    let mut csi_norm = CsiNormalizer::new();
    let mut refresh = tokio::time::interval_at(
        Instant::now() + Duration::from_millis(16),
        Duration::from_millis(16),
    );
    refresh.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut dirty = false;

    loop {
        tokio::select! {
            read = reader.read(&mut read_buf) => {
                match read {
                    Ok(0) => {
                        info!(%id, "pty eof");
                        break;
                    }
                    Ok(n) => {
                        csi_norm.rewrite(&mut read_buf[..n]);
                        let mut p = parser.lock().await;
                        p.process(&read_buf[..n]);
                        dirty = true;
                        drop(p);
                        let mut notif_bodies: Vec<String> = Vec::new();
                        sniffer.feed(&read_buf[..n], |osc| {
                            if let Some(body) = extract_osc9(osc) {
                                notif_bodies.push(body);
                            }
                        });
                        if !notif_bodies.is_empty() && event_tx.receiver_count() > 0 {
                            for body in notif_bodies {
                                let _ = event_tx.send(ServerMsg::Notification {
                                    pane_id: id.clone(),
                                    body,
                                });
                            }
                        }
                        let current_title = title_state.lock()
                            .map(|t| t.clone())
                            .unwrap_or_default();
                        if current_title != last_broadcast_title {
                            last_broadcast_title = current_title.clone();
                            if event_tx.receiver_count() > 0 {
                                let _ = event_tx.send(ServerMsg::Title {
                                    pane_id: id.clone(),
                                    title: current_title,
                                });
                            }
                        }
                    }
                    Err(e) => {
                        warn!(%id, err=%e, "pty read");
                        break;
                    }
                }
            }
            Some(data) = write_rx.recv() => {
                if let Err(e) = writer.write_all(&data).await {
                    warn!(%id, err=%e, "pty write");
                }
            }
            Some((cols, rows)) = resize_rx.recv() => {
                let _ = writer.resize(pty_process::Size::new(rows, cols));
                parser.lock().await.screen_mut().set_size(rows, cols);
                dirty = true;
            }
            _ = refresh.tick(), if dirty => {
                if event_tx.receiver_count() > 0 {
                    let p = parser.lock().await;
                    emit_update(&event_tx, &id, &p);
                }
                dirty = false;
            }
            Some(_) = close_rx.recv() => {
                info!(%id, "close requested");
                let _ = child.start_kill();
                break;
            }
            result = child.wait() => {
                info!(%id, "child exited");
                let code = match result {
                    Ok(s) => s.code().unwrap_or(-1),
                    Err(_) => -1,
                };
                exit_code.store(code, Ordering::SeqCst);
                alive.store(false, Ordering::SeqCst);
                let _ = event_tx.send(ServerMsg::PaneExit {
                    pane_id: id.clone(),
                    exit_code: code,
                });
                return;
            }
        }
    }

    let code = match child.wait().await {
        Ok(s) => s.code().unwrap_or(-1),
        Err(_) => -1,
    };
    exit_code.store(code, Ordering::SeqCst);
    alive.store(false, Ordering::SeqCst);
    let _ = event_tx.send(ServerMsg::PaneExit {
        pane_id: id.clone(),
        exit_code: code,
    });
}

fn emit_update(event_tx: &broadcast::Sender<ServerMsg>, id: &str, parser: &ConfiguredParser) {
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let (cy, cx) = screen.cursor_position();
    let grid = build_grid(screen);
    let (alt, mouse) = screen_flags(screen);
    let _ = event_tx.send(ServerMsg::PaneUpdate {
        pane_id: id.to_string(),
        rows,
        cols,
        cells: grid,
        cursor_x: cx,
        cursor_y: cy,
        alternate_screen: alt,
        mouse_protocol: mouse,
    });
}

fn row_text(screen: &vt100::Screen, row: u16, cols: u16) -> String {
    let mut s = String::new();
    for c in 0..cols {
        match screen.cell(row, c) {
            Some(cell) => {
                let contents = cell.contents();
                if contents.is_empty() {
                    s.push(' ');
                } else {
                    s.push_str(&contents);
                }
            }
            None => s.push(' '),
        }
    }
    s.trim_end().to_string()
}

pub(crate) fn build_grid(screen: &vt100::Screen) -> Vec<Vec<Cell>> {
    let (rows, cols) = screen.size();
    let mut grid = Vec::with_capacity(rows as usize);
    for r in 0..rows {
        let mut row = Vec::with_capacity(cols as usize);
        for c in 0..cols {
            row.push(cell_from(screen.cell(r, c)));
        }
        grid.push(row);
    }
    grid
}

fn cell_from(c: Option<&vt100::Cell>) -> Cell {
    match c {
        None => Cell::blank(),
        Some(cell) => {
            let contents = cell.contents();
            let ch = contents.chars().next().unwrap_or(' ');
            Cell {
                ch,
                fg: color_to_u32(cell.fgcolor()),
                bg: color_to_u32(cell.bgcolor()),
                bold: cell.bold(),
            }
        }
    }
}

fn color_to_u32(c: vt100::Color) -> Option<u32> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(n) => Some(n as u32),
        vt100::Color::Rgb(r, g, b) => {
            Some(crate::protocol::RGB_FLAG | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32))
        }
    }
}
