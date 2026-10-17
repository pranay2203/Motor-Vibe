import { useCallback, useEffect, useState } from 'react'
import { io as createSocket } from 'socket.io-client'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

type Screen = 'home' | 'login' | 'register' | 'dashboard'
type DashboardTab = 'overview' | 'live' | 'watchlist' | 'history' | 'reports'

type User = {
  id: number
  name: string
  email: string
}

type Asset = {
  id: number
  name: string
  code: string
  value: number
  state: 'nominal' | 'observe' | 'critical'
  note: string
  temp: number
  frequency: number
  trend: string
  type?: string
  location?: string
  peakVibration?: number
  rpm?: number
  healthScore?: number
  lastUpdated?: string
  signal?: string
  dataSource?: 'mqtt' | 'simulated'
}

type FeedItem = {
  id: number
  name: string
  value: string
  status: 'Nominal' | 'Observe' | 'Critical'
  detail: string
}

type WatchListItem = {
  id: number
  asset: string
  status: string
  hz: string
  temp: string
  note: string
}

type HistoryEntry = {
  id: string
  time: string
  event: string
  type: 'warning' | 'info' | 'success' | 'critical'
}

type ReportItem = {
  id: number
  title: string
  value: string
  meta: string
}

type DashboardSummary = {
  plantPulse: number
  healthyAssets: number
  attentionAssets: number
  criticalAssets: number
  uptime: string
  output: string
}

type ChartPoint = { name: string; value: number }

type DashboardPayload = {
  summary: DashboardSummary
  assets: Asset[]
  feed: FeedItem[]
  watchlist: WatchListItem[]
  history: HistoryEntry[]
  reports: ReportItem[]
  chartData: ChartPoint[]
  readings?: SensorReading[]
  alerts?: MonitoringAlert[]
  thresholds?: Record<string, { warning: number; critical: number }>
}

type SensorReading = { id: string; assetId: number; assetName: string; timestamp: string; vibration: number; peakVibration: number; temperature: number; rpm: number; status: string }
type MonitoringAlert = { id: string; assetId: number; assetName: string; type: string; metric: string; value: number; threshold: number; severity: string; timestamp: string; status: string }
type GeneratedReport = {
  name: string
  assetLabel: string
  from: string
  to: string
  generatedAt: string
  summary: { assets: number; healthy: number; warning: number; critical: number; alerts: number; criticalAlerts: number; averageVibration: number; maximumVibration: number; averageTemperature: number; maximumTemperature: number }
  assets: Array<Asset & { averageVibration: number; maximumVibration: number; averageTemperature: number; maximumTemperature: number; alertCount: number; sampleCount: number }>
  readings: SensorReading[]
  alerts: MonitoringAlert[]
}

const apiBaseUrl = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
const apiUrl = (path: string) => `${apiBaseUrl}${path}`

const readStoredUser = (): User | null => {
  const rawUser = localStorage.getItem('motorvibe-user')

  if (!rawUser) {
    return null
  }

  try {
    return JSON.parse(rawUser) as User
  } catch {
    localStorage.removeItem('motorvibe-user')
    return null
  }
}

const getToken = () => localStorage.getItem('motorvibe-token')

function Mark() {
  return (
    <div className="mark">
      <span>∿</span>
    </div>
  )
}

function Wordmark() {
  return (
    <div className="wordmark">
      <Mark />
      <b>
        motor<span>vibe</span>
      </b>
    </div>
  )
}

function VibrationChart({ data, height }: { data: ChartPoint[]; height: number }) {
  const gradientId = `vibrationFill-${height}`

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#d6f45f" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#d6f45f" stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
        <XAxis dataKey="name" stroke="#819087" tickLine={false} axisLine={false} />
        <YAxis stroke="#819087" tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: '#0d120f',
            border: '1px solid rgba(214,244,95,0.3)',
            borderRadius: 8,
          }}
        />
        <Area type="monotone" dataKey="value" stroke="#d6f45f" strokeWidth={2} fill={`url(#${gradientId})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [token, setToken] = useState<string | null>(getToken())
  const [user, setUser] = useState<User | null>(readStoredUser())
  const [dashboardData, setDashboardData] = useState<DashboardPayload | null>(null)
  const [toast, setToast] = useState('')
  const [realtimeTransport, setRealtimeTransport] = useState<'socket.io' | 'sse' | null>(null)

  const loadDashboardData = useCallback(async (currentToken: string) => {
    try {
      const response = await fetch(apiUrl('/api/dashboard/overview'), {
        headers: {
          Authorization: `Bearer ${currentToken}`,
        },
      })

      if (response.status === 401) {
        setScreen('login')
        setToken(null)
        setUser(null)
        localStorage.removeItem('motorvibe-token')
        localStorage.removeItem('motorvibe-user')
        setToast('Session expired. Please sign in again.')
        return
      }

      if (!response.ok) {
        throw new Error(`Dashboard API returned HTTP ${response.status}. Retrying shortly.`)
      }

      const payload = (await response.json()) as { success: boolean; data: DashboardPayload }
      const nextData = payload.data ?? payload
      setDashboardData(nextData as DashboardPayload)
    } catch (error: unknown) {
      setToast(
        error instanceof TypeError && error.message === 'Failed to fetch'
          ? 'Cannot reach the API. Run npm run dev from the project folder, then retry.'
          : error instanceof Error
            ? error.message
            : 'Dashboard data is temporarily unavailable. Retrying shortly.',
      )
    }
  }, [])

  const refreshDashboard = useCallback(() => {
    if (token) void loadDashboardData(token)
  }, [loadDashboardData, token])

  useEffect(() => {
    if (!token || screen !== 'dashboard') return

    const socket = createSocket(apiBaseUrl || window.location.origin, {
      auth: { token },
      reconnection: true,
    })
    let disposed = false
    let fallbackStarted = false
    let eventSource: EventSource | null = null

    const startSseFallback = async () => {
      if (fallbackStarted || disposed) return
      fallbackStarted = true

      try {
        const response = await fetch(apiUrl('/api/dashboard/stream-ticket'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error(`Stream ticket request failed (HTTP ${response.status}).`)
        const result = (await response.json()) as { ticket: string }
        if (disposed || socket.connected) return

        eventSource = new EventSource(apiUrl(`/api/dashboard/events?ticket=${encodeURIComponent(result.ticket)}`))
        eventSource.onopen = () => {
          if (!disposed) setRealtimeTransport('sse')
        }
        eventSource.onmessage = (event) => {
          try {
            setDashboardData(JSON.parse(event.data) as DashboardPayload)
          } catch (error) {
            console.error('Received invalid dashboard event data.', error)
          }
        }
        eventSource.onerror = () => {
          if (!disposed) setRealtimeTransport(null)
          eventSource?.close()
        }
      } catch (error) {
        if (!disposed) console.error('Could not start the server-sent events fallback.', error)
      }
    }

    socket.on('connect', () => {
      fallbackStarted = false
      eventSource?.close()
      eventSource = null
      setRealtimeTransport('socket.io')
    })
    socket.on('disconnect', () => {
      setRealtimeTransport(null)
      void startSseFallback()
    })
    socket.on('connect_error', () => {
      setRealtimeTransport(null)
      void startSseFallback()
    })
    socket.on('dashboard:update', (payload: DashboardPayload) => setDashboardData(payload))

    return () => {
      disposed = true
      socket.disconnect()
      eventSource?.close()
    }
  }, [screen, token])

  useEffect(() => {
    if (token && screen === 'dashboard') {
      const initialLoad = window.setTimeout(() => {
        void loadDashboardData(token)
      }, 0)

      return () => {
        window.clearTimeout(initialLoad)
      }
    }
  }, [screen, token, loadDashboardData])

  const go = (next: Screen) => {
    setToast('')
    if (next !== 'dashboard') setRealtimeTransport(null)
    setScreen(next)
  }

  const handleAuth = async (
    mode: 'login' | 'register',
    form: { name?: string; email: string; password: string },
  ) => {
    try {
      const response = await fetch(apiUrl(`/api/auth/${mode}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      const responseBody = await response.text()
      let payload: {
        success: boolean
        message?: string
        token?: string
        user?: User
      }

      try {
        payload = JSON.parse(responseBody) as typeof payload
      } catch {
        throw new Error(`The API returned an invalid response (HTTP ${response.status}). Check that the server is running and try again.`)
      }

      if (!response.ok || !payload.success || !payload.token || !payload.user) {
        throw new Error(payload.message || 'Authentication failed')
      }

      setToken(payload.token)
      setUser(payload.user)
      localStorage.setItem('motorvibe-token', payload.token)
      localStorage.setItem('motorvibe-user', JSON.stringify(payload.user))
      setToast(mode === 'login' ? 'Session opened. Loading plant overview.' : 'Workspace created. Loading your dashboard.')
      setScreen('dashboard')
      void loadDashboardData(payload.token)
    } catch (error: unknown) {
      setToast(
        error instanceof TypeError && error.message === 'Failed to fetch'
          ? 'Cannot reach the API. Run npm run dev from the project folder, then retry.'
          : error instanceof Error
            ? error.message
            : 'Authentication failed',
      )
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('motorvibe-token')
    localStorage.removeItem('motorvibe-user')
    setToken(null)
    setUser(null)
    setDashboardData(null)
    setRealtimeTransport(null)
    setScreen('home')
  }

  if (screen === 'login' || screen === 'register') {
    return (
      <AuthScreen
        mode={screen}
        onBack={() => go('home')}
        onSwitch={(nextMode) => go(nextMode)}
        onSubmit={handleAuth}
        toast={toast}
      />
    )
  }

  if (screen === 'dashboard' && token && user) {
    return (
      <DashboardView
        user={user}
        token={token}
        data={dashboardData}
        toast={toast}
        realtimeTransport={realtimeTransport}
        onRefresh={refreshDashboard}
        onLogout={handleLogout}
        onHome={() => go('home')}
      />
    )
  }

  return <HomeScreen onGo={go} />
}

function AuthScreen({
  mode,
  onBack,
  onSwitch,
  onSubmit,
  toast,
}: {
  mode: 'login' | 'register'
  onBack: () => void
  onSwitch: (mode: 'login' | 'register') => void
  onSubmit: (
    mode: 'login' | 'register',
    form: { name?: string; email: string; password: string },
  ) => Promise<void>
  toast: string
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('admin@motorvibe.com')
  const [password, setPassword] = useState('password123')

  const isLogin = mode === 'login'

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await onSubmit(mode, { name: isLogin ? undefined : name, email, password })
  }

  return (
    <main className="access">
      <section className="access-note">
        <Wordmark />
        <div className="access-statement">
          <span className="index">FIELD NOTE / 001</span>
          <h1>
            Machines leave
            <br />
            <i>clues.</i>
          </h1>
          <p>MotorVibe helps your team catch the small changes hiding inside every rotation.</p>
        </div>
        <div className="access-grid">
          <span>VIBRATION</span>
          <span>THERMAL</span>
          <span>RHYTHM</span>
        </div>
      </section>

      <section className="access-form">
        <button className="return" type="button" onClick={onBack}>
          ↤ return to motorvibe
        </button>

        <div className="form-box">
          <span className="index">{isLogin ? 'OPERATOR ACCESS' : 'NEW WORKSPACE'}</span>
          <h2>{isLogin ? 'Good to see you.' : 'Start a new log.'}</h2>
          <p>
            {isLogin
              ? 'Open your plant overview and continue where you left off.'
              : 'Bring your first machine into focus in under five minutes.'}
          </p>

          <form onSubmit={handleSubmit}>
            {!isLogin && (
              <label>
                YOUR NAME
                <input
                  required
                  placeholder="Jordan Lee"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}

            <label>
              WORK EMAIL
              <input
                required
                type="email"
                placeholder="name@plant.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label>
              ACCESS KEY
              <input
                required
                type="password"
                minLength={6}
                placeholder="Enter your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            <button className="enter" type="submit">
              {isLogin ? 'Open workspace' : 'Create workspace'} <span>↗</span>
            </button>
          </form>

          {toast && <div className="auth-toast">{toast}</div>}

          <div className="form-foot">
            <span>{isLogin ? 'No workspace yet?' : 'Already tracking?'}</span>
            <button type="button" onClick={() => onSwitch(isLogin ? 'register' : 'login')}>
              {isLogin ? 'Register here' : 'Sign in instead'}
            </button>
          </div>
        </div>

        <small className="legal">MotorVibe / Industrial condition intelligence / 2026</small>
      </section>
    </main>
  )
}

function HomeScreen({ onGo }: { onGo: (screen: Screen) => void }) {
  return (
    <main className="home">
      <header className="home-nav">
        <Wordmark />
        <nav>
          <a href="#method">Method</a>
          <a href="#signals">Signals</a>
          <a href="#crew">For teams</a>
        </nav>
        <div>
          <button className="nav-login" type="button" onClick={() => onGo('login')}>
            Sign in
          </button>
          <button className="nav-start" type="button" onClick={() => onGo('register')}>
            Enter the lab <span>↗</span>
          </button>
        </div>
      </header>

      <section className="home-hero">
        <div className="hero-side-label">
          MACHINE HEALTH
          <br />
          OBSERVATION SYSTEM
          <br />
          <span>v.02 / LIVE</span>
        </div>

        <div className="hero-message">
          <span className="index">YOUR PLANT, IN A NEW LIGHT</span>
          <h1>
            Find the
            <br />
            <i>quiet</i> warning.
          </h1>
          <p>
            A calmer way to understand vibration. MotorVibe turns the invisible behavior of rotating
            equipment into signals your people can act on.
          </p>

          <div className="hero-actions">
            <button className="nav-start" type="button" onClick={() => onGo('register')}>
              Build your watchlist <span>↗</span>
            </button>
            <a href="#method">
              See how it works <b>↓</b>
            </a>
          </div>
        </div>

        <div className="hero-figure">
          <div className="figure-label label-a">
            <b>02.4</b>
            <span>MM / S RMS</span>
          </div>
          <div className="figure-label label-b">
            <span>LIVE SIGNAL</span>
            <b>GOOD</b>
          </div>
          <div className="figure-grid" />
          <div className="figure-disc">
            <div className="disc-core">MV</div>
            <div className="disc-sweep" />
          </div>
        </div>
      </section>

      <section id="method" className="method">
        <div className="method-title">
          <span className="index">THE MOTORVIBE METHOD</span>
          <h2>
            Less noise.
            <br />
            <i>More knowing.</i>
          </h2>
        </div>

        <div className="method-list">
          <article>
            <span>01</span>
            <div>
              <h3>Collect the rhythm</h3>
              <p>Capture the pulse, heat, and pattern of every important asset.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>Understand the change</h3>
              <p>See a useful baseline, not a wall of disconnected readings.</p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>Move before the stop</h3>
              <p>Give maintenance teams enough signal to make the right call.</p>
            </div>
          </article>
        </div>
      </section>

      <footer>
        <Wordmark />
        <span>Condition intelligence for people who keep the world moving.</span>
        <button className="nav-start" type="button" onClick={() => onGo('register')}>
          Open the workspace <span>↗</span>
        </button>
      </footer>
    </main>
  )
}

function DashboardView({
  user,
  data,
  toast,
  realtimeTransport,
  onRefresh,
  onLogout,
  onHome,
}: {
  user: User
  token: string
  data: DashboardPayload | null
  toast: string
  realtimeTransport: 'socket.io' | 'sse' | null
  onRefresh: () => void
  onLogout: () => void
  onHome: () => void
}) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')
  const [assetFilter, setAssetFilter] = useState<Asset['state'] | 'all'>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [showTrendDetail, setShowTrendDetail] = useState(false)
  const [livePaused, setLivePaused] = useState(false)
  const [liveFilter, setLiveFilter] = useState('all')
  const [liveSearch, setLiveSearch] = useState('')
  const [sortBy, setSortBy] = useState('severity')
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null)
  const [watchPrefs, setWatchPrefs] = useState<Record<number, { priority: string }>>(() => {
    try { return JSON.parse(localStorage.getItem('motorvibe-watchlist') || '{}') } catch { return {} }
  })
  const [historyRange, setHistoryRange] = useState('24')
  const [historyMetric, setHistoryMetric] = useState('vibration')
  const [historySearch, setHistorySearch] = useState('')
  const [historyStatus, setHistoryStatus] = useState('all')
  const [historySeverity, setHistorySeverity] = useState('all')
  const [historyAssets, setHistoryAssets] = useState<string[]>([])
  const [historyStart, setHistoryStart] = useState('')
  const [historyEnd, setHistoryEnd] = useState('')
  const [reportType, setReportType] = useState('Daily Plant Report')
  const [reportHistory, setReportHistory] = useState<Array<{id:string; name:string; date:string; count:number; data:unknown; range?:{from:string|null;to:string|null}}>>(() => {
    try { return JSON.parse(localStorage.getItem('motorvibe-reports') || '[]') } catch { return [] }
  })
  const [reportAsset, setReportAsset] = useState('all')
  const [reportStart, setReportStart] = useState('')
  const [reportEnd, setReportEnd] = useState('')
  const [generatedReport, setGeneratedReport] = useState<GeneratedReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')

  useEffect(() => {
    if (activeTab === 'live' && livePaused) return
    const timer = window.setInterval(onRefresh, activeTab === 'live' ? 5000 : 15000)
    return () => window.clearInterval(timer)
  }, [activeTab, livePaused, onRefresh])

  const tabs: Array<{ id: DashboardTab; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: '◉' },
    { id: 'live', label: 'Live feed', icon: '⌁' },
    { id: 'watchlist', label: 'Watchlist', icon: '⌑' },
    { id: 'history', label: 'History', icon: '▤' },
    { id: 'reports', label: 'Reports', icon: '⌗' },
  ]

  const renderOverview = () => {
    if (!data) {
      return <div className="console-page empty-state">Loading live plant data…</div>
    }

    const visibleAssets =
      assetFilter === 'all' ? data.assets : data.assets.filter((asset) => asset.state === assetFilter)

    return (
      <div className="console-page">
        <div className="page-header">
          <div>
            <span className="index">OVERVIEW</span>
            <h2>North plant monitoring</h2>
          </div>
        </div>

        <section className="signal-overview">
          <div className="hero-stat">
            <span className="index">PLANT PULSE / CURRENT</span>
            <strong>{data.summary.plantPulse.toFixed(1)}</strong>
            <span>
              mm/s <b>RMS</b>
            </span>
            <small>within expected operating range</small>
            <div className="pulse-bars">
              {Array.from({ length: 24 }, (_, index) => (
                <i key={index} style={{ height: `${24 + ((index * 13) % 56)}%` }} />
              ))}
            </div>
          </div>

          <div className="quick-stat">
            <span className="index">HEALTHY</span>
            <strong>
              {data.summary.healthyAssets}
              <span>/{data.assets.length}</span>
            </strong>
            <div className="arc arc-green" />
            <small>{((data.summary.healthyAssets / data.assets.length) * 100).toFixed(1)}% of monitored assets</small>
          </div>

          <div className="quick-stat warm">
            <span className="index">ATTENTION</span>
            <strong>{data.summary.attentionAssets}</strong>
            <div className="arc arc-orange" />
            <small>
              {data.summary.criticalAssets} critical / {data.summary.attentionAssets - data.summary.criticalAssets} observe
            </small>
          </div>
        </section>

        <section className="console-grid">
          <div className="console-panel">
            <div className="panel-head">
              <span className="index">ASSET STATUS</span>
              <span className="asset-filter-count">{visibleAssets.length} / {data.assets.length}</span>
              <div className="asset-filter-control">
                <button
                  type="button"
                  aria-label="Filter assets by status"
                  aria-expanded={filterOpen}
                  onClick={() => setFilterOpen((open) => !open)}
                >
                  Filter
                </button>
                {filterOpen && (
                  <div className="asset-filter-menu" role="group" aria-label="Asset status filter">
                    {([
                      ['all', 'All statuses'],
                      ['nominal', 'Nominal'],
                      ['observe', 'Observe'],
                      ['critical', 'Critical'],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={assetFilter === value}
                        onClick={() => {
                          setAssetFilter(value)
                          setFilterOpen(false)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="asset-cards">
              {visibleAssets.map((asset) => (
                <article key={asset.code} className="asset-card">
                  <div className="asset-topline">
                    <div>
                      <strong>{asset.name}</strong>
                      <small>{asset.code}</small>
                    </div>
                    <span className={`signal-tag ${asset.state}`}>{asset.value.toFixed(1)}</span>
                  </div>
                  <div className="asset-bar">
                    <span style={{ width: `${Math.min(100, asset.value * 11)}%` }} />
                  </div>
                  <div className="asset-bottom">
                    <span className={`state-dot ${asset.state}`} />
                    <small>{asset.note}</small>
                  </div>
                </article>
              ))}
              {visibleAssets.length === 0 && (
                <div className="asset-empty-state">No assets currently match this status.</div>
              )}
            </div>
          </div>

          <div className="console-panel">
            <div className="panel-head">
              <span className="index">TREND</span>
              <button type="button" onClick={() => setShowTrendDetail(true)}>
                View
              </button>
            </div>

            <div className="mini-chart">
              <VibrationChart data={data.chartData} height={220} />
            </div>
          </div>
        </section>
      </div>
    )
  }

  const renderLive = () => {
    if (!data) return null

    const assets = data.assets.filter((asset) => {
      const statusMatch = liveFilter === 'all' || (liveFilter === 'offline' ? asset.signal === 'offline' : asset.state === liveFilter)
      return statusMatch && `${asset.name} ${asset.code}`.toLowerCase().includes(liveSearch.toLowerCase())
    }).sort((a, b) => sortBy === 'vibration' ? b.value - a.value : sortBy === 'temperature' ? b.temp - a.temp : sortBy === 'latest' ? Date.parse(b.lastUpdated || '') - Date.parse(a.lastUpdated || '') : ({critical: 0, observe: 1, nominal: 2}[a.state] - {critical: 0, observe: 1, nominal: 2}[b.state]))
    const selected = data.assets.find((asset) => asset.id === selectedAssetId) || assets[0]
    const rows = (data.readings || []).filter((reading) => reading.assetId === selected?.id).slice(-24)
    const waveform = rows.length && selected ? Array.from({length:48},(_,index)=>({name:String(index),value:Number((selected.value + Math.sin(index*Math.PI/8)*(selected.peakVibration || selected.value*1.5)*0.45).toFixed(2))})) : []
    const connectionIssue = /cannot reach|unavailable|http \d|retry/i.test(toast)

    return (
      <div className="console-page">
        <div className="page-header">
          <div>
            <span className="index">LIVE FEED</span>
            <h2>Asset stream <span className={`live-badge ${connectionIssue ? 'issue' : ''}`}>● {connectionIssue ? 'CONNECTION ISSUE' : livePaused ? 'PAUSED' : 'LIVE'}</span></h2>
          </div>
          <div className="action-row"><button type="button" onClick={() => setLivePaused(!livePaused)}>{livePaused ? 'Resume feed' : 'Pause feed'}</button><button type="button" onClick={onRefresh}>Refresh</button></div>
        </div>
        <div className="toolbar"><input aria-label="Search assets" placeholder="Search name or ID" value={liveSearch} onChange={(e) => setLiveSearch(e.target.value)} /><select value={liveFilter} onChange={(e) => setLiveFilter(e.target.value)}><option value="all">All statuses</option><option value="nominal">Healthy</option><option value="observe">Warning</option><option value="critical">Critical</option><option value="offline">Offline</option></select><select value={sortBy} onChange={(e) => setSortBy(e.target.value)}><option value="severity">Sort: severity</option><option value="vibration">Sort: vibration</option><option value="temperature">Sort: temperature</option><option value="latest">Sort: latest</option></select></div>
        <div className="live-layout"><div className="feed-list">
          {assets.map((asset) => <button type="button" key={asset.id} onClick={() => setSelectedAssetId(asset.id)} className={`feed-item live-asset ${selected?.id === asset.id ? 'active' : ''} ${asset.state}`}><div className="feed-row"><div><strong>{asset.name} <small>{asset.code} · {asset.type}</small></strong><small>{asset.location}</small></div><span className={`status-pill ${asset.state}`}>{asset.state === 'nominal' ? 'Healthy' : asset.state === 'observe' ? 'Warning' : 'Critical'}</span></div><div className="metric-grid"><span><b>{asset.value.toFixed(2)}</b><small>VIB RMS mm/s</small></span><span><b>{asset.peakVibration?.toFixed(2) ?? '—'}</b><small>PEAK mm/s</small></span><span><b>{asset.temp.toFixed(1)}°C</b><small>TEMPERATURE</small></span><span><b>{asset.rpm ?? '—'}</b><small>RPM</small></span></div><small>● {asset.dataSource === 'mqtt' ? 'MQTT SENSOR' : 'SIMULATED SENSOR'} · {asset.lastUpdated ? new Date(asset.lastUpdated).toLocaleTimeString() : 'just now'}</small></button>)}
          {assets.length === 0 && <div className="empty-card">No assets match these filters.</div>}
        </div><section className="console-panel live-detail"><span className="index">SELECTED MACHINE · LIVE</span>{selected ? <><h3>{selected.name}</h3><small>{selected.type} · {selected.location}</small><div className="mini-chart"><VibrationChart data={historyMetric === 'waveform' ? waveform : rows.map((row) => ({name: new Date(row.timestamp).toLocaleTimeString(), value: historyMetric === 'temperature' ? row.temperature : historyMetric === 'rpm' ? row.rpm : row.vibration}))} height={220} /></div><div className="toolbar"><select value={historyMetric} onChange={(e) => setHistoryMetric(e.target.value)}><option value="waveform">Vibration waveform</option><option value="vibration">Vibration RMS trend</option><option value="temperature">Temperature trend</option><option value="rpm">RPM trend</option></select><button type="button" onClick={() => {setWatchPrefs((current) => {const next = {...current}; if(next[selected.id]) delete next[selected.id]; else next[selected.id] = {priority:'medium'}; localStorage.setItem('motorvibe-watchlist', JSON.stringify(next)); return next})}}>{watchPrefs[selected.id] ? '★ Watched' : '☆ Add to watchlist'}</button></div><h4>Recent alerts</h4>{(data.alerts || []).filter((a) => a.assetId === selected.id).slice(0, 4).map((a) => <p className="alert-row" key={a.id}><b>{a.severity}</b> · {a.type} · {a.value} @ {new Date(a.timestamp).toLocaleTimeString()}</p>)}<h4>Last 10 readings</h4><small>{rows.slice(-10).reverse().map((r) => `${new Date(r.timestamp).toLocaleTimeString()} · ${r.vibration} mm/s · ${r.temperature}°C · ${r.rpm} rpm`).join('  |  ') || 'Waiting for samples'}</small></> : <p>Select an asset to inspect.</p>}</section></div>
        <section className="console-panel alerts-panel"><div className="panel-head"><span className="index">ACTIVE ALERTS</span><span>{(data.alerts || []).filter((a) => a.status === 'active').length} active</span></div>{(data.alerts || []).filter((a) => a.status === 'active').slice(0, 6).map((alert) => <p className="alert-row" key={alert.id}><b className={alert.severity.toLowerCase()}>{alert.severity}</b> {alert.assetName} · {alert.type} ({alert.value} / {alert.threshold}) · {new Date(alert.timestamp).toLocaleString()}</p>)}</section>
      </div>
    )
  }

  const renderWatchlist = () => {
    if (!data) return null

    const watched = data.assets.filter((asset) => watchPrefs[asset.id]).sort((a,b) => (({high:0,medium:1,low:2}[watchPrefs[a.id]?.priority || 'medium'] ?? 1) - ({high:0,medium:1,low:2}[watchPrefs[b.id]?.priority || 'medium'] ?? 1)) || ({critical:0,observe:1,nominal:2}[a.state] - {critical:0,observe:1,nominal:2}[b.state]))
    const alerts = (data.alerts || []).filter((alert) => watchPrefs[alert.assetId])
    return (
      <div className="console-page">
        <div className="page-header">
          <div>
            <span className="index">WATCHLIST</span>
            <h2>Priority assets</h2>
            <button type="button" onClick={() => document.getElementById('watch-add')?.scrollIntoView({behavior:'smooth'})}>Add assets to watchlist</button>
          </div>
        </div>

        {watched.length === 0 ? <div className="empty-card">Your watchlist is empty. Use “Add” below to follow the machines that matter to your shift.</div> : <div className="table-wrap">
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Status</th>
                <th>Vibration</th><th>Temp</th><th>RPM</th><th>Health</th><th>Priority</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {watched.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.name}<small>{asset.code}</small></td><td><span className={`status-pill ${asset.state}`}>{asset.state}</span></td><td>{asset.value.toFixed(2)} mm/s</td><td>{asset.temp}°C</td><td>{asset.rpm}</td><td>{asset.healthScore}%</td>
                  <td><select aria-label={`Set ${asset.name} priority`} value={watchPrefs[asset.id]?.priority || 'medium'} onChange={(e) => {const next={...watchPrefs,[asset.id]:{priority:e.target.value}};setWatchPrefs(next);localStorage.setItem('motorvibe-watchlist',JSON.stringify(next))}}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></td><td><div className="quick-actions"><button type="button" onClick={() => {setSelectedAssetId(asset.id);setActiveTab('live')}}>Details</button><button type="button" onClick={() => {setSelectedAssetId(asset.id);setActiveTab('live')}}>Live</button><button type="button" onClick={() => {setHistoryAssets([String(asset.id)]);setActiveTab('history')}}>History</button><button type="button" onClick={() => {setReportAsset(String(asset.id));setActiveTab('reports')}}>Report</button><button type="button" onClick={() => {const next={...watchPrefs};delete next[asset.id];setWatchPrefs(next);localStorage.setItem('motorvibe-watchlist',JSON.stringify(next))}}>Remove</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        <div id="watch-add" className="toolbar"><span className="index">AVAILABLE ASSETS</span>{data.assets.filter((a) => !watchPrefs[a.id]).map((a) => <button key={a.id} type="button" onClick={() => {const next={...watchPrefs,[a.id]:{priority:'medium'}};setWatchPrefs(next);localStorage.setItem('motorvibe-watchlist',JSON.stringify(next))}}>＋ {a.name}</button>)}</div>
        <section className="console-panel"><span className="index">WATCHLIST ALERTS</span>{alerts.length ? alerts.slice(0,8).map((a) => <p className="alert-row" key={a.id}>{a.severity} · {a.assetName} · {a.type} · {new Date(a.timestamp).toLocaleString()}</p>) : <p>No alerts for watched assets.</p>}</section>
      </div>
    )
  }

  const renderHistory = () => {
    if (!data) return null

    const newestReading = (data.readings || []).at(-1)?.timestamp
    const cutoff = historyRange === 'custom' ? -Infinity : (newestReading ? Date.parse(newestReading) : 0) - Number(historyRange) * 3600000
    const customStart = historyStart ? Date.parse(`${historyStart}T00:00:00`) : cutoff
    const customEnd = historyEnd ? Date.parse(`${historyEnd}T23:59:59`) : Infinity
    const filtered = (data.readings || []).filter((row) => Date.parse(row.timestamp) >= customStart && Date.parse(row.timestamp) <= customEnd && (!historyAssets.length || historyAssets.includes(String(row.assetId))) && (historyStatus === 'all' || row.status === historyStatus) && (historySeverity === 'all' || (data.alerts || []).some((alert) => alert.assetId === row.assetId && alert.severity === historySeverity && Math.abs(Date.parse(alert.timestamp) - Date.parse(row.timestamp)) < 15000)) && `${row.assetName} ${row.status}`.toLowerCase().includes(historySearch.toLowerCase()))
    const chartRows = filtered.slice(-100).map((row) => ({name:new Date(row.timestamp).toLocaleTimeString(), value:historyMetric === 'temperature' ? row.temperature : historyMetric === 'rpm' ? row.rpm : row.vibration}))
    const download = (format: 'csv'|'json') => {const rows=filtered;const content=format==='json'?JSON.stringify(rows,null,2):['timestamp,asset,vibration,peak,temperature,rpm,status',...rows.map((r)=>[r.timestamp,r.assetName,r.vibration,r.peakVibration,r.temperature,r.rpm,r.status].join(','))].join('\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([content],{type:format==='json'?'application/json':'text/csv'}));link.download=`motorvibe-history.${format}`;link.click();URL.revokeObjectURL(link.href)}
    return (
      <div className="console-page">
        <div className="page-header">
          <div>
            <span className="index">HISTORY</span>
            <h2>Sensor history & analysis</h2>
          </div>
        </div>

        <div className="toolbar">
          <select value={historyRange} onChange={(e)=>setHistoryRange(e.target.value)}>
            <option value="1">Last 1 hour</option><option value="6">Last 6 hours</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option><option value="720">Last 30 days</option><option value="custom">Custom range</option>
          </select>
          {historyRange==='custom'&&<>
            <label className="date-filter">From<input type="date" value={historyStart} onChange={(e)=>setHistoryStart(e.target.value)} /></label>
            <label className="date-filter">To<input type="date" value={historyEnd} onChange={(e)=>setHistoryEnd(e.target.value)} /></label>
          </>}
          <div className="history-asset-filter" role="group" aria-label="Filter by assets">
            <span className="index">ASSETS</span>
            <button type="button" aria-pressed={historyAssets.length === 0} onClick={()=>setHistoryAssets([])}>All assets</button>
            {data.assets.map((asset) => {
              const assetId = String(asset.id)
              const selected = historyAssets.includes(assetId)
              return <button key={asset.id} type="button" aria-pressed={selected} className={selected ? 'selected' : ''} onClick={()=>setHistoryAssets((current) => selected ? current.filter((id) => id !== assetId) : [...current, assetId])}>{asset.name}</button>
            })}
          </div>
          <input placeholder="Filter asset name/ID" value={historySearch} onChange={(e)=>setHistorySearch(e.target.value)} />
          <select value={historyStatus} onChange={(e)=>setHistoryStatus(e.target.value)}><option value="all">All statuses</option><option value="nominal">Healthy</option><option value="observe">Warning</option><option value="critical">Critical</option></select>
          <select value={historySeverity} onChange={(e)=>setHistorySeverity(e.target.value)}><option value="all">All alert severities</option><option value="CRITICAL">Critical alerts</option><option value="WARNING">Warning alerts</option><option value="INFO">Info alerts</option></select>
          <select value={historyMetric} onChange={(e)=>setHistoryMetric(e.target.value)}><option value="vibration">Vibration over time</option><option value="temperature">Temperature over time</option><option value="rpm">RPM over time</option></select>
          <button type="button" onClick={()=>download('csv')}>Export CSV</button>
          <button type="button" onClick={()=>download('json')}>Export JSON</button>
        </div>
        <div className="console-panel mini-chart"><VibrationChart data={chartRows} height={260}/></div>
        <section className="console-panel"><span className="index">ASSET COMPARISON</span><div className="comparison-grid">{data.assets.map((asset)=>{const own=filtered.filter(r=>r.assetId===asset.id);return <div key={asset.id}><b>{asset.name}</b><small>Avg vib {(own.reduce((s,r)=>s+r.vibration,0)/(own.length||1)).toFixed(2)} · Max {Math.max(0,...own.map(r=>r.vibration)).toFixed(2)}<br/>Avg temp {(own.reduce((s,r)=>s+r.temperature,0)/(own.length||1)).toFixed(1)}°C · Alerts {(data.alerts||[]).filter(a=>a.assetId===asset.id).length}<br/>Health {asset.healthScore}%</small></div>})}</div></section>
        <div className="table-wrap"><table className="watchlist-table"><thead><tr><th>Timestamp</th><th>Asset</th><th>Vib RMS</th><th>Peak</th><th>Temp</th><th>RPM</th><th>Status</th><th>Alert</th></tr></thead><tbody>{filtered.slice(-200).reverse().map((r)=>{const alert=(data.alerts||[]).find(a=>a.assetId===r.assetId&&Math.abs(Date.parse(a.timestamp)-Date.parse(r.timestamp))<10000);return <tr key={r.id}><td>{new Date(r.timestamp).toLocaleString()}</td><td>{r.assetName}</td><td>{r.vibration}</td><td>{r.peakVibration}</td><td>{r.temperature}°C</td><td>{r.rpm}</td><td>{r.status}</td><td>{alert?.severity || '—'}</td></tr>})}</tbody></table></div>
        <div className="history-list">
          {(data.alerts || []).filter(a=>Date.parse(a.timestamp)>=customStart&&Date.parse(a.timestamp)<=customEnd&&(historySeverity==='all'||a.severity===historySeverity)&&`${a.assetName} ${a.type} ${a.severity}`.toLowerCase().includes(historySearch.toLowerCase())).slice(0,30).map((entry) => (
            <div key={entry.id} className={`history-item ${entry.type}`}>
              <span className="time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              <div className="history-bullet" />
              <p>{entry.assetName} · {entry.type} · {entry.value} (threshold {entry.threshold}) · {entry.severity} · {entry.status}</p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderReports = () => {
    if (!data) return null
    const generate = async () => {
      setReportError('')
      if (reportStart && Number.isNaN(Date.parse(`${reportStart}T00:00:00Z`))) { setReportError('Enter a valid From date.'); return }
      if (reportEnd && Number.isNaN(Date.parse(`${reportEnd}T00:00:00Z`))) { setReportError('Enter a valid To date.'); return }
      if (reportStart && reportEnd && reportStart > reportEnd) { setReportError('From date must be on or before To date.'); return }
      setReportLoading(true)
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      const selectedAssets = reportAsset === 'all' ? data.assets : data.assets.filter((asset) => String(asset.id) === reportAsset)
      const inRange = (timestamp: string) => {
        const date = new Date(timestamp)
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        return (!reportStart || day >= reportStart) && (!reportEnd || day <= reportEnd)
      }
      const readings = (data.readings || []).filter((reading) => selectedAssets.some((asset) => asset.id === reading.assetId) && inRange(reading.timestamp))
      const alerts = (data.alerts || []).filter((alert) => selectedAssets.some((asset) => asset.id === alert.assetId) && inRange(alert.timestamp))
      const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
      const reportAssets = selectedAssets.map((asset) => {
        const samples = readings.filter((reading) => reading.assetId === asset.id)
        const latest = samples.at(-1)
        return { ...asset, state: (latest?.status as Asset['state'] | undefined) || asset.state, averageVibration: average(samples.map((reading) => reading.vibration)), maximumVibration: Math.max(0, ...samples.map((reading) => reading.vibration)), averageTemperature: average(samples.map((reading) => reading.temperature)), maximumTemperature: Math.max(0, ...samples.map((reading) => reading.temperature)), alertCount: alerts.filter((alert) => alert.assetId === asset.id).length, sampleCount: samples.length }
      })
      const monitored = reportAssets.filter((asset) => asset.sampleCount > 0)
      const summary = { assets: monitored.length, healthy: monitored.filter((asset) => asset.state === 'nominal').length, warning: monitored.filter((asset) => asset.state === 'observe').length, critical: monitored.filter((asset) => asset.state === 'critical').length, alerts: alerts.length, criticalAlerts: alerts.filter((alert) => alert.severity === 'CRITICAL').length, averageVibration: average(readings.map((reading) => reading.vibration)), maximumVibration: Math.max(0, ...readings.map((reading) => reading.vibration)), averageTemperature: average(readings.map((reading) => reading.temperature)), maximumTemperature: Math.max(0, ...readings.map((reading) => reading.temperature)) }
      const report: GeneratedReport = { name: reportType, assetLabel: reportAsset === 'all' ? 'All Assets' : selectedAssets[0]?.name || 'Selected Asset', from: reportStart || 'All available', to: reportEnd || 'Latest available', generatedAt: new Date().toISOString(), summary, assets: reportAssets, readings, alerts }
      setGeneratedReport(report)
      const saved = { id: `${Date.now()}`, name: reportType, date: report.generatedAt, range: { from: reportStart || null, to: reportEnd || null }, count: summary.assets, data: report }
      const next = [saved, ...reportHistory].slice(0, 30)
      setReportHistory(next)
      localStorage.setItem('motorvibe-reports', JSON.stringify(next))
      setReportLoading(false)
    }
    const downloadReport = (report: GeneratedReport, format: 'json'|'csv') => {
      const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
      const rows: unknown[][] = [
        ['Report', report.name], ['Asset selection', report.assetLabel], ['From', report.from], ['To', report.to], ['Generated at', report.generatedAt], [],
        ['Summary metric', 'Value'], ...Object.entries(report.summary), [],
        ['Asset', 'Status', 'Average vibration (mm/s)', 'Maximum vibration (mm/s)', 'Average temperature (°C)', 'Maximum temperature (°C)', 'Alerts'],
        ...report.assets.map((asset) => [asset.name, asset.sampleCount ? asset.state : 'No data in range', asset.sampleCount ? asset.averageVibration.toFixed(2) : '', asset.sampleCount ? asset.maximumVibration.toFixed(2) : '', asset.sampleCount ? asset.averageTemperature.toFixed(1) : '', asset.sampleCount ? asset.maximumTemperature.toFixed(1) : '', asset.alertCount]), [],
        ['Alert asset', 'Alert type', 'Metric', 'Value', 'Threshold', 'Severity', 'Timestamp'],
        ...report.alerts.map((alert) => [alert.assetName, alert.type, alert.metric, alert.value, alert.threshold, alert.severity, alert.timestamp]),
      ]
      const text = format === 'json' ? JSON.stringify(report, null, 2) : rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
      const link = document.createElement('a')
      const url = URL.createObjectURL(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/csv' }))
      link.href = url
      link.download = `${report.name.toLowerCase().replaceAll(' ', '-')}.${format}`
      link.click()
      URL.revokeObjectURL(url)
    }
    const trend = (metric: 'vibration'|'temperature') => (generatedReport?.readings || []).map((reading) => ({ name: new Date(reading.timestamp).toLocaleString(), value: metric === 'vibration' ? reading.vibration : reading.temperature }))
    const statusData = generatedReport ? [{name:'Healthy',value:generatedReport.summary.healthy},{name:'Warning',value:generatedReport.summary.warning},{name:'Critical',value:generatedReport.summary.critical}] : []
    const alertData = generatedReport ? [{name:'Info',value:generatedReport.alerts.filter((alert)=>alert.severity==='INFO').length},{name:'Warning',value:generatedReport.alerts.filter((alert)=>alert.severity==='WARNING').length},{name:'Critical',value:generatedReport.alerts.filter((alert)=>alert.severity==='CRITICAL').length}] : []

    return (
      <div className="console-page">
        <div className="page-header">
          <div>
            <span className="index">REPORTS</span>
            <h2>Monitoring reports</h2>
          </div>
        </div>

        <div className="toolbar report-controls"><select aria-label="Report type" value={reportType} onChange={(event)=>setReportType(event.target.value)}>{['Daily Plant Report','Weekly Plant Report','Monthly Plant Report','Asset Health Report','Vibration Analysis Report','Alert Summary Report','Maintenance/Attention Report'].map((type)=><option key={type}>{type}</option>)}</select><select aria-label="Report asset" value={reportAsset} onChange={(event)=>setReportAsset(event.target.value)}><option value="all">All assets</option>{data.assets.map((asset)=><option key={asset.id} value={String(asset.id)}>{asset.name}</option>)}</select><label className="date-filter">From<input aria-label="Report start date" type="date" value={reportStart} onChange={(event)=>setReportStart(event.target.value)} /></label><label className="date-filter">To<input aria-label="Report end date" type="date" value={reportEnd} onChange={(event)=>setReportEnd(event.target.value)} /></label><button className="generate-report" type="button" disabled={reportLoading} onClick={()=>void generate()}>{reportLoading?'Generating report…':'Generate Report'}</button><button type="button" disabled={!generatedReport} onClick={()=>generatedReport ? window.print() : setReportError('Generate a report first.')}>Print Report</button></div>
        {reportError && <div className="report-error" role="alert">{reportError}</div>}
        {generatedReport && <div id="generated-report" className="generated-report">
          <header className="generated-report-header"><div><span className="index">GENERATED REPORT</span><h2>{generatedReport.name}</h2><p>{generatedReport.assetLabel} · {generatedReport.from} → {generatedReport.to}</p></div><small>Generated {new Date(generatedReport.generatedAt).toLocaleString()}</small></header>
          <div className="toolbar report-export"><button type="button" onClick={()=>downloadReport(generatedReport,'csv')}>Download CSV</button><button type="button" onClick={()=>downloadReport(generatedReport,'json')}>Download JSON</button></div>
          {generatedReport.readings.length === 0 && <div className="empty-card">No sensor readings or alerts were recorded for this selection and date range.</div>}
          <div className="report-grid">{Object.entries({ 'Total assets monitored':generatedReport.summary.assets,'Healthy assets':generatedReport.summary.healthy,'Warning assets':generatedReport.summary.warning,'Critical assets':generatedReport.summary.critical,'Total alerts':generatedReport.summary.alerts,'Critical alerts':generatedReport.summary.criticalAlerts,'Average vibration':`${generatedReport.summary.averageVibration.toFixed(2)} mm/s`,'Maximum vibration':`${generatedReport.summary.maximumVibration.toFixed(2)} mm/s`,'Average temperature':`${generatedReport.summary.averageTemperature.toFixed(1)}°C`,'Maximum temperature':`${generatedReport.summary.maximumTemperature.toFixed(1)}°C` }).map(([label,value])=><div key={label} className="report-card"><span className="index">{label}</span><strong>{value}</strong></div>)}</div>
          <div className="report-chart-grid"><section className="console-panel"><span className="index">VIBRATION TREND · MM/S RMS</span><div className="mini-chart"><VibrationChart data={trend('vibration')} height={230}/></div></section><section className="console-panel"><span className="index">TEMPERATURE TREND · °C</span><div className="mini-chart"><VibrationChart data={trend('temperature')} height={230}/></div></section><section className="console-panel"><span className="index">ASSET HEALTH DISTRIBUTION</span><div className="report-bar-chart"><ResponsiveContainer width="100%" height={230}><BarChart data={statusData}><CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false}/><XAxis dataKey="name" stroke="#819087"/><YAxis allowDecimals={false} stroke="#819087"/><Tooltip/><Bar dataKey="value" fill="#d6f45f" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div></section><section className="console-panel"><span className="index">ALERT SEVERITY DISTRIBUTION</span><div className="report-bar-chart"><ResponsiveContainer width="100%" height={230}><BarChart data={alertData}><CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false}/><XAxis dataKey="name" stroke="#819087"/><YAxis allowDecimals={false} stroke="#819087"/><Tooltip/><Bar dataKey="value" fill="#f1c05a" radius={[4,4,0,0]}/></BarChart></ResponsiveContainer></div></section></div>
          <section className="console-panel report-asset-details"><span className="index">ASSET DETAILS</span><div className="table-wrap"><table className="watchlist-table"><thead><tr><th>Asset</th><th>Status</th><th>Avg vibration</th><th>Max vibration</th><th>Avg temperature</th><th>Max temperature</th><th>Alerts</th></tr></thead><tbody>{generatedReport.assets.map((asset)=><tr key={asset.id}><td>{asset.name}<small>{asset.code}</small></td><td>{asset.sampleCount ? asset.state : 'No data in range'}</td><td>{asset.sampleCount ? `${asset.averageVibration.toFixed(2)} mm/s` : '—'}</td><td>{asset.sampleCount ? `${asset.maximumVibration.toFixed(2)} mm/s` : '—'}</td><td>{asset.sampleCount ? `${asset.averageTemperature.toFixed(1)}°C` : '—'}</td><td>{asset.sampleCount ? `${asset.maximumTemperature.toFixed(1)}°C` : '—'}</td><td>{asset.alertCount}</td></tr>)}</tbody></table></div></section>
          <section className="console-panel"><span className="index">ALERT SUMMARY · SELECTED PERIOD</span>{generatedReport.alerts.length ? <div className="table-wrap"><table className="watchlist-table"><thead><tr><th>Asset</th><th>Alert type</th><th>Metric</th><th>Value</th><th>Threshold</th><th>Severity</th><th>Timestamp</th></tr></thead><tbody>{generatedReport.alerts.map((alert)=><tr key={alert.id}><td>{alert.assetName}</td><td>{alert.type}</td><td>{alert.metric}</td><td>{alert.value}</td><td>{alert.threshold}</td><td><span className={`status-pill ${alert.severity.toLowerCase()}`}>{alert.severity}</span></td><td>{new Date(alert.timestamp).toLocaleString()}</td></tr>)}</tbody></table></div> : <p>No alerts occurred within the selected date range.</p>}</section>
          <section className="console-panel"><span className="index">MAINTENANCE INSIGHTS</span>{generatedReport.assets.filter((asset)=>asset.sampleCount).map((asset)=>{const samples=generatedReport.readings.filter((reading)=>reading.assetId===asset.id);const highVibration=samples.filter((reading)=>reading.vibration>=5).length;const highTemperature=samples.filter((reading)=>reading.temperature>=70).length;const insight=highVibration>=2?`${asset.name} showed sustained high vibration during the selected period.`:highTemperature>=2?`${asset.name} experienced multiple temperature warnings.`:asset.state==='nominal'?`${asset.name} remained within the normal operating range.`:`${asset.name} had elevated readings; review its trend and alert history.`;return <p key={asset.id}>{insight} <small>Monitoring recommendation only.</small></p>})}</section>
        </div>}
        <section className="console-panel report-history"><span className="index">REPORT HISTORY</span>{reportHistory.length===0?<p>No generated reports yet.</p>:reportHistory.map((report)=><p className="report-history-row" key={report.id}><b>{report.name}</b> · {new Date(report.date).toLocaleString()} · {report.count} assets · {report.range?.from || 'All dates'} → {report.range?.to || 'Current'} <button type="button" onClick={()=>{if(report.data && typeof report.data==='object') downloadReport(report.data as GeneratedReport,'json')}}>Download JSON</button><button type="button" onClick={()=>{const next=reportHistory.filter((item)=>item.id!==report.id);setReportHistory(next);localStorage.setItem('motorvibe-reports',JSON.stringify(next))}}>Delete</button></p>)}</section>
      </div>
    )
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'live':
        return renderLive()
      case 'watchlist':
        return renderWatchlist()
      case 'history':
        return renderHistory()
      case 'reports':
        return renderReports()
      default:
        return renderOverview()
    }
  }

  return (
    <main className="console">
      <aside className="console-rail">
        <Wordmark />

        <div className="rail-context">
          <span className="plant-dot" />
          <div>
            <b>North plant</b>
            <small>Live monitoring</small>
          </div>
        </div>

        <nav className="console-nav">
          <span>Navigation</span>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? 'selected' : ''}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </nav>

        <div className="rail-profile">
          <span>{user.name.slice(0, 2).toUpperCase()}</span>
          <div>
            <b>{user.name}</b>
            <small>{user.email}</small>
          </div>
          <i>↗</i>
        </div>
      </aside>

      <section className="console-main">
        <header className="console-header">
          <div>
            <span className="index">
              {new Date()
                .toLocaleString('en-GB', {
                  weekday: 'short',
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })
                .toUpperCase()}
            </span>
            <h1>
              North plant <i>overview</i>
            </h1>
          </div>

          <div className="console-tools">
            <button type="button" aria-label="Back to home" onClick={onHome}>
              ⌂
            </button>
            <button type="button" aria-label="Refresh data" onClick={onRefresh}>
              ⟳
            </button>
            <button type="button" className="exit" onClick={onLogout}>
              Close workspace↗
            </button>
          </div>
        </header>

        {toast && <div className="console-toast">{toast}</div>}

        <div className="console-bar">
          <div>
            <span className={`online ${realtimeTransport ? '' : 'offline'}`} />
            <small>{data ? `${data.assets.length} assets monitored` : 'Syncing live data...'}</small>
            <small>{realtimeTransport ? `${realtimeTransport.toUpperCase()} REALTIME` : 'POLLING FALLBACK'}</small>
          </div>
          <div>
            <small>{realtimeTransport ? 'Live updates · 5 second samples' : 'Fallback refresh · 15 seconds'}</small>
          </div>
        </div>

        {renderTabContent()}
      </section>

      {showTrendDetail && data && (
        <div
          className="trend-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowTrendDetail(false)
          }}
        >
          <section className="trend-modal" role="dialog" aria-modal="true" aria-labelledby="trend-modal-title">
            <header className="trend-modal-header">
              <div>
                <span className="index">LIVE VIBRATION / MM/S RMS</span>
                <h2 id="trend-modal-title">Turbine 04 trend</h2>
              </div>
              <button
                type="button"
                className="trend-modal-close"
                aria-label="Close trend detail"
                onClick={() => setShowTrendDetail(false)}
              >
                ×
              </button>
            </header>
            <div className="trend-modal-chart">
              <VibrationChart data={data.chartData} height={360} />
            </div>
            <div className="trend-modal-summary">
              <div>
                <span className="index">LATEST READING</span>
                <strong>{data.chartData.at(-1)?.value.toFixed(1) ?? '—'} mm/s</strong>
              </div>
              <div>
                <span className="index">SAMPLES IN VIEW</span>
                <strong>{data.chartData.length}</strong>
              </div>
              <small>Updates every 15 seconds while the dashboard is open.</small>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
