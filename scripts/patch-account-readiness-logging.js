#!/usr/bin/env node
/**
 * Post-build patch: add a redacted account/read readiness marker.
 *
 * The installed Client smoke test needs to distinguish an API-key-backed
 * account from the login screen without persisting the account response. Add
 * only the account discriminator and OpenAI-auth requirement to the existing
 * response_routed safe log payload, and only for account/read responses.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const READINESS_METHOD = "account/read";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
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

function literalValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function propertyName(property) {
  if (!property || property.type !== "Property") return null;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return literalValue(property.key);
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function rootIdentifier(node) {
  const value = unwrapChain(node);
  if (!value) return null;
  if (value.type === "Identifier") return value.name;
  if (value.type === "MemberExpression") return rootIdentifier(value.object);
  return null;
}

function findMemberRoot(node, memberName) {
  let found = null;
  walk(node, (candidate) => {
    if (found || candidate.type !== "MemberExpression") return;
    const name = candidate.computed
      ? literalValue(candidate.property)
      : candidate.property?.name;
    if (name === memberName) found = rootIdentifier(candidate.object);
  });
  return found;
}

function collectReadinessPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (literalValue(node.arguments?.[0]) !== "response_routed") return;

    const payload = node.arguments?.[1];
    if (!payload || payload.type !== "ObjectExpression") {
      throw new Error("response_routed payload is not an object");
    }
    const safeProperty = payload.properties.find((property) => propertyName(property) === "safe");
    if (!safeProperty || safeProperty.value.type !== "ObjectExpression") {
      throw new Error("response_routed safe payload is missing");
    }

    const safe = safeProperty.value;
    const properties = new Map(
      safe.properties
        .filter((property) => property.type === "Property")
        .map((property) => [propertyName(property), property]),
    );
    for (const required of ["requestId", "method", "originWebcontentsId", "errorCode"]) {
      if (!properties.has(required)) {
        throw new Error(`response_routed safe payload is missing ${required}`);
      }
    }

    const nestedPropertyNames = new Set();
    walk(safe, (candidate) => {
      const name = propertyName(candidate);
      if (name) nestedPropertyNames.add(name);
    });
    const hasAccountType = nestedPropertyNames.has("accountType");
    const hasRequiresOpenaiAuth = nestedPropertyNames.has("requiresOpenaiAuth");
    if (hasAccountType || hasRequiresOpenaiAuth) {
      if (!hasAccountType || !hasRequiresOpenaiAuth) {
        throw new Error("response_routed readiness marker is only partially applied");
      }
      return;
    }

    const pendingName = findMemberRoot(properties.get("method").value, "method");
    const responseName = findMemberRoot(properties.get("errorCode").value, "error");
    if (!pendingName || !responseName) {
      throw new Error("Unable to resolve response_routed response variables");
    }

    const replacement =
      `,...(${pendingName}?.method===\`${READINESS_METHOD}\`?{` +
      `accountType:typeof ${responseName}.result?.account?.type===\`string\`` +
      `?${responseName}.result.account.type:null,` +
      `requiresOpenaiAuth:typeof ${responseName}.result?.requiresOpenaiAuth===\`boolean\`` +
      `?${responseName}.result.requiresOpenaiAuth:null}:{})`;
    patches.push({
      id: "account_readiness_safe_fields",
      start: safe.end - 1,
      end: safe.end - 1,
      replacement,
      original: "",
    });
  });

  return patches;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((candidate) =>
        fs.existsSync(path.join(SRC_DIR, candidate, "_asar", ".vite", "build")),
      );
  const targets = [];
  for (const candidate of platforms) {
    const buildDir = path.join(SRC_DIR, candidate, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const fileName of fs.readdirSync(buildDir)) {
      if (!fileName.endsWith(".js")) continue;
      const filePath = path.join(buildDir, fileName);
      const source = fs.readFileSync(filePath, "utf8");
      if (source.includes("response_routed")) {
        targets.push({ platform: candidate, path: filePath, source });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    throw new Error("No response_routed AppServerConnection bundle found");
  }

  let matched = 0;
  let changed = 0;
  for (const target of targets) {
    const ast = parse(target.source, { ecmaVersion: "latest", sourceType: "module" });
    const patches = collectReadinessPatches(ast, target.source);
    matched += patches.length;
    console.log(`  [${target.platform}] ${relPath(target.path)}`);

    if (patches.length === 0) {
      console.log("    [ok] account/read readiness marker already present");
      continue;
    }
    if (patches.length !== 1) {
      throw new Error(`Expected one response_routed marker, found ${patches.length}`);
    }
    if (isCheck) {
      console.log("    [?] add redacted account/read readiness fields");
      continue;
    }

    const patch = patches[0];
    const output =
      target.source.slice(0, patch.start) +
      patch.replacement +
      target.source.slice(patch.end);
    fs.writeFileSync(target.path, output, "utf8");
    changed++;
    console.log("    [ok] redacted account/read readiness fields added");
  }

  if (requireChange && matched === 0) {
    throw new Error("Required account/read readiness patch matched zero locations");
  }
  console.log(
    isCheck
      ? `  [ok] ${targets.length} AppServerConnection bundle(s) patchable`
      : `  [ok] ${changed} AppServerConnection bundle(s) changed`,
  );
}

module.exports = { collectReadinessPatches };

if (require.main === module) main();
