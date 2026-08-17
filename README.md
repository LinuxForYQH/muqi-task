# Muqi Task

把议题看板嵌进 Cursor：本地 SQLite 持久化，侧栏管任务，右侧对话干活，并用 MCP 把 Agent 和议题状态打通。

## 主要解决什么痛点

在 Cursor 里用 Agent 做事时，常见情况是：聊天记录一长串，需求在飞书 / Linear / 备忘录里，代码在另一个窗口。过两天再打开，对不上「哪次对话、哪条反馈、哪个目录」。

| 痛点 | 面板里怎么处理 |
| --- | --- |
| 对话和任务对不上，找不到上次聊到哪 | 每个议题绑定一条 Cursor 会话，点 **查看对话** 续写，也可以在评论里继续 |
| 任务在 IDE 外面，来回切窗口 | 侧栏就是看板：待立项 / 等待认领 / 处理中 / 等你确认 / 遇到阻碍 |
| 给 Agent 的反馈（尤其截图）进不了原会话 | **评论**只落库；**同步处理**续写已绑会话，并由 skill 拉取最新属性与评论 |
| 多个需求抢同一个工作区 | 议题上绑文件夹 / git / worktree，一键 **打开 Workspace** |
| 一条条打开对话太慢 | 先给议题写评论，再用 **自动化** 一次拉起（最多 5 条）让 Cursor 处理 |
| 任务数据散在聊天里，不好备份 | 本机 SQLite；可选 Git 仓库每日备份整库 |

推荐节奏：认领 → 处理中 → Agent 做完进「等你确认」→ 你确认后再完成。

## 怎么用

左侧活动栏点 Muqi Task 图标打开 **TASK PANEL**。侧栏按状态列出议题，点一条会在右侧打开详情。

![侧栏任务面板与议题详情](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/01-overview.png)

**项目管理**：把本地文件夹或 Git 仓库绑成项目。创建议题时会自动挂上开发上下文，也可以随时打开 Workspace。

![项目管理](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/02-projects.png)

议题绑定对话之后，点 **查看对话** 回到那条 Cursor 会话继续聊；也可以在下方评论，再同步处理。

![查看对话，续写已有会话](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/03-conversation.png)

**同步处理**会把当前评论发回已绑定会话。右侧 Agent 会按 skill 拉取最新议题属性与评论，并同步进度。

![同步处理与 Agent 续写](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/04-sync-process.png)

也可以先给多条议题写好评论，再打开 **自动化**，一次性打开对话并处理。

![先评论，再批量拉起处理](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/05-automation.png)

## 安装

把下面发给 Cursor Agent（只贴仓库地址也可以，再补一句「按 README 安装」）：

```
请安装 Muqi Task：https://github.com/LinuxForYQH/muqi-task
clone 后在仓库根目录执行 npm run install:local，不要改代码。
装完提醒我执行 Developer: Reload Window。
```

完成后命令面板运行 **Developer: Reload Window**，左侧活动栏出现 Muqi Task 即可。

手动安装：

```bash
git clone https://github.com/LinuxForYQH/muqi-task.git
cd muqi-task
npm run install:local
```

**远程 SSH：** 扩展跑在远端宿主。本机打包后：

```bash
npm run install:remote -- --host <ssh-config-Host>
```

需要 `~/.ssh/config` 里已有 Host、免密登录，且已用 Cursor 连过该 SSH。装完后在对应远程窗口 Reload Window。

## 同步 db

侧栏设置 → **同步 db**：

- 默认：本机 SQLite
- 可选：填写 Git 仓库地址，开启每日自动备份（默认凌晨 3 点）
- 支持手动「同步到 Git」「从 Git 拉回」「合并 Git 到本地」（拉回/合并会先备份本地库）
