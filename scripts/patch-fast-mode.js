#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector is gated by authMethod === "chatgpt" checks.
 * API-key users never see it because their authMethod differs.
 *
 * This patch locates chatgpt auth comparisons inside functions that also
 * reference both "authMethod" and "fast_mode". Negative comparisons become
 * false and positive comparisons become true, preserving Fast mode for
 * AgentRouter API authentication across both upstream gate shapes.
 *
 * Target: permissions-mode-helpers-*.js (or any chunk with the pattern)
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod") || !fnSrc.includes("fast_mode")) return;

    // Inside this function, find either a direct authMethod comparison or the
    // newer aliased form (the containing function still carries authMethod).
    walk(node, (child) => {
      if (
        child.type !== "BinaryExpression" ||
        !["!==", "==="].includes(child.operator)
      ) return;

      const childSrc = source.slice(child.start, child.end);
      const left = child.left;
      const right = child.right;
      const leftValue = left.type === "Literal" ? left.value : null;
      const rightValue = right.type === "Literal" ? right.value : null;
      const leftTemplate = left.type === "TemplateLiteral" && left.expressions.length === 0
        ? left.quasis[0]?.value?.cooked
        : null;
      const rightTemplate = right.type === "TemplateLiteral" && right.expressions.length === 0
        ? right.quasis[0]?.value?.cooked
        : null;
      if (![leftValue, rightValue, leftTemplate, rightTemplate].includes("chatgpt")) return;

      // Avoid duplicate patches at same offset
      if (patches.some((p) => p.start === child.start)) return;

      patches.push({
        id: "fast_mode_auth_gate",
        start: child.start,
        end: child.end,
        replacement: child.operator === "!==" ? "!1" : "!0",
        original: childSrc,
      });
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("authMethod") && src.includes("fast_mode")) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    if (requireChange) throw new Error("Required fast_mode gate target was not found");
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;
  let totalMatched = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch (error) {
      if (requireChange) throw error;
      continue;
    }

    const patches = collectPatches(ast, source);
    totalMatched += patches.length;

    if (patches.length === 0) continue;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} auth gate(s) removed`);
  } else {
    console.log("  [ok] fast_mode auth gates already patched or absent");
  }
  if (requireChange && totalMatched === 0) {
    throw new Error("Required fast_mode patch matched zero locations");
  }
}

module.exports = { collectPatches };

if (require.main === module) main();
