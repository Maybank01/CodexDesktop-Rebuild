#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 *   node scripts/patch-all.js win --allow-noop # Re-check an already patched tree
 */
const { execFileSync } = require("child_process");
const path = require("path");

const PATCHES = [
  "patch-i18n.js",
  "patch-windows-native-menu-localization.js",
  "patch-fast-mode.js",
  "patch-model-list-filter.js",
  "patch-plugin-auth.js",
  "patch-account-readiness-logging.js",
  "patch-generated-image-preview.js",
  "patch-windows-onboarding-recovery.js",
  "patch-agentrouter-agent-directory.js",
  "patch-updater.js",
];

function getPassArgs(args) {
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const allowNoop = args.includes("--allow-noop");
  const extra = args.filter((a) => a.startsWith("--") && a !== "--allow-noop");
  return [
    ...(platform ? [platform] : []),
    ...extra,
    ...(!allowNoop ? ["--require-change"] : []),
  ];
}

function main() {
  const args = process.argv.slice(2);
  const passArgs = getPassArgs(args);

  let failed = 0;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    try {
      execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
    } catch (e) {
      console.error(`[x] ${label} failed (exit ${e.status})`);
      failed++;
    }
  }

  console.log(`\n== Summary: ${PATCHES.length - failed}/${PATCHES.length} succeeded ==`);
  if (failed > 0) process.exit(1);
}

module.exports = { PATCHES, getPassArgs };

if (require.main === module) main();
