---
name: manage-taskboard
description: Manage Cursor Taskboard issues via the cursor-taskboard MCP tools. Use for e-taskboard prompts, issue IDs like LOCAL-2 or OPEN-17, status sync, or comments.
---

# Manage Taskboard

Use the **cursor-taskboard MCP tools** provided by the Cursor Taskboard extension. Do **not** run shell commands like `taskctl`.

Use the exact issue identifier from the prompt. Never invent or rewrite an identifier prefix.

## MCP tools

| Tool | Purpose |
|------|---------|
| `issue_get` | Load title, description, status, comments |
| `comment_list` | List comments only |
| `issue_update` | Update `status` / `threadId` |
| `comment_add` | Add a progress / result comment |

Open [references/mcp.md](references/mcp.md) only when argument details are needed.

## Core workflow

1. For an existing issue, **always** call `issue_get` before acting. Treat returned title, description, **all comments**, activities, properties (status / priority / labels / assignee / dates / `gitBranch` / `worktreePath`), and the **associated `project`** (`name` / `folders` / `gitUrl` / `keyPrefix`) as current requirements. Do not rely on prompt snippets alone.
2. Before starting or resuming work, read the issue again and set status to `in_progress` with `issue_update`.
3. Execute only the requested work in the relevant workspace. Prefer `worktreePath` when set; otherwise use the associated project's `folders`. Do not wander into unrelated repos.
4. After finishing, `comment_add` with changes, verification, outcome, and remaining risks. Then set status to `in_review`.
5. Move to `done` only after the user explicitly accepts. Use `blocked` / `canceled` when appropriate.

Note: Bound Cursor chats are auto-synced into **one** expandable `agent_report` per thread, with child `chat_turn` messages underneath. MCP `comment_add` also writes `kind=agent_report`. Still use `comment_add` for explicit milestone reports, and do not skip status updates.

## 「同步处理」prompts

When the user message mentions `同步处理`, `e-taskboard 同步处理`, or asks to pull latest comments/properties for a taskboard issue:

1. Immediately call MCP `issue_get` with that ID (full properties + associated project + all comments + activities).
2. Use the returned fields as source of truth — especially status, priority, labels, assignee, dates, development context, **associated project**, and every comment body/attachment.
3. Continue work from the latest user feedback inside the associated project / worktree; sync status with `issue_update` as needed.

Do not ask the user to paste comments or properties. The panel only sends a short trigger; **you** must fetch via MCP.

## First response for `e-taskboard` prompts

When the user message matches `e-taskboard 处理任务面板任务 <ID>` or `e-taskboard 同步处理 <ID>` (optionally followed by 议题主题 / 开发上下文 / 用户反馈 lines):

1. Immediately call MCP `issue_get` with that ID.
2. Summarize title, description, status/properties, **associated project**, comments, and development context (branch / worktree).
3. Claim with `issue_update` (`status: in_progress`) if appropriate, then continue in the bound worktree / project folders when present.

Do not ask the user to paste the issue body. Do not use terminal CLI.
