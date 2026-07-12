#!/usr/bin/env node
/**
 * Post-build patch: preserve provider-visible models in the desktop picker.
 *
 * The upstream model filter treats the Statsig `available_models` allowlist as
 * the complete picker catalog whenever `use_hidden_models` is enabled. Custom
 * providers can return additional models with hidden=false, but that branch
 * drops them before rendering. Use the allowlist only to opt hidden models in;
 * provider-visible models remain visible regardless of the upstream allowlist.
 *
 * Target: model-list-filter-*.js
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const ORIGINAL = "if(u?n.has(r.model):!r.hidden){";
const PATCHED = "if(!r.hidden||u&&n.has(r.model)){";

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );

  const targets = locateBundles({
    dir: "assets",
    pattern: /^model-list-filter-.*\.js$/,
    platform,
  });

  if (targets.length === 0) {
    throw new Error("No model-list-filter bundle found");
  }

  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf-8");
    const originalCount = source.split(ORIGINAL).length - 1;
    const patchedCount = source.split(PATCHED).length - 1;

    console.log(`  [${target.platform}] ${relPath(target.path)}`);

    if (patchedCount === 1 && originalCount === 0) {
      console.log("    [ok] provider-visible models already preserved");
      continue;
    }
    if (originalCount !== 1 || patchedCount !== 0) {
      throw new Error(
        `Expected one unpatched model filter, found original=${originalCount}, patched=${patchedCount}`,
      );
    }
    if (isCheck) {
      console.log("    [?] preserve visible models and union allowed hidden models");
      matched++;
      continue;
    }

    fs.writeFileSync(target.path, source.replace(ORIGINAL, PATCHED), "utf-8");
    console.log("    [ok] visible models preserved; allowed hidden models still included");
    matched++;
    changed++;
  }

  if (requireChange && matched === 0) {
    throw new Error("Required model-list-filter patch matched zero locations");
  }

  console.log(
    isCheck
      ? `  [ok] ${targets.length} model filter bundle(s) patchable or already patched`
      : `  [ok] ${changed} model filter bundle(s) changed`,
  );
}

main();
