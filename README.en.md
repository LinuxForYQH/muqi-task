# Muqi Task

[中文](README.md) | [English](README.en.md)

When you push several pieces of work at once, chats pile up and it gets hard to tell **which conversation belongs to which task**. The actual request lives in a single prompt; two days later you cannot match the chat, the feedback, or the work.

Muqi Task turns “what should the AI do” into a manageable Task: **the task is the spine, the conversation hangs off it.** You open a chat from the task, not the other way around.

## Install

Paste this to a Cursor Agent (the repo URL plus “install from the README” is enough):

```
Install Muqi Task: https://github.com/LinuxForYQH/muqi-task
After cloning, run npm run install:local at the repo root. Do not change any code.
When done, remind me to run Developer: Reload Window.
```

Then run **Developer: Reload Window** from the Command Palette. Muqi Task should appear in the left activity bar.

## What it solves

One idea: conversations revolve around tasks, instead of tasks getting buried in chats.

1. **Create the task first, then open a chat.** Each Task binds to one Cursor conversation. Open the task, click **查看对话** (View conversation), and you are back in that thread—no hunting through the chat list.
2. **Keep the request on the task, not scattered in chat.** Status, comments, and screenshots live on the Task. **同步处理** (Sync) sends feedback back into the bound conversation so the Agent continues from the latest context.
3. **Stay oriented when many tasks run in parallel.** The sidebar board tracks status (backlog / to claim / in progress / waiting for confirmation / blocked). A task can bind a folder, git repo, or worktree and open that Workspace in one click. Write comments on several tasks, then use **自动化** (Automation) to launch them together (up to 5).

Suggested rhythm: claim → in progress → Agent finishes and moves to “waiting for confirmation” → you confirm, then complete.

## How to use

Open **Muqi Task** on the left. The sidebar lists tasks by status; click one for details. Conversation, project, and comments all hang off that task.

![Sidebar task panel and issue details](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/01-overview.png)

Bind a local folder or Git repo as a project. New issues pick up that dev context automatically, and you can open the Workspace anytime.

![Project management](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/02-projects.png)

Once a conversation is attached, **查看对话** takes you back to that task’s Cursor thread.

![View conversation and continue the existing session](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/03-conversation.png)

Comment on the task, then **同步处理**: the comment goes to the bound chat, and the Agent on the right pulls the latest fields and comments to continue that task.

![Sync processing and Agent continuation](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/04-sync-process.png)

When several tasks are in flight, write the comments first, then turn on **自动化** to launch them together.

![Comment first, then batch-launch processing](https://cdn.jsdelivr.net/gh/LinuxForYQH/muqi-task@main/docs/screenshots/05-automation.png)
