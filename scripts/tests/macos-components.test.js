const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BUNDLED_CORE_ENTRYPOINT,
  DESKTOP_ENTRYPOINT,
  findMacDesktopApp,
  prepareMacShellTree,
  resolveMacExtractDirectory,
  validateMacShellTree,
} = require("../macos-component-util");
const { normalizeMacBundleEntrypoint } = require("../build-from-upstream");
const {
  assertMacSourceInfo,
  validateMacSourceLock,
  verifyMacSourceArchive,
} = require("../sync-upstream");

test("pins official macOS source identity, size, and SHA-256", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-mac-source-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, "fixture.zip");
  fs.writeFileSync(archive, "pinned-upstream", "utf8");
  const sha256 = require("node:crypto").createHash("sha256").update("pinned-upstream").digest("hex");
  const lock = validateMacSourceLock({
    schemaVersion: 1,
    version: "26.715.31251",
    build: "5538",
    variants: {
      arm64: {
        url: "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.715.31251.zip",
        size: fs.statSync(archive).size,
        sha256,
      },
      x64: {
        url: "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-x64-26.715.31251.zip",
        size: fs.statSync(archive).size,
        sha256,
      },
    },
  });
  const info = {
    version: lock.version,
    build: lock.build,
    url: lock.variants.arm64.url,
    size: lock.variants.arm64.size,
  };
  assert.doesNotThrow(() => assertMacSourceInfo(info, "arm64", lock));
  assert.doesNotThrow(() => verifyMacSourceArchive(archive, "arm64", lock));
  assert.throws(
    () => assertMacSourceInfo({ ...info, version: "26.715.99999" }, "arm64", lock),
    /drifted from lock/,
  );
  fs.appendFileSync(archive, "tamper", "utf8");
  assert.throws(() => verifyMacSourceArchive(archive, "arm64", lock), /size mismatch/);
});

test("normalizes the renamed upstream executable to a stable Codex entrypoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-mac-entrypoint-test-"));
  try {
    const app = path.join(root, "Codex.app");
    const executableDir = path.join(app, "Contents", "MacOS");
    fs.mkdirSync(executableDir, { recursive: true });
    fs.writeFileSync(path.join(executableDir, "ChatGPT"), "desktop-shell");
    let recordedExecutable = null;
    const result = normalizeMacBundleEntrypoint(app, {
      readExecutableName: () => "ChatGPT",
      writeExecutableName: (name) => { recordedExecutable = name; },
    });
    assert.equal(result, path.join(executableDir, "Codex"));
    assert.equal(recordedExecutable, "Codex");
    assert.equal(fs.existsSync(path.join(executableDir, "ChatGPT")), false);
    assert.equal(fs.readFileSync(result, "utf8"), "desktop-shell");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finds an upstream Desktop bundle after the Codex.app to ChatGPT.app rename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-mac-upstream-test-"));
  try {
    const renamedApp = path.join(root, "nested", "ChatGPT.app");
    const resources = path.join(renamedApp, "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "upstream-asar");
    fs.mkdirSync(path.join(root, "Decoy.app"));
    assert.equal(findMacDesktopApp(root), renamedApp);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
