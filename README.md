# Muqi Task

Muqi Task 侧栏任务面板扩展：议题看板、本地 SQLite 持久化，并与对话、MCP、Git 工作区打通。

## 安装

把下面发给 Cursor Agent（只贴仓库地址也可以，再补一句「按 README 安装」）：

```
请安装 Muqi Task：https://github.com/LinuxForYQH/muqi-task
clone 后在仓库根目录执行 npm run install:local，不要改代码。
装完提醒我执行 Developer: Reload Window。
```

Agent 会 clone、打包并装进本机 Cursor。完成后命令面板运行 **Developer: Reload Window**，左侧活动栏出现 Muqi Task 即可。

手动安装同一条命令：

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

## 已有界面

- 项目切换
- Dashboard / 议题看板 / 列表视图 / 甘特图（后两者占位）
- 四列看板：等待认领 / 处理中 / 遇到阻碍 / 等你确认
- 卡片拖拽改状态、搜索、详情侧栏
- 「在对话中打开」占位提示

## 同步 db

侧栏 → **同步 db**：

- 默认：本机 SQLite
- 可选：填写 Git 仓库地址，开启每日自动备份（默认凌晨 3 点）
- 支持手动「同步到 Git」「从 Git 拉回」「合并 Git 到本地」（拉回/合并会先备份本地库）
