import type { Register, Timer } from 'claude-code'

// Keeps the main conversation's 1h prompt cache warm while the person is away,
// by asking $.model.fork (Claude Code's own request over the main thread's last
// prefix, no transcript row, tool-less) a one-word question shortly before the
// cache would lapse. Off until `/keepalive on`. Every doubt stops it:
// a first "canary" fork must show the cache was read, not rewritten; a timer that
// fires late (the machine slept), a turn in progress, a compaction or a model
// change all skip; any miss ends the idle stretch.

const MIN = 60_000
const DAY = 24 * 60 * MIN
const TTL = 60 * MIN
const PING_AFTER = 51 * MIN // after the last confirmed cache touch
const JITTER = MIN // spread concurrent sessions apart
const LATE = 2 * MIN // a timer later than this is skipped, never caught up
const STALE = TTL - 3 * MIN // past this since the last touch the cache may have lapsed
const CANARY_AFTER = 90_000
const MAX_PINGS = 2 // default per idle stretch
const MAX_CAP = 24 // what `/keepalive on <n|time>` may ask for (~21h)
const MIN_PREFIX = 50_000
const READ_OK = 0.9 // fork must read at least this share of the cached prefix
const WRITE_MAX = 0.1 // and write at most this share of it
const LOCK_MS = 90_000 // one fork at a time across sessions
const QUOTA_STOP = 95 // skip pings once a 5h / 7d window is this full (%)
const OUTPUT_MAX = 100 // a fork that writes more than this is not a cheap ping
const FORGET_AFTER = 3 * DAY // store records of sessions not seen for this long
const EFFORT_EVERY = 2_000 // how often an idle session looks for an effort change (a local read)
const EFFORT_CHANGED = 'effort-changed' // blocker's answer: pause, don't stop
const BUSY_FOR = 6 * 60 * MIN // a turn marker older than this is a crash, not a turn
const TOMBSTONE_MAX = 30 * DAY // a session that never came back to take its off in
// Cache-read USD per million tokens (Anthropic list prices); used only for estimates.
const CACHE_READ_PRICE: Record<string, number> = {
  'claude-fable-5-1': 0.25,
  'claude-opus-5-5': 0.2,
  'claude-sonnet-5-5': 0.1,
  'claude-haiku-5-5': 0.01,
}
// $.model.fork takes no output cap, so the prompt keeps the reply short and OUTPUT_MAX stops the stretch.
const PROMPT =
  'Cache keep-alive ping. This needs no reasoning: do not think, do not use tools. Reply with exactly "." and nothing else.'

type Kind = 'canary' | 'ping'
// `effortSig` is what the settings said about effort when the request was made; a
// different one later means effort was changed (Claude Code renders effort into the
// request, so the next turn rewrites the conversation's cache and a refresh is wasted).
type Last = { at: number; cached: number; model: string; effort?: string | number; effortSig?: string }
type Row = {
  sid?: string
  cwd?: string
  model?: string
  cached?: number
  enabled?: boolean
  verified?: boolean
  pings?: number
  max?: number
  next?: number
  nextKind?: Kind | null
  refreshedAt?: number
  paused?: boolean
  note?: string
  updated?: number
}
type Lock = { sid: string; at: number; token: string }
// `on:<sid>` in the store. `at` is when the session was last seen (any turn or refresh),
// `anchor` its last confirmed cache touch, so a reload of the mod can resume the schedule.
type Saved = {
  isOn: boolean
  isVerified: boolean
  at: number
  base?: number
  max?: number
  capUntil?: number
  anchor?: number
  pings?: number
  isFused?: boolean // this idle stretch was stopped: no more pings until a real turn
  hasForked?: boolean // a fork went out since the cap was set
}

type Api = {
  save: () => Promise<void>
  publish: () => Promise<void>
  arm: () => Promise<void>
  list: () => Promise<string>
  cost: (n: number) => Promise<string>
  now: () => Promise<string>
  offOther: (prefix: string) => Promise<string>
  ttlProblem: () => Promise<string | undefined>
  follow: () => Promise<boolean>
  watchEffort: () => Promise<void>
  disable: (why: string) => Promise<void>
  followSoon: () => void
}

let api: Api | undefined
let sid = ''
let home = ''
let cwd = ''
let base = MAX_PINGS // the session's cap: MAX_PINGS, or MAX_CAP after `/keepalive max`
let max = MAX_PINGS // this absence's cap: `/keepalive on <n|time>` sets it; back to `base` once used or expired
let capUntil = 0 // for a time given: when that time is up
let isOn = false
let isVerified = false
let isBusy = false
// A main turn is running in this process. Unlike isBusy it survives a session load
// (forgetSession), so a load committed mid-turn still knows the turn is on.
let isTurnActive = false
let isCompacting = false
let isForking = false
let last: Last | undefined
let anchor = 0 // last time the cache was confirmed touched
let refreshedAt = 0 // last successful fork, for status lines' countdowns
let pings = 0
let isFused = false
let hasForked = false
// Effort now differs from the last request's: no refresh (the cache it would keep
// can't be used at this effort) until it is set back, or a turn runs at the new one.
let isPaused = false
let pausedFrom = '' // the effort the cache was written at, for the messages
let wasArmed = false // a refresh was due when the pause began: only then does a set-back resume it
let publishing: Promise<void> = Promise.resolve() // publishes run one at a time, newest state last
let timer: Timer | undefined
let dueAt = 0
let dueKind: Kind | undefined
let note = ''
let showStatus = true // CACHE_KEEPALIVE_UI_STATUS=0 hides the line under the prompt
// Bumped by anything that must stop a refresh already on its way (a turn, a
// compaction, off, a session switch); a fork goes out only if it did not move.
let gen = 0
let loadSeq = 0 // the newest load(); an older one that finishes later is dropped

const kTok = (n: number) => `${Math.round(n / 1000)}k`
const statusDir = () => `${home}/.cache/claude-cache-keepalive`

// "3" -> 3 pings; "8h", "90m", "2h30m", "1.5h" -> the pings that keep the cache warm
// until then (each ping buys PING_AFTER, the last cache touch TTL more).
function parseCap(arg: string): number | undefined {
  if (/^\d+$/.test(arg)) return Math.min(MAX_CAP, Number(arg))
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m(?:in)?)?$/.exec(arg)
  if (!m || (!m[1] && !m[2])) return undefined
  const away = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * MIN
  return Math.min(MAX_CAP, Math.max(0, Math.ceil((away - TTL) / PING_AFTER)))
}

const fmtMin = (ms: number) => {
  const m = Math.max(0, Math.round(ms / MIN))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}
// The family name, for looking up settings and prices only (never for safety
// checks: it drops the date). One canonical name for every spelling of a model: "claude-opus-5-5[1m]",
// "claude-opus-5-5-20261001", Bedrock's "us.anthropic.claude-opus-5-5-v1:0" and
// Vertex's "claude-opus-5-5@20261001" are all "claude-opus-5-5" here.
const modelKey = (m: string) => {
  const s = m.toLowerCase().replace(/\[.*?\]/g, '')
  const at = s.indexOf('claude-')
  return (at > 0 ? s.slice(at) : s)
    .replace(/@.*$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '')
}
// For "is this the same model?": provider wrappers go, but the date stays, so two
// dated versions of one family never compare equal (Vertex's "@date" = "-date").
const modelId = (m: string) => {
  const s = m.toLowerCase().replace(/\[.*?\]/g, '')
  const at = s.indexOf('claude-')
  return (at > 0 ? s.slice(at) : s).replace('@', '-').replace(/-v\d+(:\d+)?$/, '')
}
const sameModel = (a: string, b: string) => modelId(a) === modelId(b)

// The effort setting that wins for a model, in Claude Code's order: the env override,
// then the model's own setting, then the global one (null: the model's default).
// A change to a setting another one shadows does not count.
function effortSig(settings: Readonly<Record<string, unknown>>, env: string | undefined, model: string): string {
  const per = settings.modelSettings as Record<string, { effortLevel?: unknown } | undefined> | undefined
  const own = per
    ? Object.entries(per).find(([k]) => modelKey(k) === modelKey(model))?.[1]?.effortLevel
    : undefined
  return JSON.stringify(env || own || settings.effortLevel || null)
}

function cancel() {
  timer?.cancel()
  timer = undefined
  dueKind = undefined
}

// Everything that belongs to one conversation; a /clear or /resume starts another.
function forgetSession() {
  cancel()
  gen += 1
  isOn = false
  isVerified = false
  isBusy = false
  isCompacting = false
  base = max = MAX_PINGS
  capUntil = 0
  last = undefined
  anchor = 0
  refreshedAt = 0
  pings = 0
  isFused = false
  hasForked = false
  isPaused = false
  pausedFrom = ''
  wasArmed = false
  note = ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)

    async function save() {
      // Session and fields as they are now: a switch during the awaits must not mix them.
      const id = sid
      const v: Saved = { isOn, isVerified, at: 0, base, max, capUntil, anchor, pings, isFused, hasForked }
      v.at = await $.clock.now()
      await $.store.set(`on:${id}`, v)
    }

    // Queued: each run reads the state when its turn comes, so the last one written is the newest.
    function publish(): Promise<void> {
      publishing = publishing.then(publishNow, publishNow)
      return publishing
    }

    async function publishNow() {
      if (!home || !sid) return
      // Fields and target taken together before any await, so a switch can't mix them.
      const id = sid
      const ui = { isOn, isPaused, note, base, pings, max, isTimer: !!timer, dueAt, dueKind }
      const status: Row = {
        sid,
        cwd,
        model: last?.model,
        cached: last?.cached,
        enabled: isOn,
        verified: isVerified,
        pings,
        max,
        next: timer ? dueAt : 0,
        nextKind: timer ? (dueKind ?? null) : null,
        refreshedAt,
        paused: isPaused,
        note,
        updated: 0,
      }
      status.updated = await $.clock.now()
      await $.fs.write(`${statusDir()}/${id}.json`, JSON.stringify(status))
      if (!showStatus || sid !== id) return
      const isStopped = /未命中|出错|熔断|已关闭|被其他窗口/.test(ui.note)
      if (!ui.isOn) return $.ui.status(isStopped ? `♻✗ ${ui.note}` : undefined)
      if (ui.isPaused) return $.ui.status(undefined)
      const at = ui.isTimer ? new Date(ui.dueAt).toTimeString().slice(0, 5) : ''
      const mode = ui.base === MAX_CAP ? '常驻 ' : ''
      const upcoming = ui.isTimer ? ` · 下次${ui.dueKind === 'canary' ? '验证' : '续命'} ${at}` : ''
      $.ui.status(`♻ ${mode}${ui.pings}/${ui.max}${upcoming}${isStopped ? ` · ${ui.note}` : ''}`)
    }

    // Load a session's own record; nothing of another session is carried over.
    // Everything is read first into locals, then committed in one synchronous step,
    // and only if this is still the newest load and the engine is still on that session.
    async function load(id: string): Promise<boolean> {
      const seq = ++loadSeq
      const [dir, saved, now] = await Promise.all([
        $.session.cwd(),
        $.store.get(`on:${id}`) as Promise<Saved | undefined>,
        $.clock.now(),
      ])
      const wasOn = saved?.isOn ?? false
      const [stored, busy] = await Promise.all([
        wasOn ? ($.store.get(`last:${id}`) as Promise<Last | undefined>) : Promise.resolve(undefined),
        $.store.get(`busy:${id}`) as Promise<{ at: number } | undefined>,
      ])
      if (seq !== loadSeq || (await $.session.id()) !== id || seq !== loadSeq) return false // superseded
      forgetSession()
      sid = id
      cwd = dir
      isOn = wasOn
      isVerified = saved?.isVerified ?? false
      base = saved?.base ?? MAX_PINGS
      const isCapLive = saved?.max !== undefined && (saved.capUntil ?? 0) > now
      max = isCapLive ? (saved?.max ?? base) : base
      capUntil = isCapLive ? (saved?.capUntil ?? 0) : 0
      last = stored
      anchor = Math.max(saved?.anchor ?? 0, last?.at ?? 0)
      pings = saved?.pings ?? 0
      isFused = saved?.isFused ?? false
      hasForked = saved?.hasForked ?? false
      // A reload can land mid-turn: the turn's own marker says so.
      isBusy = isTurnActive || (busy !== undefined && now - busy.at < BUSY_FOR)
      return true
    }

    // The engine's session id moves on /clear and /resume without a session.start.
    // True only when the state in memory is the engine's current session's.
    async function follow(): Promise<boolean> {
      const id = await $.session.id()
      if (id === sid) return true
      if (!(await load(id)) || sid !== id) return false
      await resume()
      return sid === id
    }

    // /resume raises no event in the new conversation: look once it has settled.
    function followSoon() {
      $.clock.after(3_000, () => {
        void follow().catch(() => undefined)
      })
    }

    // Ends this idle stretch for good, also across a reload of the mod.
    async function stopStretch(why: string) {
      cancel()
      isFused = true
      note = why
      await save()
    }

    // Off for good, from any path: no timer, no fork in flight counts, no `last:` kept.
    async function disable(why: string) {
      const id = sid
      cancel()
      gen += 1
      isOn = false
      note = why
      await save()
      await $.store.delete(`last:${id}`)
    }

    // `g0`/`id`: the generation and session the caller started in. A caller from an
    // older stretch (a turn or switch came since) touches nothing, not even the timer.
    async function schedule(at: number, kind: Kind, g0: number, id: string, isRetry = false) {
      if (gen !== g0 || sid !== id) return
      cancel()
      // A refresh held back by a pause is remembered, so a set-back of effort brings it.
      if (isPaused) {
        wasArmed = true
        return
      }
      const now = await $.clock.now()
      if (gen !== g0 || sid !== id) return // moved on while waiting: no timer for it
      if (isPaused) {
        wasArmed = true
        return
      }
      dueAt = at
      dueKind = kind
      timer = $.clock.after(Math.max(0, at - now), () => {
        const [g, s0] = [gen, sid]
        void fire(kind, false, isRetry).catch(async err => {
          if (gen !== g || sid !== s0) return // the stretch it belonged to is over
          await stopStretch(`出错停止: ${String(err).slice(0, 80)}`)
          await publish()
        })
      })
    }

    // A main turn just ended: a new idle stretch starts from its last request.
    async function arm() {
      cancel()
      const [g0, id] = [gen, sid] // the stretch this call is for; a turn or switch ends it
      pings = 0
      isFused = false
      if (!(await synced()) || !last) return publish()
      if (last.cached < MIN_PREFIX) {
        note = `上下文 ${kTok(last.cached)} < ${kTok(MIN_PREFIX)}，不续`
        return publish()
      }
      anchor = last.at
      note = ''
      const seen = last
      const moved = await effortMoved(seen)
      if (gen !== g0 || sid !== id || last !== seen || isBusy) return // a turn or switch took over
      if (moved !== undefined) return pause(seen, moved, true)
      isPaused = false
      if (max === 0) {
        note = '上限为 0，不续'
        return publish()
      }
      // Turned on some minutes after the last request: a time already past means
      // "soon", not "late" (the STALE check in fire still guards a lapsed cache).
      const soon = (await $.clock.now()) + 5_000
      if (!isVerified) await schedule(Math.max(last.at + CANARY_AFTER, soon), 'canary', g0, id)
      else await schedule(Math.max(anchor + PING_AFTER + Math.random() * JITTER, soon), 'ping', g0, id)
      return publish()
    }

    // After a reload of the mod mid-session: carry on with the pings, never a canary
    // (a reload may land mid-turn, where a canary would only cost money).
    // `canCanary`: known idle (an effort set back), so a pending canary may go out too.
    async function resume(canCanary = false) {
      if (isFused || isBusy || isPaused || !isOn || !last || last.cached < MIN_PREFIX || pings >= max) return publish()
      if (!isVerified && !canCanary) return publish()
      const [g0, id] = [gen, sid]
      const now = await $.clock.now()
      if (gen !== g0 || sid !== id || isBusy || isPaused || !isOn || isFused) return
      if (now - anchor > STALE) return publish()
      if (!isVerified) await schedule(Math.max(last.at + CANARY_AFTER, now + 5_000), 'canary', g0, id)
      else await schedule(Math.max(anchor + PING_AFTER + Math.random() * JITTER, now + 5_000), 'ping', g0, id)
      return publish()
    }

    // Another window may have switched this session off (`/keepalive off <id>`): it
    // leaves `off:<sid>`, a key this session's save() never writes, so no later save
    // can undo it; only this session's own `/keepalive on|max` clears it.
    async function synced() {
      if (isOn && (await $.store.get(`off:${sid}`)) !== undefined) {
        await disable('已被其他窗口关闭')
        return false
      }
      const saved = (await $.store.get(`on:${sid}`)) as Saved | undefined
      if (saved && !saved.isOn && isOn) await disable('已被其他窗口关闭')
      return isOn
    }

    async function quotaFull(): Promise<string | undefined> {
      const { rateLimits } = await $.session.usage()
      const full = rateLimits.find(
        w => (w.kind === 'five_hour' || w.kind === 'seven_day') && w.percentUsed >= QUOTA_STOP,
      )
      return full && `${full.kind === 'five_hour' ? '5小时' : '7天'}额度已用 ${full.percentUsed}%`
    }

    // Forks run on the subagent TTL; a 5m fork would not keep a 1h cache.
    async function ttlProblem(): Promise<string | undefined> {
      const env = await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
      const set = (await $.settings.read()).subagentPromptCacheTtl
      const ttl = env ?? (typeof set === 'string' ? set : undefined)
      if (ttl === '1h') return undefined
      return `续命请求走的是子代理缓存档，现在是 ${ttl ?? '默认（5m）'}，必须是 1h（settings.json 设 "subagentPromptCacheTtl": "1h"）`
    }

    // The effective effort for a model as the settings say now ("null": the model's default).
    async function effortNow(model: string): Promise<string> {
      const env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
      return effortSig(await $.settings.read(), env, model)
    }
    const effortName = (sig: string) => String(JSON.parse(sig) ?? '默认')

    // The effort now, when it differs from the one the request was sent with.
    async function effortMoved(seen: Last): Promise<string | undefined> {
      if (seen.effortSig === undefined) return undefined
      const sig = await effortNow(seen.model)
      return sig !== seen.effortSig ? sig : undefined
    }
    const effortChanged = async (seen: Last) => (await effortMoved(seen)) !== undefined

    // Effort moved away from the last request's: hold every refresh, say so once.
    // A fork already sent is left to settle (its pings and fuses still count).
    // `armed`: a refresh was due, so setting effort back should bring it back.
    function pause(seen: Last, nowSig: string, armed: boolean) {
      if (isPaused) {
        if (armed) wasArmed = true // a refresh became due during the pause: a set-back brings it
        return publish()
      }
      cancel()
      isPaused = true
      wasArmed = armed
      pausedFrom = seen.effortSig ? effortName(seen.effortSig) : ''
      const to = effortName(nowSig)
      note = `effort 已从 ${pausedFrom} 改为 ${to}，续命暂停`
      $.ui.toast(
        `缓存续命已暂停：effort ${pausedFrom} → ${to}。改回 ${pausedFrom} 会自动恢复；` +
          `按 ${to} 发消息会重写一次缓存，之后按新 effort 续命。`,
        { timeoutMs: 8_000 },
      )
      return publish()
    }

    // Effort is back to what the cache was written at: carry on where the stretch was,
    // if a refresh was due when it paused.
    async function unpause() {
      isPaused = false
      note = ''
      $.ui.toast(`effort 已改回 ${pausedFrom}，缓存续命已恢复。`, { timeoutMs: 5_000 })
      pausedFrom = ''
      const armed = wasArmed
      wasArmed = false
      // A fork in flight schedules the next refresh itself once it settles.
      return armed && !isForking ? resume(true) : publish()
    }

    // Effort is watched every couple of seconds while idle, and right after /effort and
    // /model: a change pauses keep-alive (the ♻ goes), setting it back resumes it.
    async function watchEffort() {
      if (!(await follow())) return
      if (!isOn || isBusy || isCompacting || !last) return
      const [s0, g, seen, paused] = [sid, gen, last, isPaused]
      const moved = await effortMoved(seen)
      // Nothing may have moved while the settings were read.
      if (sid !== s0 || gen !== g || last !== seen || isPaused !== paused) return
      if (!isOn || isBusy || isCompacting) return
      if (moved !== undefined && !isPaused) await pause(seen, moved, timer !== undefined || isForking)
      else if (moved === undefined && isPaused) await unpause()
    }

    // Takes the cross-session lock: write a token of our own, wait a moment, and
    // only hold it if it is still ours (the store has no compare-and-set).
    async function takeLock(): Promise<Lock | undefined> {
      const now = await $.clock.now()
      const held = (await $.store.get('lock')) as Lock | undefined
      if (held && now - held.at < LOCK_MS) return undefined // even our own: a second caller in this session
      const mine: Lock = { sid, at: now, token: `${sid}:${now}:${Math.random()}` }
      await $.store.set('lock', mine)
      await $.clock.sleep(200 + Math.random() * 300)
      const after = (await $.store.get('lock')) as Lock | undefined
      return after?.token === mine.token ? mine : undefined
    }

    async function dropLock(mine: Lock) {
      const held = (await $.store.get('lock')) as Lock | undefined
      if (held?.token === mine.token) await $.store.delete('lock')
    }

    // Whether a refresh may go out right now; undefined means yes, else why not.
    async function blocker(isManual: boolean, seen: Last): Promise<string | undefined> {
      if (isBusy) return ''
      if (isCompacting) return '正在压缩，本次不续'
      const now = await $.clock.now()
      if (!isManual && now - dueAt > LATE) return '定时器迟到（可能休眠过），本次不续'
      if (now - anchor > STALE) return '缓存可能已过期，本次不续'
      const model = await $.session.model()
      if (!sameModel(model, seen.model)) return `模型已切换（${seen.model} → ${model}），本次不续`
      if (await effortChanged(seen)) return EFFORT_CHANGED
      const quota = await quotaFull()
      if (quota) return `${quota}，本次不续`
      const ttl = await ttlProblem()
      if (ttl) return ttl
      return undefined
    }

    async function fire(kind: Kind, isManual = false, isRetry = false) {
      if (!isManual) timer = undefined
      if (!(await follow())) return
      if (!isManual && isFused) return publish()
      const g = gen
      const fireSid = sid
      if (!isManual && !(await synced())) return publish()
      if (isBusy || !last) return publish()
      if (!isManual && !isOn) return publish()
      const seen = last
      anchor = Math.max(anchor, seen.at) // the last real request touched the cache too
      const early = await blocker(isManual, seen)
      if (early === EFFORT_CHANGED) {
        const moved = await effortMoved(seen)
        if (gen !== g || sid !== fireSid) return publish()
        return moved !== undefined ? pause(seen, moved, true) : resume(true) // set back already: keep the stretch
      }
      if (early !== undefined) {
        if (early && !isManual) await stopStretch(early)
        else if (early) note = early
        return publish()
      }

      const mine = await takeLock()
      if (!mine) {
        if (isManual) {
          note = '其他会话正在续命，稍后再试'
          return publish()
        }
        // Another session is forking: one more try shortly, if there is still room.
        const retry = (await $.clock.now()) + 20_000 + Math.random() * 30_000
        if (!isRetry && retry - anchor < STALE - MIN) {
          await schedule(retry, kind, g, fireSid, true)
          return publish()
        }
        await stopStretch('其他会话占用，本次不续')
        return publish()
      }

      let r
      let sent = 0
      try {
        // Last look: nothing may have moved while the checks and the lock were awaited.
        const late = await blocker(isManual, seen)
        if (late === EFFORT_CHANGED) {
          const moved = await effortMoved(seen)
          if (gen !== g || sid !== fireSid) return publish()
          return moved !== undefined ? pause(seen, moved, true) : resume(true) // set back already: keep the stretch
        }
        if (gen !== g || late !== undefined) {
          if (late && !isManual && gen === g) await stopStretch(late)
          else if (late) note = late
          return publish()
        }
        hasForked = true
        await save()
        // The cache's clock restarts when the request is served, not when its reply ends.
        sent = await $.clock.now()
        // The remote-off check is the last await: nothing runs between it and the fork.
        const isStillOn = isManual || (await synced())
        // A pause or a used-up cap that landed during the awaits above stops it here.
        const isOverCap = !isManual && pings >= max
        if (gen !== g || !isStillOn || isPaused || isOverCap) {
          if (isPaused && gen === g && sid === fireSid) wasArmed = true // held back, not dropped
          hasForked = false // no request was made
          if (sid === fireSid) await save()
          return publish()
        }
        isForking = true
        r = await $.model.fork({ prompt: PROMPT })
      } finally {
        isForking = false
        await dropLock(mine)
      }

      // The conversation moved on while the fork ran (a turn, /clear, /resume, off):
      // its result belongs to no current stretch, and nothing is recorded from it.
      if (gen !== g || sid !== fireSid) return publish()
      // Switched off from another window while the fork ran: that wins, nothing is saved over it.
      if (isOn && !(await synced())) return publish()
      const at = sent
      if (!r.isAnswered && r.reason === 'nothing-to-fork') {
        hasForked = false // no request was made
        note = '没有可续的主会话请求'
        await save()
        return publish()
      }
      const u = 'usage' in r ? r.usage : undefined
      const read = u?.cache_read_input_tokens ?? 0
      const wrote = u?.cache_creation_input_tokens ?? 0
      const out = u?.output_tokens ?? 0
      // Only whether the reply was the expected ".": its text never reaches disk.
      const reply = !r.isAnswered ? '' : r.text.trim() === '.' ? ' 回复"."' : ` 回复非预期（${r.text.length} 字）`
      const spent = `读${kTok(read)} 写${kTok(wrote)} 出${out}${reply}`
      const isHit = r.isAnswered && read >= READ_OK * seen.cached && wrote <= WRITE_MAX * seen.cached

      if (!isHit) {
        cancel()
        if (kind === 'canary') {
          isVerified = false
          await disable(`验证未命中（${spent}），已关闭`)
        } else {
          await stopStretch(`续命未命中（${spent}），本次熔断`)
        }
        return publish()
      }

      anchor = at
      refreshedAt = at
      if (kind === 'canary') {
        isVerified = true
        note = `验证通过（${spent}）`
      } else if (isManual) {
        note = `手动续命（${spent}）`
      } else {
        pings += 1
        note = `第${pings}次续命（${spent}）`
      }
      await save()
      if (out > OUTPUT_MAX) {
        // The cache was kept, but this ping cost real output: no more this stretch.
        await stopStretch(`${note}，输出 ${out} token 超过 ${OUTPUT_MAX}，本次熔断`)
        return publish()
      }
      if (isBusy || !isOn || isFused) return publish()
      if (kind === 'canary' ? max > 0 : pings < max)
        await schedule(anchor + PING_AFTER + Math.random() * JITTER, 'ping', g, fireSid)
      else note += '，已达上限'
      return publish()
    }

    // Cache-read price per MTok, for the cost estimate only.
    function readPrice(model: string): number | undefined {
      const key = Object.keys(CACHE_READ_PRICE).find(k => modelKey(model) === modelKey(k))
      return key ? CACHE_READ_PRICE[key] : undefined
    }

    // The windows open on this machine with keep-alive on (from their status files).
    async function list(): Promise<string> {
      const now = await $.clock.now()
      const rows: Row[] = []
      let files: { name: string }[] = []
      try {
        files = await $.fs.list(statusDir())
      } catch {
        // no session has written its status yet
      }
      for (const f of files) {
        if (!f.name.endsWith('.json')) continue
        try {
          const r = JSON.parse(await $.fs.read(`${statusDir()}/${f.name}`)) as Row
          if (r.enabled || r.next) rows.push({ ...r, sid: r.sid ?? f.name.slice(0, -5) })
        } catch {
          // a file being written or emptied by a session that ended
        }
      }
      if (rows.length === 0) return '没有打开的窗口开着缓存续命。'
      const lines = rows
        .sort((a, b) => (a.next || Infinity) - (b.next || Infinity))
        .map(r => {
          const me = r.sid === sid ? '（本会话）' : ''
          const state = !r.next
            ? r.note || '等待下一轮结束'
            : r.next < now - LATE
              ? '已失联（窗口可能已关闭）'
              : `${r.nextKind === 'canary' ? '验证' : '续命'}在 ${fmtMin(r.next - now)} 后`
          return `- ${r.sid?.slice(0, 8)}${me} ${r.cwd ?? ''} | ${kTok(r.cached ?? 0)} | 已续 ${r.pings ?? 0}/${r.max ?? 0} | ${state}`
        })
      return [`开着缓存续命的窗口（${rows.length}）：`, ...lines].join('\n')
    }

    async function cost(n: number): Promise<string> {
      if (!last) return ''
      const price = readPrice(last.model)
      if (price === undefined) return ''
      const one = (last.cached * price) / 1e6
      const total = n + (isVerified || n === 0 ? 0 : 1)
      const canary = isVerified || n === 0 ? '' : '（含首次验证 1 次）'
      return `，按当前 ${kTok(last.cached)} 上下文每次约 $${one.toFixed(3)}，最多约 $${(one * total).toFixed(2)}${canary}`
    }

    // `/keepalive now`: one refresh right away, outside the schedule.
    async function refreshNow(): Promise<string> {
      if (!(await follow())) return '会话正在切换，请稍后再试。'
      if (!last) return '这个会话还没有可续的请求：先完成一轮对话。'
      if (isBusy) return '正在对话中，缓存本来就是热的。'
      if (last.cached < MIN_PREFIX) return `上下文 ${kTok(last.cached)} < ${kTok(MIN_PREFIX)}，不值得续。`
      await fire(isVerified ? 'ping' : 'canary', true)
      return note
    }

    // `/keepalive off <id>`: switch another session off through the shared store.
    async function offOther(prefix: string): Promise<string> {
      const keys = (await $.store.keys()).filter(k => k.startsWith(`on:${prefix}`))
      if (keys.length === 0) return `没有 id 以 ${prefix} 开头的会话记录。`
      if (keys.length > 1) return `有 ${keys.length} 个会话 id 以 ${prefix} 开头，请多写几位。`
      const other = keys[0].slice(3)
      if (other === sid) return ''
      await $.store.set(`off:${other}`, { at: await $.clock.now() })
      try {
        const path = `${statusDir()}/${other}.json`
        const row = JSON.parse(await $.fs.read(path)) as Row
        await $.fs.write(path, JSON.stringify({ ...row, enabled: false, next: 0, nextKind: null, note: '已被其他窗口关闭' }))
      } catch {
        // no status file: nothing on screen to correct
      }
      return `已关闭会话 ${other.slice(0, 8)} 的续命；它不会再发出续命请求。`
    }

    api = { save, publish, arm, list, cost, now: refreshNow, offOther, ttlProblem, follow, watchEffort, disable, followSoon }
    home = (await $.env.get('HOME')) ?? ''
    showStatus = (await $.env.get('CACHE_KEEPALIVE_UI_STATUS')) !== '0'
    await load(await $.session.id()) // false: superseded; the state stays off until the next follow()

    // Forget records of sessions not seen for three days; `last:`/`busy:` keys go by
    // their own time. An `off:` tombstone stays until its session has taken it in
    // (its `on:` says off, written after the tombstone), however old it is.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      const [kind, id] = [key.slice(0, key.indexOf(':') + 1), key.slice(key.indexOf(':') + 1)]
      if (id === sid || !['on:', 'last:', 'busy:', 'off:'].includes(kind)) continue
      const v = (await $.store.get(key)) as { at?: number } | undefined
      if (kind === 'off:') {
        const owner = (await $.store.get(`on:${id}`)) as Saved | undefined
        const isTakenIn = owner !== undefined && !owner.isOn && owner.at >= (v?.at ?? 0)
        const isAbandoned = now - (v?.at ?? 0) > TOMBSTONE_MAX
        if (isTakenIn || isAbandoned) await $.store.delete(key)
        if (isAbandoned) await $.store.delete(`on:${id}`)
        continue
      }
      if (kind === 'on:' && (await $.store.get(`off:${id}`)) !== undefined) continue // keep it for the check above
      if (typeof v?.at !== 'number' || now - v.at > FORGET_AFTER) await $.store.delete(key)
    }
    await $.command.register({
      name: 'keepalive',
      description: 'Prompt-cache keep-alive: on [n|8h], max (always full), now, off [id], status, list',
      argumentHint: 'on [次数|8h] | max | now | off [会话id] | status | list',
    })
    await resume()
    $.clock.every(EFFORT_EVERY, () => {
      void watchEffort().catch(() => undefined)
    })
    return r
  })

  on('command.run', { command: 'keepalive' }, async ($, e) => {
    if (api && !(await api.follow())) return { text: '会话正在切换，请稍后再试。' }
    let [verb = 'status', param = ''] = e.args.trim().toLowerCase().split(/\s+/)
    // `/keepalive 5` or `/keepalive 8h` means `on` with that cap.
    if (verb && parseCap(verb) !== undefined) [verb, param] = ['on', verb]
    if (verb === 'on' && param === 'max') [verb, param] = ['max', '']
    if (verb === 'max' || verb === 'on') {
      const cap = verb === 'max' ? MAX_CAP : param ? parseCap(param) : MAX_PINGS
      if (cap === undefined) return { text: `看不懂"${param}"：写次数（如 3）或大概多久回来（如 8h、90m、2h30m）。` }
      const ttl = await api?.ttlProblem()
      if (ttl) return { text: `没有开启：${ttl}。` }
      await $.store.delete(`off:${sid}`)
      isOn = true
      isFused = false
      hasForked = false
      if (verb === 'max') base = MAX_CAP
      else if (!param) base = MAX_PINGS // plain `on` is the normal mode
      max = cap
      // A one-off cap is for this absence: it lapses when the cache it buys would.
      capUntil = verb === 'on' && param ? (await $.clock.now()) + (cap * PING_AFTER + TTL) : 0
      if (last) await $.store.set(`last:${sid}`, last)
      await api?.save()
      if (!isBusy) await api?.arm()
      else await api?.publish()
      const reach = fmtMin(cap * PING_AFTER + TTL)
      const price = (await api?.cost(cap)) ?? ''
      const check = isVerified || cap === 0 ? '' : `先在上一轮结束约 ${CANARY_AFTER / 1000} 秒后验证一次（算一次续命的钱）；`
      if (cap === 0) return { text: `缓存续命已开启，但这次离开不需要续：1 小时内缓存本来就在。` }
      if (verb === 'max')
        return {
          text: `常驻续命已开启：${check}每次离开最多续 ${MAX_CAP} 次（缓存约可撑 ${reach}${price}），回来后不重置。在场时不花钱；关窗口、额度到 ${QUOTA_STOP}%、未命中都会停。/keepalive on 回普通模式，/keepalive off 关闭。`,
        }
      const back = base === MAX_CAP ? `常驻 ${MAX_CAP}` : `默认 ${MAX_PINGS}`
      return { text: `缓存续命已开启：${check}本次离开最多续 ${cap} 次，缓存约可撑 ${reach}${price}。你回来后恢复为 ${back} 次。` }
    }
    if (verb === 'now') return { text: (await api?.now()) || '没有执行。' }
    if (verb === 'off' && param) {
      const done = await api?.offOther(param)
      if (done) return { text: done }
    }
    if (verb === 'off') {
      base = max = MAX_PINGS
      capUntil = 0
      await api?.disable('')
      await api?.publish()
      return { text: '缓存续命已关闭。' }
    }
    if (verb === 'list') return { text: (await api?.list()) ?? '' }
    const upcoming = timer
      ? `，下次${dueKind === 'canary' ? '验证' : '续命'}在 ${fmtMin(dueAt - (await $.clock.now()))} 后`
      : ''
    return {
      text: `缓存续命：${isOn ? (isPaused ? '暂停（effort 已改）' : base === MAX_CAP ? '常驻' : '开') : '关'}，${isVerified ? '已验证' : '未验证'}，本次已续 ${pings}/${max}${upcoming}${note ? `；${note}` : ''}。`,
    }
  })

  // Right after /effort or /model, not only on the next poll (a picker may still be
  // open when this resolves; the poll catches a choice made later).
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    if (e.command === 'effort' || e.command === 'model') void api?.watchEffort().catch(() => undefined)
    return r
  })

  on('turn.start', async ($, e, next) => {
    // Stopping timers and marking busy is safe whatever session the state is for.
    isTurnActive = true
    isBusy = true
    isPaused = false
    gen += 1
    cancel()
    // A failure here leaves the flags set on purpose: if the turn runs anyway, clearing
    // them could let a ping out mid-turn. The next turn's completion clears them.
    if (api && !(await api.follow())) return next(e)
    isBusy = true // a load committed by follow() starts from a clean state
    if (isOn) await $.store.set(`busy:${sid}`, { at: await $.clock.now() })
    // Back after a fork went out for it, or past its time: the one-off cap was for that absence.
    if (capUntil && (hasForked || (await $.clock.now()) > capUntil)) {
      max = base
      capUntil = 0
      hasForked = false
      if (isOn) await api?.save()
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Decided before any await: our own fork runs while no turn does; a real turn's
    // steps always count, even if a turn starts while this step is in flight.
    const isMain = e.agentId === undefined && !(isForking && !isBusy)
    if (!isMain) return yield* next(e)
    const start = await $.clock.now()
    // The effort settings as the request leaves, not as they are once it is answered.
    let sig: string | undefined
    try {
      const [settings, envEffort] = await Promise.all([$.settings.read(), $.env.get('CLAUDE_CODE_EFFORT_LEVEL')])
      sig = effortSig(settings, envEffort, e.model)
    } catch {
      sig = undefined // unknown: this request must not be refreshed (below)
    }
    const r = yield* next(e)
    if (sig === undefined) {
      // Without the settings this request went out with, a change could not be seen:
      // forget the last request whether or not this one was answered.
      last = undefined
      if (isOn) await $.store.delete(`last:${sid}`)
      return r
    }
    if (r && r.usage) {
      const u = r.usage
      last = {
        at: start,
        cached: u.cache_read_input_tokens + u.cache_creation_input_tokens,
        model: e.model,
        effort: e.effort,
        effortSig: sig,
      }
      // Kept across reloads of the mod, for sessions with keep-alive on only.
      if (isOn) await $.store.set(`last:${sid}`, last)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    let r
    try {
      r = await next(e)
    } finally {
      if (e.agentId === undefined) {
        // Cleared whatever happens in the chain, or a stuck flag would end keep-alive silently.
        isTurnActive = false
        isBusy = false
        await $.store.delete(`busy:${sid}`).catch(() => undefined)
      }
    }
    if (e.agentId === undefined) {
      if (e.reason === 'answer') await api?.arm()
      else {
        cancel()
        note = '上一轮未正常结束，不续'
        await api?.publish()
      }
      if (isOn) await api?.save() // the session was seen: its record stays
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    isCompacting = true
    gen += 1
    cancel()
    try {
      return await next(e)
    } finally {
      isCompacting = false
      last = undefined
      pings = 0
      await $.store.delete(`last:${sid}`)
      note = '已压缩，等下一轮请求后再续'
      await api?.publish()
    }
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const ended = sid
    forgetSession()
    if (ended) await $.store.delete(`busy:${ended}`)
    if (e.reason === 'clear' && ended) {
      await $.store.delete(`last:${ended}`)
      await $.store.delete(`on:${ended}`)
      await $.store.delete(`off:${ended}`)
    }
    if (e.reason === 'resume') api?.followSoon()
    if (home && ended) await $.fs.write(`${statusDir()}/${ended}.json`, '{}')
    return next(e)
  })
}
