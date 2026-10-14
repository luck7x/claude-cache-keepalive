# claude-cache-keepalive

[中文](#中文) · [English](#english)

A Claude Code mod that keeps the main conversation's prompt cache warm while you are away, so coming back does not re-write the whole context at cache-write price.

---

## 中文

### 它解决什么问题

Claude Code 每次请求都会把整段上下文（工具、系统提示、全部历史）发给模型，靠 Prompt 缓存避免重复计费。以 Opus 5.5 为例：

| 处理方式 | 每百万 token | 300k 上下文一次 |
|---|---|---|
| 读缓存 | $0.20 | $0.06 |
| 写缓存（1 小时档） | $8.00 | $2.40 |

缓存 60 分钟没人用就会过期。你离开超过 1 小时，回来发的第一句话就要把整段上下文按写入价重算一遍。每读一次缓存，它的寿命会重新从 60 分钟算起；所以只要在过期前用**同一份前缀**读一次，就能用约 1/40 的价格保住它。

### 它怎么做

- 使用 Claude Code 官方 mod 接口 `$.model.fork`：由 Claude Code **自己**发出请求，复用主会话最后一次请求的模型、系统提示、工具和消息，末尾追加一句"只回复一个点"。
- 这次请求**不写进对话记录**，不能调用工具，不在新内容上打缓存标记。
- 不碰你的凭证，不经过任何代理或网关。

实测（Opus 5.5，约 300k 上下文）：读缓存 319k、写 0、输出 3 token，回复 `"."`。

### 要求

- Claude Code **2.1.287 或更高**（需要 mod 接口和 `$.model.fork`）。
- 续命请求使用"子代理/辅助请求"的缓存档位，**必须是 1 小时**。在 `~/.claude/settings.json` 中加入：

  ```json
  { "subagentPromptCacheTtl": "1h" }
  ```

  不是 1h 时，插件会拒绝开启并说明原因。
- 由组织统一管理的 Claude Code 中，个人安装的插件收不到压缩（compact）事件；插件仍会在下一轮请求后重新计时，但请知悉。

### 安装

在 Claude Code 里执行：

```
/plugin install cache-keepalive --marketplace luck7x/claude-cache-keepalive
```

按提示输入 `y` 添加插件市场，选择安装范围（建议 user）。装完立即生效。

### 用法

默认**关闭**，按会话开启，每个窗口各自独立。

| 命令 | 作用 |
|---|---|
| `/keepalive on` | 普通模式：每次离开最多续 2 次（约撑 2 小时 42 分） |
| `/keepalive 5`、`/keepalive 8h`、`/keepalive 2h30m` | 只对这一次离开加长；写时长会按"大概多久回来"自动算次数 |
| `/keepalive max` | 常驻模式：每次离开都最多续 24 次（约 21 小时），回来后不重置 |
| `/keepalive now` | 立刻续一次（不计入次数） |
| `/keepalive off` | 关闭本会话 |
| `/keepalive off <会话id前几位>` | 从任一窗口关闭别的会话 |
| `/keepalive status` | 本会话状态，含上一次续命读/写/输出了多少 |
| `/keepalive list` | 本机所有开着续命的会话 |

### 时间线

```
0 分        最后一次请求
1.5 分      首次验证（每个会话第一次开启时）
51 分       续命 1
102 分      续命 2
162 分      缓存过期（默认上限 2 次时）
```

能撑多久 = 续命次数 × 51 分钟 + 60 分钟。每次续命另加 0–60 秒随机错开。

### 安全设计：一有疑问就不发

续命最大的风险是"以为在续，其实在整段重写"。所以：

- **首次验证**：读到的缓存必须 ≥ 预期前缀的 90%、写入 ≤ 10%，否则自动关闭。
- **任何一次没命中**：本次离开不再续。
- **定时器迟到 2 分钟以上**（机器睡眠过）：跳过，不补发。
- **距上次触碰缓存超过 57 分钟**：跳过。
- **上下文 < 50k**：不续（重建本来就便宜）。
- **正在对话、刚压缩、换了模型、上一轮被中断**：不续，等下一轮正常结束再计时。
- **5 小时或 7 天额度 ≥ 95%**：跳过。
- **单次输出 > 100 token**：本次离开不再续（`$.model.fork` 不支持设置 max_tokens，只能事后熔断）。
- **多窗口**：全局锁，同一时间只有一个会话在续，其他错开 20–50 秒。
- 关掉窗口，定时器随进程结束。

### 状态显示

插件会在输入框下方显示一行，例如 `♻ 常驻 1/24 · 下次续命 15:42`；`♻✗` 表示未命中已停止。
设置环境变量 `CACHE_KEEPALIVE_UI_STATUS=0` 可以隐藏这一行。

想接进自己的状态栏脚本，可以读取 `~/.cache/claude-cache-keepalive/<session_id>.json`：

```json
{
  "sid": "…", "cwd": "/path", "model": "claude-opus-5-5", "cached": 319000,
  "enabled": true, "verified": true, "pings": 1, "max": 24,
  "next": 1791990000000, "nextKind": "ping",
  "refreshedAt": 1791986940000, "note": "第1次续命（读319k 写0k 出3 回复\".\"）",
  "updated": 1791986940000
}
```

`refreshedAt`（毫秒）是最近一次成功续命的时间；缓存剩余时间 ≈ `refreshedAt + 60 分钟 − 现在`。

### 什么时候不该用

续命只保住"你离开那一刻"的那份缓存。回来后如果开新会话、执行 `/clear`、或回退到很早的消息，之前的续命就白花了。过夜或隔几天的长期项目，更省钱的做法是让 Claude 把进度写进 `CLAUDE.md` / `PROGRESS.md`，下次开新会话读一下即可。

### 已知限制

- mod 接口是 Claude Code 的早期功能，后续版本可能变化；插件出错时会停止续命，不会多花钱。
- 无法硬性限制续命请求的输出长度，见上文。
- 订阅账号不直接扣费，但续命同样消耗 5 小时 / 7 天额度。

---

## English

### What it solves

Claude Code resends the whole context (tools, system prompt, full history) on every request and relies on prompt caching to avoid paying for it again. On Opus 5.5:

| | per MTok | 300k context |
|---|---|---|
| Cache read | $0.20 | $0.06 |
| Cache write (1h) | $8.00 | $2.40 |

The cache expires after 60 minutes without use. Each read resets that clock, so one read of the **same prefix** before expiry keeps the cache for about 1/40 of the cost of rebuilding it.

### How it works

- Uses Claude Code's own mod API `$.model.fork`: Claude Code itself sends a request over the main thread's last request (same model, system prompt, tools and messages) with one short prompt appended ("reply with a single dot").
- The fork is **not written to the transcript**, cannot use tools, and puts no cache marker on its own tail.
- It never touches your credentials and goes through no proxy or gateway.

Measured on Opus 5.5 with ~300k context: 319k read from cache, 0 written, 3 output tokens, reply `"."`.

### Requirements

- Claude Code **2.1.287+** (mod API with `$.model.fork`).
- Forks use the auxiliary/subagent cache tier, which **must be 1 hour**. Add to `~/.claude/settings.json`:

  ```json
  { "subagentPromptCacheTtl": "1h" }
  ```

  The plugin refuses to turn on otherwise and says why.
- Where an organization manages Claude Code, plugins a person installs do not receive the compaction event; the plugin still re-arms after the next request.

### Install

In Claude Code:

```
/plugin install cache-keepalive --marketplace luck7x/claude-cache-keepalive
```

Answer `y` to add the marketplace, pick a scope (user is recommended). It is active right away.

### Usage

Off by default; enabled per session, each window on its own.

| Command | Effect |
|---|---|
| `/keepalive on` | Normal mode: up to 2 refreshes per absence (~2h42m) |
| `/keepalive 5`, `/keepalive 8h`, `/keepalive 2h30m` | Longer cap for this absence only; a duration is turned into the refreshes needed |
| `/keepalive max` | Always-on mode: up to 24 refreshes (~21h) every absence, kept after you return |
| `/keepalive now` | Refresh once right now (not counted) |
| `/keepalive off` | Turn off for this session |
| `/keepalive off <id prefix>` | Turn off another session from any window |
| `/keepalive status` | This session, including the last refresh's read/write/output |
| `/keepalive list` | All sessions on this machine with keep-alive on |

How long the cache lasts = refreshes × 51 min + 60 min. Each refresh adds 0–60 s of jitter.

### Safety: when in doubt, don't send

- **Canary** on first enable: it must read ≥ 90% of the expected prefix and write ≤ 10%, or the plugin turns itself off.
- **Any miss** stops refreshing for the rest of that absence.
- **Timer late by > 2 min** (the machine slept): skipped, never caught up.
- **> 57 min since the cache was last touched**: skipped.
- **Context < 50k tokens**: not refreshed (rebuilding is cheap).
- **Turn in progress, just compacted, model changed, last turn interrupted**: not refreshed until the next normal turn.
- **5-hour or 7-day quota ≥ 95%**: skipped.
- **Output > 100 tokens** in one refresh: no more refreshes that absence (`$.model.fork` takes no max_tokens).
- **Several windows**: a shared lock lets one fork run at a time; others retry 20–50 s later.
- Closing the window ends its timers.

### Status

A line under the prompt such as `♻ 常驻 1/24 · 下次续命 15:42`; `♻✗` means a miss stopped it. Set `CACHE_KEEPALIVE_UI_STATUS=0` to hide it.

For your own status line script, read `~/.cache/claude-cache-keepalive/<session_id>.json` (format above). `refreshedAt` (ms) is the last successful refresh; cache time left ≈ `refreshedAt + 60 min − now`.

### When not to use it

It only keeps the cache of the moment you left. A new session, `/clear`, or rewinding far back wastes the refreshes. For overnight or multi-day breaks, write progress into `CLAUDE.md` / `PROGRESS.md` and start a fresh session instead.

### Limitations

- The mod API is an early Claude Code feature and may change; on errors the plugin stops refreshing rather than spending more.
- The output length of a refresh cannot be hard-capped (see above).
- On a subscription nothing is billed per request, but refreshes count toward the 5-hour / 7-day limits.

## License

Apache-2.0
