const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse } = require("acorn");

const {
  COMPOSITION_MANIFEST_NAME,
  CORE_ALLOWED_FILES,
  CORE_ENTRYPOINT,
  CORE_MANIFEST_NAME,
  SHELL_MANIFEST_NAME,
  createCoreManifest,
  createZip,
  extractArchiveSafely,
  listArchiveEntries,
  prepareShellTree,
  validateCompositeTree,
  validateCorePayload,
  validateShellTree,
  writeJson,
} = require("../windows-component-util");
const { getSyncCacheDir, parseSyncOptions, refreshCachedArchive } = require("../sync-upstream");
const { PATCHES, getPassArgs } = require("../patch-all");
const { collectPatches: collectFastModePatches } = require("../patch-fast-mode");
const { patchModelFilterSource } = require("../patch-model-list-filter");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

test("maintained Shell patch chain is minimal and strict by default", () => {
  assert.deepEqual(PATCHES, [
    "patch-i18n.js",
    "patch-fast-mode.js",
    "patch-model-list-filter.js",
    "patch-plugin-auth.js",
    "patch-updater.js",
  ]);
  assert.deepEqual(getPassArgs(["win"]), ["win", "--require-change"]);
  assert.deepEqual(getPassArgs(["win", "--check"]), [
    "win",
    "--check",
    "--require-change",
  ]);
  assert.deepEqual(getPassArgs(["win", "--allow-noop"]), ["win"]);
});

test("Fast mode patch covers negative and positive ChatGPT auth gates", () => {
  const source = [
    'function read(n,e){e.query.setData("key",{authMethod:n});if(n!=="chatgpt")return false;return {fast_mode:true}}',
    'function allowed(a){let enabled=a?.authMethod==="chatgpt";return enabled&&a.fast_mode}',
  ].join(";");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const patches = collectFastModePatches(ast, source);
  assert.deepEqual(
    patches.map((patch) => ({ original: patch.original, replacement: patch.replacement })),
    [
      { original: 'n!=="chatgpt"', replacement: "!1" },
      { original: 'a?.authMethod==="chatgpt"', replacement: "!0" },
    ],
  );
});

test("model filter patch survives chunk renames and minified identifier changes", () => {
  for (const original of [
    "function old(){if(u?n.has(r.model):!r.hidden){return r}}",
    "function current(){if(l?t.has(n.model):!n.hidden){return n}}",
  ]) {
    const patched = patchModelFilterSource(original);
    assert.equal(patched.changed, true);
    assert.match(patched.source, /if\(![rn]\.hidden\|\|[ul]&&[nt]\.has\([rn]\.model\)\)\{/);
    assert.equal(patchModelFilterSource(patched.source).changed, false);
  }
  assert.throws(
    () => patchModelFilterSource("const unrelated = true"),
    /Expected one unpatched model filter/,
  );
});

function runScript(scriptName, args) {
  return execFileSync(process.execPath, [path.join(PROJECT_ROOT, "scripts", scriptName), ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function writeFakePe(filePath, label) {
  fs.writeFileSync(filePath, Buffer.from(`MZ-${label}`, "utf8"));
}

function createShellFixture(root, version = "26.707.31428") {
  fs.mkdirSync(path.join(root, "resources"), { recursive: true });
  writeFakePe(path.join(root, "Codex.exe"), "desktop-shell");
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "fixture-asar", "utf8");
  writeFakePe(path.join(root, ...CORE_ENTRYPOINT.split("/")), "old-core");
  prepareShellTree(root, version, { sourcePackageVersion: "26.707.3748.0" });
}

test("refresh-download and isolated cache-key options are deterministic", (t) => {
  const options = parseSyncOptions([
    "--force",
    "--skip-mac",
    "--refresh-download",
    "--cache-key",
    "latest-26.707.31428",
  ]);
  assert.deepEqual(options, {
    force: true,
    checkOnly: false,
    skipMac: true,
    skipWin: false,
    refreshDownload: true,
    cacheKey: "latest-26.707.31428",
    macLock: null,
  });
  assert.equal(
    getSyncCacheDir(options.cacheKey, "C:\\Temp"),
    path.join("C:\\Temp", "codex-sync", "latest-26.707.31428"),
  );
  assert.throws(() => parseSyncOptions(["--cache-key", "..\\escape"]), /cache-key may contain/);
  assert.throws(() => parseSyncOptions(["--cache-key"]), /requires a value/);
  assert.throws(() => parseSyncOptions(["--mac-lock", "..\\escape.json"]), /forward-slash/);
  assert.throws(() => parseSyncOptions(["--mac-lock"]), /requires a repository-relative/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-options-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const selectedCache = getSyncCacheDir("selected", temp);
  const otherCache = getSyncCacheDir("other", temp);
  fs.mkdirSync(selectedCache, { recursive: true });
  fs.mkdirSync(otherCache, { recursive: true });
  const selectedArchive = path.join(selectedCache, "OpenAI.Codex.msix");
  const otherArchive = path.join(otherCache, "OpenAI.Codex.msix");
  fs.writeFileSync(selectedArchive, "stale", "utf8");
  fs.writeFileSync(otherArchive, "preserve", "utf8");
  assert.equal(refreshCachedArchive(selectedArchive, true), true);
  assert.equal(fs.existsSync(selectedArchive), false);
  assert.equal(fs.existsSync(otherArchive), true);
  assert.equal(refreshCachedArchive(otherArchive, false), false);
});

test("build CLI rejects an unsupported artifact before reading generated sources", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(PROJECT_ROOT, "scripts", "build-from-upstream.js"), "--platform", "win", "--artifact", "invalid"],
    { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /--artifact must be shell or composite/);
});

test("legacy Windows build still defaults to the composite artifact", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["build:win-x64"],
    "node scripts/build-from-upstream.js --platform win",
  );
  const buildSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts", "build-from-upstream.js"),
    "utf8",
  );
  assert.match(buildSource, /artifactIdx !== -1 \? args\[artifactIdx \+ 1\] : "composite"/);
});

test("Shell, Core, and test composition obey the two-layer contract", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-components-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const shellTree = path.join(temp, "shell tree");
  fs.mkdirSync(shellTree, { recursive: true });
  createShellFixture(shellTree);
  const shell = validateShellTree(shellTree);
  assert.equal(shell.manifest.version, "26.707.31428");
  assert.equal(shell.manifest.sourcePackageVersion, "26.707.3748.0");
  assert.equal(fs.existsSync(path.join(shellTree, ...CORE_ENTRYPOINT.split("/"))), false);

  const shellZip = path.join(temp, "Codex-Desktop-Shell-win-x64-26.707.31428.zip");
  createZip(shellTree, shellZip);
  const shellEntries = listArchiveEntries(shellZip)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.path.toLowerCase());
  assert(shellEntries.includes(SHELL_MANIFEST_NAME));
  assert(!shellEntries.includes(CORE_ENTRYPOINT));

  const coreZip = path.join(temp, "Codex-Core-win-x64-test-core-1.zip");
  const fakeCore = path.join(temp, "fake-codex.exe");
  writeFakePe(fakeCore, "new-core");
  runScript("package-windows-core.js", [
    "--input",
    fakeCore,
    "--core-version",
    "test-core-1",
    "--output",
    coreZip,
  ]);
  const coreFiles = listArchiveEntries(coreZip)
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.path.toLowerCase())
    .sort();
  assert.deepEqual(coreFiles, [...CORE_ALLOWED_FILES].map((value) => value.toLowerCase()).sort());

  const compositeZip = path.join(temp, "Codex-win-x64-component-test.zip");
  runScript("compose-windows-runtime.js", [
    "--shell",
    shellZip,
    "--core",
    coreZip,
    "--output",
    compositeZip,
  ]);
  const compositeTree = path.join(temp, "composite");
  extractArchiveSafely(compositeZip, compositeTree);
  const composite = validateCompositeTree(compositeTree);
  assert.equal(composite.shell.manifest.version, "26.707.31428");
  assert.equal(composite.core.manifest.version, "test-core-1");
  assert(fs.existsSync(path.join(compositeTree, ...CORE_ENTRYPOINT.split("/"))));
  assert(fs.existsSync(path.join(compositeTree, COMPOSITION_MANIFEST_NAME)));

  const verifyOutput = runScript("verify-windows-components.js", [
    "--shell",
    shellZip,
    "--core",
    coreZip,
    "--composite",
    compositeZip,
  ]);
  const report = JSON.parse(verifyOutput);
  assert.equal(report.status, "passed");
  assert.equal(report.shell.sourcePackageVersion, "26.707.3748.0");
  assert.equal(report.core.fileCount, 2);
  assert.equal(report.composite.coreVersion, "test-core-1");

  const manifestPath = path.join(temp, "runtime-components-dev.json");
  const manifestArgs = [
    "--channel",
    "dev",
    "--minimum-client-version",
    "0.1.75",
    "--published-at",
    "2026-07-12T00:00:00Z",
    "--shell",
    shellZip,
    "--shell-url",
    "https://download.agentrouter.top/codex/runtime/components/shell/26.707.31428/Codex-Desktop-Shell-win-x64-26.707.31428.zip",
    "--core",
    coreZip,
    "--core-url",
    "https://download.agentrouter.top/codex/runtime/components/core/test-core-1/Codex-Core-win-x64-test-core-1.zip",
    "--compatible-shell-version",
    "26.707.31428",
    "--core-upstream-git-sha",
    "a".repeat(40),
    "--output",
    manifestPath,
  ];
  runScript("generate-runtime-components-manifest.js", manifestArgs);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.channel, "dev");
  assert.equal(manifest.compositions[0].shell.version, "26.707.31428");
  assert.equal(manifest.compositions[0].core.version, "test-core-1");
  assert.equal(manifest.compositions[0].minimumClientVersion, "0.1.75");
  assert.equal(
    manifest.compositions[0].shell.artifact.url,
    "https://download.agentrouter.top/codex/runtime/components/shell/26.707.31428/Codex-Desktop-Shell-win-x64-26.707.31428.zip",
  );
  assert.equal(
    manifest.compositions[0].core.artifact.url,
    "https://download.agentrouter.top/codex/runtime/components/core/test-core-1/Codex-Core-win-x64-test-core-1.zip",
  );
  assert.equal(manifest.compositions[0].shell.artifact.sourceId, "source-agentrouter-download");
  assert.equal(manifest.compositions[0].core.artifact.sourceId, "source-agentrouter-download");
  assert.equal(Object.hasOwn(manifest.compositions[0].shell.artifact, "mirrors"), false);
  assert.equal(Object.hasOwn(manifest.compositions[0].core.artifact, "mirrors"), false);

  const invalidCases = [
    {
      name: "third-party host",
      option: "--shell-url",
      value: "https://example.com/codex/runtime/components/shell/version/shell.zip",
      error: /shell URL host must be download\.agentrouter\.top/,
    },
    {
      name: "wrong component path",
      option: "--shell-url",
      value: "https://download.agentrouter.top/codex/runtime/components/core/version/shell.zip",
      error: /shell URL path must be under \/codex\/runtime\/components\/shell\//,
    },
    {
      name: "query string",
      option: "--core-url",
      value:
        "https://download.agentrouter.top/codex/runtime/components/core/version/core.zip?download=1",
      error: /core URL must not contain a query or fragment/,
    },
    {
      name: "fragment",
      option: "--core-url",
      value: "https://download.agentrouter.top/codex/runtime/components/core/version/core.zip#asset",
      error: /core URL must not contain a query or fragment/,
    },
    {
      name: "userinfo",
      option: "--shell-url",
      value:
        "https://user:password@download.agentrouter.top/codex/runtime/components/shell/version/shell.zip",
      error: /shell URL must not contain userinfo/,
    },
    {
      name: "non-standard port",
      option: "--core-url",
      value: "https://download.agentrouter.top:8443/codex/runtime/components/core/version/core.zip",
      error: /core URL must use port 443/,
    },
    {
      name: "plain HTTP",
      option: "--shell-url",
      value: "http://download.agentrouter.top/codex/runtime/components/shell/version/shell.zip",
      error: /shell URL must use HTTPS/,
    },
  ];
  for (const invalidCase of invalidCases) {
    const args = [...manifestArgs];
    args[args.indexOf(invalidCase.option) + 1] = invalidCase.value;
    const result = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, "scripts", "generate-runtime-components-manifest.js"), ...args],
      { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1, invalidCase.name);
    assert.match(`${result.stdout}${result.stderr}`, invalidCase.error, invalidCase.name);
  }

  for (const mirrorOption of [
    "--shell-mirror-url",
    "--regional-mirror-url",
    "--core-mirror-url=https://download.agentrouter.top/core.zip",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(PROJECT_ROOT, "scripts", "generate-runtime-components-manifest.js"),
        ...manifestArgs,
        mirrorOption,
        ...(mirrorOption.includes("=")
          ? []
          : ["https://download.agentrouter.top/codex/runtime/components/shell/mirror/shell.zip"]),
      ],
      { cwd: PROJECT_ROOT, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1, mirrorOption);
    assert.match(`${result.stdout}${result.stderr}`, /is not supported; Runtime components use one official source/);
  }
});

test("Core verification rejects any file outside the first-version allowlist", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-core-negative-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const executable = path.join(temp, ...CORE_ENTRYPOINT.split("/"));
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  writeFakePe(executable, "negative-core");
  writeJson(path.join(temp, CORE_MANIFEST_NAME), createCoreManifest("test-core", executable, process.version));
  fs.writeFileSync(path.join(temp, "unexpected.txt"), "not allowed", "utf8");
  assert.throws(() => validateCorePayload(temp), /allowlist mismatch/);
});
