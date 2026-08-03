const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { isDeepStrictEqual } = require("util");

const COMPONENT_SCHEMA_VERSION = 1;
const SHELL_KIND = "agentrouter-codex-desktop-shell";
const CORE_KIND = "agentrouter-codex-core";
const COMPOSITION_KIND = "agentrouter-codex-runtime-composition";
const SHELL_MANIFEST_NAME = "agentrouter-shell.json";
const CORE_MANIFEST_NAME = "agentrouter-core.json";
const COMPOSITION_MANIFEST_NAME = "agentrouter-composition.json";
const DESKTOP_ENTRYPOINT = "Codex.exe";
const CORE_ENTRYPOINT = "resources/codex.exe";
const NON_WINDOWS_CORE_ENTRYPOINT = "resources/codex";
const CORE_ALLOWED_FILES = Object.freeze([CORE_MANIFEST_NAME, CORE_ENTRYPOINT]);

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizedPathKey(value) {
  return normalizeRelativePath(value).toLowerCase();
}

function assertSafeArchivePath(value) {
  const normalized = normalizeRelativePath(value);
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new Error(`Unsafe archive path: ${value}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return normalized;
}

function resolveArchiveTool() {
  for (const candidate of ["7zz", "7z"]) {
    try {
      execFileSync(candidate, ["i"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return candidate;
    } catch {
      // Try the next supported executable name.
    }
  }
  throw new Error("Neither 7zz nor 7z is available on PATH.");
}

function createZip(sourceDir, outputPath, { force = false } = {}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputPath);
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`ZIP source is not a directory: ${source}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) {
    if (!force) throw new Error(`Output already exists: ${output}`);
    fs.rmSync(output, { force: true });
  }

  const tool = resolveArchiveTool();
  execFileSync(tool, ["a", "-tzip", "-mx=5", output, "."], {
    cwd: source,
    stdio: "inherit",
    windowsHide: true,
  });
  execFileSync(tool, ["t", output], {
    stdio: "pipe",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { outputPath: output, tool };
}

function parseTechnicalListing(output) {
  const blocks = output.split(/\r?\n\r?\n/);
  const entries = [];
  for (const block of blocks) {
    const properties = new Map();
    for (const line of block.split(/\r?\n/)) {
      const index = line.indexOf(" = ");
      if (index <= 0) continue;
      properties.set(line.slice(0, index), line.slice(index + 3));
    }
    const rawPath = properties.get("Path");
    if (!rawPath || !properties.has("Folder")) continue;
    entries.push({
      path: assertSafeArchivePath(rawPath),
      isDirectory: properties.get("Folder") === "+",
    });
  }
  return entries;
}

function listArchiveEntries(archivePath) {
  const archive = path.resolve(archivePath);
  if (!fs.statSync(archive).isFile()) {
    throw new Error(`Component archive is not a file: ${archive}`);
  }
  const tool = resolveArchiveTool();
  const output = execFileSync(tool, ["l", "-ba", "-slt", archive], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries = parseTechnicalListing(output);
  if (entries.length === 0) throw new Error(`Archive contains no entries: ${archive}`);

  const seen = new Set();
  for (const entry of entries) {
    const key = normalizedPathKey(entry.path);
    if (seen.has(key)) throw new Error(`Archive contains duplicate path: ${entry.path}`);
    seen.add(key);
  }
  return entries;
}

function ensureEmptyDirectory(directory) {
  const target = path.resolve(directory);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function extractArchiveSafely(archivePath, destination) {
  listArchiveEntries(archivePath);
  const target = ensureEmptyDirectory(destination);
  const tool = resolveArchiveTool();
  execFileSync(tool, ["x", "-y", `-o${target}`, path.resolve(archivePath)], {
    stdio: "pipe",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  walkFiles(target);
  return target;
}

function walkFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        throw new Error(`Component tree contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Component tree contains unsupported entry: ${relative}`);
    }
  }
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function withMaterializedComponent(inputPath, callback) {
  const input = path.resolve(inputPath);
  const stat = fs.statSync(input);
  if (stat.isDirectory()) return callback(input);
  if (!stat.isFile()) throw new Error(`Component input is neither a file nor directory: ${input}`);

  const tempBase = path.resolve(process.env.CODEX_COMPONENT_TEMP_DIR || os.tmpdir());
  fs.mkdirSync(tempBase, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempBase, "agentrouter-component-"));
  try {
    extractArchiveSafely(input, tempDir);
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

function assertPeExecutable(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(2);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
      throw new Error(`Expected a Windows PE executable (MZ): ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeVersionForFilename(value) {
  const safe = String(value)
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`Version cannot be represented in a filename: ${value}`);
  return safe;
}

function createShellManifest(version, extra = {}) {
  if (!String(version || "").trim()) throw new Error("Shell version is required.");
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    kind: SHELL_KIND,
    platform: "windows",
    arch: "x64",
    version: String(version),
    entrypoint: DESKTOP_ENTRYPOINT,
    requiredCore: {
      kind: CORE_KIND,
      manifest: CORE_MANIFEST_NAME,
      entrypoint: CORE_ENTRYPOINT,
    },
    ...extra,
  };
}

function prepareShellTree(rootDir, version, extra = {}) {
  const root = path.resolve(rootDir);
  const desktopEntrypoint = path.join(root, DESKTOP_ENTRYPOINT);
  if (!fs.existsSync(desktopEntrypoint)) {
    throw new Error(`Desktop shell entrypoint is missing: ${desktopEntrypoint}`);
  }
  const coreEntrypoint = path.join(root, ...CORE_ENTRYPOINT.split("/"));
  const nonWindowsCoreEntrypoint = path.join(
    root,
    ...NON_WINDOWS_CORE_ENTRYPOINT.split("/"),
  );
  fs.rmSync(coreEntrypoint, { force: true });
  fs.rmSync(nonWindowsCoreEntrypoint, { force: true });
  writeJson(path.join(root, SHELL_MANIFEST_NAME), createShellManifest(version, extra));
  return validateShellTree(root);
}

function validateBaseManifest(manifest, expectedKind, manifestPath) {
  if (manifest.schemaVersion !== COMPONENT_SCHEMA_VERSION) {
    throw new Error(`${manifestPath} has unsupported schemaVersion.`);
  }
  if (manifest.kind !== expectedKind) {
    throw new Error(`${manifestPath} has unexpected kind: ${manifest.kind}`);
  }
  if (manifest.platform !== "windows" || manifest.arch !== "x64") {
    throw new Error(`${manifestPath} must target windows-x64.`);
  }
  if (!String(manifest.version || "").trim()) {
    throw new Error(`${manifestPath} is missing version.`);
  }
}

function validateShellTree(rootDir, { requireCoreAbsent = true } = {}) {
  const root = path.resolve(rootDir);
  walkFiles(root);
  const manifestPath = path.join(root, SHELL_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error(`Shell manifest is missing: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  validateBaseManifest(manifest, SHELL_KIND, manifestPath);
  if (manifest.entrypoint !== DESKTOP_ENTRYPOINT) {
    throw new Error(`Shell manifest entrypoint must be ${DESKTOP_ENTRYPOINT}.`);
  }
  if (!String(manifest.sourcePackageVersion || "").trim()) {
    throw new Error("Shell manifest is missing sourcePackageVersion.");
  }
  const hasSourceIdentity = [
    "sourceGitSha",
    "sourceBranch",
    "productionEligible",
  ].some((key) => Object.hasOwn(manifest, key));
  if (hasSourceIdentity) {
    if (!/^[0-9a-f]{40}$/.test(manifest.sourceGitSha || "")) {
      throw new Error("Shell manifest has an invalid sourceGitSha.");
    }
    if (!String(manifest.sourceBranch || "").trim()) {
      throw new Error("Shell manifest has an invalid sourceBranch.");
    }
    if (typeof manifest.productionEligible !== "boolean") {
      throw new Error("Shell manifest has an invalid productionEligible value.");
    }
    if (
      manifest.productionEligible &&
      (!/^[0-9a-f]{40}$/.test(manifest.sourceRemoteSha || "") ||
        manifest.sourceRemoteSha !== manifest.sourceGitSha)
    ) {
      throw new Error("Production Shell source is not bound to its remote commit.");
    }
  }
  if (
    manifest.requiredCore?.kind !== CORE_KIND ||
    manifest.requiredCore?.manifest !== CORE_MANIFEST_NAME ||
    manifest.requiredCore?.entrypoint !== CORE_ENTRYPOINT
  ) {
    throw new Error("Shell manifest has an invalid requiredCore contract.");
  }
  if (!fs.existsSync(path.join(root, DESKTOP_ENTRYPOINT))) {
    throw new Error(`Shell entrypoint is missing: ${DESKTOP_ENTRYPOINT}`);
  }
  const bundledCore = path.join(root, ...CORE_ENTRYPOINT.split("/"));
  if (requireCoreAbsent && fs.existsSync(bundledCore)) {
    throw new Error(`Shell must not contain ${CORE_ENTRYPOINT}.`);
  }
  const bundledNonWindowsCore = path.join(
    root,
    ...NON_WINDOWS_CORE_ENTRYPOINT.split("/"),
  );
  if (requireCoreAbsent && fs.existsSync(bundledNonWindowsCore)) {
    throw new Error(`Windows Shell must not contain ${NON_WINDOWS_CORE_ENTRYPOINT}.`);
  }
  return { manifest, root };
}

function createCoreManifest(version, executablePath, binaryVersion = null) {
  const stat = fs.statSync(executablePath);
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    kind: CORE_KIND,
    platform: "windows",
    arch: "x64",
    version: String(version),
    entrypoint: CORE_ENTRYPOINT,
    binaryVersion,
    files: [
      {
        path: CORE_ENTRYPOINT,
        size: stat.size,
        sha256: sha256File(executablePath),
      },
    ],
  };
}

function validateCorePayload(rootDir, { requireExactFiles = true } = {}) {
  const root = path.resolve(rootDir);
  const files = walkFiles(root);
  if (requireExactFiles) {
    const actual = files.map(normalizedPathKey).sort();
    const expected = [...CORE_ALLOWED_FILES].map(normalizedPathKey).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Core component file allowlist mismatch. Expected ${expected.join(", ")}; got ${actual.join(", ")}.`,
      );
    }
  }

  const manifestPath = path.join(root, CORE_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) throw new Error(`Core manifest is missing: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  validateBaseManifest(manifest, CORE_KIND, manifestPath);
  if (manifest.entrypoint !== CORE_ENTRYPOINT) {
    throw new Error(`Core manifest entrypoint must be ${CORE_ENTRYPOINT}.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) {
    throw new Error("Core manifest must describe exactly one payload file.");
  }
  const record = manifest.files[0];
  if (record.path !== CORE_ENTRYPOINT || !/^[0-9a-f]{64}$/.test(record.sha256 || "")) {
    throw new Error("Core manifest payload record is invalid.");
  }

  const executablePath = path.join(root, ...CORE_ENTRYPOINT.split("/"));
  if (!fs.existsSync(executablePath)) throw new Error(`Core executable is missing: ${CORE_ENTRYPOINT}`);
  assertPeExecutable(executablePath);
  const stat = fs.statSync(executablePath);
  if (record.size !== stat.size) throw new Error("Core executable size does not match its manifest.");
  if (record.sha256 !== sha256File(executablePath)) {
    throw new Error("Core executable SHA256 does not match its manifest.");
  }
  return { executablePath, files, manifest, root };
}

function createCompositionManifest(shellManifest, coreManifest) {
  const coreRecord = coreManifest.files[0];
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    kind: COMPOSITION_KIND,
    platform: "windows",
    arch: "x64",
    version: `${shellManifest.version}+core.${coreManifest.version}`,
    entrypoint: DESKTOP_ENTRYPOINT,
    shell: {
      version: shellManifest.version,
      manifest: SHELL_MANIFEST_NAME,
    },
    core: {
      version: coreManifest.version,
      manifest: CORE_MANIFEST_NAME,
      entrypoint: CORE_ENTRYPOINT,
      size: coreRecord.size,
      sha256: coreRecord.sha256,
    },
  };
}

function validateCompositeTree(rootDir) {
  const root = path.resolve(rootDir);
  const shell = validateShellTree(root, { requireCoreAbsent: false });
  const core = validateCorePayload(root, { requireExactFiles: false });
  const manifestPath = path.join(root, COMPOSITION_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Composition manifest is missing: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  validateBaseManifest(manifest, COMPOSITION_KIND, manifestPath);
  const expected = createCompositionManifest(shell.manifest, core.manifest);
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error("Composition manifest does not match the installed Shell and Core.");
  }
  return { core, manifest, root, shell };
}

function copyDirectory(sourceDir, destinationDir) {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link: ${sourcePath}`);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new Error(`Refusing to copy unsupported filesystem entry: ${sourcePath}`);
  }
}

module.exports = {
  COMPONENT_SCHEMA_VERSION,
  COMPOSITION_KIND,
  COMPOSITION_MANIFEST_NAME,
  CORE_ALLOWED_FILES,
  CORE_ENTRYPOINT,
  CORE_KIND,
  CORE_MANIFEST_NAME,
  DESKTOP_ENTRYPOINT,
  SHELL_KIND,
  SHELL_MANIFEST_NAME,
  assertPeExecutable,
  copyDirectory,
  createCompositionManifest,
  createCoreManifest,
  createShellManifest,
  createZip,
  ensureEmptyDirectory,
  extractArchiveSafely,
  listArchiveEntries,
  normalizeRelativePath,
  prepareShellTree,
  readJson,
  sanitizeVersionForFilename,
  sha256File,
  validateCompositeTree,
  validateCorePayload,
  validateShellTree,
  walkFiles,
  withMaterializedComponent,
  writeJson,
};
