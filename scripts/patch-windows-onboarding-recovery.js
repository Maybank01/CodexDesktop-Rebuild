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
const LEGACY_PATCHED =
  "y=()=>{m.isLoading||(r===U.Start||r===U.WindowsSandboxSetup&&!m.finalStep.shouldShow)&&v()}";
const ORIGINAL_COMPILED_EFFECT =
  "let v=(0,Jc.useEffectEvent)(_),y;e[12]!==v||e[13]!==r||e[14]!==m.isLoading?(y=()=>{m.isLoading||(r===U.Start||r===U.WindowsSandboxSetup&&!m.finalStep.shouldShow)&&v()},e[12]=v,e[13]=r,e[14]=m.isLoading,e[15]=y):y=e[15];let b;e[16]!==r||e[17]!==m.isLoading?(b=[r,m.isLoading],e[16]=r,e[17]=m.isLoading,e[18]=b):b=e[18],(0,Jc.useEffect)(y,b);";
const PATCHED_COMPILED_EFFECT =
  "let v=(0,Jc.useEffectEvent)(_),y=()=>{m.isLoading||(r===U.Start||r===U.WindowsSandboxSetup&&!m.finalStep.shouldShow)&&v()};(0,Jc.useEffect)(y,[r,m.isLoading,m.finalStep.shouldShow]);";

function patchSource(source) {
  let next = source;
  let changed = false;
  const originalCount = next.split(ORIGINAL).length - 1;
  const patchedCompiledCount =
    next.split(PATCHED_COMPILED_EFFECT).length - 1;

  if (patchedCompiledCount === 1 && originalCount === 0) {
    return { source, changed: false, matched: true };
  }
  if (originalCount === 1) {
    next = next.replace(ORIGINAL, LEGACY_PATCHED);
    changed = true;
  } else if (originalCount !== 0) {
    throw new Error(
      `Expected one Windows onboarding recovery effect, found original=${originalCount}, patched=${patchedCompiledCount}`,
    );
  }
  const compiledCount = next.split(ORIGINAL_COMPILED_EFFECT).length - 1;
  if (compiledCount === 1) {
    next = next.replace(ORIGINAL_COMPILED_EFFECT, PATCHED_COMPILED_EFFECT);
    changed = true;
    return { source: next, changed, matched: true };
  }
  if (changed) {
    return { source: next, changed: true, matched: true };
  }
  throw new Error(
    `Expected one Windows onboarding recovery effect, found compiled=${compiledCount}`,
  );
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

module.exports = {
  ORIGINAL,
  LEGACY_PATCHED,
  ORIGINAL_COMPILED_EFFECT,
  PATCHED_COMPILED_EFFECT,
  patchSource,
};

if (require.main === module) main();
