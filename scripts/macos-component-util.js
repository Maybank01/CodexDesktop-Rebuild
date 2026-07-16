const fs = require("fs");
const path = require("path");

const COMPONENT_SCHEMA_VERSION = 1;
const SHELL_KIND = "agentrouter-codex-desktop-shell";
const SHELL_MANIFEST_NAME = "agentrouter-shell.json";
const APP_BUNDLE_NAME = "Codex.app";
const DESKTOP_ENTRYPOINT = "Codex.app/Contents/MacOS/Codex";
const BUNDLED_CORE_ENTRYPOINT = "Codex.app/Contents/Resources/codex";

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeArch(value) {
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported macOS component architecture: ${value}`);
}

function resolveMacExtractDirectory(tempRoot, cacheKey, arch) {
  const variant = normalizeArch(arch);
  return path.join(
    path.resolve(tempRoot),
    "codex-sync",
    ...(cacheKey ? [cacheKey] : []),
    `${variant}-extract`,
  );
}

function findMacDesktopApp(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
    if (
      entry.name.endsWith(".app") &&
      fs.existsSync(path.join(fullPath, "Contents", "Resources", "app.asar"))
    ) {
      return fullPath;
    }
    const nested = findMacDesktopApp(fullPath);
    if (nested) return nested;
  }
  return null;
}

function createMacShellManifest(version, arch, extra = {}) {
  if (!String(version || "").trim()) throw new Error("Shell version is required.");
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    kind: SHELL_KIND,
    platform: "macos",
    arch: normalizeArch(arch),
    version: String(version),
    entrypoint: DESKTOP_ENTRYPOINT,
    requiredCore: {
      kind: "agentrouter-codex-core",
      mode: "external",
      environmentVariable: "CODEX_CLI_PATH",
      bundledPathMustBeAbsent: BUNDLED_CORE_ENTRYPOINT,
    },
    ...extra,
  };
}

function validateMacShellTree(rootDir, { requireCoreAbsent = true } = {}) {
  const root = path.resolve(rootDir);
  const manifestPath = path.join(root, SHELL_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error(`Shell manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== COMPONENT_SCHEMA_VERSION || manifest.kind !== SHELL_KIND) {
    throw new Error("macOS Shell manifest has an invalid schema or kind.");
  }
  if (manifest.platform !== "macos" || !["arm64", "x64"].includes(manifest.arch)) {
    throw new Error("macOS Shell manifest has an invalid platform or architecture.");
  }
  if (manifest.entrypoint !== DESKTOP_ENTRYPOINT) {
    throw new Error(`macOS Shell entrypoint must be ${DESKTOP_ENTRYPOINT}.`);
  }
  if (
    manifest.requiredCore?.kind !== "agentrouter-codex-core" ||
    manifest.requiredCore?.mode !== "external" ||
    manifest.requiredCore?.environmentVariable !== "CODEX_CLI_PATH" ||
    manifest.requiredCore?.bundledPathMustBeAbsent !== BUNDLED_CORE_ENTRYPOINT
  ) {
    throw new Error("macOS Shell manifest has an invalid external Core contract.");
  }
  const appBundle = path.join(root, APP_BUNDLE_NAME);
  const entrypoint = path.join(root, ...DESKTOP_ENTRYPOINT.split("/"));
  if (!fs.statSync(appBundle).isDirectory()) throw new Error(`Shell app bundle is missing: ${appBundle}`);
  if (!fs.statSync(entrypoint).isFile()) throw new Error(`Shell entrypoint is missing: ${entrypoint}`);
  const bundledCore = path.join(root, ...BUNDLED_CORE_ENTRYPOINT.split("/"));
  if (requireCoreAbsent && fs.existsSync(bundledCore)) {
    throw new Error(`macOS Shell must not contain ${BUNDLED_CORE_ENTRYPOINT}.`);
  }
  return { appBundle, entrypoint, manifest, root };
}

function prepareMacShellTree(rootDir, version, arch, extra = {}) {
  const root = path.resolve(rootDir);
  const bundledCore = path.join(root, ...BUNDLED_CORE_ENTRYPOINT.split("/"));
  fs.rmSync(bundledCore, { force: true });
  writeJson(path.join(root, SHELL_MANIFEST_NAME), createMacShellManifest(version, arch, extra));
  return validateMacShellTree(root);
}

module.exports = {
  APP_BUNDLE_NAME,
  BUNDLED_CORE_ENTRYPOINT,
  DESKTOP_ENTRYPOINT,
  SHELL_MANIFEST_NAME,
  createMacShellManifest,
  findMacDesktopApp,
  prepareMacShellTree,
  resolveMacExtractDirectory,
  validateMacShellTree,
};
