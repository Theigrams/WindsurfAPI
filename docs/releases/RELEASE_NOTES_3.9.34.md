# v3.9.34

四条外部 PR 进 master：Connect 连续同 role 纯文本不再打成 run≥3 的 `invalid_argument`；
Responses 工具输出里的图能进 `#10 images`；Docker nginx 不再用默认 1m 挡多模态；
本机导入认 Devin 桌面目录。另：`swe-2` 进 Connect 目录，`gpt-5.6` Devin Local 显式 opt-in。
无 API 破坏。ACU `^22` 仍默认关。`FREE_TIER_SELECTOR` 仍是 `swe-1-6-slow`。

---

## 用户可感知

### 连续同 role 纯文本在进 Connect wire 前合并（#270）

客户端把一个回合按 part 拆存时，历史里会出现连续同 role 的纯文本。原样编码后 wire 上连续同源
ChatMessage，**run 长度 ≥ 3** 时上游 `invalid_argument`（"an internal error occurred"）。
本版只合并 user/assistant 的纯文本；带 `tool_calls` / `tool_call_id` / reasoning / 图片的条目不合并；
生成新对象、不改调用方数组。四条 wire 断言钉住 source 序列。
`DEVIN_CONNECT_COLLAPSE_SYSTEM=1` 时 system 仍占相邻位，不会把夹心 system 挤出注入槽。

并行 tool_calls 的交错仍是 #261：那一层把 N 个 call 拆成交替单调用。两层不抢。

### Responses 工具输出里的图走 Connect `#10`；nginx 不再 1m 挡（#265）

`function_call_output` / `custom_tool_call_output` 的数组 `output` 不再被 `stringifyMaybe` 压成
扁平文本。Connect 路径上 data-URL 图进 `#10 images`（默认 tag **10**）。
Docker 拓扑里 nginx 是唯一前置跳数，默认 `client_max_body_size` **1m**，>1 MB 多模态必然 413。
本版 `32m`、`proxy_read/send_timeout 900s`（必须严格大于应用层 `DEVIN_TIMEOUT_MS` 默认 600s）。
**真上限仍是应用层 `MAX_BODY_SIZE` = 10 MB**；nginx 只负责放到应用门口。Cascade 侧未改。

### 本机导入认 Devin 桌面目录（#264）

桌面端 userData 在 `%APPDATA%\Devin` / `~/Library/Application Support/Devin`。
flavors 补 `'Devin'`。`windsurfAuthStatus` 实测约 160KB，旧 128KB 上限会静默跳过唯一带 token 的行。
上限 128KB → 512KB（DB 级仍 24 MB）。160KB 能导入、512KB+1 仍跳过，有 sqlite 样例。
CLI 路径仍是小写 `devin`，两处不合成一个常量。

### SWE-2 进 Connect 目录；gpt-5.6 Local 显式 opt-in（#266）

`swe-2-medium` / `high` / `max`（credit 6/9/12）进快照。`DEVIN_CONNECT=1` 仍赢过 CLI。
`swe-2` / `swe-2.0` / `swe2` / `swe-2.0-high` 映射到对应 selector，不再 400 或静默降到
`swe-1-6-slow`。`gpt-5.6-luna|sol|terra` 只在 `DEVIN_CLI_ENABLED=1` 时走 Devin Local；
默认不冒充 Desktop、不默认 `DEVIN_PERMISSION_MODE=auto`、账号没记 server 就不声明
`api_server_url`。`devin acp --model` 对这些 key 的真实接受度本机未验证。

---

## 工程

突变规格仍 **49 / 588**。合入后按实测刷基线：`responses.test.js` 四份各 +2；
`credit-cost-top-level` 181→186；`reasoning-continuity` 308→313；
`connect-catalog-hotfix` 40→41。`FREE_TIER` / `FREE_REACHABLE` 未动。

OTA 跟 annotated tag。`docs/releases/RELEASE_NOTES_3.9.33.md` 钉在 v3.9.33 上不改。
