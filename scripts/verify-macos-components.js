#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { validateMacShellTree } = require("./macos-component-util");

function readOption(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function main() {
  if (process.platform !== "darwin") throw new Error("macOS component verification requires macOS.");
  const shell = readOption(process.argv.slice(2), "--shell");
  if (!shell) throw new Error("Usage: verify-macos-components.js --shell <shell.zip>");
  const archive = path.resolve(shell);
  if (!fs.statSync(archive).isFile()) throw new Error(`Shell archive is missing: ${archive}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-macos-shell-verify-"));
  try {
    execFileSync("ditto", ["-x", "-k", archive, temp], { stdio: "inherit" });
    const result = validateMacShellTree(temp);
    execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", result.appBundle], {
      stdio: "inherit",
    });
    console.log(JSON.stringify({
      arch: result.manifest.arch,
      entrypoint: result.manifest.entrypoint,
      shell: archive,
      version: result.manifest.version,
    }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[x] ${error.message}`);
  process.exit(1);
}
