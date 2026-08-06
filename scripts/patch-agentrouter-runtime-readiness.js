#!/usr/bin/env node
/**
 * Emit the AgentRouter Runtime control protocol from the Shell main process.
 *
 * The outer Client does not treat a visible Electron window as ready. It
 * waits for this ordered stream and verifies the actual Shell executable,
 * Core path, and app-server-reported version against the installed Runtime
 * composition.
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const PATCH_MARKER = "AGENTROUTER_RUNTIME_READINESS_PROTOCOL_V1";
const READY_HOOK = "__agentrouterRuntimeReadyV1";
const FAIL_HOOK = "__agentrouterRuntimeFailV1";
const COMPLETION_ANCHOR =
  "this.logger.info(`Codex CLI initialized`),this.initialized=!0,";
const FAILURE_PATTERN =
  /if\(([A-Za-z_$][\w$]*)\.error\)\{let ([A-Za-z_$][\w$]*)=Error\(`Failed to initialize Codex app-server: \$\{JSON\.stringify\(\1\.error\)\}`\);this\.rejectInitialize\?\.\(\2\)\}/gu;

const BOOTSTRAP = `/*${PATCH_MARKER}*/(()=>{if(process.env.AGENTROUTER_RUNTIME_CONTROL_PROTOCOL!==\`1\`)return;let e=process.env.AGENTROUTER_RUNTIME_LAUNCH_ID,t=process.env.AGENTROUTER_RUNTIME_SHELL_VERSION,n=process.env.CODEX_CLI_PATH;if(!e||!t||!n)return;let r=!1,i=(t,n={})=>{try{process.stdout.write(\`AGENTROUTER_RUNTIME_EVENT \${JSON.stringify({schemaVersion:1,launchId:e,type:t,...n})}\\n\`)}catch{}};globalThis.${READY_HOOK}=e=>{if(r)return;r=!0;let t=typeof e===\`string\`&&e.length>0?e:\`unknown\`;i(\`core-spawned\`,{coreVersion:t,corePath:n}),i(\`app-server-ready\`,{coreVersion:t,appServerVersion:t,corePath:n})},globalThis.${FAIL_HOOK}=e=>{i(\`startup-failed\`,{stage:e,message:\`Codex Runtime startup failed. See the Shell log for details.\`})},i(\`shell-started\`,{shellVersion:t,executablePath:process.execPath}),process.on(\`uncaughtExceptionMonitor\`,()=>globalThis.${FAIL_HOOK}?.(\`shell\`))})();`;

function count(source, value) {
  return source.split(value).length - 1;
}

function patchSource(source) {
  if (source.includes(PATCH_MARKER)) {
    const readyCount = count(source, `globalThis.${READY_HOOK}?.(`);
    const failureCount = count(source, `globalThis.${FAIL_HOOK}?.(`);
    if (readyCount !== 1 || failureCount < 1) {
      throw new Error(
        `Runtime readiness patch is incomplete; ready=${readyCount}, failure=${failureCount}.`,
      );
    }
    return { source, changed: false, matched: true };
  }

  const completionCount = count(source, COMPLETION_ANCHOR);
  if (completionCount !== 1) {
    return { source, changed: false, matched: false };
  }
  let failureCount = 0;
  const withFailure = source.replace(
    FAILURE_PATTERN,
    (match, responseName, errorName) => {
      failureCount += 1;
      return (
        `if(${responseName}.error){globalThis.${FAIL_HOOK}?.(\`app-server\`);` +
        `let ${errorName}=Error(\`Failed to initialize Codex app-server: \${JSON.stringify(${responseName}.error)}\`);` +
        `this.rejectInitialize?.(${errorName})}`
      );
    },
  );
  if (failureCount !== 1) {
    throw new Error(
      `Expected one app-server initialization failure hook, found ${failureCount}.`,
    );
  }
  const withReady = withFailure.replace(
    COMPLETION_ANCHOR,
    `${COMPLETION_ANCHOR}globalThis.${READY_HOOK}?.(this.initializedAppServerVersion),`,
  );
  return {
    source: `${BOOTSTRAP}${withReady}`,
    changed: true,
    matched: true,
  };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(arg),
  );
  if (platform != null && platform !== "win") {
    console.log("  [skip] Runtime readiness protocol is Windows-only");
    return;
  }
  const isCheck = args.includes("--check");
  const requireChange = args.includes("--require-change");
  const buildDir = path.join(SRC_DIR, "win", "_asar", ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    throw new Error("Windows main-process build directory not found");
  }
  const targets = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(buildDir, name));
  let matched = 0;
  let changed = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    const result = patchSource(source);
    if (!result.matched) continue;
    matched += 1;
    console.log(`  [win] ${relPath(target)}`);
    if (result.changed && !isCheck) {
      fs.writeFileSync(target, result.source, "utf8");
      changed += 1;
    }
    console.log(
      result.changed
        ? "    [ok] structured Shell/Core/app-server readiness installed"
        : "    [ok] Runtime readiness protocol already installed",
    );
  }
  if (matched !== 1) {
    throw new Error(`Expected one Runtime readiness bundle, found ${matched}`);
  }
  if (requireChange && changed === 0 && !isCheck) {
    throw new Error("Required Runtime readiness patch changed zero files");
  }
}

module.exports = {
  BOOTSTRAP,
  COMPLETION_ANCHOR,
  FAIL_HOOK,
  PATCH_MARKER,
  READY_HOOK,
  patchSource,
};

if (require.main === module) main();
