#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  COMPOSITION_MANIFEST_NAME,
  CORE_ENTRYPOINT,
  CORE_MANIFEST_NAME,
  copyDirectory,
  createCompositionManifest,
  createZip,
  extractArchiveSafely,
  sanitizeVersionForFilename,
  validateCompositeTree,
  validateCorePayload,
  validateShellTree,
  withMaterializedComponent,
  writeJson,
} = require("./windows-component-util");

const PROJECT_ROOT = path.resolve(__dirname, "..");

function readRequiredOption(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? null : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function materializeShell(shellInput, stage) {
  const resolved = path.resolve(shellInput);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) copyDirectory(resolved, stage);
  else if (stat.isFile()) extractArchiveSafely(resolved, stage);
  else throw new Error(`Shell input is neither a file nor directory: ${resolved}`);
}

function main() {
  const args = process.argv.slice(2);
  const shellInput = readRequiredOption(args, "--shell");
  const coreInput = readRequiredOption(args, "--core");
  const force = args.includes("--force");
  const requestedOutput = readOption(args, "--output");
  const tempBase = path.resolve(
    readOption(args, "--temp-dir") || path.join(PROJECT_ROOT, "out", ".component-work"),
  );
  fs.mkdirSync(tempBase, { recursive: true });
  process.env.CODEX_COMPONENT_TEMP_DIR = tempBase;

  const stage = fs.mkdtempSync(path.join(tempBase, "agentrouter-composition-"));
  try {
    materializeShell(shellInput, stage);
    const shell = validateShellTree(stage);

    const core = withMaterializedComponent(coreInput, (coreRoot) => {
      const validated = validateCorePayload(coreRoot);
      const coreDestination = path.join(stage, ...CORE_ENTRYPOINT.split("/"));
      fs.mkdirSync(path.dirname(coreDestination), { recursive: true });
      fs.copyFileSync(validated.executablePath, coreDestination);
      fs.copyFileSync(
        path.join(validated.root, CORE_MANIFEST_NAME),
        path.join(stage, CORE_MANIFEST_NAME),
      );
      return validated;
    });

    const composition = createCompositionManifest(shell.manifest, core.manifest);
    writeJson(path.join(stage, COMPOSITION_MANIFEST_NAME), composition);
    validateCompositeTree(stage);

    const output = path.resolve(
      requestedOutput ||
        path.join(
          PROJECT_ROOT,
          "out",
          `Codex-win-x64-${sanitizeVersionForFilename(shell.manifest.version)}-core-${sanitizeVersionForFilename(core.manifest.version)}.zip`,
        ),
    );
    const protectedInputs = [shellInput, coreInput].map((value) => path.resolve(value).toLowerCase());
    if (protectedInputs.includes(output.toLowerCase())) {
      throw new Error("Composite output must not overwrite a Shell or Core input.");
    }
    const result = createZip(stage, output, { force });
    console.log(`Composite package: ${result.outputPath}`);
    console.log(`Shell version: ${shell.manifest.version}`);
    console.log(`Core version: ${core.manifest.version}`);
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
