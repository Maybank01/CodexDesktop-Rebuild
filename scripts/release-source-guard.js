const { execFileSync } = require("child_process");

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function normalizeRemoteUrl(value) {
  let normalized = String(value || "").trim().replaceAll("\\", "/");
  if (normalized.startsWith("git@github.com:")) {
    normalized = `https://github.com/${normalized.slice("git@github.com:".length)}`;
  }
  if (normalized.startsWith("ssh://git@github.com/")) {
    normalized = `https://github.com/${normalized.slice("ssh://git@github.com/".length)}`;
  }
  return normalized.replace(/\/$/, "").replace(/\.git$/, "").toLowerCase();
}

function verifyReleaseSource({
  root,
  developmentEvidence = false,
  expectedBranch = "agent/runtime-components-v2",
  remote = "fork",
  expectedRemoteUrl = "https://github.com/Maybank01/CodexDesktop-Rebuild.git",
}) {
  const sourceGitSha = git(root, ["rev-parse", "HEAD"]);
  const actualBranch = git(root, ["branch", "--show-current"]);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const sourceDirty = Boolean(status);
  const sourceBranch = actualBranch || "<detached>";
  const identity = {
    sourceGitSha,
    sourceBranch,
    releaseBranch: expectedBranch,
    sourceRemote: remote,
    sourceRemoteSha: null,
    sourceDirty,
    productionEligible: false,
  };
  if (developmentEvidence) return identity;
  if (sourceDirty) {
    throw new Error(`Release Shell source must be clean; first change: ${status.split(/\r?\n/)[0]}`);
  }
  if (actualBranch && actualBranch !== expectedBranch) {
    throw new Error(`Release Shell branch must be ${expectedBranch}; got ${actualBranch}`);
  }
  const actualRemoteUrl = git(root, ["remote", "get-url", remote]);
  if (normalizeRemoteUrl(actualRemoteUrl) !== normalizeRemoteUrl(expectedRemoteUrl)) {
    throw new Error(
      `Release Shell remote ${remote} must be ${expectedRemoteUrl}; got ${actualRemoteUrl}`,
    );
  }
  const remoteRef = `refs/heads/${expectedBranch}`;
  const remoteLine = git(root, ["ls-remote", "--heads", remote, remoteRef]);
  const match = remoteLine.match(new RegExp(`^([0-9a-f]{40})\\s+${remoteRef.replaceAll("/", "\\/")}$`));
  if (!match) throw new Error(`Release Shell remote ref ${remote}/${remoteRef} is invalid`);
  if (match[1] !== sourceGitSha) {
    throw new Error(
      `Release Shell source HEAD ${sourceGitSha} does not match pushed fixed branch ${match[1]}`,
    );
  }
  return {
    ...identity,
    sourceRemoteSha: match[1],
    productionEligible: true,
  };
}

module.exports = { normalizeRemoteUrl, verifyReleaseSource };
