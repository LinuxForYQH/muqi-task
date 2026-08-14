#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const {
  findLatestVsix,
  installLocal,
  installRemote,
  listSshHosts,
} = require("../remote-install");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  /** @type {{ remote: boolean, host: string, vsix: string, pack: boolean }} */
  const out = { remote: false, host: "", vsix: "", pack: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--remote") out.remote = true;
    else if (token === "--package" || token === "--pack") out.pack = true;
    else if (token === "--host" && argv[i + 1]) {
      out.host = argv[++i];
    } else if (token.startsWith("--host=")) {
      out.host = token.slice("--host=".length);
    } else if (token === "--vsix" && argv[i + 1]) {
      out.vsix = argv[++i];
    } else if (!token.startsWith("-") && !out.host && out.remote) {
      out.host = token;
    }
  }
  return out;
}

function ensureVsix(pack) {
  if (pack) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "package.js")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  const vsix = findLatestVsix(ROOT);
  if (!vsix) {
    console.error("没有 releases/*.vsix，请先运行 npm run package");
    process.exit(1);
  }
  return vsix;
}

const args = parseArgs(process.argv.slice(2));
const vsix = args.vsix || ensureVsix(args.pack);
console.log(`VSIX: ${vsix}`);

try {
  if (!args.remote) {
    const result = installLocal(vsix);
    console.log(result.stdout.trim() || "已安装到本机 Cursor");
    process.exit(0);
  }
  let host = args.host;
  if (!host) {
    const hosts = listSshHosts();
    if (hosts.length === 1) host = hosts[0];
    else if (hosts.length === 0) {
      console.error("未找到 ~/.ssh/config 中的 Host，请加 --host <name>");
      process.exit(1);
    } else {
      console.error("多个 SSH Host，请指定一个：");
      for (const name of hosts) console.error(`  npm run install:remote -- --host ${name}`);
      process.exit(1);
    }
  }
  const result = installRemote({ host, vsixPath: vsix });
  console.log(result.stdout.trim() || `已安装到远程 ${host}（${result.mode}）`);
  console.log("请在对应 SSH 窗口执行 Developer: Reload Window");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
