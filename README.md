# Muqi Task

Muqi Task 侧栏任务面板扩展：议题看板、本地 SQLite 持久化，并与对话、MCP、Git 工作区打通。

## 已有界面

- 项目切换
- Dashboard / 议题看板 / 列表视图 / 甘特图（后两者占位）
- 四列看板：等待认领 / 处理中 / 遇到阻碍 / 等你确认
- 卡片拖拽改状态、搜索、详情侧栏
- 「在对话中打开」占位提示

## 安装

```bash
cd /path/to/muqi-task
npm run package
```

产物输出到 `releases/`，只保留最近 3 个 `.vsix`。

**本机：**

```bash
npm run install:vsix
```

或 Cursor：Extensions → `...` → Install from VSIX → 选择 `releases/` 下最新的 `.vsix`。

**远程 SSH：** 扩展声明为 `workspace`，会跑在远端扩展宿主。本机打包后可用维护脚本推过去：

```bash
npm run install:remote -- --host <ssh-config-Host>
```

需要 `~/.ssh/config` 里已有 Host、免密登录，且已用 Cursor 连过该 SSH（远端存在 `~/.cursor-server`）。装完后在对应远程窗口执行 `Developer: Reload Window`。

## 同步 db

侧栏 → **同步 db**：

- 默认：本机 SQLite
- 可选：填写 Git 仓库地址，开启每日自动备份（默认凌晨 3 点）
- 支持手动「同步到 Git」「从 Git 拉回」「合并 Git 到本地」（拉回/合并会先备份本地库）
