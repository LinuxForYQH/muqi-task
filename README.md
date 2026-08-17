# Muqi Task

[中文](README.md) | [English](README.en.md)

同时推进多个需求时，对话越开越多，分不清「哪个会话对应哪个任务」。需求只活在某一轮 prompt 里，过两天再打开，对不上哪次对话、哪条反馈。

Muqi Task 把「让 AI 做什么」沉淀成可管理的 Task：**任务是主线，对话挂在任务下面。** 从任务进会话，而不是从会话找任务。

## 安装

把下面发给 Cursor Agent（只贴仓库地址也可以，再补一句「按 README 安装」）：

```
请安装 Muqi Task：https://github.com/LinuxForYQH/muqi-task
clone 后在仓库根目录执行 npm run install:local，不要改代码。
装完提醒我执行 Developer: Reload Window。
```

完成后命令面板运行 **Developer: Reload Window**，左侧活动栏出现 Muqi Task 即可。

## 解决什么

核心就一件事：让对话围着任务转，而不是任务淹没在对话里。

1. **先建任务，再开对话。** 每条 Task 绑定一条 Cursor 会话。点任务进详情，点 **查看对话** 回到那条会话，不用在聊天列表里翻。
2. **需求落在任务上，不散在聊天里。** 状态、评论、截图都挂在这条 Task 下；**同步处理** 把反馈发回已绑会话，Agent 按最新内容续写。
3. **多任务并行时仍分得清。** 侧栏看板管状态（待立项 / 等待认领 / 处理中 / 等你确认 / 遇到阻碍）。任务还可以绑文件夹 / git / worktree，一键打开 Workspace；多条任务写好评论后，用 **自动化** 一次拉起（最多 5 条）。

推荐节奏：认领 → 处理中 → Agent 做完进「等你确认」→ 你确认后再完成。

## 怎么用

打开左侧 **Muqi Task**：侧栏按状态列出任务，点一条看详情。对话、项目、评论都在这条任务下面。

![侧栏任务面板与议题详情](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/01-overview.png)

把本地文件夹或 Git 仓库绑成项目。创建议题时自动带上开发上下文，也可以随时打开 Workspace。

![项目管理](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/02-projects.png)

对话挂在任务上之后，点 **查看对话** 回到这条任务对应的会话。

![查看对话，续写已有会话](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/03-conversation.png)

在任务下评论，再 **同步处理**：评论发回已绑会话，右侧 Agent 拉取最新属性与评论，继续这条任务。

![同步处理与 Agent 续写](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/04-sync-process.png)

多条任务并行时，先写好评论，再开 **自动化**，一次拉起处理。

![先评论，再批量拉起处理](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/05-automation.png)
