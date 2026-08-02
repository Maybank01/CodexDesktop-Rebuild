#!/usr/bin/env node
/**
 * Recover Windows onboarding after sandbox setup completed across a restart.
 *
 * The onboarding step atom can remain at WindowsSandboxSetup when the Shell or
 * Core restarts before the setup promise advances the flow. On the next launch,
 * the current upstream effect only re-evaluates the Start step, so a live
 * `windowsSandbox/readiness = ready` result cannot release the stale setup
 * screen. Re-evaluate the Windows step after its readiness query settles; the
 * existing state machine then advances it to Complete.
 *
 * Target: onboarding-page-*.js
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const ORIGINAL = "y=()=>{r!==U.Start||m.isLoading||v()}";
const PATCHED =
  "y=()=>{m.isLoading||(r===U.Start||r===U.WindowsSandboxSetup&&!m.finalStep.shouldShow)&&v()}";

function patchSource(source) {
  const originalCount = source.split(ORIGINAL).length - 1;
  const patchedCount = source.split(PATCHED).length - 1;

  if (patchedCount === 1 && originalCount === 0) {
    return { source, changed: false, matched: true };
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `Expected one Windows onboarding recovery effect, found original=${originalCount}, patched=${patchedCount}`,
    );
  }
  return {
    source: source.replace(ORIGINAL, PATCHED),
    changed: true,
    matched: true,
  };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  const targets = locateBundles({
    dir: "assets",
    pattern: /^onboarding-page-.*\.js$/,
    platform,
  });

  if (targets.length === 0) {
    throw new Error("No onboarding-page bundle found");
  }

  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);
    matched += result.matched ? 1 : 0;

    console.log(`  [${target.platform}] ${relPath(target.path)}`);
    if (!result.changed) {
      console.log("    [ok] Windows onboarding restart recovery already applied");
      continue;
    }
    if (isCheck) {
      console.log("    [?] Windows onboarding restart recovery will be applied");
      continue;
    }

    fs.writeFileSync(target.path, result.source, "utf8");
    changed += 1;
    console.log("    [ok] Windows onboarding now recovers from a completed setup");
  }

  if (requireChange && matched === 0) {
    throw new Error("Required Windows onboarding recovery patch matched zero locations");
  }

  console.log(
    isCheck
      ? `  [ok] ${targets.length} onboarding bundle(s) patchable or already patched`
      : `  [ok] ${changed} onboarding bundle(s) changed`,
  );
}

module.exports = { ORIGINAL, PATCHED, patchSource };

if (require.main === module) main();
