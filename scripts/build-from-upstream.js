#!/usr/bin/env node
/**
 * build-from-upstream.js — Patch upstream Codex and repackage
 *
 * For macOS and Windows: no forge needed.
 * Takes the upstream app, patches ASAR in-place, replaces codex CLI, outputs distributable.
 *
 * Usage:
 *   node scripts/build-from-upstream.js --platform mac-arm64
 *   node scripts/build-from-upstream.js --platform mac-x64
 *   node scripts/build-from-upstream.js --platform win [--artifact shell|composite] [--development-evidence]
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const { prepareShellTree } = require("./windows-component-util");
const { verifyReleaseSource } = require("./release-source-guard");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");
const CODEX_RUNTIME_SOURCE = (process.env.CODEX_RUNTIME_SOURCE || "upstream").toLowerCase();

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "win": "x86_64-pc-windows-msvc",
};

// ─── Helpers ────────────────────────────────────────────────────

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch {}
      count++;
    } else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function createZip(sourceDir, zipPath) {
  let lastError;
  for (const bin of ["7zz", "7z"]) {
    try {
      if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
      execFileSync(bin, ["a", "-tzip", "-mx=5", zipPath, "."], {
        cwd: sourceDir,
        stdio: "inherit",
      });
      return bin;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Neither 7zz nor 7z could create the archive: ${lastError?.message || "unknown error"}`);
}

function createWindowsCompatibilityEntrypoint(appDir) {
  const officialEntrypoint = path.join(appDir, "ChatGPT.exe");
  const compatibilityEntrypoint = path.join(appDir, "Codex.exe");
  const upstreamLauncherBackup = path.join(appDir, "Codex-upstream-launcher.bin");

  if (!fs.existsSync(officialEntrypoint)) return;

  if (fs.existsSync(compatibilityEntrypoint)) {
    fs.copyFileSync(compatibilityEntrypoint, upstreamLauncherBackup);
  }
  fs.copyFileSync(officialEntrypoint, compatibilityEntrypoint);
  console.log("   [entrypoint] Codex.exe mapped to the official ChatGPT.exe runtime");
}

function shouldReplaceCodexRuntime() {
  if (CODEX_RUNTIME_SOURCE === "upstream") return false;
  if (CODEX_RUNTIME_SOURCE === "cometix") return true;
  throw new Error(
    `Unsupported CODEX_RUNTIME_SOURCE=${CODEX_RUNTIME_SOURCE}; expected upstream or cometix`,
  );
}

function resolveCodexVendor(platform) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;
  const binName = platform === "win" ? "codex.exe" : "codex";

  // Try platform-specific package (0.128+)
  const PKG_MAP = { "mac-arm64": "codex-darwin-arm64", "mac-x64": "codex-darwin-x64", "win": "codex-win32-x64" };
  const platPkg = PKG_MAP[platform];
  if (platPkg) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@cometix", platPkg, "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  }
  // Try old-style vendor (pre-0.128)
  const localPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, "codex", binName);
  if (fs.existsSync(localPath)) return localPath;

  // npm pack fallback — fetch platform-specific package
  // First get latest cometix base version, then append platform suffix
  const PLAT_SUFFIX = {
    "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64",
    "win": "win32-x64",
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  };
  const suffix = PLAT_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }

  // e.g. "0.128.0-cometix" → "@cometix/codex@0.128.0-cometix-darwin-x64"
  const platPkgSpec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [codex] fetching ${platPkgSpec} via npm pack...`);
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tgzName = execSync(`npm pack ${platPkgSpec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();
    const extractDir = path.join(tmpDir, "extracted");
    clearDir(extractDir);
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
    const p = path.join(extractDir, "package", "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }
  return null;
}

// ─── macOS build ────────────────────────────────────────────────

function buildMac(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] ${platform}/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // 1. Find the .app in the ZIP extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(tempDir, `${variant}-extract`);

  // Find Codex.app
  let appPath = null;
  if (fs.existsSync(extractDir)) {
    const findApp = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "Codex.app" && e.isDirectory()) return path.join(dir, e.name);
        if (e.isDirectory()) { const r = findApp(path.join(dir, e.name)); if (r) return r; }
      }
      return null;
    };
    appPath = findApp(extractDir);
  }

  if (!appPath) {
    console.error(`[x] Codex.app not found in cache. Run sync-upstream first.`);
    process.exit(1);
  }

  console.log(`   [source] ${appPath}`);

  // 2. Copy .app to output (ditto preserves symlinks + resource forks)
  const outAppDir = path.join(OUT_DIR, platform);
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex.app");
  console.log("   [copy] Codex.app -> out/");
  execSync(`ditto "${appPath}" "${outApp}"`);

  const resourcesDir = path.join(outApp, "Contents", "Resources");

  // 3. Repack patched ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // 4. Update ASAR integrity hash in Info.plist
  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    updateAsarIntegrity(asarPath, infoPlist);
  }

  // 5. Strip original signature + quarantine
  console.log("   [codesign] removing original signature");
  try { execSync(`codesign --remove-signature "${outApp}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`xattr -rd com.apple.quarantine "${outApp}"`, { stdio: "pipe" }); } catch {}

  // 6. Keep the Codex CLI shipped with the official app by default. A
  // Cometix replacement remains available as an explicit compatibility mode.
  if (shouldReplaceCodexRuntime()) {
    replaceCodex(platform, resourcesDir, "codex");
  } else {
    console.log("   [codex] keeping official upstream runtime");
  }

  // 7. Ad-hoc re-sign (prevents "damaged app" Gatekeeper error)
  console.log("   [codesign] ad-hoc signing");
  try {
    execSync(`codesign --sign - --force --deep "${outApp}"`, { stdio: "pipe" });
    console.log("   [ok] ad-hoc signed");
  } catch (e) {
    console.log(`   [!] ad-hoc sign failed: ${e.message}`);
  }

  // 8. Create DMG
  const version = getVersion(asarDir);
  const dmgName = `Codex-${platform}-${version}.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);
  console.log(`   [dmg] ${dmgName}`);
  execSync(`hdiutil create -volname Codex -srcfolder "${outAppDir}" -ov -format UDZO "${dmgPath}"`, { stdio: "pipe" });
  const sizeMB = (fs.statSync(dmgPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${dmgPath} (${sizeMB} MB)`);
}

// ─── Windows build ──────────────────────────────────────────────

function buildWin(platform, { artifact, cacheKey, sourcePackageVersion, sourceIdentity }) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] win/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Windows: use the MSIX extract cache
  const tempDir = cacheKey
    ? path.join(require("os").tmpdir(), "codex-sync", cacheKey)
    : path.join(require("os").tmpdir(), "codex-sync");
  const extractDir = path.join(tempDir, "win-extract");
  const appDir = path.join(extractDir, "app");

  if (!fs.existsSync(appDir)) {
    console.error(`[x] MSIX extract not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Copy app/ to output
  const outAppDir = path.join(OUT_DIR, "win");
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex-win32-x64");
  console.log("   [copy] MSIX app/ -> out/");
  copyRecursive(appDir, outApp);

  const resourcesDir = path.join(outApp, "resources");

  // Compute old ASAR header hash (before repack)
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] old hash: ${oldHash.slice(0, 16)}...`);

  // Repack patched ASAR
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // Compute new hash and patch exe
  const newHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] new hash: ${newHash.slice(0, 16)}...`);

  if (oldHash !== newHash) {
    // Newer MSIX packages launch ChatGPT.exe; older ones used Codex.exe.
    const exePaths = ["ChatGPT.exe", "Codex.exe"]
      .map((name) => path.join(outApp, name))
      .filter((exePath) => fs.existsSync(exePath));
    const patched = exePaths.some((exePath) => patchExeHash(exePath, oldHash, newHash));
    if (!patched) {
      console.log("   [integrity] no embedded ASAR hash (runtime patch not required)");
    }
  }

  // AgentRouter Client and older portable launchers resolve Codex.exe. The
  // current Microsoft Store package declares ChatGPT.exe as its real desktop
  // entrypoint, while its Codex.exe helper exits outside the MSIX identity.
  createWindowsCompatibilityEntrypoint(outApp);

  const version = getVersion(asarDir);

  // A Shell artifact deliberately has no Core entrypoint. It cannot be
  // activated until AgentRouter Client composes it with a verified Core.
  if (artifact === "shell") {
    prepareShellTree(outApp, version, { sourcePackageVersion, ...sourceIdentity });
    console.log("   [component] removed non-Shell Core payloads and wrote agentrouter-shell.json");
  } else {
    // Keep the official Store runtime so the desktop model catalog and CLI stay
    // on the same release. Opt in to Cometix only for compatibility testing.
    if (shouldReplaceCodexRuntime()) {
      replaceCodex(platform, resourcesDir, "codex.exe");
    } else {
      console.log("   [codex] keeping official upstream runtime");
    }
  }

  // Create ZIP
  const zipName = artifact === "shell"
    ? `Codex-Desktop-Shell-win-x64-${version}.zip`
    : `Codex-win-x64-${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`   [zip] ${zipName}`);
  const archiver = createZip(outApp, zipPath);
  console.log(`   [zip] created with ${archiver}`);

  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${zipPath} (${sizeMB} MB)`);
}

// ─── ASAR integrity ─────────────────────────────────────────────

function computeAsarHeaderHash(asarPath) {
  const crypto = require("crypto");
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) return false;
  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] ${path.basename(exePath)} hash patched at offset ${idx}`);
  return true;
}

function updateAsarIntegrity(asarPath, infoPlistPath) {
  const newHash = computeAsarHeaderHash(asarPath);
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.hash -string "${newHash}" "${infoPlistPath}"`, { stdio: "pipe" });
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.algorithm -string "SHA256" "${infoPlistPath}"`, { stdio: "pipe" });

  // Verify
  const verify = execSync(`plutil -extract ElectronAsarIntegrity.Resources/app\\\\.asar.hash raw "${infoPlistPath}"`, { encoding: "utf-8" }).trim();
  if (verify === newHash) {
    console.log(`   [integrity] hash updated: ${newHash.slice(0, 16)}...`);
  } else {
    console.log(`   [!] integrity verify failed`);
  }
}

// ─── Shared ─────────────────────────────────────────────────────

function replaceCodex(platform, resourcesDir, binName) {
  const vendor = resolveCodexVendor(platform);
  if (vendor) {
    const dest = path.join(resourcesDir, binName);
    fs.copyFileSync(vendor, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex not found, keeping upstream codex`);
  }
}

function getVersion(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function getRecordedWindowsSyncState() {
  const versionsPath = path.join(__dirname, ".versions.json");
  try {
    const versions = JSON.parse(fs.readFileSync(versionsPath, "utf-8"));
    return {
      sourcePackageVersion: String(versions.win?.version || "").trim() || null,
      cacheKey: String(versions.win?.cacheKey || "").trim() || null,
    };
  } catch {
    return { sourcePackageVersion: null, cacheKey: null };
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;
  const artifactIdx = args.indexOf("--artifact");
  const artifact = artifactIdx !== -1 ? args[artifactIdx + 1] : "composite";
  const sourceVersionIdx = args.indexOf("--source-package-version");
  const explicitSourcePackageVersion = sourceVersionIdx !== -1 ? args[sourceVersionIdx + 1] : null;
  const cacheKeyIdx = args.indexOf("--cache-key");
  const explicitCacheKey = cacheKeyIdx !== -1 ? args[cacheKeyIdx + 1] : null;
  const developmentEvidence = args.includes("--development-evidence");

  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    console.error("[x] Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win> [--artifact <shell|composite>]");
    process.exit(1);
  }
  if (!["shell", "composite"].includes(artifact)) {
    console.error("[x] --artifact must be shell or composite");
    process.exit(1);
  }
  if (platform !== "win" && artifact !== "composite") {
    console.error("[x] Shell components are currently supported only for Windows");
    process.exit(1);
  }
  if (sourceVersionIdx !== -1 && (!explicitSourcePackageVersion || explicitSourcePackageVersion.startsWith("--"))) {
    console.error("[x] --source-package-version requires a value");
    process.exit(1);
  }
  if (cacheKeyIdx !== -1 && (!explicitCacheKey || explicitCacheKey.startsWith("--"))) {
    console.error("[x] --cache-key requires a value");
    process.exit(1);
  }
  if (explicitCacheKey && !/^[0-9A-Za-z._-]+$/.test(explicitCacheKey)) {
    console.error("[x] --cache-key may contain only letters, numbers, dot, underscore, and dash");
    process.exit(1);
  }

  const recordedSyncState = getRecordedWindowsSyncState();
  const sourcePackageVersion = explicitSourcePackageVersion || recordedSyncState.sourcePackageVersion;
  const cacheKey = explicitCacheKey || recordedSyncState.cacheKey;
  if (platform === "win" && artifact === "shell" && !sourcePackageVersion) {
    console.error("[x] Shell builds require Windows sourcePackageVersion from sync-upstream or --source-package-version");
    process.exit(1);
  }
  const sourceIdentity = platform === "win" && artifact === "shell"
    ? verifyReleaseSource({ root: PROJECT_ROOT, developmentEvidence })
    : null;

  console.log(`\n== Build from upstream: ${platform} (${artifact}) ==\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (platform.startsWith("mac")) {
    buildMac(platform);
  } else {
    buildWin(platform, { artifact, cacheKey, sourcePackageVersion, sourceIdentity });
  }
}

main();
