#!/usr/bin/env node
/**
 * Keep the AgentRouter-managed Windows Shell bound to its managed Runtime.
 *
 * - disable the upstream primary-runtime updater when AgentRouter launch
 *   environment is present;
 * - let the app-server config.toml permission policy remain authoritative;
 * - repair AppContainer read/execute ACLs for relocated Runtime directories.
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const PATCH_MARKER = "AGENTROUTER_MANAGED_RUNTIME_PATCH_V1";
const MANAGED_CONDITION =
  "(process.env.AGENTROUTER_CLIENT_LOG_DIR||process.env.AGENTROUTER_API_KEY)";
const RUNTIME_UPDATER_ORIGINAL =
  "getStaticDisabledReason(){return this.options.hostId===`local`?";
const RUNTIME_UPDATER_PATCHED =
  `getStaticDisabledReason(){return ${MANAGED_CONDITION}?` +
  "`agentrouter-managed-runtime`:this.options.hostId===`local`?";
const PERMISSION_OVERRIDE_ORIGINAL = "shouldSendPermissionOverrides:!0";
const PERMISSION_OVERRIDE_PATCHED = "shouldSendPermissionOverrides:!1";

const WINDOWS_ACL_BOOTSTRAP = `/*${PATCH_MARKER}*/(()=>{if(process.platform!==\`win32\`||!${MANAGED_CONDITION})return;try{let e=require(\`node:child_process\`),t=require(\`node:path\`),n=t.dirname(process.execPath),r=[process.execPath,process.env.CODEX_CLI_PATH].filter(e=>typeof e===\`string\`&&e.length>0),i=(t,n)=>{let r=e.spawnSync(\`icacls.exe\`,[t,\`/grant\`,\`*S-1-15-2-1:${'${n}'}\`,\`*S-1-15-2-2:${'${n}'}\`,\`/C\`],{encoding:\`utf8\`,windowsHide:!0});r.status!==0&&console.warn(\`[agentrouter-managed-runtime] ACL repair failed\`,{target:t,status:r.status})};i(n,\`(OI)(CI)(RX)\`);for(let e of new Set(r))i(e,\`(RX)\`)}catch(e){console.warn(\`[agentrouter-managed-runtime] ACL repair threw\`,e)}})();`;

function count(source, value) {
  return source.split(value).length - 1;
}

function patchMainSource(source) {
  const originalCount = count(source, RUNTIME_UPDATER_ORIGINAL);
  const patchedCount = count(source, RUNTIME_UPDATER_PATCHED);
  const hasBootstrap = source.includes(PATCH_MARKER);
  if (originalCount === 0 && patchedCount === 1 && hasBootstrap) {
    return { source, changed: false, matched: true };
  }
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `Expected one primary Runtime updater hook; original=${originalCount}, patched=${patchedCount}`,
    );
  }
  const next =
    WINDOWS_ACL_BOOTSTRAP +
    source.replace(RUNTIME_UPDATER_ORIGINAL, RUNTIME_UPDATER_PATCHED);
  return { source: next, changed: true, matched: true };
}

function patchPermissionSource(source) {
  const originalCount = count(source, PERMISSION_OVERRIDE_ORIGINAL);
  const patchedCount = count(source, PERMISSION_OVERRIDE_PATCHED);
  if (originalCount === 0) {
    return {
      source,
      changed: false,
      matched: patchedCount > 0,
      replacements: 0,
    };
  }
  return {
    source: source.replaceAll(
      PERMISSION_OVERRIDE_ORIGINAL,
      PERMISSION_OVERRIDE_PATCHED,
    ),
    changed: true,
    matched: true,
    replacements: originalCount,
  };
}

function listAssetBundles(platform) {
  const assetDir = path.join(
    SRC_DIR,
    platform,
    "_asar",
    "webview",
    "assets",
  );
  if (!fs.existsSync(assetDir)) return [];
  return fs
    .readdirSync(assetDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetDir, name));
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const platform =
    args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg)) ||
    "win";
  if (platform !== "win") {
    console.log("  [ok] AgentRouter managed Runtime patch is Windows-only");
    return;
  }

  const mainTargets = locateBundles({
    dir: "build",
    pattern: /^main-.*\.js$/,
    platform,
  });
  if (mainTargets.length !== 1) {
    throw new Error(`Expected one Windows main bundle, found ${mainTargets.length}`);
  }

  let changedFiles = 0;
  let permissionReplacements = 0;
  for (const target of mainTargets) {
    const source = fs.readFileSync(target.path, "utf8");
    const result = patchMainSource(source);
    console.log(`  [${target.platform}] ${relPath(target.path)}`);
    if (result.changed && !isCheck) {
      fs.writeFileSync(target.path, result.source, "utf8");
      changedFiles += 1;
    }
    console.log(
      result.changed
        ? "    [ok] managed updater disabled and Runtime ACL repair installed"
        : "    [ok] managed Runtime main-process patch already applied",
    );
  }

  const assetTargets = listAssetBundles(platform);
  let matchedPermissionBundles = 0;
  for (const target of assetTargets) {
    const source = fs.readFileSync(target, "utf8");
    const result = patchPermissionSource(source);
    if (!result.matched) continue;
    matchedPermissionBundles += 1;
    permissionReplacements += result.replacements;
    console.log(`  [${platform}] ${relPath(target)}`);
    if (result.changed && !isCheck) {
      fs.writeFileSync(target, result.source, "utf8");
      changedFiles += 1;
    }
    console.log(
      result.changed
        ? "    [ok] app-server permission defaults restored"
        : "    [ok] permission default patch already applied",
    );
  }
  if (matchedPermissionBundles === 0) {
    throw new Error("No Windows permission override bundle matched");
  }
  if (permissionReplacements !== 0 && permissionReplacements !== 4) {
    throw new Error(
      `Expected four permission override replacements, found ${permissionReplacements}`,
    );
  }
  if (requireChange && changedFiles === 0) {
    throw new Error("Required AgentRouter managed Runtime patch changed zero files");
  }
  console.log(
    isCheck
      ? `  [ok] ${matchedPermissionBundles} permission bundle(s) and main bundle are patchable`
      : `  [ok] ${changedFiles} bundle(s) changed`,
  );
}

module.exports = {
  MANAGED_CONDITION,
  PATCH_MARKER,
  PERMISSION_OVERRIDE_ORIGINAL,
  PERMISSION_OVERRIDE_PATCHED,
  RUNTIME_UPDATER_ORIGINAL,
  RUNTIME_UPDATER_PATCHED,
  WINDOWS_ACL_BOOTSTRAP,
  patchMainSource,
  patchPermissionSource,
};

if (require.main === module) main();
