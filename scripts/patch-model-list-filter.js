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
 * The filter used to live in model-list-filter-*.js. Newer Desktop builds fold
 * it into a route bundle, so the target is discovered by both feature keys and
 * the filter expression instead of by an unstable chunk filename.
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const IDENTIFIER = "[A-Za-z_$][0-9A-Za-z_$]*";

function originalPattern() {
  return new RegExp(
    `if\\((${IDENTIFIER})\\?(${IDENTIFIER})\\.has\\((${IDENTIFIER})\\.model\\):!\\3\\.hidden\\)\\{`,
    "g",
  );
}

function patchedPattern() {
  return new RegExp(
    `if\\(!(${IDENTIFIER})\\.hidden\\|\\|(${IDENTIFIER})&&(${IDENTIFIER})\\.has\\(\\1\\.model\\)\\)\\{`,
    "g",
  );
}

function patchModelFilterSource(source, { apply = true } = {}) {
  const originalMatches = [...source.matchAll(originalPattern())];
  const patchedMatches = [...source.matchAll(patchedPattern())];
  if (patchedMatches.length === 1 && originalMatches.length === 0) {
    return { changed: false, matched: true, source };
  }
  if (originalMatches.length !== 1 || patchedMatches.length !== 0) {
    throw new Error(
      `Expected one unpatched model filter, found original=${originalMatches.length}, patched=${patchedMatches.length}`,
    );
  }
  if (!apply) return { changed: false, matched: true, source };

  const [match, useHidden, availableModels, model] = originalMatches[0];
  const replacement = `if(!${model}.hidden||${useHidden}&&${availableModels}.has(${model}.model)){`;
  const index = originalMatches[0].index;
  return {
    changed: true,
    matched: true,
    source: `${source.slice(0, index)}${replacement}${source.slice(index + match.length)}`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );

  const candidates = locateBundles({
    dir: "assets",
    pattern: /\.js$/,
    platform,
    allMatches: true,
  });
  const targets = candidates.filter((target) => {
    const source = fs.readFileSync(target.path, "utf-8");
    if (!source.includes("available_models") || !source.includes("use_hidden_models")) return false;
    return originalPattern().test(source) || patchedPattern().test(source);
  });
  const targetsPerPlatform = new Map();
  for (const target of targets) {
    targetsPerPlatform.set(target.platform, (targetsPerPlatform.get(target.platform) || 0) + 1);
  }
  const expectedPlatforms = new Set(candidates.map((target) => target.platform));
  for (const expectedPlatform of expectedPlatforms) {
    const count = targetsPerPlatform.get(expectedPlatform) || 0;
    if (count !== 1) {
      throw new Error(`Expected one model filter bundle for ${expectedPlatform}, found ${count}`);
    }
  }

  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf-8");
    console.log(`  [${target.platform}] ${relPath(target.path)}`);
    const result = patchModelFilterSource(source, { apply: !isCheck });
    if (!result.changed && !isCheck) {
      console.log("    [ok] provider-visible models already preserved");
      matched++;
      continue;
    }
    if (isCheck) {
      console.log("    [?] preserve visible models and union allowed hidden models");
      matched++;
      continue;
    }

    fs.writeFileSync(target.path, result.source, "utf-8");
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

module.exports = { patchModelFilterSource };

if (require.main === module) main();
