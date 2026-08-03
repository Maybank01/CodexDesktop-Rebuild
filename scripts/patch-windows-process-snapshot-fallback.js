#!/usr/bin/env node
/**
 * Keep Windows process discovery working when the optional performance-counter
 * WMI class is unavailable. Win32_Process is still sufficient to identify and
 * stop descendant processes; only CPU telemetry is omitted in this fallback.
 *
 * Targets: every JavaScript bundle under the Windows main-process build.
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const ORIGINAL =
  "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object";
const PATCHED =
  "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | ForEach-Object";

function patchSource(source) {
  const originalCount = source.split(ORIGINAL).length - 1;
  const patchedCount = source.split(PATCHED).length - 1;
  if (originalCount === 0) {
    return { source, changed: false, matched: patchedCount > 0 };
  }
  return {
    source: source.split(ORIGINAL).join(PATCHED),
    changed: true,
    matched: true,
  };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(arg),
  );
  if (platform != null && platform !== "win") {
    console.log("  [skip] Windows process snapshot fallback is Windows-only");
    return;
  }

  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const buildDir = path.join(SRC_DIR, "win", "_asar", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    throw new Error("Windows main-process build directory not found");
  }

  const targets = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(buildDir, name));
  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    const result = patchSource(source);
    if (!result.matched) continue;
    matched += 1;
    console.log(`  [win] ${relPath(target)}`);
    if (!result.changed) {
      console.log("    [ok] WMI performance-counter fallback already applied");
      continue;
    }
    if (isCheck) {
      console.log("    [?] WMI performance-counter fallback will be applied");
      continue;
    }
    fs.writeFileSync(target, result.source, "utf8");
    changed += 1;
    console.log("    [ok] Process discovery now tolerates missing CPU counters");
  }

  if (requireChange && matched === 0) {
    throw new Error("Required Windows process snapshot pattern matched zero bundles");
  }
  console.log(
    isCheck
      ? `  [ok] ${matched} Windows process bundle(s) patchable or already patched`
      : `  [ok] ${changed} Windows process bundle(s) changed`,
  );
}

module.exports = { ORIGINAL, PATCHED, patchSource };

if (require.main === module) main();
