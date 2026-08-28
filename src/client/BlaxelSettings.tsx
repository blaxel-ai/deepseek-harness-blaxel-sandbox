import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import {
  beginBlaxelBrowserLogin,
  closeBlaxel,
  completeBlaxelBrowserLogin,
  connectBlaxelMcp,
  disconnectBlaxelMcp,
  getStatus,
  inspectBlaxelChanges,
  installBlaxelSkills,
  loginBlaxel,
  logoutBlaxel,
  pollBlaxelBrowserLogin,
  moveBlaxelChangesLocal,
  saveBlaxelDefaults,
  switchBlaxelWorkspace,
  testBlaxelConnection,
  type SandboxDefaults,
  type SandboxSessionStatus,
  type BlaxelSettingsStatus,
  type Status,
  type BrowserLoginState,
} from './api.js'
import { SandboxIcon } from './BlaxelSidebarMarker.js'
import { formatDuration } from './format.js'

const card: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1, #1f1f1f)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))',
  borderRadius: 10,
  marginBottom: 12,
  maxWidth: 680,
  padding: '16px 18px',
}

const button: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))',
  borderRadius: 7,
  color: 'var(--dsw-alias-label-primary, #eee)',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  minHeight: 30,
  padding: '5px 10px',
  whiteSpace: 'nowrap',
}

const primaryButton: CSSProperties = {
  ...button,
  background: 'var(--dsw-alias-button-primary-fill, #316fea)',
  borderColor: 'var(--dsw-alias-button-primary-fill, #316fea)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
}
const dangerButton: CSSProperties = { ...button, color: 'var(--dsw-alias-state-error-primary, #ec1313)' }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #aaa)', fontSize: 12, lineHeight: 1.5 }
const label: CSSProperties = { display: 'grid', fontSize: 12, fontWeight: 600, gap: 6 }
const fallbackChoices: BlaxelSettingsStatus['choices'] = {
  images: [{ value: 'blaxel/ts-app:latest', label: 'TypeScript App' }],
  memory: [1024, 2048, 4096, 8192, 16384, 32768],
  regions: [{ value: '', label: 'Automatic' }],
  idleDeletion: [{ value: '', label: 'Platform default' }],
  verified: false,
}
const input: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2, #171717)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.24))',
  borderRadius: 7,
  color: 'var(--dsw-alias-label-primary, #eee)',
  font: 'inherit',
  fontSize: 13,
  minWidth: 0,
  padding: '8px 10px',
}

function SectionTitle(props: { title: string; detail: string }): ReactNode {
  return <div style={{ marginBottom: 13 }}>
    <h3 style={{ fontSize: 14, margin: 0 }}>{props.title}</h3>
    <div style={{ ...muted, marginTop: 3 }}>{props.detail}</div>
  </div>
}

function StatusPill(props: { ok: boolean; children: ReactNode }): ReactNode {
  const color = props.ok ? 'var(--dsw-alias-state-success-primary, #22c55e)' : 'var(--dsw-alias-state-warn-primary, #f59e0b)'
  return <span style={{ alignItems: 'center', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08))', border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))', borderRadius: 999, color: 'var(--dsw-alias-label-secondary, #aaa)', display: 'inline-flex', fontSize: 12, fontWeight: 600, gap: 6, padding: '3px 8px', whiteSpace: 'nowrap' }}><span aria-hidden="true" style={{ background: color, borderRadius: '50%', height: 6, width: 6 }} />{props.children}</span>
}

function SandboxCard(props: {
  sandbox: SandboxSessionStatus
  onMoveLocal: (sessionId: string) => Promise<void>
  onStop: (sessionId: string) => Promise<void>
}): ReactNode {
  const [stopping, setStopping] = useState(false)
  const [moving, setMoving] = useState(false)
  const item = props.sandbox
  return <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))', padding: '13px 0 2px' }}>
    <div style={{ alignItems: 'center', display: 'flex', gap: 7, fontWeight: 600 }}><SandboxIcon /> {item.sandbox.name}</div>
    <div style={{ ...muted, marginTop: 4 }}>{item.state} · {formatDuration(item.sandbox.uptimeMs)} · {String(item.live.processes)} active tool processes</div>
    {item.error === undefined ? null : <div style={{ color: 'var(--dsw-alias-state-warn-label, #dd8629)', fontSize: 12, marginTop: 4 }}>{item.error}</div>}
    <div style={{ ...muted, marginTop: 8 }}>Session <code>{item.sessionId}</code><br />Workspace <code>{item.sandbox.cwd}</code></div>
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
      <button type="button" style={button} disabled={moving || stopping || item.state !== 'ready'} onClick={() => {
        setMoving(true)
        void props.onMoveLocal(item.sessionId).finally(() => setMoving(false))
      }}>{moving ? 'Moving…' : 'Move to local'}</button>
      <button data-variant="danger" type="button" style={dangerButton} disabled={moving || stopping} onClick={() => {
        if (!window.confirm('Stop this sandbox and discard any changes that have not been moved locally?')) return
        setStopping(true)
        void props.onStop(item.sessionId).finally(() => setStopping(false))
      }}>{stopping ? 'Stopping…' : 'Discard sandbox'}</button>
    </div>
  </div>
}

const sourceNames = {
  'api-key-environment': 'API key environment',
  'client-credentials-environment': 'client credentials environment',
  'blaxel-host': 'Blaxel host identity',
  cli: 'Blaxel CLI',
  none: 'not connected',
} as const

export function BlaxelSettings(): ReactNode {
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [workspace, setWorkspace] = useState('')
  const [newWorkspace, setNewWorkspace] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [browserLogin, setBrowserLogin] = useState<BrowserLoginState>()
  const [browserWorkspace, setBrowserWorkspace] = useState('')
  const [defaults, setDefaults] = useState<SandboxDefaults>({ image: 'blaxel/ts-app:latest', memory: 4096 })
  const [editingDefaults, setEditingDefaults] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus()
      setStatus(next)
      setWorkspace(current => current === '' ? next.settings.connection.workspace ?? next.settings.connection.profiles[0] ?? '' : current)
      setDefaults(current => editingDefaults ? current : next.settings.defaults)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [editingDefaults])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (browserLogin?.state !== 'waiting') return
    let stopped = false
    const poll = async (): Promise<void> => {
      while (!stopped) {
        await new Promise(resolve => window.setTimeout(resolve, 1_000))
        const next = await pollBlaxelBrowserLogin(browserLogin.id)
        if (stopped) return
        if (next.state === 'choose-workspace') {
          const required = (status?.sandboxes.length ?? 0) > 0 ? status?.settings.connection.workspace : undefined
          if (required !== undefined && next.workspaces?.some(item => item.value === required) === true) {
            await completeBlaxelBrowserLogin(next.id, required)
            if (stopped) return
            setBrowserLogin(undefined)
            setBrowserWorkspace('')
            setWorkspace(required)
            setNotice(`Connected ${required}.`)
            setBusy(undefined)
            await refresh()
            return
          }
          setBrowserLogin(next)
          setBrowserWorkspace(next.workspaces?.[0]?.value ?? '')
          setNotice('Signed in. Choose the workspace to use.')
          setBusy(undefined)
          return
        }
      }
    }
    void poll().catch(cause => {
      if (stopped) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setBrowserLogin(undefined)
      setBusy(undefined)
    })
    return () => { stopped = true }
  }, [browserLogin?.id, browserLogin?.state])

  const run = async (name: string, success: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(name)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
      setNotice(success)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const stop = async (sessionId: string): Promise<void> => {
    await run('stop', 'Sandbox stopped.', async () => await closeBlaxel(sessionId))
  }

  const moveLocal = async (sessionId: string): Promise<void> => {
    setBusy('move-local')
    setError(undefined)
    setNotice(undefined)
    try {
      const divergence = await inspectBlaxelChanges(sessionId)
      const label = divergence.changed === 1 ? '1 changed file' : `${String(divergence.changed)} changed files`
      if (!window.confirm(`Apply ${label} to the original local worktree, stop this sandbox, and continue this same session locally? Conflicting local files will block safely.`)) return
      const result = await moveBlaxelChangesLocal(sessionId)
      setNotice(`${String(result.divergence.changed)} sandbox ${result.divergence.changed === 1 ? 'change' : 'changes'} applied locally. Future tools run on the local worktree.`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  const connection = status?.settings.connection
  const running = status?.sandboxes.length ?? 0
  const authLocked = connection?.managedByEnvironment === true || running > 0
  const choices = status?.settings.choices ?? fallbackChoices
  const defaultsVerified = choices.verified
  const skills = status?.settings.capabilities?.skills
  const mcp = status?.settings.capabilities?.mcp

  const saveDefaults = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await run('defaults', 'Defaults saved for new sandbox sessions.', async () => {
      await saveBlaxelDefaults(defaults)
      setEditingDefaults(false)
    })
  }

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await run('login', 'Workspace connected.', async () => {
      await loginBlaxel(newWorkspace, apiKey)
      setWorkspace(newWorkspace)
      setApiKey('')
    })
  }

  const startBrowserLogin = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setBusy('oauth')
    setError(undefined)
    setNotice(undefined)
    try {
      const next = await beginBlaxelBrowserLogin()
      setBrowserLogin(next)
      if (popup === null || next.authorizationUrl === undefined) setNotice('Open the Blaxel sign-in page below to continue.')
      else {
        popup.location.replace(next.authorizationUrl)
        setNotice('Finish signing in with Blaxel in the browser tab.')
      }
    } catch (cause) {
      popup?.close()
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(undefined)
    }
  }

  const finishBrowserLogin = async (): Promise<void> => {
    if (browserLogin === undefined || browserWorkspace === '') return
    await run('oauth-complete', `Connected ${browserWorkspace}.`, async () => {
      await completeBlaxelBrowserLogin(browserLogin.id, browserWorkspace)
      setBrowserLogin(undefined)
      setWorkspace(browserWorkspace)
    })
  }

  return <div data-blaxel-settings style={{ color: 'var(--dsw-alias-label-primary, #eee)', maxWidth: 720, paddingBottom: 28 }}>
    <style>{`
      [data-blaxel-settings] button:hover:not(:disabled):not([data-variant="primary"]):not([data-variant="danger"]) { background: var(--dsw-alias-interactive-bg-hover-solid, rgba(127, 127, 127, 0.1)) !important; }
      [data-blaxel-settings] button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #43454a) !important; border-color: var(--dsw-alias-button-primary-hover, #43454a) !important; }
      [data-blaxel-settings] button[data-variant="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05)) !important; }
      [data-blaxel-settings] button:disabled { background: var(--dsw-alias-button-primary-dimmed, rgba(127, 127, 127, 0.12)) !important; border-color: var(--dsw-alias-border-l1, transparent) !important; color: var(--dsw-alias-label-caption, #888) !important; cursor: not-allowed !important; opacity: 1; }
    `}</style>
    <h2 style={{ fontSize: 18, margin: '0 0 5px' }}>Blaxel</h2>
    <p style={{ ...muted, fontSize: 13, margin: '0 0 18px' }}>Connect your workspace, choose sandbox defaults, and manage running cloud sessions here.</p>

    <section style={card}>
      <SectionTitle title="Agent capabilities" detail="Official Blaxel skills and authenticated resource tools used by DSH agents." />
      <div style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between', paddingBottom: 13 }}>
        <div><strong style={{ fontSize: 13 }}>Blaxel skills</strong><div style={muted}>{skills?.upToDate === true ? 'Blaxel CLI and SDK guidance is current.' : skills?.installed === true ? skills.checkError ?? 'A newer skill version is available.' : 'Install the official Blaxel agent skills.'}</div></div>
        {skills?.upToDate === true
          ? <StatusPill ok>Up to date</StatusPill>
          : <button data-variant={skills?.installed === true ? undefined : 'primary'} type="button" style={skills?.installed === true ? button : primaryButton} disabled={busy !== undefined} onClick={() => void run('skills', 'Blaxel skills are up to date.', installBlaxelSkills)}>{busy === 'skills' ? 'Updating…' : skills?.installed === true ? 'Update' : 'Install'}</button>}
      </div>
      <div style={{ alignItems: 'center', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))', display: 'flex', gap: 12, justifyContent: 'space-between', paddingTop: 13 }}>
        <div><strong style={{ fontSize: 13 }}>Resource MCP</strong><div style={muted}>{mcp?.connected === true ? 'Blaxel resources are available to agents through OAuth.' : 'Connect Blaxel resource tools with browser OAuth.'}</div></div>
        {mcp?.connected === true
          ? <div style={{ alignItems: 'center', display: 'flex', gap: 8 }}><StatusPill ok>Connected</StatusPill><button type="button" style={{ ...button, padding: '5px 8px' }} disabled={busy !== undefined} onClick={() => void run('mcp-logout', 'Blaxel MCP disconnected.', disconnectBlaxelMcp)}>{busy === 'mcp-logout' ? 'Disconnecting…' : 'Disconnect'}</button></div>
          : <button data-variant="primary" type="button" style={primaryButton} disabled={busy !== undefined} onClick={() => void run('mcp-login', 'Blaxel MCP connected.', connectBlaxelMcp)}>{busy === 'mcp-login' ? 'Waiting for browser…' : 'Connect with OAuth'}</button>}
      </div>
    </section>

    <section style={card}>
      <SectionTitle title="Account" detail="Sign in with Blaxel, then select a workspace. The same secure profile is shared with the Blaxel CLI." />
      {connection === undefined ? <div style={muted}>Checking connection…</div> : <>
        <div style={{ alignItems: 'center', display: 'flex', gap: 9, marginBottom: 13 }}>
          <span aria-hidden="true" style={{ background: connection.authenticated ? '#42c77a' : '#777', borderRadius: '50%', height: 8, width: 8 }} />
          <strong>{connection.authenticated ? connection.workspace : 'Not connected'}</strong>
          <span style={muted}>{connection.environment} · {sourceNames[connection.source]}</span>
        </div>
        {connection.managedByEnvironment ? <div style={{ ...muted, marginBottom: 12 }}>Authentication is supplied by the DSH process environment. Restart DSH with different BL_* values to change it.</div> : null}
        {running > 0 && !connection.managedByEnvironment ? <div style={{ ...muted, marginBottom: 12 }}>You can reconnect {connection.workspace} while sandbox sessions are running. Switching workspaces and signing out remain locked.</div> : null}
        {connection.profiles.length > 0 ? <div style={{ marginBottom: 12 }}>
          <div style={{ alignItems: 'end', display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <label style={label}>Workspace
              <select style={input} value={workspace} disabled={authLocked} onChange={event => setWorkspace(event.target.value)}>
                {connection.profiles.map(profile => <option key={profile} value={profile}>{profile}</option>)}
              </select>
            </label>
            <button type="button" style={button} disabled={authLocked || busy !== undefined || workspace === connection.workspace} onClick={() => void run('workspace', `Using ${workspace}.`, async () => await switchBlaxelWorkspace(workspace))}>{busy === 'workspace' ? 'Switching…' : 'Use workspace'}</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={button} disabled={!connection.authenticated || busy !== undefined} onClick={() => void run('test', 'Connection verified.', testBlaxelConnection)}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            <button type="button" style={button} disabled={authLocked || !connection.authenticated || busy !== undefined || connection.workspace === undefined} onClick={() => {
              const currentWorkspace = connection.workspace
              if (currentWorkspace !== undefined) void run('logout', `${currentWorkspace} signed out.`, async () => await logoutBlaxel(currentWorkspace))
            }}>{busy === 'logout' ? 'Signing out…' : 'Sign out'}</button>
          </div>
        </div> : null}
        {!connection.managedByEnvironment ? <div style={{ borderTop: connection.profiles.length > 0 ? '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18))' : undefined, paddingTop: connection.profiles.length > 0 ? 14 : 0 }}>
          {browserLogin?.state === 'choose-workspace' ? <div style={{ alignItems: 'end', display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            <label style={label}>Choose workspace
              <select style={input} value={browserWorkspace} onChange={event => setBrowserWorkspace(event.target.value)}>
                {browserLogin.workspaces?.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <button data-variant="primary" type="button" style={primaryButton} disabled={browserWorkspace === '' || busy !== undefined} onClick={() => void finishBrowserLogin()}>{busy === 'oauth-complete' ? 'Connecting…' : 'Use workspace'}</button>
          </div> : <div style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
            <button data-variant="primary" type="button" style={primaryButton} disabled={connection.managedByEnvironment || busy !== undefined} onClick={() => void startBrowserLogin()}>{busy === 'oauth' ? 'Waiting for browser…' : running > 0 ? 'Reconnect account' : connection.authenticated ? 'Add account' : 'Sign in with browser'}</button>
            {browserLogin?.state === 'waiting' && browserLogin.authorizationUrl !== undefined ? <a href={browserLogin.authorizationUrl} rel="noreferrer" style={{ ...muted, color: '#7da7ff' }} target="_blank">Open sign-in page</a> : null}
          </div>}
          <details style={{ marginTop: 12 }}>
            <summary style={{ ...muted, cursor: 'pointer' }}>Use an API key instead</summary>
            <form onSubmit={event => void connect(event)} style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(150px, 1fr) minmax(220px, 2fr) auto', paddingTop: 10 }}>
              <label style={label}>Workspace<input autoComplete="off" required style={input} placeholder="workspace-name" value={newWorkspace} disabled={running > 0} onChange={event => setNewWorkspace(event.target.value)} /></label>
              <label style={label}>API key<input autoComplete="off" required style={input} type="password" placeholder="Paste once" value={apiKey} disabled={running > 0} onChange={event => setApiKey(event.target.value)} /></label>
              <button type="submit" style={{ ...button, alignSelf: 'end' }} disabled={running > 0 || busy !== undefined}>{busy === 'login' ? 'Connecting…' : 'Connect'}</button>
            </form>
          </details>
        </div> : null}
      </>}
    </section>

    <section style={card}>
      <SectionTitle title="New sandbox defaults" detail="Only options available to the active workspace are shown. Existing sessions keep their current resources." />
      <form onSubmit={event => void saveDefaults(event)} style={{ display: 'grid', gap: 12 }}>
        {defaultsVerified ? <div style={{ alignItems: 'center', display: 'flex', gap: 8 }}><StatusPill ok>Verified</StatusPill><span style={muted}>{choices.workspace}{choices.plan === undefined ? '' : ` · ${choices.plan.replaceAll('_', ' ')}`}{choices.tier === undefined ? '' : ` · ${choices.tier.replace('_', ' ')}`}{choices.maxMemory === undefined ? '' : ` · up to ${choices.maxMemory < 1024 ? `${String(choices.maxMemory)} MB` : `${String(choices.maxMemory / 1024)} GB`}`}</span></div> : null}
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '2fr 1fr' }}>
          <label style={label}>Container image
            <select disabled={!defaultsVerified} required style={input} value={defaults.image} onChange={event => { setEditingDefaults(true); setDefaults({ ...defaults, image: event.target.value }) }}>
              {choices.images.map(item => <option disabled={item.available === false} key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label style={label}>Memory
            <select disabled={!defaultsVerified} required style={input} value={defaults.memory} onChange={event => { setEditingDefaults(true); setDefaults({ ...defaults, memory: Number(event.target.value) }) }}>
              {choices.memory.map(value => <option key={value} value={value}>{value < 1024 ? `${String(value)} MB` : `${String(value / 1024)} GB`}</option>)}
            </select>
          </label>
          <label style={label}>Region
            <select disabled={!defaultsVerified} style={input} value={defaults.region ?? ''} onChange={event => { setEditingDefaults(true); setDefaults({ ...defaults, region: event.target.value || undefined }) }}>
              {choices.regions.map(item => <option disabled={item.available === false} key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label style={label}>Maximum lifetime
            <select disabled={!defaultsVerified} style={input} value={defaults.ttl ?? ''} onChange={event => { setEditingDefaults(true); setDefaults({ ...defaults, ttl: event.target.value || undefined }) }}>
              {choices.idleDeletion.map(item => <option disabled={item.available === false} key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>
        {!connection?.authenticated ? <div style={muted}>Connect a workspace to load and verify its sandbox options.</div> : status?.settings.choices?.unavailable === undefined ? null : <div style={muted}>Workspace options could not be verified: {status.settings.choices.unavailable}</div>}
        <div><button data-variant="primary" type="submit" style={primaryButton} disabled={!defaultsVerified || !editingDefaults || busy !== undefined}>{busy === 'defaults' ? 'Saving…' : 'Save defaults'}</button></div>
      </form>
    </section>

    <section style={card}>
      <SectionTitle title={`Running sandboxes${running === 0 ? '' : ` (${String(running)})`}`} detail="Cloud sessions remain ordinary chats in the main sidebar. The indented container marker identifies them." />
      {status === undefined && error === undefined ? <div style={muted}>Checking sandboxes…</div> : null}
      {status?.sandboxes.length === 0 ? <div style={muted}>No sandbox sessions are running.</div> : null}
      {status?.sandboxes.map(sandbox => <SandboxCard key={sandbox.sessionId} sandbox={sandbox} onMoveLocal={moveLocal} onStop={stop} />)}
    </section>

    {notice === undefined ? null : <p role="status" style={{ color: 'var(--dsw-alias-state-success-primary, #22c55e)', fontSize: 13 }}>{notice}</p>}
    {error === undefined ? null : <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary, #ec1313)', fontSize: 13 }}>{error}</p>}
  </div>
}
