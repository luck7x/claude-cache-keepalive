import type { Register, Timer } from 'claude-code'

// Keeps the main conversation's 1h prompt cache warm while the person is away,
// by asking $.model.fork (Claude Code's own request over the main thread's last
// prefix, no transcript row, tool-less) a one-word question shortly before the
// cache would lapse. Off until `/keepalive on`. Every doubt stops it:
// a first "canary" fork must show the cache was read, not rewritten; a timer that
// fires late (the machine slept), a turn in progress, a compaction or a model
// change all skip; any miss ends the idle stretch.

const MIN = 60_000
const TTL = 60 * MIN
const PING_AFTER = 51 * MIN // after the last confirmed cache touch
const JITTER = MIN // spread concurrent sessions apart
const LATE = 2 * MIN // a timer later than this is skipped, never caught up
const CANARY_AFTER = 90_000
const MAX_PINGS = 2 // default per idle stretch
const MAX_CAP = 24 // what `/keepalive on <n|time>` may ask for (~21h)
const MIN_PREFIX = 50_000
const READ_OK = 0.9 // fork must read at least this share of the cached prefix
const WRITE_MAX = 0.1 // and write at most this share of it
const LOCK_MS = 90_000 // one fork at a time across sessions
const QUOTA_STOP = 95 // skip pings once a 5h / 7d window is this full (%)
const OUTPUT_MAX = 100 // a fork that writes more than this is not a cheap ping
// $.model.fork takes no output cap, so the prompt keeps the reply short and OUTPUT_MAX stops the stretch.
// Cache-read USD per million tokens (Anthropic list prices); used only for estimates.
const CACHE_READ_PRICE: Record<string, number> = {
  'claude-fable-5-1': 0.25,
  'claude-opus-5-5': 0.2,
  'claude-sonnet-5-5': 0.1,
  'claude-haiku-5-5': 0.01,
}
const PROMPT =
  'Cache keep-alive ping. This needs no reasoning: do not think, do not use tools. Reply with exactly "." and nothing else.'

type Kind = 'canary' | 'ping'
type Last = { at: number; cached: number; model: string }
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
  note?: string
  updated?: number
}
type Lock = { sid: string; at: number }
type Saved = { isOn: boolean; isVerified: boolean; at: number; base?: number }

type Api = {
  save: () => Promise<void>
  publish: () => Promise<void>
  arm: () => Promise<void>
  list: () => Promise<string>
  cost: (n: number) => Promise<string>
  now: () => Promise<string>
  offOther: (prefix: string) => Promise<string>
  ttlProblem: () => Promise<string | undefined>
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
let isForking = false
let last: Last | undefined
let anchor = 0 // last time the cache was confirmed touched
let refreshedAt = 0 // last successful fork, for the status line's countdown
let pings = 0
let timer: Timer | undefined
let dueAt = 0
let dueKind: Kind | undefined
let note = ''
let showStatus = true // CACHE_KEEPALIVE_UI_STATUS=0 hides the line under the prompt

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
// "claude-opus-5-5[1m]", "claude-opus-5-5-20261001" and "claude-opus-5-5" are one model here.
const sameModel = (a: string, b: string) => {
  const [x, y] = [a, b].map(m => m.toLowerCase().replace(/\[.*?\]/g, ''))
  return x.startsWith(y) || y.startsWith(x)
}

function cancel() {
  timer?.cancel()
  timer = undefined
  dueKind = undefined
}

function reset() {
  cancel()
  last = undefined
  pings = 0
  refreshedAt = 0
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    async function save() {
      const v: Saved = { isOn, isVerified, at: await $.clock.now(), base }
      await $.store.set(`on:${sid}`, v)
    }

    async function publish() {
      if (!home || !sid) return
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
        note,
        updated: await $.clock.now(),
      }
      await $.fs.write(`${statusDir()}/${sid}.json`, JSON.stringify(status))
      if (!showStatus) return
      const isFused = /未命中|出错|熔断|已关闭|被其他窗口/.test(note)
      if (!isOn) return $.ui.status(isFused ? `♻✗ ${note}` : undefined)
      const at = timer ? new Date(dueAt).toTimeString().slice(0, 5) : ''
      const mode = base === MAX_CAP ? '常驻 ' : ''
      const upcoming = timer ? ` · 下次${dueKind === 'canary' ? '验证' : '续命'} ${at}` : ''
      $.ui.status(`♻ ${mode}${pings}/${max}${upcoming}${isFused ? ` · ${note}` : ''}`)
    }

    async function schedule(at: number, kind: Kind) {
      cancel()
      const now = await $.clock.now()
      dueAt = at
      dueKind = kind
      timer = $.clock.after(Math.max(0, at - now), () => {
        void fire(kind).catch(async err => {
          note = `出错停止: ${String(err).slice(0, 80)}`
          cancel()
          await publish()
        })
      })
    }

    // A main turn just ended: a new idle stretch starts from its last request.
    async function arm() {
      cancel()
      pings = 0
      refreshedAt = 0
      if (!(await synced()) || !last) return publish()
      if (last.cached < MIN_PREFIX) {
        note = `上下文 ${kTok(last.cached)} < ${kTok(MIN_PREFIX)}，不续`
        return publish()
      }
      anchor = last.at
      note = ''
      if (!isVerified) await schedule(last.at + CANARY_AFTER, 'canary')
      else if (max > 0) await schedule(anchor + PING_AFTER + Math.random() * JITTER, 'ping')
      else note = '上限为 0，不续'
      return publish()
    }

    // Another window may have switched this session off (`/keepalive off <id>`).
    async function synced() {
      const saved = (await $.store.get(`on:${sid}`)) as Saved | undefined
      if (saved && !saved.isOn && isOn) {
        isOn = false
        cancel()
        note = '已被其他窗口关闭'
      }
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

    async function fire(kind: Kind, isManual = false) {
      if (!isManual) timer = undefined
      const now = await $.clock.now()
      if (!isManual && !(await synced())) return publish()
      if (isBusy || !last) return publish()
      if (!isManual && !isOn) return publish()
      anchor = Math.max(anchor, last.at) // the last real request touched the cache too
      const quota = await quotaFull()
      if (quota) {
        note = `${quota}，本次不续`
        return publish()
      }
      const ttl = await ttlProblem()
      if (ttl) {
        note = ttl
        return publish()
      }
      if (!isManual && now - dueAt > LATE) {
        note = '定时器迟到（可能休眠过），本次不续'
        return publish()
      }
      if (now - anchor > TTL - 3 * MIN) {
        note = '缓存可能已过期，本次不续'
        return publish()
      }
      const model = await $.session.model()
      if (!sameModel(model, last.model)) {
        note = `模型已切换（${last.model} → ${model}），本次不续`
        return publish()
      }

      const lock = (await $.store.get('lock')) as Lock | undefined
      if (lock && lock.sid !== sid && now - lock.at < LOCK_MS) {
        if (isManual) {
          note = '其他会话正在续命，稍后再试'
          return publish()
        }
        // Another session is forking: try once more shortly, if there is still room.
        const retry = now + 20_000 + Math.random() * 30_000
        if (retry - anchor < TTL - 4 * MIN) {
          await schedule(retry, kind)
          return publish()
        }
        note = '其他会话占用，本次不续'
        return publish()
      }
      const mine: Lock = { sid, at: now }
      await $.store.set('lock', mine)

      isForking = true
      let r
      try {
        r = await $.model.fork({ prompt: PROMPT })
      } finally {
        isForking = false
        const held = (await $.store.get('lock')) as Lock | undefined
        if (held && held.sid === sid && held.at === now) await $.store.delete('lock')
      }

      const at = await $.clock.now()
      if (!r.isAnswered && r.reason === 'nothing-to-fork') {
        note = '没有可续的主会话请求'
        return publish()
      }
      const u = 'usage' in r ? r.usage : undefined
      const read = u?.cache_read_input_tokens ?? 0
      const wrote = u?.cache_creation_input_tokens ?? 0
      const reply = r.isAnswered ? r.text.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
      const spent = `读${kTok(read)} 写${kTok(wrote)} 出${u?.output_tokens ?? 0}${r.isAnswered ? ` 回复"${reply}"` : ''}`
      const out = u?.output_tokens ?? 0
      const isHit = r.isAnswered && read >= READ_OK * last.cached && wrote <= WRITE_MAX * last.cached

      if (!isHit) {
        cancel()
        if (kind === 'canary') {
          isOn = false
          isVerified = false
          await save()
          note = `验证未命中（${spent}），已关闭`
        } else {
          note = `续命未命中（${spent}），本次熔断`
        }
        return publish()
      }

      anchor = at
      refreshedAt = at
      if (kind === 'canary') {
        isVerified = true
        await save()
        note = `验证通过（${spent}）`
      } else if (isManual) {
        note = `手动续命（${spent}）`
      } else {
        pings += 1
        note = `第${pings}次续命（${spent}）`
      }
      if (out > OUTPUT_MAX) {
        // The cache was kept, but this ping cost real output: no more this stretch.
        note += `，输出 ${out} token 超过 ${OUTPUT_MAX}，本次熔断`
        cancel()
        return publish()
      }
      if (isBusy || !isOn) return publish()
      if (kind === 'canary' ? max > 0 : pings < max)
        await schedule(anchor + PING_AFTER + Math.random() * JITTER, 'ping')
      else note += '，已达上限'
      return publish()
    }

    // Cache-read price per MTok, for the cost estimate only.
    function readPrice(model: string): number | undefined {
      const key = Object.keys(CACHE_READ_PRICE)
        .filter(k => sameModel(model, k))
        .sort((a, b) => b.length - a.length)[0]
      return key ? CACHE_READ_PRICE[key] : undefined
    }

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
      if (rows.length === 0) return '没有会话开着缓存续命。'
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
      return [`开着缓存续命的会话（${rows.length}）：`, ...lines].join('\n')
    }

    async function cost(n: number): Promise<string> {
      if (!last || n === 0) return ''
      const price = readPrice(last.model)
      if (price === undefined) return ''
      const one = (last.cached * price) / 1e6
      return `，按当前 ${kTok(last.cached)} 上下文每次约 $${one.toFixed(3)}，最多约 $${(one * n).toFixed(2)}`
    }

    // `/keepalive now`: one refresh right away, outside the schedule.
    async function refreshNow(): Promise<string> {
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
      const saved = (await $.store.get(keys[0])) as Saved
      await $.store.set(keys[0], { ...saved, isOn: false, at: await $.clock.now() })
      try {
        const path = `${statusDir()}/${other}.json`
        const row = JSON.parse(await $.fs.read(path)) as Row
        await $.fs.write(path, JSON.stringify({ ...row, enabled: false, next: 0, nextKind: null, note: '已被其他窗口关闭' }))
      } catch {
        // no status file: nothing on screen to correct
      }
      return `已关闭会话 ${other.slice(0, 8)} 的续命；它不会再发出续命请求。`
    }

    api = { save, publish, arm, list, cost, now: refreshNow, offOther, ttlProblem }
    sid = await $.session.id()
    home = (await $.env.get('HOME')) ?? ''
    showStatus = (await $.env.get('CACHE_KEEPALIVE_UI_STATUS')) !== '0'
    cwd = await $.session.cwd()
    const saved = (await $.store.get(`on:${sid}`)) as Saved | undefined
    isOn = saved?.isOn ?? false
    isVerified = saved?.isVerified ?? false
    // A reload starts the module over; the last main request is kept in the store.
    last = ((await $.store.get(`last:${sid}`)) as Last | undefined) ?? last
    base = saved?.base ?? MAX_PINGS
    max = base
    // Forget sessions not seen for three days.
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith('on:') || key === `on:${sid}`) continue
      const v = (await $.store.get(key)) as Saved | undefined
      if (!v || now - v.at > 3 * 24 * 60 * MIN) {
        await $.store.delete(key)
        await $.store.delete(`last:${key.slice(3)}`)
      }
    }
    await $.command.register({
      name: 'keepalive',
      description: 'Prompt-cache keep-alive: on [n|8h], max (always full), now, off [id], status, list',
      argumentHint: 'on [次数|8h] | max | now | off [会话id] | status | list',
    })
    await publish()
    return r
  })

  on('command.run', { command: 'keepalive' }, async ($, e) => {
    let [verb = 'status', param = ''] = e.args.trim().toLowerCase().split(/\s+/)
    // `/keepalive 5` or `/keepalive 8h` means `on` with that cap.
    if (verb && parseCap(verb) !== undefined) [verb, param] = ['on', verb]
    if (verb === 'on' && param === 'max') [verb, param] = ['max', '']
    if (verb === 'max') {
      const ttl = await api?.ttlProblem()
      if (ttl) return { text: `没有开启：${ttl}。` }
      sid = await $.session.id()
      isOn = true
      base = max = MAX_CAP
      capUntil = 0
      await api?.save()
      if (!isBusy) await api?.arm()
      else await api?.publish()
      return {
        text: `常驻续命已开启：每次离开最多续 ${MAX_CAP} 次（缓存约可撑 ${fmtMin(MAX_CAP * PING_AFTER + TTL)}${(await api?.cost(MAX_CAP)) ?? ''}），回来后不重置。在场时不花钱；关窗口、额度到 ${QUOTA_STOP}%、未命中都会停。/keepalive on 回普通模式，/keepalive off 关闭。${isVerified ? '' : '先在下一轮结束约 90 秒后验证一次。'}`,
      }
    }
    if (verb === 'on') {
      const cap = param ? parseCap(param) : MAX_PINGS
      if (cap === undefined) return { text: `看不懂"${param}"：写次数（如 3）或大概多久回来（如 8h、90m、2h30m）。` }
      const ttl = await api?.ttlProblem()
      if (ttl) return { text: `没有开启：${ttl}。` }
      sid = await $.session.id()
      isOn = true
      if (!param) base = MAX_PINGS // plain `on` is the normal mode
      max = cap
      capUntil = param && !/^\d+$/.test(param) ? (await $.clock.now()) + (cap * PING_AFTER + TTL) : 0
      await api?.save()
      if (!isBusy) await api?.arm()
      else await api?.publish()
      const reach = fmtMin(cap * PING_AFTER + TTL)
      const plan = `本次离开最多续 ${cap} 次，缓存约可撑 ${reach}${(await api?.cost(cap)) ?? ''}。你回来后恢复为 ${base === MAX_CAP ? `常驻 ${MAX_CAP}` : `默认 ${MAX_PINGS}`} 次`
      return {
        text: isVerified
          ? `缓存续命已开启：${plan}。`
          : `缓存续命已开启：先在下一轮结束约 ${CANARY_AFTER / 1000} 秒后验证一次；${plan}。`,
      }
    }
    if (verb === 'now') return { text: (await api?.now()) || '没有执行。' }
    if (verb === 'off' && param) {
      const done = await api?.offOther(param)
      if (done) return { text: done }
    }
    if (verb === 'off') {
      isOn = false
      base = max = MAX_PINGS
      await api?.save()
      cancel()
      note = ''
      await api?.publish()
      return { text: '缓存续命已关闭。' }
    }
    if (verb === 'list') return { text: (await api?.list()) ?? '' }
    const next = timer
      ? `，下次${dueKind === 'canary' ? '验证' : '续命'}在 ${fmtMin(dueAt - (await $.clock.now()))} 后`
      : ''
    return {
      text: `缓存续命：${isOn ? (base === MAX_CAP ? '常驻' : '开') : '关'}，${isVerified ? '已验证' : '未验证'}，本次已续 ${pings}/${max}${next}${note ? `；${note}` : ''}。`,
    }
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    cancel()
    // Back after pings, or past the time given: the cap was for that absence.
    if (pings > 0 || (capUntil && (await $.clock.now()) > capUntil)) {
      max = base
      capUntil = 0
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const start = await $.clock.now()
    const r = yield* next(e)
    // Our own fork runs while no turn does; a real turn's steps always count.
    if (e.agentId === undefined && !(isForking && !isBusy) && r && r.usage) {
      const u = r.usage
      last = { at: start, cached: u.cache_read_input_tokens + u.cache_creation_input_tokens, model: e.model }
      await $.store.set(`last:${sid}`, last)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      isBusy = false
      if (e.reason === 'answer') await api?.arm()
      else {
        cancel()
        note = '上一轮未正常结束，不续'
        await api?.publish()
      }
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      reset()
      await $.store.delete(`last:${sid}`)
      note = '已压缩，等下一轮请求后再续'
      await api?.publish()
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    reset()
    if (e.reason === 'clear' && sid) await $.store.delete(`last:${sid}`)
    if (e.reason === 'clear') {
      isOn = false
      note = ''
    }
    if (home && sid) await $.fs.write(`${statusDir()}/${sid}.json`, '{}')
    return next(e)
  })
}
