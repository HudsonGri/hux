import type { IpcClient, SessionInfo } from './ipc-client.js'
import type { TerminalSession } from './terminal.js'
import { filterSessionEntries } from './view.js'
import {
  collectPaneIds,
  type AppState,
  type SessionPickerEntry,
  type SessionPickerState,
} from './wm.js'

export type SessionUiDeps = {
  getState: () => AppState
  setState: (s: AppState) => void
  sessions: Map<string, TerminalSession>
  getIpc: () => IpcClient
  getCurrentSession: () => string
  setCurrentSession: (name: string) => void
  attachSessionInPlace: (name: string) => Promise<void>
  scheduleRender: () => void
  schedulePersist: () => void
}

let deps: SessionUiDeps | null = null

export function initSessionUi(d: SessionUiDeps): void {
  deps = d
}

function d(): SessionUiDeps {
  if (!deps) throw new Error('session-ui not initialized')
  return deps
}

function infoToEntry(info: SessionInfo): SessionPickerEntry {
  return {
    name: info.name,
    attached: info.attached,
    lastActiveMs: info.last_active_ms,
    paneCount: info.pane_count,
    hasState: info.has_state,
  }
}

function validateName(name: string): string | null {
  if (!name) return 'name cannot be empty'
  if (name.length > 64) return 'name too long'
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(name)) {
    return 'use alnum, dot, underscore, hyphen, or space'
  }
  return null
}

export async function openSessionPicker(): Promise<void> {
  const { getState, setState, getIpc, getCurrentSession, scheduleRender } = d()
  const ipc = getIpc()
  let entries: SessionPickerEntry[]
  try {
    const { sessions } = await ipc.listSessions()
    entries = sessions.map(infoToEntry)
  } catch (err) {
    setState({ ...getState(), status: `sessions: ${(err as Error).message}` })
    scheduleRender()
    return
  }
  const current = getCurrentSession()
  const sortedIdx = entries.findIndex(e => e.name === current)
  const picker: SessionPickerState = {
    entries,
    filter: '',
    cursor: Math.max(0, sortedIdx),
    mode: 'browse',
    draftName: '',
  }
  setState({ ...getState(), sessionPicker: picker })
  scheduleRender()
}

export function closeSessionPicker(): void {
  const { getState, setState, scheduleRender } = d()
  setState({ ...getState(), sessionPicker: undefined })
  scheduleRender()
}

export function startSessionRename(): void {
  const { getState, setState, getCurrentSession, scheduleRender } = d()
  setState({
    ...getState(),
    sessionRenaming: { buffer: getCurrentSession() },
  })
  scheduleRender()
}

export function cancelSessionRename(): void {
  const { getState, setState, scheduleRender } = d()
  setState({ ...getState(), sessionRenaming: undefined })
  scheduleRender()
}

export async function commitSessionRename(): Promise<void> {
  const { getState, setState, getIpc, getCurrentSession, setCurrentSession, scheduleRender } = d()
  const draft = getState().sessionRenaming?.buffer.trim() ?? ''
  const current = getCurrentSession()
  if (draft === current || !draft) {
    cancelSessionRename()
    return
  }
  const err = validateName(draft)
  if (err) {
    setState({
      ...getState(),
      sessionRenaming: undefined,
      status: `rename: ${err}`,
    })
    scheduleRender()
    return
  }
  try {
    await getIpc().renameSession(current, draft)
    setCurrentSession(draft)
    setState({
      ...getState(),
      sessionRenaming: undefined,
      sessionName: draft,
      status: `renamed session → ${draft}`,
    })
  } catch (e) {
    setState({
      ...getState(),
      sessionRenaming: undefined,
      status: `rename failed: ${(e as Error).message}`,
    })
  }
  scheduleRender()
}

export function appendSessionRename(char: string): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const cur = st.sessionRenaming
  if (!cur) return
  if (cur.buffer.length >= 64) return
  setState({ ...st, sessionRenaming: { buffer: cur.buffer + char } })
  scheduleRender()
}

export function backspaceSessionRename(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const cur = st.sessionRenaming
  if (!cur) return
  if (!cur.buffer) return
  setState({
    ...st,
    sessionRenaming: { buffer: cur.buffer.slice(0, -1) },
  })
  scheduleRender()
}

export function clearSessionRename(): void {
  const { getState, setState, scheduleRender } = d()
  setState({
    ...getState(),
    sessionRenaming: { buffer: '' },
  })
  scheduleRender()
}

/**
 * Bytes-to-action for the session picker. Returns the number of bytes
 * consumed from the input. Returns 0 when the picker isn't open or the key
 * doesn't apply (so the caller can try the next handler).
 */
export async function consumePickerKey(input: string): Promise<number> {
  const { getState } = d()
  const picker = getState().sessionPicker
  if (!picker) return 0
  if (input.length === 0) return 0
  const first = input[0]!

  // Consume ANSI arrow sequences in one chunk.
  if (first === '\x1b') {
    const seq = /^\x1b(?:\[[\d;?]*[ -/]*[@-~]|O[A-Z])/.exec(input)
    if (seq) {
      handleArrow(seq[0])
      return seq[0].length
    }
    if (picker.mode === 'browse') {
      closeSessionPicker()
    } else {
      exitSubmode()
    }
    return 1
  }

  if (first === '\r' || first === '\n') {
    await handleEnter()
    return 1
  }

  if (first === '\x7f' || first === '\x08') {
    handleBackspace()
    return 1
  }

  if (first === '\x15') {
    // Ctrl-U clears the current line (filter or draft).
    handleClearLine()
    return 1
  }

  if (first === '\x03') {
    closeSessionPicker()
    return 1
  }

  // Submode-specific handlers.
  if (picker.mode === 'confirm-kill') {
    if (first === 'y' || first === 'Y') {
      await commitKill()
      return 1
    }
    if (first === 'n' || first === 'N') {
      exitSubmode()
      return 1
    }
    return 1
  }

  if (picker.mode === 'browse') {
    if (first === 'n') {
      enterCreateMode()
      return 1
    }
    if (first === 'r') {
      enterRenameMode()
      return 1
    }
    if (first === 'd') {
      enterKillMode()
      return 1
    }
    if (first === 'j') {
      moveCursor(1)
      return 1
    }
    if (first === 'k') {
      moveCursor(-1)
      return 1
    }
  }

  // Printable characters append to filter (browse) or draft (create/rename).
  const code = first.charCodeAt(0)
  if (code >= 0x20 && code < 0x7f) {
    const char = Array.from(input)[0]!
    if (picker.mode === 'browse') {
      appendFilter(char)
    } else {
      appendDraft(char)
    }
    return char.length
  }
  return 1
}

function handleArrow(seq: string): void {
  if (seq === '\x1b[A' || seq === '\x1bOA') moveCursor(-1)
  else if (seq === '\x1b[B' || seq === '\x1bOB') moveCursor(1)
}

function moveCursor(delta: number): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const visible = filterSessionEntries(picker.entries, picker.filter)
  if (visible.length === 0) return
  const next = (picker.cursor + delta + visible.length) % visible.length
  if (next === picker.cursor) return
  setState({ ...st, sessionPicker: { ...picker, cursor: next } })
  scheduleRender()
}

function appendFilter(char: string): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const nextFilter = picker.filter + char
  const visible = filterSessionEntries(picker.entries, nextFilter)
  const cursor = visible.length === 0 ? 0 : Math.min(picker.cursor, visible.length - 1)
  setState({
    ...st,
    sessionPicker: { ...picker, filter: nextFilter, cursor, lastError: undefined },
  })
  scheduleRender()
}

function appendDraft(char: string): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  if (picker.draftName.length >= 64) return
  setState({
    ...st,
    sessionPicker: { ...picker, draftName: picker.draftName + char, lastError: undefined },
  })
  scheduleRender()
}

function handleBackspace(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  if (picker.mode === 'browse') {
    if (!picker.filter) return
    const nextFilter = picker.filter.slice(0, -1)
    const visible = filterSessionEntries(picker.entries, nextFilter)
    const cursor = visible.length === 0 ? 0 : Math.min(picker.cursor, visible.length - 1)
    setState({
      ...st,
      sessionPicker: { ...picker, filter: nextFilter, cursor, lastError: undefined },
    })
  } else {
    if (!picker.draftName) return
    setState({
      ...st,
      sessionPicker: { ...picker, draftName: picker.draftName.slice(0, -1) },
    })
  }
  scheduleRender()
}

function handleClearLine(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  if (picker.mode === 'browse') {
    setState({
      ...st,
      sessionPicker: { ...picker, filter: '', cursor: 0, lastError: undefined },
    })
  } else {
    setState({ ...st, sessionPicker: { ...picker, draftName: '' } })
  }
  scheduleRender()
}

async function handleEnter(): Promise<void> {
  const { getState } = d()
  const picker = getState().sessionPicker
  if (!picker) return
  switch (picker.mode) {
    case 'browse':
      await commitAttach()
      return
    case 'create':
      await commitCreate()
      return
    case 'rename':
      await commitPickerRename()
      return
    case 'confirm-kill':
      await commitKill()
      return
  }
}

async function commitAttach(): Promise<void> {
  const {
    getState,
    getCurrentSession,
    attachSessionInPlace,
    setState,
    scheduleRender,
  } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const visible = filterSessionEntries(picker.entries, picker.filter)
  if (visible.length === 0) return
  const cursor = Math.min(picker.cursor, visible.length - 1)
  const chosen = visible[cursor]!
  if (chosen.name === getCurrentSession()) {
    closeSessionPicker()
    return
  }
  setState({ ...st, sessionPicker: undefined, status: `attaching ${chosen.name}…` })
  scheduleRender()
  try {
    await attachSessionInPlace(chosen.name)
  } catch (err) {
    setState({
      ...getState(),
      status: `attach failed: ${(err as Error).message}`,
    })
    scheduleRender()
  }
}

async function commitCreate(): Promise<void> {
  const {
    getState,
    getIpc,
    setState,
    attachSessionInPlace,
    scheduleRender,
  } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const draft = picker.draftName.trim()
  const err = validateName(draft)
  if (err) {
    setState({ ...st, sessionPicker: { ...picker, lastError: err } })
    scheduleRender()
    return
  }
  try {
    await getIpc().createSession(draft)
  } catch (e) {
    setState({
      ...st,
      sessionPicker: { ...picker, lastError: (e as Error).message },
    })
    scheduleRender()
    return
  }
  setState({ ...getState(), sessionPicker: undefined, status: `created ${draft}` })
  scheduleRender()
  try {
    await attachSessionInPlace(draft)
  } catch (e) {
    setState({ ...getState(), status: `attach failed: ${(e as Error).message}` })
    scheduleRender()
  }
}

async function commitPickerRename(): Promise<void> {
  const { getState, getIpc, getCurrentSession, setCurrentSession, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const visible = filterSessionEntries(picker.entries, picker.filter)
  if (visible.length === 0) return
  const from = visible[Math.min(picker.cursor, visible.length - 1)]!.name
  const to = picker.draftName.trim()
  if (from === to || !to) {
    exitSubmode()
    return
  }
  const err = validateName(to)
  if (err) {
    setState({ ...st, sessionPicker: { ...picker, lastError: err } })
    scheduleRender()
    return
  }
  try {
    await getIpc().renameSession(from, to)
  } catch (e) {
    setState({
      ...st,
      sessionPicker: { ...picker, lastError: (e as Error).message },
    })
    scheduleRender()
    return
  }
  if (getCurrentSession() === from) {
    setCurrentSession(to)
  }
  await refreshAfterMutation(getCurrentSession() === from ? to : undefined)
}

async function commitKill(): Promise<void> {
  const { getState, getIpc, getCurrentSession, attachSessionInPlace, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const target = picker.draftName
  const current = getCurrentSession()
  try {
    await getIpc().killSession(target)
  } catch (e) {
    setState({
      ...st,
      sessionPicker: { ...picker, mode: 'browse', lastError: (e as Error).message },
    })
    scheduleRender()
    return
  }
  if (current === target) {
    // Killed the session we were on: attach to another, or create default.
    const { sessions } = await getIpc().listSessions()
    const fallback = sessions.find(s => s.name !== target)?.name ?? 'default'
    setState({ ...getState(), sessionPicker: undefined })
    try {
      await attachSessionInPlace(fallback)
    } catch (e) {
      setState({ ...getState(), status: `attach after kill failed: ${(e as Error).message}` })
    }
    scheduleRender()
    return
  }
  await refreshAfterMutation()
}

async function refreshAfterMutation(newCurrent?: string): Promise<void> {
  const { getState, setState, getIpc, scheduleRender } = d()
  try {
    const { sessions } = await getIpc().listSessions()
    const entries = sessions.map(infoToEntry)
    const st = getState()
    const picker = st.sessionPicker
    if (!picker) return
    const nextCursor = Math.min(picker.cursor, Math.max(0, entries.length - 1))
    setState({
      ...st,
      sessionPicker: {
        entries,
        filter: picker.filter,
        cursor: nextCursor,
        mode: 'browse',
        draftName: '',
      },
      sessionName: newCurrent ?? st.sessionName,
    })
  } catch (e) {
    setState({
      ...getState(),
      sessionPicker: { ...getState().sessionPicker!, lastError: (e as Error).message },
    })
  }
  scheduleRender()
}

function enterCreateMode(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  setState({
    ...st,
    sessionPicker: { ...picker, mode: 'create', draftName: '', lastError: undefined },
  })
  scheduleRender()
}

function enterRenameMode(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const visible = filterSessionEntries(picker.entries, picker.filter)
  if (visible.length === 0) return
  const target = visible[Math.min(picker.cursor, visible.length - 1)]!
  setState({
    ...st,
    sessionPicker: {
      ...picker,
      mode: 'rename',
      draftName: target.name,
      lastError: undefined,
    },
  })
  scheduleRender()
}

function enterKillMode(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  const visible = filterSessionEntries(picker.entries, picker.filter)
  if (visible.length === 0) return
  const target = visible[Math.min(picker.cursor, visible.length - 1)]!
  setState({
    ...st,
    sessionPicker: {
      ...picker,
      mode: 'confirm-kill',
      draftName: target.name,
      lastError: undefined,
    },
  })
  scheduleRender()
}

function exitSubmode(): void {
  const { getState, setState, scheduleRender } = d()
  const st = getState()
  const picker = st.sessionPicker
  if (!picker) return
  setState({
    ...st,
    sessionPicker: { ...picker, mode: 'browse', draftName: '', lastError: undefined },
  })
  scheduleRender()
}

// Export a convenience used by the caller's rename key consumer.
export function isSessionPickerOpen(state: AppState): boolean {
  return !!state.sessionPicker
}

// Unused imports would error under strict settings — reference here if needed.
export const __internal = { collectPaneIds }
