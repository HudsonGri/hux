# hux

A tiny tmux-flavoured window manager in the terminal, built on an
Ink-inspired renderer plus a flexbox layout engine (`src/layout/flex.ts`).

Each pane is a real interactive shell: your normal prompt (starship, powerlevel10k, whatever), `ls --color`, `vim`, `git log`, `htop`, whatever you'd get in a fresh terminal. The Rust server owns the PTYs (via `pty-process` + `vt100`) and broadcasts cell grids to the TypeScript client over a Unix socket; the client paints them straight into the flex-laid-out screen buffer.

## Run (dev)

```bash
bun install
cargo build --release --manifest-path server/Cargo.toml
swift build -c release --package-path daemon   # optional, only for Ghostty drag-out
bun run start
```

## Install

```bash
curl -fsSL https://hux.sh | sh
```

The installer downloads the latest macOS release asset, verifies the published
SHA-256 checksum, installs `hux` to `~/.local/bin`, and installs helper binaries
to `~/.hux/bin`.

## Build (production)

```bash
bun run build          # server + daemon + compiled ./hux client
./hux
```

`bun run build` runs `build:server` (cargo release), `build:daemon` (Swift release, macOS only), and `build:client` (`bun build --compile --minify` of `src/index.ts` into a standalone `./hux`). Use the individual scripts if you only want one artifact.

Before cutting a release, run:

```bash
bun run check
bun run build
```

The Swift daemon is only needed for the Ghostty drag-integration feature. The first time you drag a pane out of the terminal window, macOS prompts you to grant the daemon Accessibility permission (System Settings → Privacy & Security → Accessibility). Until you grant it, drags stay inside hux and the status line explains why.

Snapshots print static chrome (no shell attached):

```bash
bun run snapshot
```

`Ctrl+B q` quits. `Esc` cancels an in-progress drag.

## Mouse

- **click a pane**: focus it
- **click a tab**: switch to it
- **click `+`**: new tab (new shell)
- **drag a pane header onto another pane**: swap them
- **drag a pane header onto a tab**: move the pane into that tab
- **drag a pane header onto the tab bar**: promote the pane into its own tab
- **drag a pane header out of the terminal window**: hand the pane off to a new Ghostty tab (or new window if you drop outside Ghostty). Requires the Swift drag daemon + Accessibility permission; first drag triggers the permission prompt.
- **drag a tab onto a pane**: fold the tab's pane tree into that pane
- **drag a tab between tabs**: reorder

## Keys

Outside prefix, keystrokes go straight to the focused pane's shell. Prefix is `Ctrl+B`:

| prefix key | action |
| --- | --- |
| `%` | split current pane left/right (new shell) |
| `"` | split current pane top/bottom (new shell) |
| `c` | new tab |
| `x` | close current pane (kills its shell) |
| `e` | eject current pane: detaches the pane's shell but leaves it alive on the server; run `hux pane-view <id>` in another terminal to reattach |
| `E` | eject current tab: detaches every pane in the active tab and removes the tab from hux |
| `n` / `p` | next / previous tab |
| `1`–`9` | jump to tab n |
| arrows | cycle focus between panes |
| `q` | quit |
| `?` | show shortcuts in the status bar |

Shells get `TERM=xterm-256color` and `COLORTERM=truecolor`. RGB output from programs is mapped down to the nearest 256-palette entry (that's what our cell renderer speaks).

## Files

- `src/index.ts`: terminal I/O, SGR mouse + drag, key routing, session lifecycle (spawn on split / new-tab, dispose on close / shell-exit)
- `src/terminal.ts`: `RemoteSession` per pane that subscribes to `pane_update` / `pane_exit` / `title` broadcasts from the server and paints the cell grid into our Painter
- `src/ipc.ts` / `src/ipc-client.ts`: length-prefixed JSON protocol over the Unix socket; wraps `createPane`, `write`, `resize`, `closePane`, state snapshot/restore, plus the broadcast event bus
- `src/boot.ts`: locates the Rust server binary, spawns it detached on first attach, and re-connects via `IpcClient`
- `src/wm.ts`: pane-tree state and reducers (split, close, swap, promote, fold, reorder). Pane is now just `{ id, title, accent }`; the shell state lives in the RemoteSession
- `src/view.ts`: builds the `ViewNode` tree (tab bar, splits, status) and asks `index.ts` for a paint callback per pane
- `src/runtime.ts`: Ink-ish flex renderer with `overlays` (for the drag ghost) and `paint` (for terminal grids) extensions
- `src/layout/flex.ts`: flexbox layout engine (descended from Meta's Yoga, trimmed to hux's surface)
- `src/pane-view.ts`: single-pane viewer (`hux pane-view <id>`) that connects as a second client to the running server and renders just that pane full-window
- `src/drag-bridge.ts`: talks to the Swift drag daemon over a Unix socket; spawns the daemon on first use
- `daemon/`: Swift Package Manager project for `hux-drag-daemon`, a macOS agent that floats a preview window while the cursor is outside hux and uses AppleScript to hand the pane off to Ghostty on drop
