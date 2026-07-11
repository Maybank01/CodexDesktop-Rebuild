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

function option(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  const value = index === -1 ? null : args[index + 1];
  if ((index !== -1 && (!value || value.startsWith("--"))) || (required && !value)) {
    throw new Error(`${name} ${required ? "is required" : "requires a value"}.`);
  }
  return value;
}

function assertHttps(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return url.toString();
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

function artifact(archivePath, url, sourceId, mirrorUrl, mirrorSourceId) {
  const archive = path.resolve(archivePath);
  const result = {
    name: path.basename(archive),
    url: assertHttps(url, `${sourceId} URL`),
    sourceId,
    size: fs.statSync(archive).size,
    sha256: sha256File(archive),
    mirrors: [],
  };
  if (mirrorUrl) {
    result.mirrors.push({
      url: assertHttps(mirrorUrl, `${mirrorSourceId} URL`),
      sourceId: mirrorSourceId,
      name: mirrorSourceId,
      priority: 20,
    });
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
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
  const shellArtifact = artifact(
    shellPath,
    shellUrl,
    "github-shell-release",
    option(args, "--shell-mirror-url"),
    "agentrouter-shell-mirror",
  );
  const coreArtifact = artifact(
    corePath,
    coreUrl,
    "github-core-release",
    option(args, "--core-mirror-url"),
    "agentrouter-core-mirror",
  );
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
