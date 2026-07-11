#!/usr/bin/env node
const path = require("path");
const {
  CORE_ENTRYPOINT,
  listArchiveEntries,
  sha256File,
  validateCompositeTree,
  validateCorePayload,
  validateShellTree,
  withMaterializedComponent,
} = require("./windows-component-util");

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function archiveFileCount(input) {
  try {
    return listArchiveEntries(input).filter((entry) => !entry.isDirectory).length;
  } catch {
    return null;
  }
}

function verifyInput(input, validator) {
  return withMaterializedComponent(input, (root) => {
    const result = validator(root);
    return { result, root };
  });
}

function main() {
  const args = process.argv.slice(2);
  const tempDir = readOption(args, "--temp-dir");
  process.env.CODEX_COMPONENT_TEMP_DIR = path.resolve(
    tempDir || path.join(__dirname, "..", "out", ".component-work"),
  );
  const shellInput = readOption(args, "--shell");
  const coreInput = readOption(args, "--core");
  const compositeInput = readOption(args, "--composite");
  if (!shellInput && !coreInput && !compositeInput) {
    throw new Error("Pass at least one of --shell, --core, or --composite.");
  }

  const report = { schemaVersion: 1, status: "passed" };
  if (shellInput) {
    const verified = verifyInput(shellInput, validateShellTree);
    report.shell = {
      input: path.resolve(shellInput),
      version: verified.result.manifest.version,
      sourcePackageVersion: verified.result.manifest.sourcePackageVersion || null,
      fileCount: archiveFileCount(shellInput),
      coreAbsent: true,
    };
  }
  if (coreInput) {
    const verified = verifyInput(coreInput, validateCorePayload);
    report.core = {
      input: path.resolve(coreInput),
      version: verified.result.manifest.version,
      binaryVersion: verified.result.manifest.binaryVersion,
      fileCount: archiveFileCount(coreInput) ?? verified.result.files.length,
      sha256: verified.result.manifest.files[0].sha256,
    };
  }
  if (compositeInput) {
    report.composite = withMaterializedComponent(compositeInput, (root) => {
      const verified = validateCompositeTree(root);
      const executable = path.join(root, ...CORE_ENTRYPOINT.split("/"));
      return {
        input: path.resolve(compositeInput),
        version: verified.manifest.version,
        shellVersion: verified.shell.manifest.version,
        coreVersion: verified.core.manifest.version,
        fileCount: archiveFileCount(compositeInput),
        coreSha256: sha256File(executable),
      };
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[x] ${error.message}`);
  process.exit(1);
}
