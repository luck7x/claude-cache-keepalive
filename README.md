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
- 插件不读取你的凭证，也不连接任何第三方。续命是一次真实的模型请求，走的是你当前 Claude Code 配置的服务商（如果你配置了网关或 Bedrock / Vertex，就经过它们）。

实测（Opus 5.5，约 300k 上下文）：读缓存 319k、写 0、输出 3 token，回复 `"."`。

### 要求

- Claude Code **2.1.287 或更高**（需要 mod 接口和 `$.model.fork`）。
- 续命请求使用"子代理/辅助请求"的缓存档位，**必须是 1 小时**。在 `~/.claude/settings.json` 中加入：

  ```json
  { "subagentPromptCacheTtl": "1h" }
  ```

  不是 1h 时，插件会拒绝开启并说明原因。
- 由组织统一管理的 Claude Code 中，个人安装的插件收不到压缩（compact）事件：插件拦不下空闲压缩，但仍会在下一轮请求后重新计时。

### 安装

在 Claude Code 里执行：

```
/plugin install cache-keepalive --marketplace luck7x/claude-cache-keepalive
```

按提示输入 `y` 添加插件市场，选择安装范围（建议 user）。装完立即生效。

### 用法

默认**关闭**，按会话开启，每个窗口各自独立。

想让新会话自动开启（普通模式，每次离开最多续 2 次），在 `~/.claude/settings.json` 的 `env` 里加 `"CACHE_KEEPALIVE_DEFAULT": "on"`。会话在**第一轮对话结束后**才开启，只打开没说话的窗口不会开启、也不留记录。只对交互式窗口生效（`claude -p` 和 SDK 不会自动开启）；你对某个会话执行过 `/keepalive off`（包括从别的窗口关闭）后，它一直保持关闭，直到你再 `/keepalive on`。

| 命令 | 作用 |
|---|---|
| `/keepalive on` | 普通模式：每次离开最多续 2 次（约撑 2 小时 42 分）；会话第一次开启时另有 1 次验证 |
| `/keepalive 5`、`/keepalive 8h`、`/keepalive 2h30m` | 只对这一次离开加长；写时长会按"大概多久回来"自动算次数 |
| `/keepalive max` | 常驻模式：每次离开都最多续 24 次（约 21 小时），回来后不重置 |
| `/keepalive now` | 立刻续一次（不计入次数） |
| `/keepalive off` | 关闭本会话 |
| `/keepalive off <会话id前几位>` | 从任一窗口关闭别的会话 |
| `/keepalive status` | 本会话状态；本次离开期间最近一次续命读/写/输出了多少 |
| `/keepalive list` | 本机开着续命的窗口；正常关闭的窗口不在其中，异常退出的会显示为"已失联" |

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

续命最大的风险是"以为在续，其实在整段重写"。下面这些检查都会在发出请求前再确认一遍，但它们是尽力而为，不是绝对保证：

- **首次验证**：读到的缓存必须 ≥ 预期前缀的 90%、写入 ≤ 10%，否则自动关闭。
- **任何一次没命中**：本次离开不再续。
- **定时器迟到 2 分钟以上**（机器睡眠过）：跳过，不补发。
- **距上次触碰缓存超过 57 分钟**：跳过。
- **上下文 < 50k**：不续（重建本来就便宜）。
- **正在对话、刚压缩、换了模型、上一轮被中断**：不续，等下一轮正常结束再计时。
- **改了思考等级（effort）**：在 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 上（API key 或订阅直连），改 effort **不会**让缓存失效（[官方说明](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)），续命照常。其他模型改 effort 会让缓存失效；用了 Bedrock / Vertex / Foundry、设置了 `ANTHROPIC_BASE_URL` 或 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 时可能失效，插件稳妥起见同样处理。这些情况下：**续命暂停**并弹出提示，状态行的 ♻ 消失；**改回原来的 effort 会自动恢复**；按新 effort 发一条消息，则重写一次缓存后按新 effort 续命。空闲时每 2 秒检查一次，`/effort`、`/model` 之后立即检查，续命前也会再查。插件按 Claude Code 的优先级（`CLAUDE_CODE_EFFORT_LEVEL` → `modelSettings.<模型>.effortLevel` → `effortLevel`）取值。只在当前会话生效、没写进设置或环境变量的改动检测不到；HIPAA 组织等插件检测不到的情况，可能多花一次没命中的续命，随后自动停止。
- **与空闲压缩互斥**：Claude Code 2.1.299 起会在你离开约 54 分钟、缓存过期前自动压缩较长的对话（空闲压缩）。它看不到续命请求，压缩后续命就白做了。所以**开着续命的会话里，插件会拦下空闲压缩**，`/keepalive status` 会显示"已拦下空闲压缩"；关掉续命后恢复。手动 `/compact` 和上下文满了的自动压缩不受影响。想让所有会话都不做空闲压缩，可以在 `~/.claude/settings.json` 里加 `"idleCompaction": false`。
- **5 小时或 7 天额度 ≥ 95%**：跳过。
- **单次输出 > 100 token**：本次离开不再续（`$.model.fork` 不支持设置 max_tokens，只能事后熔断）。
- **多窗口**：用共享锁尽量让同一时间只有一个会话在续，其他错开 20–50 秒、只重试一次。存储不支持原子操作，极少数情况下两个会话可能同时发出；两次都是各自本来就要续的，不会多花钱。
- **`/clear`、`/resume` 切换会话**：新会话不继承旧会话的开关和验证状态；`/clear` 会清掉旧会话的记录。
- **重启 Claude Code 或 /resume 之后**：必须先在这个会话里发一条消息才能续命。续命请求复用的是 Claude Code 内存里"本进程最近一次主请求"，它不写盘，新进程或刚切换的会话里还没有；在这之前状态行不显示 ♻，`/keepalive list` 也不列出它（`/keepalive status` 会说明在等第一条消息），不发请求、不花钱。
- **上限为 0**（如 `/keepalive 1h`）：不验证也不续。临时上限（数字或时长）都会在它能撑到的时间过后自动失效，热重载也会保留它。
- **Claude Code 热重载插件**：如果当时正在对话，等这一轮结束才重新计时；不在对话中则接着之前的计划续。
- 关掉窗口，定时器随进程结束。

### 本地保存了什么

- 插件存储（Claude Code 管理）：每个开过续命的会话一条开关记录，以及它最近一次请求的时间、上下文大小和模型名；3 天没出现的会话会被清理。手动关闭过的会话另有一条只含时间的"已关闭"记录，不会被清理，`/clear` 时删除。
- 状态文件 `~/.cache/claude-cache-keepalive/<session_id>.json`：会话 id、项目目录、模型名、token 数、续命进度。不保存对话内容，也不保存续命回复的原文，只记录回复是不是预期的 "."。

### 状态显示

插件会在输入框下方显示一行，例如 `♻ 常驻 1/24 · 下次续命 15:42`；`♻✗` 表示未命中已停止。
设置环境变量 `CACHE_KEEPALIVE_UI_STATUS=0` 可以隐藏这一行。

想接进自己的状态栏脚本，可以读取 `~/.cache/claude-cache-keepalive/<session_id>.json`：

```json
{
  "sid": "…", "cwd": "/path", "model": "claude-opus-5-5", "cached": 319000,
  "enabled": true, "verified": true, "pings": 1, "max": 24,
  "next": 1791990000000, "nextKind": "ping",
  "refreshedAt": 1791986940000, "paused": false, "note": "第1次续命（读319k 写0k 出3 回复\".\"）",
  "updated": 1791986940000
}
```

`refreshedAt`（毫秒）是最近一次成功续命的时间；缓存剩余时间 ≈ `refreshedAt + 60 分钟 − 现在`。`paused` 为 true 表示因 effort 改动暂停（此时 `enabled` 仍为 true），显示 ♻ 的条件应写成 `enabled && !paused`。

### 中途改模型或思考等级

缓存按模型分开存，换模型后整个缓存作废；改 effort 会让对话历史部分的缓存作废（Claude Code 目前把 effort 作为请求顶层参数发送，没有使用 API 里"按消息改 effort、不破坏缓存"的 beta）。所以改完后的下一句话一定会重写一次缓存，与是否续命无关。建议在新任务开始、上下文还小时改，或者改完立刻接着聊；不要改完就离开。只改设置、不发消息，服务器上的缓存不受影响。插件检测到设置或环境变量里的改动后会暂停续命并提示（♻ 消失），改回原值自动恢复；纯会话级的改动它看不到，这种情况请手动 `/keepalive off`。

### 什么时候不该用

续命只保住"你离开那一刻"的那份缓存。回来后如果开新会话、执行 `/clear`、或回退到很早的消息，之前的续命就白花了。过夜或隔几天的长期项目，更省钱的做法是让 Claude 把进度写进 `CLAUDE.md` / `PROGRESS.md`，下次开新会话读一下即可。

### 已知限制

- mod 接口是 Claude Code 的早期功能，后续版本可能变化。插件出错时会停止本次续命；但它只能尽量避免多余请求，不能绝对保证。
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
- The plugin never reads your credentials and contacts no third party. Each refresh is a real model request through whatever provider Claude Code is configured with (your gateway, Bedrock or Vertex if you use one).

Measured on Opus 5.5 with ~300k context: 319k read from cache, 0 written, 3 output tokens, reply `"."`.

### Requirements

- Claude Code **2.1.287+** (mod API with `$.model.fork`).
- Forks use the auxiliary/subagent cache tier, which **must be 1 hour**. Add to `~/.claude/settings.json`:

  ```json
  { "subagentPromptCacheTtl": "1h" }
  ```

  The plugin refuses to turn on otherwise and says why.
- Where an organization manages Claude Code, plugins a person installs do not receive the compaction event: idle compaction cannot be held back, though the plugin still re-arms after the next request.

### Install

In Claude Code:

```
/plugin install cache-keepalive --marketplace luck7x/claude-cache-keepalive
```

Answer `y` to add the marketplace, pick a scope (user is recommended). It is active right away.

### Usage

Off by default; enabled per session, each window on its own.

To have new sessions start on (normal mode, up to 2 refreshes per absence), add `"CACHE_KEEPALIVE_DEFAULT": "on"` to the `env` block of `~/.claude/settings.json`. A session turns on **after its first turn**; a window opened and never used is not turned on and leaves no record. Interactive windows only (`claude -p` and the SDK never start on); a session you turned off with `/keepalive off` (also from another window) stays off until `/keepalive on`.

| Command | Effect |
|---|---|
| `/keepalive on` | Normal mode: up to 2 refreshes per absence (~2h42m); plus one canary the first time in a session |
| `/keepalive 5`, `/keepalive 8h`, `/keepalive 2h30m` | Longer cap for this absence only; a duration is turned into the refreshes needed |
| `/keepalive max` | Always-on mode: up to 24 refreshes (~21h) every absence, kept after you return |
| `/keepalive now` | Refresh once right now (not counted) |
| `/keepalive off` | Turn off for this session |
| `/keepalive off <id prefix>` | Turn off another session from any window |
| `/keepalive status` | This session, with the read/write/output of the latest refresh in the current absence |
| `/keepalive list` | Windows on this machine with keep-alive on; windows closed normally are not listed, ones that crashed show as lost |

How long the cache lasts = refreshes × 51 min + 60 min. Each refresh adds 0–60 s of jitter.

### Safety: when in doubt, don't send

These checks are re-run right before a request goes out; they are best effort, not hard guarantees.


- **Canary** on first enable: it must read ≥ 90% of the expected prefix and write ≤ 10%, or the plugin turns itself off.
- **Any miss** stops refreshing for the rest of that absence.
- **Timer late by > 2 min** (the machine slept): skipped, never caught up.
- **> 57 min since the cache was last touched**: skipped.
- **Context < 50k tokens**: not refreshed (rebuilding is cheap).
- **Turn in progress, just compacted, model changed, last turn interrupted**: not refreshed until the next normal turn.
- **Effort changed**: on Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 (API key or subscription, direct), changing effort **keeps** the cache ([docs](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)) and keep-alive carries on. On other models it invalidates the cache; with Bedrock / Vertex / Foundry, `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set it may, and the plugin plays safe the same way. In those cases: **keep-alive pauses** with a notice and the ♻ disappears; **setting effort back resumes it**; sending a message at the new effort rewrites the cache once and keep-alive carries on at that effort. Checked every 2 seconds while idle, right after `/effort` and `/model`, and again before a refresh, using Claude Code's order (`CLAUDE_CODE_EFFORT_LEVEL` → `modelSettings.<model>.effortLevel` → `effortLevel`). A change made for the session only is not seen; where the plugin cannot tell (a HIPAA organization, say), one refresh may miss and be paid for before keep-alive stops.
- **Exclusive with idle compaction**: from Claude Code 2.1.299, a long conversation is compacted about 54 minutes into an absence, before its cache lapses (idle compaction). It does not see keep-alive's refreshes, so compacting throws them away. **In a session with keep-alive on, the plugin holds idle compaction back** (`/keepalive status` says so); turning keep-alive off lets it run again. `/compact` and compaction at a full context are untouched. To stop idle compaction in every session, add `"idleCompaction": false` to `~/.claude/settings.json`.
- **5-hour or 7-day quota ≥ 95%**: skipped.
- **Output > 100 tokens** in one refresh: no more refreshes that absence (`$.model.fork` takes no max_tokens).
- **Several windows**: a shared lock tries to keep one fork at a time; others retry once 20–50 s later. The store has no atomic write, so on rare occasions two sessions may send at once; each was due anyway, so it costs nothing extra.
- **`/clear`, `/resume`**: a new conversation inherits neither the switch nor the canary of the old one; `/clear` deletes the old one's records.
- **After restarting Claude Code or a /resume**: send one message in that session before anything can be refreshed. A refresh replays Claude Code's in-memory copy of this process's last main request, which is never written to disk, so a new process or a just-switched session has none yet; until then the status line shows no ♻ and `/keepalive list` leaves it out (`/keepalive status` says it is waiting for a first message); nothing is sent and nothing is spent.
- **Cap 0** (e.g. `/keepalive 1h`): no canary, no refresh. A one-off cap (count or time) lapses when the cache it buys would, and survives a reload of the mod.
- **A reload of the mod**: mid-turn, it waits for the turn to end; otherwise it carries on with the schedule.
- Closing the window ends its timers.

### What is kept locally

- The plugin store (managed by Claude Code): per session with keep-alive on, its switch and its last request's time, context size and model; sessions not seen for 3 days are removed. A session you turned off also keeps a time-only "off" mark that is never cleaned up; `/clear` deletes it.
- Status files `~/.cache/claude-cache-keepalive/<session_id>.json`: session id, project directory, model, token counts, progress. No conversation content and no reply text, only whether the reply was the expected ".".

### Status

A line under the prompt such as `♻ 常驻 1/24 · 下次续命 15:42`; `♻✗` means a miss stopped it. Set `CACHE_KEEPALIVE_UI_STATUS=0` to hide it.

For your own status line script, read `~/.cache/claude-cache-keepalive/<session_id>.json` (format above). `refreshedAt` (ms) is the last successful refresh; cache time left ≈ `refreshedAt + 60 min − now`. `paused` is true while an effort change holds keep-alive (`enabled` stays true), so show the ♻ on `enabled && !paused`.

### Switching model or effort mid-session

Caches are per model, so a model switch drops the whole cache; an effort change drops the conversation's part of it (Claude Code currently sends effort as a top-level request parameter, not through the API's per-message effort beta that keeps the cache). The next message after such a change rewrites the cache whether or not keep-alive is on. Change them early in a task, or keep chatting right after; don't change and walk away. Changing a setting without sending anything leaves the cache on the server untouched. The plugin pauses keep-alive with a notice once it sees the change in settings or the environment (the ♻ disappears) and resumes when the value is set back; a session-only change is invisible to it, so run `/keepalive off` yourself in that case.

### When not to use it

It only keeps the cache of the moment you left. A new session, `/clear`, or rewinding far back wastes the refreshes. For overnight or multi-day breaks, write progress into `CLAUDE.md` / `PROGRESS.md` and start a fresh session instead.

### Limitations

- The mod API is an early Claude Code feature and may change. On errors the plugin stops refreshing for that absence; it avoids extra requests as best it can but cannot guarantee it.
- The output length of a refresh cannot be hard-capped (see above).
- On a subscription nothing is billed per request, but refreshes count toward the 5-hour / 7-day limits.

## License

Apache-2.0
