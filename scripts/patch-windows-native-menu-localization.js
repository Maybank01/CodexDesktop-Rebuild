#!/usr/bin/env node
/**
 * Localize the Windows Electron application menu in the main process.
 *
 * The renderer owns a complete Chinese catalog, but Electron's native menu is
 * built in the main process and only loads native-menu-locales/zh-CN.json.
 * Upstream also leaves several menu labels as English string literals.  Keep
 * both sources covered so a Runtime refresh cannot silently restore English.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WIN_ASAR = path.join(ROOT, "src", "win", "_asar");
const LOCALE_PATH = path.join(WIN_ASAR, "native-menu-locales", "zh-CN.json");
const MAIN_BUILD_DIR = path.join(WIN_ASAR, ".vite", "build");
const MARKER = "AGENTROUTER_NATIVE_MENU_LOCALIZATION_PATCH_V1";

const LOCALE_MESSAGES = Object.freeze({
  "codex.commandMenuTitle.archiveThread": "归档任务",
  "codex.commandMenuTitle.closeTab": "关闭标签页",
  "codex.commandMenuTitle.closeWindow": "关闭",
  "codex.commandMenuTitle.composer.startDictation": "开始听写",
  "codex.commandMenuTitle.copyConversationPath": "复制对话路径",
  "codex.commandMenuTitle.copyDeeplink": "复制深层链接",
  "codex.commandMenuTitle.copySessionId": "复制会话 ID",
  "codex.commandMenuTitle.copyWorkingDirectory": "复制工作目录",
  "codex.commandMenuTitle.findInThread": "在任务中查找",
  "codex.commandMenuTitle.focusBrowserAddressBar": "聚焦浏览器地址栏",
  "codex.commandMenuTitle.hardReloadBrowserPage": "强制重新加载浏览器页面",
  "codex.commandMenuTitle.navigateBack": "后退",
  "codex.commandMenuTitle.navigateForward": "前进",
  "codex.commandMenuTitle.newProjectlessTask": "新建无项目任务",
  "codex.commandMenuTitle.newThread": "新建任务",
  "codex.commandMenuTitle.newWindow": "新建窗口",
  "codex.commandMenuTitle.nextThread": "下一个任务",
  "codex.commandMenuTitle.openAvatarOverlay": "打开头像浮层",
  "codex.commandMenuTitle.openBrowserTab": "打开浏览器标签页",
  "codex.commandMenuTitle.openCommandMenu": "打开命令菜单",
  "codex.commandMenuTitle.openFolder": "打开文件夹…",
  "codex.commandMenuTitle.openProcessManager": "进程管理器",
  "codex.commandMenuTitle.openThreadInNewWindow": "在新窗口中打开任务",
  "codex.commandMenuTitle.previousThread": "上一个任务",
  "codex.commandMenuTitle.reloadBrowserPage": "重新加载浏览器页面",
  "codex.commandMenuTitle.renameThread": "重命名任务",
  "codex.commandMenuTitle.searchChats": "搜索任务…",
  "codex.commandMenuTitle.searchFiles": "搜索文件…",
  "codex.commandMenuTitle.settings": "设置…",
  "codex.commandMenuTitle.showKeyboardShortcuts": "键盘快捷键",
  "codex.commandMenuTitle.thread1": "任务 1",
  "codex.commandMenuTitle.thread2": "任务 2",
  "codex.commandMenuTitle.thread3": "任务 3",
  "codex.commandMenuTitle.thread4": "任务 4",
  "codex.commandMenuTitle.thread5": "任务 5",
  "codex.commandMenuTitle.thread6": "任务 6",
  "codex.commandMenuTitle.thread7": "任务 7",
  "codex.commandMenuTitle.thread8": "任务 8",
  "codex.commandMenuTitle.thread9": "任务 9",
  "codex.commandMenuTitle.toggleBottomPanel": "切换底部面板",
  "codex.commandMenuTitle.toggleBrowserPanel": "切换浏览器面板",
  "codex.commandMenuTitle.toggleFileTreePanel": "切换文件树",
  "codex.commandMenuTitle.togglePinnedSummary": "切换固定摘要",
  "codex.commandMenuTitle.toggleSidebar": "切换侧边栏",
  "codex.commandMenuTitle.toggleSidePanel": "切换侧面板",
  "codex.commandMenuTitle.toggleTerminal": "切换终端",
  "codex.commandMenuTitle.toggleThreadPin": "固定或取消固定任务",
  "codex.commandMenuTitle.toggleTraceRecording": "切换跟踪记录",
  "agentrouter.nativeMenu.file": "文件",
  "agentrouter.nativeMenu.view": "视图",
  "agentrouter.nativeMenu.logOut": "退出登录",
  "agentrouter.nativeMenu.exit": "退出",
  "agentrouter.nativeMenu.reloadWindow": "重新加载窗口",
  "agentrouter.nativeMenu.findNext": "查找下一个",
  "agentrouter.nativeMenu.findPrevious": "查找上一个",
  "agentrouter.nativeMenu.browserBack": "浏览器后退",
  "agentrouter.nativeMenu.browserForward": "浏览器前进",
  "agentrouter.nativeMenu.zoomIn": "放大",
  "agentrouter.nativeMenu.zoomOut": "缩小",
  "agentrouter.nativeMenu.actualSize": "实际大小",
  "agentrouter.nativeMenu.toggleFullScreen": "切换全屏",
  "agentrouter.nativeMenu.documentation": "文档",
  "agentrouter.nativeMenu.whatsNew": "新功能",
  "agentrouter.nativeMenu.troubleshooting": "故障排除",
  "agentrouter.nativeMenu.sendFeedback": "发送反馈",
});

const label = (messageId, fallback) =>
  `arMenuLabel(\`${messageId}\`,\`${fallback}\`)`;

const LITERAL_LABELS = Object.freeze([
  ["label:`Log Out`", `label:${label("agentrouter.nativeMenu.logOut", "Log Out")}`],
  ["label:`Reload Window`", `label:${label("agentrouter.nativeMenu.reloadWindow", "Reload Window")}`],
  ["label:`Find Next`", `label:${label("agentrouter.nativeMenu.findNext", "Find Next")}`],
  ["label:`Find Previous`", `label:${label("agentrouter.nativeMenu.findPrevious", "Find Previous")}`],
  ["label:`File`,id:", `label:${label("agentrouter.nativeMenu.file", "File")},id:`],
  ["label:`View`,id:", `label:${label("agentrouter.nativeMenu.view", "View")},id:`],
  ["label:`Browser Back`", `label:${label("agentrouter.nativeMenu.browserBack", "Browser Back")}`],
  ["label:`Browser Forward`", `label:${label("agentrouter.nativeMenu.browserForward", "Browser Forward")}`],
  ["label:`Zoom In`", `label:${label("agentrouter.nativeMenu.zoomIn", "Zoom In")}`],
  ["label:`Zoom Out`", `label:${label("agentrouter.nativeMenu.zoomOut", "Zoom Out")}`],
  ["label:`Actual Size`", `label:${label("agentrouter.nativeMenu.actualSize", "Actual Size")}`],
  ["label:`Toggle Full Screen`", `label:${label("agentrouter.nativeMenu.toggleFullScreen", "Toggle Full Screen")}`],
  ["label:`Documentation`", `label:${label("agentrouter.nativeMenu.documentation", "Documentation")}`],
  ["label:`What's New`", `label:${label("agentrouter.nativeMenu.whatsNew", "What's New")}`],
  ["label:`Troubleshooting`", `label:${label("agentrouter.nativeMenu.troubleshooting", "Troubleshooting")}`],
  ["label:`Send Feedback`", `label:${label("agentrouter.nativeMenu.sendFeedback", "Send Feedback")}`],
]);

function patchMainSource(source) {
  if (source.includes(MARKER)) return { changed: false, source };
  if (!source.includes("function b8(") || !source.includes("label:`Log Out`")) {
    throw new Error("Windows native menu source signature has drifted");
  }

  let result = source.replace("function b8(", `var ${MARKER}=!0;function b8(`);
  const helperAnchor = "accelerator:n.Gt({commandId:e,isMacOS:t}).filter(w)[r??0]}},O=";
  if (!result.includes(helperAnchor)) {
    throw new Error("Windows native menu label helper anchor was not found");
  }
  result = result.replace(
    helperAnchor,
    "accelerator:n.Gt({commandId:e,isMacOS:t}).filter(w)[r??0]}},arMenuLabel=(e,t)=>a.H().formatMessage({messageId:e,defaultMessage:t}),O=",
  );

  for (const [original, replacement] of LITERAL_LABELS) {
    if (!result.includes(original)) {
      throw new Error(`Windows native menu label was not found: ${original}`);
    }
    result = result.replaceAll(original, replacement);
  }

  const quitItem = "new c.MenuItem({role:`quit`,accelerator:`Ctrl+Q`})";
  if (!result.includes(quitItem)) {
    throw new Error("Windows native menu Exit item was not found");
  }
  result = result.replace(
    quitItem,
    `new c.MenuItem({label:${label("agentrouter.nativeMenu.exit", "Exit")},role:\`quit\`,accelerator:\`Ctrl+Q\`})`,
  );
  return { changed: true, source: result };
}

function mergeLocaleMessages(messages) {
  let changed = false;
  const merged = { ...messages };
  for (const [key, value] of Object.entries(LOCALE_MESSAGES)) {
    if (merged[key] !== value) {
      merged[key] = value;
      changed = true;
    }
  }
  return { changed, messages: merged };
}

function locateMainBundle() {
  const matches = fs.readdirSync(MAIN_BUILD_DIR)
    .filter((name) => /^main-.*\.js$/.test(name))
    .map((name) => path.join(MAIN_BUILD_DIR, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes("function b8("));
  if (matches.length !== 1) {
    throw new Error(`Expected one Windows main menu bundle, found ${matches.length}`);
  }
  return matches[0];
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => ["win", "mac-arm64", "mac-x64", "unix"].includes(arg));
  const check = args.includes("--check");
  const requireChange = args.includes("--require-change");
  if (platform && platform !== "win") {
    console.log(`[skip] Windows native menu localization does not apply to ${platform}`);
    return;
  }

  const locale = mergeLocaleMessages(JSON.parse(fs.readFileSync(LOCALE_PATH, "utf8")));
  const mainPath = locateMainBundle();
  const mainPatch = patchMainSource(fs.readFileSync(mainPath, "utf8"));
  const changeCount = Number(locale.changed) + Number(mainPatch.changed);

  if (requireChange && changeCount === 0) {
    throw new Error("Required Windows native menu localization patch matched zero files");
  }
  if (check) {
    console.log(`[check] ${changeCount} file(s) require Windows native menu localization`);
    return;
  }
  if (locale.changed) fs.writeFileSync(LOCALE_PATH, JSON.stringify(locale.messages), "utf8");
  if (mainPatch.changed) fs.writeFileSync(mainPath, mainPatch.source, "utf8");
  console.log(`[ok] Windows native menu localization updated ${changeCount} file(s)`);
}

module.exports = {
  LITERAL_LABELS,
  LOCALE_MESSAGES,
  MARKER,
  mergeLocaleMessages,
  patchMainSource,
};

if (require.main === module) main();
