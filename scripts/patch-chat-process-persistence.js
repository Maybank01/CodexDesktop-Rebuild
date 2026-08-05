#!/usr/bin/env node
/**
 * Keep the Shell's process-manager telemetry from corrupting itself when more
 * than one Codex window shares a CODEX_HOME. The file is auxiliary state, but
 * a truncated JSON document currently rejects every subsequent turn event.
 *
 * The patch makes writes atomic and quarantines an already-corrupt record so
 * the registry can rebuild it. Conversation rollouts and state_5.sqlite are
 * never touched.
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const PATCH_MARKER =
  "[agentrouter] quarantined corrupt chat process records";

const ORIGINAL_READ =
  "async function Bq(e){try{let t=await(0,u.readFile)(Kq(e),`utf8`),n=Rq.safeParse(JSON.parse(t));return n.success?n.data.map(e=>({...e,conversationId:t_(e.conversationId),osPid:e.osPid??null})):[]}catch(e){if(e instanceof Error&&`code`in e&&e.code===`ENOENT`)return[];throw e}}";
const ORIGINAL_WRITE =
  "async function qq(e,t){let n=Kq(e);await(0,u.mkdir)(i.default.dirname(n),{recursive:!0}),await(0,u.writeFile)(n,JSON.stringify(t,null,2),`utf8`)}";

const READ_PATTERN =
  /async function ([A-Za-z_$][\w$]*)\(e\)\{try\{let t=await\(0,([A-Za-z_$][\w$]*)\.readFile\)\(([A-Za-z_$][\w$]*)\(e\),`utf8`\),n=([A-Za-z_$][\w$]*)\.safeParse\(JSON\.parse\(t\)\);return n\.success\?n\.data\.map\(e=>\(\{\.\.\.e,conversationId:([A-Za-z_$][\w$]*)\(e\.conversationId\),osPid:e\.osPid\?\?null\}\)\):\[\]\}catch\(e\)\{if\(e instanceof Error&&`code`in e&&e\.code===`ENOENT`\)return\[\];throw e\}\}/gu;
const WRITE_PATTERN =
  /async function ([A-Za-z_$][\w$]*)\(e,t\)\{let n=([A-Za-z_$][\w$]*)\(e\);await\(0,([A-Za-z_$][\w$]*)\.mkdir\)\(([A-Za-z_$][\w$]*)\.default\.dirname\(n\),\{recursive:!0\}\),await\(0,\3\.writeFile\)\(n,JSON\.stringify\(t,null,2\),`utf8`\)\}/gu;

function patchedRead(match, fn, fsModule, recordPath, schema, normalizeId) {
  return (
    `async function ${fn}(e){let t=${recordPath}(e);try{` +
    `let n=await(0,${fsModule}.readFile)(t,\`utf8\`),r=${schema}.safeParse(JSON.parse(n));` +
    `return r.success?r.data.map(e=>({...e,conversationId:${normalizeId}(e.conversationId),osPid:e.osPid??null})):[]` +
    `}catch(e){if(e instanceof Error&&\`code\`in e&&e.code===\`ENOENT\`)return[];` +
    `if(e instanceof SyntaxError){let n=\`${"${t}"}.corrupt-${"${Date.now()}"}\`;` +
    `try{await(0,${fsModule}.rename)(t,n),console.warn(\`${PATCH_MARKER}\`,{recordPath:t,quarantinePath:n})}catch{}return[]}` +
    `throw e}}`
  );
}

function patchedWrite(match, fn, recordPath, fsModule, pathModule) {
  return (
    `async function ${fn}(e,t){let n=${recordPath}(e),` +
    `r=\`${"${n}"}.${"${process.pid}"}-${"${Date.now()}"}-${"${Math.random().toString(16).slice(2)}"}.tmp\`;` +
    `await(0,${fsModule}.mkdir)(${pathModule}.default.dirname(n),{recursive:!0});` +
    `try{await(0,${fsModule}.writeFile)(r,JSON.stringify(t,null,2),{encoding:\`utf8\`,flag:\`wx\`}),` +
    `await(0,${fsModule}.rename)(r,n)}finally{await(0,${fsModule}.rm)(r,{force:!0}).catch(()=>{})}}`
  );
}

function patchSource(source) {
  if (source.includes(PATCH_MARKER)) {
    return { source, changed: false, matched: true };
  }
  let readCount = 0;
  let writeCount = 0;
  const withReadRecovery = source.replace(READ_PATTERN, (...args) => {
    readCount += 1;
    return patchedRead(...args);
  });
  const patched = withReadRecovery.replace(WRITE_PATTERN, (...args) => {
    writeCount += 1;
    return patchedWrite(...args);
  });
  if (readCount === 0 && writeCount === 0) {
    return { source, changed: false, matched: false };
  }
  if (readCount !== 1 || writeCount !== 1) {
    throw new Error(
      `Expected one chat process reader and writer; reader=${readCount}, writer=${writeCount}`,
    );
  }
  return { source: patched, changed: true, matched: true };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) =>
    ["mac-arm64", "mac-x64", "win", "unix"].includes(arg),
  );
  if (platform != null && platform !== "win") {
    console.log("  [skip] Chat process persistence patch is Windows-only");
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
  let changed = 0;
  let matched = 0;
  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    const result = patchSource(source);
    if (!result.matched) continue;
    matched += 1;
    console.log(`  [win] ${relPath(target)}`);
    if (!result.changed) {
      console.log("    [ok] Chat process records already use recovery-safe writes");
      continue;
    }
    if (isCheck) {
      console.log("    [?] Chat process persistence recovery will be applied");
      continue;
    }
    fs.writeFileSync(target, result.source, "utf8");
    changed += 1;
    console.log("    [ok] Chat process records now use atomic writes and quarantine recovery");
  }

  if (requireChange && matched === 0) {
    throw new Error("Required chat process persistence pattern matched zero bundles");
  }
  console.log(
    isCheck
      ? `  [ok] ${matched} chat process bundle(s) patchable or already patched`
      : `  [ok] ${changed} chat process bundle(s) changed`,
  );
}

module.exports = {
  ORIGINAL_READ,
  ORIGINAL_WRITE,
  PATCH_MARKER,
  patchSource,
};

if (require.main === module) main();
