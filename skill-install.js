"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME_DIR = path.join(os.homedir(), ".cursor-taskboard");
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const CURSOR_SKILLS_DIR = path.join(os.homedir(), ".cursor", "skills");
const SKILL_NAME = "manage-taskboard";

/**
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Install User skill into ~/.cursor/skills and write runtime config.
 * @param {import('vscode').ExtensionContext | { extensionPath?: string }} context
 * @param {string} dbPath
 * @param {{ attachmentsRoot?: string }} [extras]
 */
function installRuntime(context, dbPath, extras = {}) {
  fs.mkdirSync(HOME_DIR, { recursive: true });

  const skillSource = path.join(context.extensionPath, "skills", SKILL_NAME);
  const skillDest = path.join(CURSOR_SKILLS_DIR, SKILL_NAME);
  const mcpServerJs = path.join(context.extensionPath, "mcp-server.js");
  const skillPath = path.join(skillDest, "SKILL.md");

  if (!fs.existsSync(skillSource)) {
    throw new Error(`缺少 skill: ${skillSource}`);
  }
  if (!dbPath) {
    throw new Error("缺少 dbPath");
  }

  fs.mkdirSync(CURSOR_SKILLS_DIR, { recursive: true });
  fs.rmSync(skillDest, { recursive: true, force: true });
  copyDir(skillSource, skillDest);

  /** @type {Record<string, string>} */
  let previous = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      previous = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
    }
  } catch {
    previous = {};
  }

  const config = {
    dbPath,
    mcpServerJs,
    skillPath,
    extensionPath: context.extensionPath,
    attachmentsRoot: extras.attachmentsRoot || previous.attachmentsRoot || null,
    // 保留同步配置，避免 activate 重装 skill 时被冲掉
    sync: previous.sync || extras.sync || undefined,
    updatedAt: new Date().toISOString(),
  };
  if (!config.sync) delete config.sync;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

module.exports = {
  CONFIG_PATH,
  CURSOR_SKILLS_DIR,
  installRuntime,
};
