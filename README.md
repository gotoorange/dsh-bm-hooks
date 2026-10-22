# dsh-bm-hooks

[English](README.en.md) | **简体中文**

把 Basic Memory 的生命周期钩子做成 **DeepSeek Harness 原生插件**，外加一个
Settings 面板，用来修改真正属于「用户偏好」的那几项。

它和其他 DSH 插件一样安装、一样加载 —— 不需要 bridge，不需要实验性 mods 包，
不需要任何 hook 配置文件。它直接挂在 harness 自己的扩展点上调用 `bm` CLI，
因此能做到外部命令钩子桥做不到的两件事：

- **能读到活的对话记录**：通过 `session.deriveMessages()`。外部钩子进程拿到的
  `transcript_path` 永远是空的，所以它做不到。
- **在真正的 PreCompact 时刻写检查点**：`compaction/start` 会话事件在摘要开始
  之前追加，此时对话表面还完整。

设计对齐 Basic Memory 自己的 `bm hook` 语义（Claude Code / Codex 那一套）。
生命周期契约相同，区别是实现走 DSH 原生扩展点，而不是外部钩子进程。

---

## 事件映射

| Basic Memory 钩子 | Claude Code / Codex | 本插件 |
|---|---|---|
| `bm hook session-start` | `SessionStart` | `agent/created` 预热 CLI；`agent/pre-step` 以「带来源标注的上下文」投递简报 |
| `bm hook pre-compact` | `PreCompact` | `session/event` → `compaction/start` —— **真正的压缩前检查点** |
| `bm hook flush` | *（从不被调度）* | `agent/disposed`，由 `flushIntervalHours` 节流 |
| `bm hook status` | — | `/bm-status` |
| *（手动检查点）* | — | `/bm-checkpoint` |
| `bm hook stop` | 已废弃的 `Stop` | 不需要；它只为兼容升级前的旧配置而存在 |

为什么 `agent/created` 和 `agent/pre-step` 要拆开：`agent/created` 是唯一在
**首轮之前**执行的位置，而 `agent/pre-step` 是唯一返回值能携带 `messages` 的位置。
所以简报子进程在创建时启动，在第一轮投递，结果按会话缓存 —— 续跑的轮次不会重复执行。

---

## 安装

本插件是标准 **bundle**（`package.json` 声明了 `dsh.bundle.patch`），
所有安装路径都由 DSH 的插件安装器完成，你不需要碰 profile 里的任何文件。

### 方式一：Web 侧边栏「插件」页（推荐）

打开侧边栏的 **插件** 页面，搜索 `dsh-bm-hooks`，点安装。
安装器会自动完成：写入 profile 依赖、选中 bundle、把下面这行插进配置层。

```yaml
- insert:
    - id: bm-hooks
      name: 'dsh-bm-hooks'
```

### 方式二：让 Agent 安装

```
plugin_manager  action: install_bundle   target: dsh-bm-hooks
```

`install_bundle` 和插件页走同一套 `installBundle` 实现，结果一致。
（该工具需要 `danger-full-access`，或对该次调用单独授权。）

### 方式三：命令行

```powershell
dsh plugin add dsh-bm-hooks
```

安装结果看 `dsh plugin list`：`dsh-bm-hooks` 会出现在依赖里，同时出现在
`dsh.profile.bundles` 中。

> 安装器会在 pnpm 成功之后才选中 bundle，失败则回滚 profile 清单与 lockfile。
> 因此**不需要**手工编辑 `package.json` 或 `cordis.patch.yml`。

### 前置条件：`bm` 必须在 PATH 上

```powershell
uv tool install basic-memory
```

不锁版本：本插件跟随最新版，`bm update` / 自动更新保持其最新。
唯一的硬要求是安装的 CLI **包含 `hook` 命令组**，该命令组在 v0.23 引入 ——
PATH 上若是 0.23 之前的旧版 `bm`，无法工作。

`uv tool install` 把 shim 放在 `%USERPROFILE%\.local\bin`，这个目录**默认不在 PATH 上**。
加一次即可：

```powershell
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (($userPath -split ';') -notcontains "$env:USERPROFILE\.local\bin") {
  [Environment]::SetEnvironmentVariable("PATH", "$userPath;$env:USERPROFILE\.local\bin", "User")
}
```

**改完 PATH 必须重启 DSH** —— 运行中的进程保留的是启动时的环境，
新加的目录对它不可见。

---

## 配置

整份配置都是可选的。插件不携带任何路径、版本号、项目名或工作区路径：

```yaml
- id: bm-hooks
  name: "dsh-bm-hooks"
  config:
    harness: codex
    project: project-memory
    recallTimeframe: 7d
    briefLimit: 5
    injectBrief: true
    checkpointOnCompact: true
    autoDetectProject: false
```

| 键 | 默认值 | 可在线修改 | 含义 |
|---|---|---|---|
| `enabled` | `true` | | `false` 时卸载全部监听器与命令。 |
| `bmArgv` | `['bm']` | | 调用 CLI 的 argv 前缀。裸名字，按 PATH 解析。 |
| `harness` | `codex` | | `--harness` 取值；`codex` 对应 DSH 输出的 snake_case 载荷形状。 |
| `project` | `''` | ✅ | 简报与检查点使用的 Basic Memory 项目。属于用户偏好：在 Settings 或 `/bm-project` 里改。 |
| `recallTimeframe` | `7d` | ✅ | 简报的召回窗口。 |
| `briefLimit` | `5` | ✅ | 简报每节显示的条目数。 |
| `autoDetectProject` | `false` | ✅ | 按会话工作目录匹配项目。见下文。 |
| `captureFolder` | `codex` | | 项目内的文件夹。bm 的 `--folder` 是必填参数；这里是相对名称，不是路径。 |
| `noteType` | `session` | | frontmatter 里的 `type`。 |
| `titlePrefix` | `DSH session` | | 标题前缀；bm 自己的取值是 `Session` / `Codex session`。 |
| `projectDir` | `''` | | bm 查找 settings 用的 `--project-dir`；留空则用会话 cwd。 |
| `injectBrief` | `true` | | 是否投递会话简报。 |
| `briefWaitMs` | `8000` | | 一步最多等简报多久；超时则不带上下文继续。`0` 表示从不等待。 |
| `checkpointOnCompact` | `true` | | 是否在 `compaction/start` 写检查点。 |
| `flushIntervalHours` | `24` | | 两次收件箱清扫之间的最小间隔。`0` 关闭。 |
| `flushRetentionDays` | `30` | | 清扫时的 `--older-than-days`。 |
| `timeoutMs` | `120000` | | 单次 CLI 调用上限，通过中止受管进程组强制执行。 |

标 ✅ 的字段声明为 `.volatile()`，是活引用：插件每次使用时通过 `.get()` 读取，
Settings 里的写入无需重启即可生效。

### 一个会话用哪个项目

解析优先级，从最具体到最宽泛：

1. 会话级显式切换 —— `/bm-project <name>` 或 `bm_set_project` 工具；
2. 工作目录落在某个项目根目录内（`autoDetectProject`）；
3. 配置里的 `project`；
4. Basic Memory 自己的 `default_project`。

`autoDetectProject` **默认关闭**：它会给每个会话增加一次
`bm project list --json` 调用（有缓存），并且允许 cwd 匹配压过配置值。
只有当一份 profile 服务多个仓库时才建议打开。

匹配按**最长前缀**、并区分分隔符：`D:/work/deep` 优先于 `D:/work`，
而 `/work/ab` 不会被当成 `/work/a` 的子目录。`~` 与符号链接写法在比较前会做规范化。
实测（真实两项目环境）：

```
D:/project-memory              => project-memory
D:/project-memory/notes/deep   => project-memory     ← 子目录继承
~\\basic-memory                => main
C:/Windows                     => (无匹配)           → 回退
some/workspace/dir             => (无匹配)           → 回退到 default_project
```

第 4 步这个回退，是为了一般的 workspace 目录不至于把简报整个丢掉。

---

## Settings 面板

client 半身为 Settings 增加一个 **Basic Memory** 分页，三个控件加一个开关：

| 控件 | 绑定 | 行为 |
|---|---|---|
| 项目 | `project` | 下拉框，数据来自 `bm project list --json`，带刷新按钮 |
| 召回窗口 | `recallTimeframe` | `1d` / `7d` / `30d` |
| 每节条数 | `briefLimit` | 数字，1–20 |
| 按工作目录匹配项目 | `autoDetectProject` | 开关 |

写入走 `ctx.configForms`，即 Host 的 settings 传输层，用读到的 revision 做一次
原子提交 —— 和其他设置页走同一条路径。面板**不会**自己去改 `cordis.patch.yml`，
那样会绕过 Loader 校验和并发写的版本检查。

项目**列表**不属于 settings 文档，所以 Host 半身在
`GET /bm-hooks/api/projects` 提供它（仅回环地址、`no-store`）。
该路由只在组合了 `webServer` 时注册；无头部署下插件照常工作，只是面板没有列表可显示。

`lib/client.js` 是**构建产物**而非普通 ESM：它把懒加载工厂注册到
`window.__ModuleLoader__`，React 从平台模块表取用。没有构建步骤 ——
包里的这个文件就是浏览器执行的那份。就地修改它是受支持的做法。

---

## 命令

```
/bm-project              # 列出 Basic Memory 项目并显示当前值
/bm-project <name>       # 切换到另一个项目（持久化到 profile）
/bm-status               # bm hook status：收件箱深度、上次清扫、设置、版本
/bm-checkpoint           # 立即为本会话写一个检查点
/bm-flush                # 立即清扫收件箱，不必等间隔
```

`/bm-project <name>` 会先用 `bm project list --json` 校验项目名，
所以打错字不会让简报和检查点指向一个不存在的项目。
它通过 `configEditor.edit()` 写入 —— 与 Settings 写入同一个服务 ——
因此改动会持久化到 profile patch，并由 Loader 在线生效。
没有组合 config editor 时，它会如实说明并指向 `cordis.patch.yml`，而不会假装保存成功。

### `bm_set_project`（供模型调用）

插件**从不**解析对话文本去猜项目 —— 那既脆弱又不可预测。
它改为提供一个确定性的切换原语：

```
bm_set_project({ project?: string })
```

工具描述会让模型在用户点名某个项目、仓库或工作区时调用它。
不带参数则列出可用项目。该绑定是**会话级**的，不写任何配置，
所以模型侧切换不会影响其他会话的行为。

---

## `bm hook flush` 没有任何东西调度它

在已安装的整个 Basic Memory 包里检索：`basic_memory.hooks.archive`
**只在一处**被 import —— `cli/commands/hook.py`，也就是 `bm hook flush` 命令自己。
没有守护进程、没有启动钩子、没有 MCP 侧清扫、没有 cron。
所以在 Claude Code 和 Codex 上，收件箱只会不断增长，`processed/` 永不清理。

本插件因此在 `agent/disposed` 时清扫，由 `flushIntervalHours` 节流。

把这个动作自动化是安全的，两个性质都来自 bm 自己的实现：

- **它从不写图谱**：`archive.flush` 只把合法信封移进 `processed/`、
  按 `idempotency_key` 去重、按保留期清理。
- **遇到脏数据会安全失败**：非法或 `envelope_version` 超前的文件保持待处理状态，
  留待人工查看，而不是被删除。

如果你更喜欢外部调度 `bm hook flush`，把 `flushIntervalHours` 设为 `0` 即可，结果完全一样。

---

## 失败行为

每一次 CLI 调用都被兜住：

| 失败情形 | 行为 |
|---|---|
| `bm` 无法解析 | 记 `warn`；这一步仍然进入，只是没有上下文 |
| CLI 非零退出 | 记 `warn` 并带上 stderr 尾部；会话继续 |
| spawn 抛异常 | 作为失败结果返回；记录日志，绝不抛进主循环 |
| 简报不可用 | 不追加上下文消息；这一轮照常进行 |
| 没有用户回合可做检查点 | `/bm-checkpoint` 如实报告；不写任何东西 |
| 项目列表读不到 | 简报回退到配置里的项目 |

这与 bm 自己的钩子契约一致：活跃的生命周期动词都是 fail-open 的，
捕获或召回出错绝不能打断 Agent 会话。

---

## 实现说明

- **简报不绑定在第 1 步。** `bm` 是 Python 进程：本机实测热启动约 3.5 秒、
  冷启动约 12.5 秒。把首步阻塞在这上面是错的，所以 `agent/pre-step` 让简报
  与 `briefWaitMs` 赛跑，在**第一个发现它已就绪**的步骤投递。子进程在
  `agent/created` 时只启动一次并缓存，慢的首步不会起第二个。
- **定时器都 `unref()` 过。** `timeoutMs` 的截止时间会中止受管进程组，
  但定时器绝不能成为宿主进程不退出的原因。
- **来源标注是承重的。** 每条注入消息都带
  `source: { kind: 'bm-hooks', form: 'snapshot', sections: [...] }`。
  没有来源标注的上下文消息，在派生历史里会被渲染成用户提问。
- **`session/event` 是只观察的。** 发射方不 await 监听器，所以检查点的工作
  必须在处理器内部启动并自我兜底。
- **子代理会话被跳过。** `session.header.origin === 'subagent'` 表示这是子会话，
  给它做简报或检查点会重复父会话的工作。
- **`bm tool write-note` 没有 `--metadata` 参数**，但笔记内容自身 frontmatter
  的优先级高于 `--type`，所以 frontmatter 随内容一起写入，元数据一个都不丢。
- **所有外部调用都是命令，不是 MCP 调用。** 插件通过 `ctx.subprocess` 调 `bm`。
  它从不走 `mcp__basic-memory__*` 工具：生命周期钩子是命令边界，
  这样只有一条执行路径、一种失败模式，不依赖 MCP 连接器是否恰好连着，
  也不会产生同一个数据库的第二个客户端。
- **绝不写 settings 文件。** 配置只存在于 DSH 一侧。简报通过显式 `--project`
  查询构建，因此 `~/.codex/basic-memory.json` 和 `~/.claude/settings.json`
  都不会被创建、读取或修改。
- **只 import `@deepseek-ai/schemastery`。** profile 插件从 profile 自己的
  `node_modules` 解析 peer；`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`
  这类包只存在于 app 归档里，在那里解析不到。import 它们会让插件以
  `Cannot find package` 加载失败。所以工具定义和上下文消息都按 harness
  的公开形状自建，而不是 import 它的构造函数。

---

## 测试

```powershell
node test/native.mjs      # 36 项离线检查：插件形状、配置、生命周期、命令、工具
node test/client.mjs      # 3 项：client bundle 注册与写入路径
node test/projects.mjs    # 4 项：对着真实 bm CLI 验证归一化与匹配
```

`native.mjs` 加载真实的 `lib/index.js`，只 stub `@deepseek-ai/schemastery`，
并通过一个假的 Cordis 上下文驱动插件。它同时守卫上面三条约束：
不 import harness 内部包、不调 MCP 工具、不写 settings 文件。

三个套件都不依赖当前工作目录，可以用任意 cwd 启动。

---

## 已知限制

- **必须用插件安装器安装。** 本包是标准 bundle，由插件页 / `plugin_manager` /
  `dsh plugin add` 完成依赖写入与 bundle 选中；手工把目录塞进 profile
  不属于支持路径 —— profile 插件的 peer 是从 profile 的 `node_modules` 解析的，
  绕过安装器就没有这层解析，插件会以 `Cannot find package` 加载失败。
- **代码改动需要重启。** 插件在启动时加载一次。Settings 的**取值**不需要重启，
  因为那些字段是活引用；但插件**代码**更新后必须重启 DSH。
- **发布到 npm 之前，插件市场里搜不到。** 仓库已开源，包名 `dsh-bm-hooks`
  在 registry.npmjs.org 上未被占用；执行 `npm publish --access public` 之后，
  上面三种安装方式才真正可用。
- **Settings 面板的渲染未经浏览器验证。** bundle 的注册、服务声明和写入路径
  由 `test/client.mjs` 覆盖，但真实渲染没有。请把「面板出现在 Settings 里」
  当作一次手动确认。
- **项目自动识别每会话一次 CLI 调用**（开启时），结果缓存 60 秒。
  会话中途新增的项目要等缓存过期或下个会话才可见。
- **简报是抽取式的、有上限的。** 每节最多 `briefLimit` 条，不摘要笔记正文；
  完整图谱仍在 Basic Memory 里。
- **`bm` 必须在 harness 启动时的那份 PATH 上。** DSH 运行期间改 PATH，
  在重启前不可见。
- **项目列表路由仅限回环地址。** 若把 GUI 暴露在非回环地址上，
  面板能打开但没有项目列表。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
