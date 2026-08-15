#!/usr/bin/env node
"use strict";

const os = require("os");
const path = require("path");
const { createStore } = require("../storage");
const { repairIssueThreadBindings, syncIssueComposerChat } = require("../composer-sync");

async function main() {
  const dir = path.join(
    os.homedir(),
    "Library/Application Support/Cursor/User/globalStorage/local-test.muqi-task",
  );
  const store = await createStore({ fsPath: dir });
  try {
    const changes = repairIssueThreadBindings(store);
    console.log("repair:", JSON.stringify(changes, null, 2));
    for (const change of changes) {
      if (!change.to) continue;
      const result = await syncIssueComposerChat(store, change.identifier);
      console.log("sync", change.identifier, {
        added: result.added,
        threadId: result.threadId,
        reason: result.reason,
      });
    }
    console.log("\nthread bindings:");
    for (const issue of store.listIssues()) {
      console.log(`  ${issue.identifier}\t${issue.threadId || "(none)"}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
