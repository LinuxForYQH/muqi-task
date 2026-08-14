#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RELEASES_DIR = path.join(ROOT, "releases");
const KEEP = 3;

function ensureReleasesDir() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

function packageExtension() {
  ensureReleasesDir();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const outFile = path.join(RELEASES_DIR, `${pkg.name}-${pkg.version}.vsix`);
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "@vscode/vsce",
      "package",
      "--allow-missing-repository",
      "--out",
      outFile,
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

/**
 * Keep only the newest KEEP .vsix files under releases/, delete the rest.
 * Also remove any leftover .vsix sitting in the project root.
 */
function prunePackages() {
  ensureReleasesDir();

  // Move any root-level .vsix into releases/ first.
  for (const name of fs.readdirSync(ROOT)) {
    if (!name.endsWith(".vsix")) continue;
    const from = path.join(ROOT, name);
    const to = path.join(RELEASES_DIR, name);
    if (fs.existsSync(to)) {
      fs.unlinkSync(from);
    } else {
      fs.renameSync(from, to);
    }
  }

  const vsix = fs
    .readdirSync(RELEASES_DIR)
    .filter((name) => name.endsWith(".vsix"))
    .map((name) => {
      const full = path.join(RELEASES_DIR, name);
      return { name, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const keep = vsix.slice(0, KEEP);
  const remove = vsix.slice(KEEP);
  for (const item of remove) {
    fs.unlinkSync(item.full);
    console.log(`removed old package: ${item.name}`);
  }

  console.log(`\nKept ${keep.length} package(s) in releases/:`);
  for (const item of keep) {
    console.log(`  - ${item.name}`);
  }
  if (keep[0]) {
    console.log(`\nLatest: ${path.join("releases", keep[0].name)}`);
  }
}

ensureReleasesDir();
packageExtension();
prunePackages();
