#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Output structure per platform:
 *   src/{platform}/
 *     _asar/              Extracted app.asar content (patch target)
 *     app.asar.unpacked/  Native modules (kept as-is from upstream)
 *     codex|codex.exe     CLI binary (will be replaced by @cometix/codex)
 *     rg|rg.exe           ripgrep binary (kept from upstream)
 *     plugins/            Bundled plugins
 *     native/             Platform native modules
 *     ...                 All other upstream resources
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--skip-mac] [--skip-win]
 *     [--refresh-download] [--cache-key <safe-key>]
 *     [--mac-lock <repository-relative-json>]
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function parseSyncOptions(argv) {
  const cacheKeyIndex = argv.indexOf("--cache-key");
  const cacheKey = cacheKeyIndex === -1 ? null : argv[cacheKeyIndex + 1];
  if (cacheKeyIndex !== -1 && (!cacheKey || cacheKey.startsWith("--"))) {
    throw new Error("--cache-key requires a value");
  }
  if (cacheKey && !/^[0-9A-Za-z._-]+$/.test(cacheKey)) {
    throw new Error("--cache-key may contain only letters, numbers, dot, underscore, and dash");
  }
  const macLockIndex = argv.indexOf("--mac-lock");
  const macLock = macLockIndex === -1 ? null : argv[macLockIndex + 1];
  if (macLockIndex !== -1 && (!macLock || macLock.startsWith("--"))) {
    throw new Error("--mac-lock requires a repository-relative JSON path");
  }
  if (macLock && (path.isAbsolute(macLock) || macLock.includes("\\"))) {
    throw new Error("--mac-lock must use a repository-relative forward-slash path");
  }
  return {
    force: argv.includes("--force"),
    checkOnly: argv.includes("--check-only"),
    skipMac: argv.includes("--skip-mac"),
    skipWin: argv.includes("--skip-win"),
    refreshDownload: argv.includes("--refresh-download"),
    cacheKey,
    macLock,
  };
}

function getSyncCacheDir(cacheKey, tempRoot = require("os").tmpdir()) {
  const base = path.join(tempRoot, "codex-sync");
  return cacheKey ? path.join(base, cacheKey) : base;
}

function refreshCachedArchive(archivePath, enabled) {
  if (!enabled || !fs.existsSync(archivePath)) return false;
  fs.rmSync(archivePath, { force: true });
  return true;
}

// TLS certs for MS delivery CDN
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OPTIONS = parseSyncOptions(process.argv.slice(2));
const TEMP_DIR = getSyncCacheDir(OPTIONS.cacheKey);
const VERSION_FILE = path.join(__dirname, ".versions.json");
const MAC_SOURCE_LOCK = loadMacSourceLock(OPTIONS.macLock);

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";

const FORCE = OPTIONS.force;
const CHECK_ONLY = OPTIONS.checkOnly;
const SKIP_MAC = OPTIONS.skipMac;
const SKIP_WIN = OPTIONS.skipWin;
const REFRESH_DOWNLOAD = OPTIONS.refreshDownload;

// ─── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  execFileSync(
    "curl",
    ["--fail", "--location", "--retry", "3", "--retry-delay", "2", "--output", dest, url],
    { stdio: "inherit" },
  );
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}

function validateMacSourceLock(lock) {
  if (!lock || lock.schemaVersion !== 1) throw new Error("macOS source lock schemaVersion must be 1");
  if (!/^\d+(?:\.\d+){2,3}$/.test(String(lock.version || ""))) {
    throw new Error("macOS source lock version is invalid");
  }
  if (!/^\d+$/.test(String(lock.build || ""))) throw new Error("macOS source lock build is invalid");
  for (const variant of ["arm64", "x64"]) {
    const record = lock.variants?.[variant];
    const expectedUrl = `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-${variant}-${lock.version}.zip`;
    if (!record || record.url !== expectedUrl) throw new Error(`macOS ${variant} source URL is not pinned to ${expectedUrl}`);
    if (!Number.isSafeInteger(record.size) || record.size <= 0) throw new Error(`macOS ${variant} source size is invalid`);
    if (!/^[0-9a-f]{64}$/.test(String(record.sha256 || ""))) throw new Error(`macOS ${variant} source SHA-256 is invalid`);
  }
  return lock;
}

function loadMacSourceLock(relativePath) {
  if (!relativePath) return null;
  const resolved = path.resolve(PROJECT_ROOT, relativePath);
  if (!resolved.startsWith(`${PROJECT_ROOT}${path.sep}`) || !fs.statSync(resolved).isFile()) {
    throw new Error("--mac-lock must resolve to a file inside the repository");
  }
  return validateMacSourceLock(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

function assertMacSourceInfo(info, variant, lock = MAC_SOURCE_LOCK) {
  if (!lock) return;
  const record = lock.variants[variant];
  if (info.version !== lock.version || info.build !== String(lock.build)) {
    throw new Error(
      `macOS ${variant} appcast drifted from lock: expected ${lock.version} (${lock.build}), got ${info.version} (${info.build})`,
    );
  }
  if (info.url !== record.url || info.size !== record.size) {
    throw new Error(`macOS ${variant} appcast URL or size drifted from the committed source lock`);
  }
}

function verifyMacSourceArchive(filePath, variant, lock = MAC_SOURCE_LOCK) {
  if (!lock) return;
  const record = lock.variants[variant];
  const size = fs.statSync(filePath).size;
  if (size !== record.size) throw new Error(`macOS ${variant} source size mismatch: expected ${record.size}, got ${size}`);
  const actual = sha256File(filePath);
  if (actual !== record.sha256) throw new Error(`macOS ${variant} source SHA-256 mismatch: expected ${record.sha256}, got ${actual}`);
  console.log(`   [pin] ${variant} ${lock.version} sha256=${actual}`);
}

function extractArchive(archive, dest) {
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto preserves macOS symlinks + resource forks (required for .app)
    execFileSync("ditto", ["-xk", archive, dest], { stdio: "inherit" });
  } else {
    // 7zz for Windows MSIX and Linux (symlinks don't matter — only ASAR content used)
    for (const bin of ["7zz", "7z"]) {
      try {
        execFileSync(bin, ["x", "-y", `-o${dest}`, archive], { stdio: "pipe" });
        return;
      } catch {
        if (fs.readdirSync(dest).length > 0) return;
      }
    }
    throw new Error(`Failed to extract ${archive}`);
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * MSIX stores path segments containing reserved characters in URL-encoded form
 * (for example, npm scopes are written as "%40worklouder"). Windows decodes
 * those names while installing the package, but generic archive tools do not.
 * Normalize the extracted tree before reading app.asar.unpacked or copying the
 * other resources into a portable build.
 */
function decodeMsixPaths(root) {
  const entries = [];

  function visit(dir, depth) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      entries.push({ full, name: entry.name, depth });
    }
  }

  visit(root, 0);
  entries.sort((a, b) => b.depth - a.depth);

  let renamed = 0;
  for (const entry of entries) {
    if (!/%[0-9a-f]{2}/i.test(entry.name)) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(entry.name);
    } catch {
      continue;
    }
    if (decoded === entry.name) continue;

    const target = path.join(path.dirname(entry.full), decoded);
    if (fs.existsSync(target)) {
      throw new Error(`MSIX path decode collision: ${entry.full} -> ${target}`);
    }
    fs.renameSync(entry.full, target);
    renamed++;
  }

  return renamed;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
    size: Number(enc?.["@_length"] || 0),
  };
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");
  const pkg = msstore.selectArchitecturePackage(pkgs, "x64");
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

// ─── Extract macOS ──────────────────────────────────────────────

async function syncMac(variant, info, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);
  assertMacSourceInfo(info, variant);
  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${variant}-extract`);

  if (refreshCachedArchive(zipPath, REFRESH_DOWNLOAD)) {
    console.log(`   [refresh] removed cached archive ${zipPath}`);
  }
  if (!fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }
  verifyMacSourceArchive(zipPath, variant);

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(zipPath, extractDir);

  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  assembleOutput(resourcesDir, destDir, label);
  return info;
}

// ─── Extract Windows ────────────────────────────────────────────

async function syncWin(destDir) {
  console.log("\n-- Windows");

  const info = await getWindowsVersion();
  console.log(`   version: ${info.version}`);

  const msixPath = path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  if (refreshCachedArchive(msixPath, REFRESH_DOWNLOAD)) {
    console.log(`   [refresh] removed cached archive ${msixPath}`);
  }
  if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(msixPath, extractDir);

  const decodedPathCount = decodeMsixPaths(extractDir);
  if (decodedPathCount > 0) {
    console.log(`   [msix paths] decoded ${decodedPathCount} entries`);
  }

  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const alt = findFile(extractDir, "app.asar");
    throw new Error(`Windows: resources dir not found${alt ? `, app.asar at ${alt}` : ""}`);
  }

  assembleOutput(resourcesDir, destDir, "Windows");
  return info;
}

// ─── Assemble output ────────────────────────────────────────────

function assembleOutput(resourcesDir, destDir, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  clearDir(destDir);

  // 1. Extract app.asar → _asar/ (for patching)
  const asarDest = path.join(destDir, "_asar");
  console.log("   [asar extract] -> _asar/");
  const npxExecutable = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npxExecutable, ["asar", "extract", asarPath, asarDest], { stdio: "inherit" });

  // 2. Copy app.asar.unpacked/ as-is (native modules)
  const unpackedSrc = path.join(resourcesDir, "app.asar.unpacked");
  if (fs.existsSync(unpackedSrc)) {
    const n = copyRecursive(unpackedSrc, path.join(destDir, "app.asar.unpacked"));
    console.log(`   [copy] app.asar.unpacked/ (${n} files)`);
  }

  // 3. Copy all other resources (binaries, plugins, native, etc.)
  let extraCount = 0;
  for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
    if (e.name.endsWith(".lproj")) continue;
    const s = path.join(resourcesDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) { extraCount += copyRecursive(s, d); }
    else if (!e.isSymbolicLink()) { fs.copyFileSync(s, d); extraCount++; }
  }
  console.log(`   [copy] ${extraCount} extra resource files`);

  const total = countFiles(destDir);
  console.log(`   [ok] ${total} files total`);
}

function findResourcesDir(extractDir) {
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Version state ──────────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}
function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const results = {};
  const failures = [];

  // Detect versions
  if (!SKIP_MAC) {
    try {
      const arm64Info = await getAppcastVersion(APPCAST_ARM64);
      assertMacSourceInfo(arm64Info, "arm64");
      console.log(`\n   mac-arm64: ${arm64Info.version} (build ${arm64Info.build})`);
      results["mac-arm64"] = arm64Info;
    } catch (e) {
      failures.push(`mac-arm64 check: ${e.message}`);
      console.error(`   [x] mac-arm64 check: ${e.message}`);
    }

    try {
      const x64Info = await getAppcastVersion(APPCAST_X64);
      assertMacSourceInfo(x64Info, "x64");
      console.log(`   mac-x64:   ${x64Info.version} (build ${x64Info.build})`);
      results["mac-x64"] = x64Info;
    } catch (e) {
      failures.push(`mac-x64 check: ${e.message}`);
      console.error(`   [x] mac-x64 check: ${e.message}`);
    }
  }

  if (!SKIP_WIN) {
    try {
      const winInfo = await getWindowsVersion();
      console.log(`   win:       ${winInfo.version}`);
      results.win = winInfo;
    } catch (e) {
      failures.push(`win check: ${e.message}`);
      console.error(`   [x] win check: ${e.message}`);
    }
  }

  if (CHECK_ONLY) {
    console.log("\n== Check only, skipping download ==");
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return;
  }

  // Download and extract
  if (!SKIP_MAC && results["mac-arm64"]) {
    try {
      results["mac-arm64"] = await syncMac("arm64", results["mac-arm64"], path.join(SRC_DIR, "mac-arm64"));
    } catch (e) {
      failures.push(`mac-arm64 sync: ${e.message}`);
      console.error(`   [x] mac-arm64: ${e.message}`);
    }
  }
  if (!SKIP_MAC && results["mac-x64"]) {
    try {
      results["mac-x64"] = await syncMac("x64", results["mac-x64"], path.join(SRC_DIR, "mac-x64"));
    } catch (e) {
      failures.push(`mac-x64 sync: ${e.message}`);
      console.error(`   [x] mac-x64: ${e.message}`);
    }
  }
  if (!SKIP_WIN && results.win) {
    try {
      results.win = await syncWin(path.join(SRC_DIR, "win"));
    } catch (e) {
      failures.push(`win sync: ${e.message}`);
      console.error(`   [x] win: ${e.message}`);
    }
  }

  if (failures.length > 0) throw new Error(failures.join("\n"));

  const saved = loadVersions();
  for (const [key, info] of Object.entries(results)) {
    saved[key] = {
      version: info.version,
      build: info.build || "",
      checkedAt: new Date().toISOString(),
      cacheKey: OPTIONS.cacheKey,
    };
  }
  saveVersions(saved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

module.exports = {
  assertMacSourceInfo,
  getSyncCacheDir,
  parseSyncOptions,
  refreshCachedArchive,
  validateMacSourceLock,
  verifyMacSourceArchive,
};

if (require.main === module) {
  main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
}
