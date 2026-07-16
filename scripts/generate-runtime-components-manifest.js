#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  CORE_MANIFEST_NAME,
  SHELL_MANIFEST_NAME,
  readJson,
  sha256File,
  validateCorePayload,
  validateShellTree,
  withMaterializedComponent,
  writeJson,
} = require("./windows-component-util");

const OFFICIAL_RUNTIME_HOST = "download.agentrouter.top";
const OFFICIAL_RUNTIME_SOURCE_ID = "source-agentrouter-download";

function option(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  const value = index === -1 ? null : args[index + 1];
  if ((index !== -1 && (!value || value.startsWith("--"))) || (required && !value)) {
    throw new Error(`${name} ${required ? "is required" : "requires a value"}.`);
  }
  return value;
}

function assertOfficialComponentUrl(value, componentKind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${componentKind} URL must be a valid absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${componentKind} URL must use HTTPS.`);
  if (url.hostname !== OFFICIAL_RUNTIME_HOST) {
    throw new Error(`${componentKind} URL host must be ${OFFICIAL_RUNTIME_HOST}.`);
  }
  if (url.port && url.port !== "443") {
    throw new Error(`${componentKind} URL must use port 443.`);
  }
  if (url.username || url.password) {
    throw new Error(`${componentKind} URL must not contain userinfo.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${componentKind} URL must not contain a query or fragment.`);
  }
  const expectedPrefix = `/codex/runtime/components/${componentKind}/`;
  if (!url.pathname.startsWith(expectedPrefix) || url.pathname === expectedPrefix) {
    throw new Error(`${componentKind} URL path must be under ${expectedPrefix}.`);
  }
  return url.toString();
}

function rejectMirrorUrlOptions(args) {
  const mirrorOption = args.find((arg) => /^--.*-mirror-url(?:=|$)/.test(arg));
  if (mirrorOption) {
    throw new Error(`${mirrorOption} is not supported; Runtime components use one official source.`);
  }
}

function assertGitSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value || "")) {
    throw new Error("Core upstream Git SHA must be 40 lowercase hexadecimal characters.");
  }
  return value;
}

function readComponent(input, validator, manifestName) {
  return withMaterializedComponent(input, (root) => {
    const validated = validator(root);
    return {
      manifest: readJson(path.join(root, manifestName)),
      validated,
    };
  });
}

function artifact(archivePath, url, componentKind) {
  const archive = path.resolve(archivePath);
  return {
    name: path.basename(archive),
    url: assertOfficialComponentUrl(url, componentKind),
    sourceId: OFFICIAL_RUNTIME_SOURCE_ID,
    size: fs.statSync(archive).size,
    sha256: sha256File(archive),
  };
}

function main() {
  const args = process.argv.slice(2);
  rejectMirrorUrlOptions(args);
  const shellPath = path.resolve(option(args, "--shell", { required: true }));
  const corePath = path.resolve(option(args, "--core", { required: true }));
  const shellUrl = option(args, "--shell-url", { required: true });
  const coreUrl = option(args, "--core-url", { required: true });
  const output = path.resolve(option(args, "--output", { required: true }));
  const minimumClientVersion = option(args, "--minimum-client-version", { required: true });
  const publishedAt = option(args, "--published-at", { required: true });
  const channel = option(args, "--channel") || "dev";
  if (!new Set(["dev", "release"]).has(channel)) throw new Error("--channel must be dev or release.");
  if (!/^\d+\.\d+\.\d+$/.test(minimumClientVersion)) {
    throw new Error("--minimum-client-version must be a numeric dotted version.");
  }
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error("--published-at must be RFC3339.");

  const shell = readComponent(shellPath, validateShellTree, SHELL_MANIFEST_NAME);
  const core = readComponent(corePath, validateCorePayload, CORE_MANIFEST_NAME);
  const compatibleShellVersions = Array.isArray(core.manifest.compatibleShellVersions)
    ? core.manifest.compatibleShellVersions
    : option(args, "--compatible-shell-version")
      ? [option(args, "--compatible-shell-version")]
      : [];
  if (!compatibleShellVersions.includes(shell.manifest.version)) {
    throw new Error(`Core ${core.manifest.version} is not compatible with Shell ${shell.manifest.version}.`);
  }
  const upstreamGitSha = assertGitSha(
    core.manifest.upstreamGitSha || option(args, "--core-upstream-git-sha", { required: true }),
  );
  const coreFile = core.manifest.files[0];
  const shellArtifact = artifact(shellPath, shellUrl, "shell");
  const coreArtifact = artifact(corePath, coreUrl, "core");
  const id = `windows-x64.shell-${shell.manifest.version}.core-${core.manifest.version}`;
  const manifest = {
    schemaVersion: 2,
    channel,
    compositions: [
      {
        id,
        platformKey: "windows-x64",
        publishedAt,
        minimumClientVersion,
        shell: {
          version: shell.manifest.version,
          sourcePackageVersion: shell.manifest.sourcePackageVersion || null,
          entrypoint: shell.manifest.entrypoint,
          artifact: shellArtifact,
        },
        core: {
          version: core.manifest.version,
          upstreamGitSha,
          payloadPath: core.manifest.entrypoint,
          targetPath: core.manifest.entrypoint,
          fileSha256: coreFile.sha256,
          compatibleShellVersions,
          artifact: coreArtifact,
        },
      },
    ],
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJson(output, manifest);
  console.log(JSON.stringify({ output, compositionId: id, shell: shellArtifact, core: coreArtifact }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[x] ${error.message}`);
  process.exit(1);
}
