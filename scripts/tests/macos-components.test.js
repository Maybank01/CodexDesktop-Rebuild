const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BUNDLED_CORE_ENTRYPOINT,
  DESKTOP_ENTRYPOINT,
  prepareMacShellTree,
  resolveMacExtractDirectory,
  validateMacShellTree,
} = require("../macos-component-util");

test("resolves the same isolated sync cache selected by the workflow", () => {
  assert.equal(
    resolveMacExtractDirectory("/tmp", "macos-arm64-123", "arm64"),
    path.resolve("/tmp", "codex-sync", "macos-arm64-123", "arm64-extract"),
  );
  assert.equal(
    resolveMacExtractDirectory("/tmp", null, "x64"),
    path.resolve("/tmp", "codex-sync", "x64-extract"),
  );
});

function createFakeApp(root) {
  const entrypoint = path.join(root, ...DESKTOP_ENTRYPOINT.split("/"));
  const core = path.join(root, ...BUNDLED_CORE_ENTRYPOINT.split("/"));
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(core), { recursive: true });
  fs.writeFileSync(entrypoint, "shell");
  fs.writeFileSync(core, "core");
}

test("prepares a macOS Shell with external Core activation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-mac-shell-test-"));
  try {
    createFakeApp(root);
    const prepared = prepareMacShellTree(root, "26.707.91948", "arm64", {
      sourceBuildVersion: "91948",
    });
    assert.equal(prepared.manifest.requiredCore.mode, "external");
    assert.equal(prepared.manifest.requiredCore.environmentVariable, "CODEX_CLI_PATH");
    assert.equal(fs.existsSync(path.join(root, ...BUNDLED_CORE_ENTRYPOINT.split("/"))), false);
    assert.deepEqual(validateMacShellTree(root).manifest, prepared.manifest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a Shell that regains a bundled Core", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-mac-shell-test-"));
  try {
    createFakeApp(root);
    prepareMacShellTree(root, "26.707.91948", "x64");
    const core = path.join(root, ...BUNDLED_CORE_ENTRYPOINT.split("/"));
    fs.mkdirSync(path.dirname(core), { recursive: true });
    fs.writeFileSync(core, "unexpected-core");
    assert.throws(() => validateMacShellTree(root), /must not contain/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
