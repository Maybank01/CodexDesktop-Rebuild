#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  CORE_ENTRYPOINT,
  CORE_ALLOWED_FILES,
  CORE_MANIFEST_NAME,
  assertPeExecutable,
  createCoreManifest,
  createZip,
  listArchiveEntries,
  sanitizeVersionForFilename,
  validateCorePayload,
  writeJson,
} = require("./windows-component-util");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function readBinaryVersion(executablePath) {
  try {
    const output = execFileSync(executablePath, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!output) throw new Error("empty version output");
    return output.split(/\r?\n/, 1)[0].trim();
  } catch (error) {
    throw new Error(`Failed to read Core binary version: ${error.message}`);
  }
}

function versionFromBinaryOutput(binaryVersion) {
  return binaryVersion.replace(/^codex-cli\s+/i, "").trim();
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const input = path.resolve(
    readOption(args, "--input") || path.join(PROJECT_ROOT, "src", "win", "codex.exe"),
  );
  if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
    throw new Error(`Core executable not found: ${input}`);
  }
  assertPeExecutable(input);

  const explicitVersion = readOption(args, "--core-version");
  const binaryVersion = explicitVersion ? null : readBinaryVersion(input);
  const version = String(explicitVersion || versionFromBinaryOutput(binaryVersion)).trim();
  if (!version) throw new Error("Core version is empty.");

  const output = path.resolve(
    readOption(args, "--output") ||
      path.join(
        PROJECT_ROOT,
        "out",
        `Codex-Core-win-x64-${sanitizeVersionForFilename(version)}.zip`,
      ),
  );
  if (output.toLowerCase() === input.toLowerCase()) {
    throw new Error("Core output must not overwrite the input executable.");
  }

  const tempBase = path.resolve(
    readOption(args, "--temp-dir") || path.join(PROJECT_ROOT, "out", ".component-work"),
  );
  fs.mkdirSync(tempBase, { recursive: true });
  const stage = fs.mkdtempSync(path.join(tempBase, "agentrouter-core-package-"));
  try {
    const stagedExecutable = path.join(stage, ...CORE_ENTRYPOINT.split("/"));
    fs.mkdirSync(path.dirname(stagedExecutable), { recursive: true });
    fs.copyFileSync(input, stagedExecutable);
    const manifest = createCoreManifest(version, stagedExecutable, binaryVersion);
    writeJson(path.join(stage, CORE_MANIFEST_NAME), manifest);
    validateCorePayload(stage);
    const result = createZip(stage, output, { force });
    const archiveFiles = listArchiveEntries(output)
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path.toLowerCase())
      .sort();
    const expectedFiles = [...CORE_ALLOWED_FILES].map((entry) => entry.toLowerCase()).sort();
    if (JSON.stringify(archiveFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error("Created Core archive violates the component file allowlist.");
    }
    console.log(`Core package: ${result.outputPath}`);
    console.log(`Core version: ${version}`);
    if (binaryVersion) console.log(`Core binary: ${binaryVersion}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[x] ${error.message}`);
  process.exit(1);
}
