# MCP 与 Agent 协作

## Skill

扩展会安装 `manage-taskboard` skill：Agent 通过 MCP 读写议题，而不是用终端 CLI。

## 传输方式

- **本机窗口**：stdio 子进程（`mcp-server.js`）。启动时不写 stderr，避免 Cursor Shared MCP 把诊断日志当成 `[error]` 并打断连接。
- **远程 SSH / WSL**：扩展宿主内的本机 HTTP MCP，经 `asExternalUri` 端口转发注册。远端 stdio 路径在本机 Shared MCP 里 spawn 常会变成 `error=Canceled`。
- `auth=unknown` 对无 OAuth 的本地 MCP 是正常状态，不代表鉴权失败。

## 安装到远程

本机打包后可用维护脚本装进 SSH 主机（扩展 `extensionKind` 为 `workspace`）：

```bash
npm run install:remote -- --host <ssh-config-Host>
```

装完后在对应远程窗口 Reload。产品设置页和命令面板不再提供该入口。

## 常用 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `issue_get` | 拉标题、描述、状态、项目、评论、活动、开发上下文等 |
| `issue_update` | 更新状态 / 绑定 `threadId` |
| `comment_add` | 写 Agent 进度评论 |
| `comment_list` | 只列评论 |

## 面板触发语

- **处理任务**：`e-taskboard 处理任务面板任务 <ID>`  
- **同步处理**：续写已绑会话，要求立刻 `issue_get` 再继续  
- **同步属性**：请求 Agent 用 MCP 核对属性  

已绑定会话时优先续写，避免「同步处理」误开新对话丢绑定。

## 推荐状态约定

1. 认领 → `in_progress`  
2. 完成后 → `in_review` 并 `comment_add`  
3. 用户确认后再 → `done`  

## 产出与 Agent

总结类产物建议写成目录书（多章节 md），再挂到议题「产出内容」，方便人在面板里点开阅读，也方便后续议题追溯。
