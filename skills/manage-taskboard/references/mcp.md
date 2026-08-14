# cursor-taskboard MCP

Server name: `cursor-taskboard` (registered by the Cursor Taskboard extension).

## issue_get

```json
{ "id": "OPEN-17" }
```

Returns the issue JSON, including `comments`, `activities`, and associated `project` (`id` / `name` / `keyPrefix` / `folders` / `gitUrl`).

## comment_list

```json
{ "id": "OPEN-17" }
```

## issue_update

```json
{ "id": "OPEN-17", "status": "in_progress" }
```

Optional: `"threadId": "<composer-id>"`.

Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled`.

## comment_add

```json
{
  "id": "OPEN-17",
  "body": "变更说明、验证结果、剩余风险"
}
```
