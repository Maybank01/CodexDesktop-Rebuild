#!/usr/bin/env node
/**
 * Prefer the image payload over savedPath when rendering generated images.
 *
 * The app-server returns both:
 * - result: PNG bytes encoded as base64
 * - savedPath: the durable file under the managed CODEX_HOME
 *
 * On Windows, the webview cannot use the raw savedPath as an <img src>. Keep
 * savedPath on the item for persistence/artifacts, but derive src from result
 * first so the preview uses a data URL.
 *
 * Target: app-server-manager-signals-*.js
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const ORIGINAL =
  "function xm(e){let t=typeof e.savedPath==`string`?Sm(e.savedPath):null;return{...e,src:t??Sm(e.result)}}";
const PATCHED =
  "function xm(e){let t=Sm(e.result),n=typeof e.savedPath==`string`?Sm(e.savedPath):null;return{...e,src:t??n}}";

function patchSource(source) {
  const originalCount = source.split(ORIGINAL).length - 1;
  const patchedCount = source.split(PATCHED).length - 1;

  if (patchedCount === 1 && originalCount === 0) {
    return { source, changed: false, matched: true };
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `Expected one generated-image source selector, found original=${originalCount}, patched=${patchedCount}`,
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
    pattern: /^app-server-manager-signals-.*\.js$/,
    platform,
  });

  if (targets.length === 0) {
    throw new Error("No app-server-manager-signals bundle found");
  }

  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchSource(source);
    matched += result.matched ? 1 : 0;

    console.log(`  [${target.platform}] ${relPath(target.path)}`);
    if (!result.changed) {
      console.log("    [ok] generated-image preview already prefers result data");
      continue;
    }
    if (isCheck) {
      console.log("    [?] generated-image preview will prefer result data");
      continue;
    }

    fs.writeFileSync(target.path, result.source, "utf8");
    changed += 1;
    console.log("    [ok] generated-image preview now prefers result data");
  }

  if (requireChange && matched === 0) {
    throw new Error("Required generated-image preview patch matched zero locations");
  }

  console.log(
    isCheck
      ? `  [ok] ${targets.length} generated-image bundle(s) patchable or already patched`
      : `  [ok] ${changed} generated-image bundle(s) changed`,
  );
}

module.exports = { ORIGINAL, PATCHED, patchSource };

if (require.main === module) main();
