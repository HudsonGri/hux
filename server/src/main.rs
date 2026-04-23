mod framing;
mod pane;
mod protocol;
mod server;

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex as TokioMutex;
use tracing::{error, info, warn};

use crate::framing::{read_frame, write_frame};
use crate::pane::{
    all_text_parser, snapshot_parser, snapshot_scrollback_parser, spawn_pane, ConfiguredParser,
    PaneConfig, EXIT_PENDING,
};
use crate::protocol::{ByeReason, ClientMsg, PaneInfo, ServerMsg, PROTOCOL_VERSION};
use crate::server::{now_ms, SessionEntry, SharedServer, DEFAULT_SESSION};

fn socket_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".hux").join("server.sock"))
}

fn ensure_socket_dir(path: &PathBuf) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let path = socket_path()?;
    ensure_socket_dir(&path)?;
    remove_stale_socket_or_bail(&path).await?;

    let listener =
        UnixListener::bind(&path).with_context(|| format!("bind socket at {}", path.display()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod socket at {}", path.display()))?;
    info!(path = %path.display(), "listening");

    let server = SharedServer::new();

    let mut shutdown_rx = server.shutdown_tx.subscribe();
    let server_for_sig = Arc::clone(&server);
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                error!(err = ?e, "sigterm install");
                return;
            }
        };
        let mut sighup = match signal(SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                error!(err = ?e, "sighup install");
                return;
            }
        };
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    info!("SIGINT received");
                    server_for_sig.trigger_shutdown();
                    return;
                }
                _ = sigterm.recv() => {
                    info!("SIGTERM received");
                    server_for_sig.trigger_shutdown();
                    return;
                }
                _ = sighup.recv() => {
                    info!("SIGHUP ignored");
                }
            }
        }
    });

    loop {
        tokio::select! {
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _addr)) => {
                        let server = Arc::clone(&server);
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(server, stream).await {
                                warn!(err = ?e, "connection ended");
                            }
                        });
                    }
                    Err(e) => {
                        error!(err = ?e, "accept failed");
                    }
                }
            }
            _ = shutdown_rx.recv() => {
                info!("shutting down");
                break;
            }
        }
    }

    close_all_panes(&server).await;
    let _ = std::fs::remove_file(&path);
    Ok(())
}

async fn remove_stale_socket_or_bail(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    match UnixStream::connect(path).await {
        Ok(_) => bail!("hux-server already running at {}", path.display()),
        Err(_) => {
            std::fs::remove_file(path)
                .with_context(|| format!("remove stale socket at {}", path.display()))?;
            Ok(())
        }
    }
}

async fn close_all_panes(server: &SharedServer) {
    let handles: Vec<_> = {
        let mut panes = server.panes.lock().await;
        panes.drain().map(|(_, handle)| handle).collect()
    };
    for handle in &handles {
        let _ = handle.close_tx.send(()).await;
    }
    for handle in handles {
        let mut task = handle.task;
        if tokio::time::timeout(std::time::Duration::from_millis(750), &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }
}

async fn handle_connection(server: Arc<SharedServer>, stream: UnixStream) -> Result<()> {
    let result = run_session(Arc::clone(&server), stream).await;
    info!("client disconnected");
    result
}

type Writer = Arc<TokioMutex<tokio::net::unix::OwnedWriteHalf>>;

async fn run_session(server: Arc<SharedServer>, stream: UnixStream) -> Result<()> {
    let (mut reader, writer) = stream.into_split();
    let writer: Writer = Arc::new(TokioMutex::new(writer));
    let mut event_rx = server.event_tx.subscribe();

    let writer_for_events = Arc::clone(&writer);
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(msg) => {
                    let mut w = writer_for_events.lock().await;
                    if write_frame(&mut *w, &msg).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // The client fell behind the broadcast buffer, so its screen
                    // is now inconsistent with the server. Silently dropping the
                    // updates leaves a stale UI — force a reconnect so it re-syncs
                    // from scratch via ListPanes + GetGrid.
                    warn!(n, "broadcast lagged — kicking client to force resync");
                    let mut w = writer_for_events.lock().await;
                    let _ = write_frame(
                        &mut *w,
                        &ServerMsg::Bye {
                            reason: ByeReason::Kicked,
                        },
                    )
                    .await;
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let result = command_loop(server, &mut reader, writer).await;
    event_task.abort();
    result
}

async fn command_loop(
    server: Arc<SharedServer>,
    reader: &mut tokio::net::unix::OwnedReadHalf,
    writer: Writer,
) -> Result<()> {
    // Per-connection state: which session (if any) this client has attached
    // to. Used on disconnect to decrement the session's attached count so the
    // picker shows accurate live-client numbers.
    let mut attached_session: Option<String> = None;

    let result: Result<()> = async {
        loop {
            let msg: Option<ClientMsg> = read_frame(reader).await?;
            let Some(msg) = msg else {
                return Ok(());
            };

            match msg {
                ClientMsg::Hello { id, version } => {
                    info!(%version, "hello");
                    send_ack(
                        &writer,
                        id,
                        serde_json::json!({ "version": PROTOCOL_VERSION }),
                    )
                    .await?;
                }
                ClientMsg::AttachSession { id, name, create } => {
                    if let Err(msg) = validate_session_name(&name) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let mut sessions = server.sessions.lock().await;
                    let is_new = !sessions.contains_key(&name);
                    if is_new && !create {
                        drop(sessions);
                        send_err(&writer, id, &format!("no such session: {name}")).await?;
                        continue;
                    }
                    let entry = sessions
                        .entry(name.clone())
                        .or_insert_with(|| SessionEntry {
                            last_active_ms: now_ms(),
                            ..Default::default()
                        });
                    entry.attached = entry.attached.saturating_add(1);
                    entry.last_active_ms = now_ms();
                    let attached_count = entry.attached;
                    drop(sessions);

                    // If the client is switching sessions on an existing
                    // connection, decrement the previous session's attached
                    // count so the picker's numbers stay honest.
                    if let Some(prev) = attached_session.take() {
                        if prev != name {
                            let mut sessions = server.sessions.lock().await;
                            if let Some(pe) = sessions.get_mut(&prev) {
                                pe.attached = pe.attached.saturating_sub(1);
                            }
                        }
                    }
                    attached_session = Some(name.clone());
                    send_ack(
                        &writer,
                        id,
                        serde_json::json!({
                            "name": name,
                            "created": is_new,
                            "attached": attached_count,
                        }),
                    )
                    .await?;
                }
                ClientMsg::ListSessions { id } => {
                    let sessions = server.sessions.lock().await;
                    let panes = server.panes.lock().await;
                    let mut pane_counts: std::collections::HashMap<String, u32> =
                        std::collections::HashMap::new();
                    for h in panes.values() {
                        *pane_counts.entry(h.session.clone()).or_insert(0) += 1;
                    }
                    drop(panes);
                    let mut out: Vec<serde_json::Value> = sessions
                        .iter()
                        .map(|(name, e)| {
                            serde_json::json!({
                                "name": name,
                                "attached": e.attached,
                                "last_active_ms": e.last_active_ms,
                                "pane_count": pane_counts.get(name).copied().unwrap_or(0),
                                "has_state": e.blob.is_some(),
                            })
                        })
                        .collect();
                    out.sort_by(|a, b| {
                        let la = a["last_active_ms"].as_u64().unwrap_or(0);
                        let lb = b["last_active_ms"].as_u64().unwrap_or(0);
                        lb.cmp(&la)
                    });
                    drop(sessions);
                    send_ack(&writer, id, serde_json::json!({ "sessions": out })).await?;
                }
                ClientMsg::CreateSession { id, name } => {
                    if let Err(msg) = validate_session_name(&name) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let mut sessions = server.sessions.lock().await;
                    if sessions.contains_key(&name) {
                        drop(sessions);
                        send_err(&writer, id, &format!("session already exists: {name}")).await?;
                    } else {
                        sessions.insert(
                            name.clone(),
                            SessionEntry {
                                last_active_ms: now_ms(),
                                ..Default::default()
                            },
                        );
                        drop(sessions);
                        send_ack(&writer, id, serde_json::json!({ "name": name })).await?;
                    }
                }
                ClientMsg::KillSession { id, name } => {
                    if let Err(msg) = validate_session_name(&name) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let mut sessions = server.sessions.lock().await;
                    let removed = sessions.remove(&name);
                    drop(sessions);
                    if removed.is_none() {
                        send_err(&writer, id, &format!("no such session: {name}")).await?;
                        continue;
                    }
                    // Cascade: close every pane tagged with this session.
                    let mut panes = server.panes.lock().await;
                    let victim_ids: Vec<String> = panes
                        .iter()
                        .filter(|(_, h)| h.session == name)
                        .map(|(k, _)| k.clone())
                        .collect();
                    let mut handles = Vec::with_capacity(victim_ids.len());
                    for pid in &victim_ids {
                        if let Some(h) = panes.remove(pid) {
                            handles.push(h);
                        }
                    }
                    drop(panes);
                    for h in handles {
                        let _ = h.close_tx.send(()).await;
                    }
                    // Track whether this connection was attached to the now-dead
                    // session — if so, clear so a later disconnect doesn't try to
                    // decrement a missing entry.
                    if attached_session.as_deref() == Some(&name) {
                        attached_session = None;
                    }
                    send_ack(
                        &writer,
                        id,
                        serde_json::json!({
                            "killed": name,
                            "panes_closed": victim_ids.len(),
                        }),
                    )
                    .await?;
                }
                ClientMsg::RenameSession { id, from, to } => {
                    if let Err(msg) = validate_session_name(&from) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    if let Err(msg) = validate_session_name(&to) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let mut sessions = server.sessions.lock().await;
                    if !sessions.contains_key(&from) {
                        drop(sessions);
                        send_err(&writer, id, &format!("no such session: {from}")).await?;
                        continue;
                    }
                    if from != to && sessions.contains_key(&to) {
                        drop(sessions);
                        send_err(&writer, id, &format!("session already exists: {to}")).await?;
                        continue;
                    }
                    if from != to {
                        if let Some(entry) = sessions.remove(&from) {
                            sessions.insert(to.clone(), entry);
                        }
                    }
                    drop(sessions);
                    // Retag panes so KillSession cascades stay correct.
                    if from != to {
                        let mut panes = server.panes.lock().await;
                        for h in panes.values_mut() {
                            if h.session == from {
                                h.session = to.clone();
                            }
                        }
                        drop(panes);
                        if attached_session.as_deref() == Some(&from) {
                            attached_session = Some(to.clone());
                        }
                    }
                    send_ack(&writer, id, serde_json::json!({ "from": from, "to": to })).await?;
                }
                ClientMsg::CreatePane {
                    id,
                    pane_id,
                    session,
                    cwd,
                    shell,
                    args,
                    cols,
                    rows,
                    env,
                } => {
                    if let Err(msg) = validate_dims(cols, rows) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let session_name = session
                        .or_else(|| attached_session.clone())
                        .unwrap_or_else(|| DEFAULT_SESSION.to_string());
                    if let Err(msg) = validate_session_name(&session_name) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    // Ensure the session entry exists so ListSessions stays
                    // consistent. create_pane from a client that hasn't yet
                    // called attach_session (e.g., the initial bootstrap)
                    // should still land in a real session bucket.
                    {
                        let mut sessions = server.sessions.lock().await;
                        sessions
                            .entry(session_name.clone())
                            .or_insert_with(|| SessionEntry {
                                last_active_ms: now_ms(),
                                ..Default::default()
                            });
                    }
                    let mut panes = server.panes.lock().await;
                    if panes.contains_key(&pane_id) {
                        drop(panes);
                        send_err(&writer, id, "pane already exists").await?;
                    } else {
                        let cfg = PaneConfig {
                            id: pane_id.clone(),
                            session: session_name,
                            cwd,
                            shell,
                            args,
                            cols,
                            rows,
                            env,
                        };
                        match spawn_pane(cfg, server.event_tx.clone()) {
                            Ok(handle) => {
                                panes.insert(pane_id.clone(), handle);
                                drop(panes);
                                send_ack(&writer, id, serde_json::json!({})).await?;
                            }
                            Err(err) => {
                                drop(panes);
                                send_err(&writer, id, &format!("spawn: {err}")).await?;
                            }
                        }
                    }
                }
                ClientMsg::ClosePane { id, pane_id } => {
                    let mut panes = server.panes.lock().await;
                    let handle = panes.remove(&pane_id);
                    drop(panes);
                    if let Some(handle) = handle {
                        let _ = handle.close_tx.send(()).await;
                        send_ack(&writer, id, serde_json::json!({})).await?;
                    } else {
                        send_err(&writer, id, "no such pane").await?;
                    }
                }
                ClientMsg::Write { id, pane_id, data } => {
                    let panes = server.panes.lock().await;
                    let tx = panes.get(&pane_id).map(|h| h.write_tx.clone());
                    drop(panes);
                    if let Some(tx) = tx {
                        // If the PTY is backed up, don't let a single pane block the
                        // whole command loop. A short timeout gives normal bursts room
                        // to queue while still surfacing a hung reader to the client.
                        let fut = tx.send(data.into_bytes());
                        match tokio::time::timeout(std::time::Duration::from_secs(2), fut).await {
                            Ok(Ok(())) => send_ack(&writer, id, serde_json::json!({})).await?,
                            Ok(Err(_)) => send_err(&writer, id, "pane closed").await?,
                            Err(_) => send_err(&writer, id, "pane write timed out").await?,
                        }
                    } else {
                        send_err(&writer, id, "no such pane").await?;
                    }
                }
                ClientMsg::Resize {
                    id,
                    pane_id,
                    cols,
                    rows,
                } => {
                    if let Err(msg) = validate_dims(cols, rows) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    let panes = server.panes.lock().await;
                    let tx = panes.get(&pane_id).map(|h| h.resize_tx.clone());
                    drop(panes);
                    if let Some(tx) = tx {
                        let _ = tx.send((cols, rows)).await;
                        send_ack(&writer, id, serde_json::json!({})).await?;
                    } else {
                        send_err(&writer, id, "no such pane").await?;
                    }
                }
                ClientMsg::GetGrid { id, pane_id } => {
                    let parser = parser_for(&server, &pane_id).await;
                    match parser {
                        Some(p) => {
                            let s = snapshot_parser(&p).await;
                            send_ack(
                                &writer,
                                id,
                                serde_json::json!({
                                    "rows": s.rows,
                                    "cols": s.cols,
                                    "cells": s.grid,
                                    "cursor_x": s.cursor_x,
                                    "cursor_y": s.cursor_y,
                                    "alternate_screen": s.alt_screen,
                                    "mouse_protocol": s.mouse_protocol,
                                }),
                            )
                            .await?;
                        }
                        None => send_err(&writer, id, "no such pane").await?,
                    }
                }
                ClientMsg::GetScrollback {
                    id,
                    pane_id,
                    offset,
                } => {
                    let parser = parser_for(&server, &pane_id).await;
                    match parser {
                        Some(p) => {
                            let s = snapshot_scrollback_parser(&p, offset).await;
                            send_ack(
                                &writer,
                                id,
                                serde_json::json!({
                                    "rows": s.rows,
                                    "cols": s.cols,
                                    "cells": s.grid,
                                    "cursor_x": s.cursor_x,
                                    "cursor_y": s.cursor_y,
                                    "offset": s.offset,
                                    "alternate_screen": s.alt_screen,
                                    "mouse_protocol": s.mouse_protocol,
                                }),
                            )
                            .await?;
                        }
                        None => send_err(&writer, id, "no such pane").await?,
                    }
                }
                ClientMsg::ListPanes { id } => {
                    let panes = server.panes.lock().await;
                    let mut infos = Vec::with_capacity(panes.len());
                    for (pid, h) in panes.iter() {
                        let alive = h.alive.load(std::sync::atomic::Ordering::SeqCst);
                        let ec = h.exit_code.load(std::sync::atomic::Ordering::SeqCst);
                        let exit_code = if alive || ec == EXIT_PENDING {
                            None
                        } else {
                            Some(ec)
                        };
                        let title_s = h.title.lock().map(|t| t.clone()).unwrap_or_default();
                        let title = if title_s.is_empty() {
                            None
                        } else {
                            Some(title_s)
                        };
                        infos.push(PaneInfo {
                            id: pid.clone(),
                            session: h.session.clone(),
                            alive,
                            exit_code,
                            title,
                        });
                    }
                    drop(panes);
                    send_ack(&writer, id, serde_json::json!({ "panes": infos })).await?;
                }
                ClientMsg::GetState { id, session } => {
                    let name = session
                        .or_else(|| attached_session.clone())
                        .unwrap_or_else(|| DEFAULT_SESSION.to_string());
                    let sessions = server.sessions.lock().await;
                    let entry = sessions.get(&name).cloned().unwrap_or_default();
                    drop(sessions);
                    send_ack(
                        &writer,
                        id,
                        serde_json::json!({
                            "session": name,
                            "version": entry.version,
                            "blob": entry.blob,
                        }),
                    )
                    .await?;
                }
                ClientMsg::SetState {
                    id,
                    session,
                    version,
                    blob,
                } => {
                    let name = session
                        .or_else(|| attached_session.clone())
                        .unwrap_or_else(|| DEFAULT_SESSION.to_string());
                    if let Err(msg) = validate_session_name(&name) {
                        send_err(&writer, id, msg).await?;
                        continue;
                    }
                    if blob.len() > MAX_STATE_BLOB_BYTES {
                        send_err(&writer, id, "state blob exceeds maximum").await?;
                        continue;
                    }
                    let mut sessions = server.sessions.lock().await;
                    let entry = sessions
                        .entry(name.clone())
                        .or_insert_with(|| SessionEntry {
                            last_active_ms: now_ms(),
                            ..Default::default()
                        });
                    if entry.version != 0 && entry.version != version {
                        let cur_ver = entry.version;
                        drop(sessions);
                        send_err(&writer, id, &format!("version mismatch: current={cur_ver}"))
                            .await?;
                    } else {
                        entry.version = version + 1;
                        entry.blob = Some(blob);
                        entry.last_active_ms = now_ms();
                        let new_ver = entry.version;
                        drop(sessions);
                        send_ack(
                            &writer,
                            id,
                            serde_json::json!({
                                "accepted": true,
                                "version": new_ver,
                            }),
                        )
                        .await?;
                    }
                }
                ClientMsg::GetScrollbackText { id, pane_id } => {
                    let parser = parser_for(&server, &pane_id).await;
                    match parser {
                        Some(p) => {
                            let lines = all_text_parser(&p).await;
                            send_ack(&writer, id, serde_json::json!({ "lines": lines })).await?;
                        }
                        None => send_err(&writer, id, "no such pane").await?,
                    }
                }
                ClientMsg::KillServer { id } => {
                    info!("kill_server");
                    send_ack(&writer, id, serde_json::json!({})).await?;
                    {
                        let mut w = writer.lock().await;
                        write_frame(
                            &mut *w,
                            &ServerMsg::Bye {
                                reason: ByeReason::Exit,
                            },
                        )
                        .await?;
                    }
                    server.trigger_shutdown();
                    return Ok(());
                }
            }
        }
    }
    .await;

    // Whether the loop ended cleanly, errored, or the client dropped, make
    // sure the attached session's live-client count decrements so the picker
    // doesn't show ghost attachments.
    if let Some(name) = attached_session.take() {
        let mut sessions = server.sessions.lock().await;
        if let Some(entry) = sessions.get_mut(&name) {
            entry.attached = entry.attached.saturating_sub(1);
        }
    }

    result
}

async fn parser_for(
    server: &SharedServer,
    pane_id: &str,
) -> Option<Arc<tokio::sync::Mutex<ConfiguredParser>>> {
    server
        .panes
        .lock()
        .await
        .get(pane_id)
        .map(|h| Arc::clone(&h.parser))
}

fn validate_dims(cols: u16, rows: u16) -> std::result::Result<(), &'static str> {
    // Zero dims produce a dead PTY; absurd dims let a client balloon per-pane
    // allocations (each pane's grid is rows*cols cells of Cell structs). Cap
    // the upper bound well above any real terminal.
    const MAX_COLS: u16 = 1024;
    const MAX_ROWS: u16 = 1024;
    if cols == 0 || rows == 0 {
        return Err("cols and rows must be non-zero");
    }
    if cols > MAX_COLS || rows > MAX_ROWS {
        return Err("cols/rows exceed maximum");
    }
    Ok(())
}

const MAX_STATE_BLOB_BYTES: usize = 512 * 1024;

fn validate_session_name(name: &str) -> std::result::Result<(), &'static str> {
    if name.is_empty() {
        return Err("session name must be non-empty");
    }
    if name.len() > 64 {
        return Err("session name too long (max 64)");
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err("session name must be non-empty");
    };
    if !(first.is_ascii_alphanumeric() || matches!(first, '.' | '_' | '-')) {
        return Err("session name must start with alnum/._-");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
    {
        return Err("session name contains invalid characters");
    }
    Ok(())
}

async fn send_ack(writer: &Writer, id: u64, data: serde_json::Value) -> Result<()> {
    let mut w = writer.lock().await;
    write_frame(&mut *w, &ServerMsg::Ack { id, data }).await
}

async fn send_err(writer: &Writer, id: u64, err: &str) -> Result<()> {
    let mut w = writer.lock().await;
    write_frame(
        &mut *w,
        &ServerMsg::Err {
            id,
            error: err.to_string(),
        },
    )
    .await
}
