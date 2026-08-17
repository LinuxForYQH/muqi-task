#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createStore } = require("../storage");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-background: #181818;
  --vscode-sideBar-background: #141414;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-disabledForeground: #6e6e6e;
  --vscode-editorWidget-background: #1f1f1f;
  --vscode-input-background: #2a2a2a;
  --vscode-list-hoverBackground: #2a2a2a;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-panel-border: #2b2b2b;
  --vscode-widget-border: #2b2b2b;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0e639c;
  --vscode-errorForeground: #f14c4c;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-yellow: #e2c08d;
  --vscode-charts-green: #89d185;
  --vscode-charts-blue: #75beff;
  --vscode-charts-purple: #b180d7;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-testing-iconPassed: #89d185;
  --vscode-editorGroupHeader-tabsBackground: #181818;
}
html, body { margin: 0; background: #181818; color: #ccc; }
body { overflow: hidden; }
#app.workspace { height: 100vh; }
`;

function writeHarness(file, surface, snapshot, options = {}) {
  const snapshotJson = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const selectId = options.selectId ? JSON.stringify(options.selectId) : "null";
  const expandList = Boolean(options.expandList);
  fs.writeFileSync(
    file,
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${pathToFileURL(path.join(ROOT, "media", "styles.css"))}" />
  <style>${THEME}</style>
  <title>Muqi Task</title>
</head>
<body data-surface="${surface}" data-locale="zh">
  <div id="app" class="workspace"></div>
  <script>
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (msg) {
          if (!msg || msg.type !== "ready") return;
          window.postMessage(Object.assign({ type: "dataSnapshot", locale: "zh" }, ${snapshotJson}), "*");
          var selectId = ${selectId};
          if (selectId) {
            setTimeout(function () {
              window.postMessage({ type: "showIssue", taskId: selectId }, "*");
            }, 40);
          }
        },
        getState: function () { return null; },
        setState: function () {}
      };
    };
  </script>
  <script src="${pathToFileURL(path.join(ROOT, "media", "i18n.js"))}"></script>
  <script src="${pathToFileURL(path.join(ROOT, "media", "main.js"))}"></script>
  ${
    expandList
      ? `<script>
    setTimeout(function () {
      document.querySelectorAll(".list-group.is-collapsed:not(.is-empty) .list-group-header").forEach(function (btn) {
        btn.click();
      });
      document.documentElement.setAttribute("data-shot-ready", "1");
    }, 120);
  </script>`
      : `<script>
    setTimeout(function () {
      document.documentElement.setAttribute("data-shot-ready", "1");
    }, 180);
  </script>`
  }
</body>
</html>`,
  );
}

async function main() {
  const dir = path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/local-test.muqi-task");
  const store = await createStore({ fsPath: dir });
  const snapshot = store.getSnapshot();
  store.close();

  const tasks = snapshot.tasks || [];
  const pick =
    tasks.find((item) => item.identifier === "MUQI-6") ||
    tasks.find((item) => item.threadId) ||
    tasks[0];
  if (!pick) throw new Error("任务库里没有议题，无法截图");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muqi-shot-"));
  const sidebarHtml = path.join(tmp, "sidebar.html");
  const detailHtml = path.join(tmp, "detail.html");
  writeHarness(sidebarHtml, "sidebar", snapshot, { expandList: true });
  writeHarness(detailHtml, "editor", snapshot, { selectId: pick.id });

  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const sidebar = await browser.newPage({ viewport: { width: 380, height: 820 } });
    await sidebar.goto(pathToFileURL(sidebarHtml).href);
    await sidebar.waitForSelector("[data-shot-ready='1']");
    await sidebar.waitForTimeout(200);
    await sidebar.screenshot({
      path: path.join(OUT_DIR, "01-task-list.png"),
      type: "png",
    });

    const detail = await browser.newPage({ viewport: { width: 920, height: 900 } });
    await detail.goto(pathToFileURL(detailHtml).href);
    await detail.waitForSelector("[data-shot-ready='1']");
    await detail.waitForSelector(".issue-detail");
    await detail.waitForTimeout(250);
    await detail.screenshot({
      path: path.join(OUT_DIR, "02-issue-detail.png"),
      type: "png",
    });

    const comment = await detail.locator(".comment-composer").first();
    if (await comment.count()) {
      await comment.scrollIntoViewIfNeeded();
      await comment.screenshot({
        path: path.join(OUT_DIR, "03-comment.png"),
        type: "png",
      });
    }
  } finally {
    await browser.close();
  }

  console.log("wrote");
  for (const name of ["01-task-list.png", "02-issue-detail.png", "03-comment.png"]) {
    const full = path.join(OUT_DIR, name);
    const stat = fs.statSync(full);
    console.log(`  ${name}  ${(stat.size / 1024).toFixed(0)}KB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
