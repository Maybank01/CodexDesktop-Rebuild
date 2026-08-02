#!/usr/bin/env node
/**
 * Keep ordinary Codex conversations and AgentRouter Agents in one Shell.
 *
 * The outer Client writes a non-secret Agent directory. The Shell watches it,
 * registers prepared Agent Session Gateways as native App Server hosts, and
 * renders a separate Role -> Agent section above ordinary conversations.
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const PATCH_MARKER = "AGENTROUTER_AGENT_DIRECTORY_PATCH_V1";

function replaceOnce(code, search, replacement, label) {
  const index = code.indexOf(search);
  if (index < 0) throw new Error(`${label} anchor not found`);
  if (code.indexOf(search, index + search.length) >= 0) {
    throw new Error(`${label} anchor is ambiguous`);
  }
  return code.slice(0, index) + replacement + code.slice(index + search.length);
}

function replaceOneOf(code, candidates, replacement, label) {
  const matching = candidates.filter((candidate) => code.includes(candidate));
  if (matching.length !== 1) {
    throw new Error(`${label} expected one anchor, found ${matching.length}`);
  }
  return replaceOnce(code, matching[0], replacement(matching[0]), label);
}

function patchMain(bundle) {
  let code = fs.readFileSync(bundle.path, "utf8");
  if (code.includes(PATCH_MARKER)) {
    const legacyNavigation =
      "setTimeout(()=>{c.shell.openExternal(`codex://threads/${encodeURIComponent(u.threadId)}`).catch(()=>void 0)},150)";
    if (!code.includes(legacyNavigation)) {
      console.log(`  [ok] ${relPath(bundle.path)}: main already patched`);
      return;
    }
    code = replaceOnce(
      code,
      legacyNavigation,
      "setTimeout(()=>{let e=this.options.windowManager.getPrimaryWindow();e&&!e.isDestroyed()&&(this.options.windowManager.sendMessageToWindow(e,{type:`navigate-to-route`,path:`/local/${encodeURIComponent(u.threadId)}`}),e.isMinimized()&&e.restore(),e.show(),e.focus())},150)",
      "Legacy Agent Session navigation",
    );
    fs.writeFileSync(bundle.path, code);
    console.log(`  [ok] ${relPath(bundle.path)}: upgraded Agent Session navigation`);
    return;
  }

  code = replaceOneOf(
    code,
    [
      "function t6(e){return process.env.CODEX_APP_SERVER_FORCE_CLI===`1`?null:n.In(e)}",
      "function r6(e){return process.env.CODEX_APP_SERVER_FORCE_CLI===`1`?null:n.In(e)}",
    ],
    (anchor) =>
      anchor.replace(
        "?null:n.In(e)",
        "?null:e?.id?.startsWith(`agentrouter-agent:`)?e.websocket_url:n.In(e)",
      ),
    "Per-Agent websocket resolver",
  );

  code = replaceOneOf(
    code,
    [
      "function s4(e){return n.Qa(e)?a4(e):n.ro(e)?o4(e):i4(e)}",
      "function l4(e){return n.Qa(e)?s4(e):n.ro(e)?c4(e):o4(e)}",
    ],
    (anchor) => {
      const body = anchor.slice(anchor.indexOf("{return") + 7, -1);
      return anchor.replace(
        `{return${body}}`,
        `{return e?.source===\`agentrouter-agent\`?{id:e.hostId,display_name:e.displayName,kind:\`local\`,websocket_url:e.websocketUrl,codex_cli_command:[],terminal_command:[],default_workspaces:[]}:${body}}`,
      );
    },
    "Agent host config",
  );

  const sharedConnections =
    "getSharedRemoteConnections(){return[...this.sharedObjectRepository.get(`remote_ssh_connections`)??[],...this.sharedObjectRepository.get(`remote_wsl_connections`)??[],...this.sharedObjectRepository.get(`remote_control_connections`)??[]]}";
  const connectionCount = code.split(sharedConnections).length - 1;
  if (connectionCount < 2) {
    throw new Error("Shared remote connection anchors not found");
  }
  code = code.split(sharedConnections).join(
    "getSharedRemoteConnections(){return[...this.sharedObjectRepository.get(`remote_ssh_connections`)??[],...this.sharedObjectRepository.get(`remote_wsl_connections`)??[],...this.sharedObjectRepository.get(`remote_control_connections`)??[],...this.sharedObjectRepository.get(`agentrouter_agent_connections`)??[]]}",
  );

  code = replaceOnce(
    code,
    "e===`remote_ssh_connections`||e===`remote_wsl_connections`||e===`remote_control_connections`",
    "e===`remote_ssh_connections`||e===`remote_wsl_connections`||e===`remote_control_connections`||e===`agentrouter_agent_connections`",
    "Remote connection subscriber",
  );

  const constructorTail =
    "})),this.initialRemoteConnectionsRefresh=Promise.all([this.remoteConnectionsHandler.refreshRemoteConnections()";
  code = replaceOnce(
    code,
    constructorTail,
    "})),this.initializeAgentRouterAgentDirectory(),this.initialRemoteConnectionsRefresh=Promise.all([this.remoteConnectionsHandler.refreshRemoteConnections()",
    "Agent directory initialization",
  );

  const createAppHostAnchor = "}createAppHost(e){";
  const directoryMethod = [
    "}initializeAgentRouterAgentDirectory(){",
    `void \`${PATCH_MARKER}\`;`,
    "this.sharedObjectRepository.set(`agentrouter_agent_directory`,{schemaVersion:1,revision:0,entries:[]});",
    "this.sharedObjectRepository.set(`agentrouter_agent_connections`,[]);",
    "let e=process.env.AGENTROUTER_AGENT_DIRECTORY_PATH;",
    "if(!e)return;",
    "let t=require(`node:fs`),n=require(`node:path`),r=null;",
    "let i=()=>{r!=null&&clearTimeout(r),r=setTimeout(()=>{",
    "t.readFile(e,`utf8`,(r,i)=>{",
    "if(r)return;",
    "let a;try{a=JSON.parse(i)}catch{return}",
    "if(a?.schemaVersion!==1||!Array.isArray(a.entries))return;",
    "let o=[];",
    "for(let e of a.entries){",
    "if(!e||typeof e.agentId!==`string`||!/^[0-9a-f-]{36}$/iu.test(e.agentId)||typeof e.agentName!==`string`||typeof e.roleId!==`string`||typeof e.roleName!==`string`||typeof e.threadId!==`string`)continue;",
    "let t=null;",
    "if(typeof e.endpointUrl===`string`)try{let n=new URL(e.endpointUrl);n.protocol===`ws:`&&n.hostname===`127.0.0.1`&&n.username===``&&n.password===``&&(t=n.toString())}catch{}",
    "o.push({agentId:e.agentId,agentName:e.agentName.slice(0,200),roleId:e.roleId,roleName:e.roleName.slice(0,200),threadId:e.threadId,endpointUrl:t});",
    "}",
    "let s={schemaVersion:1,revision:Number(a.revision)||Date.now(),entries:o};",
    "this.sharedObjectRepository.set(`agentrouter_agent_directory`,s);",
    "this.sharedObjectRepository.set(`agentrouter_agent_connections`,o.flatMap(e=>e.endpointUrl?[{hostId:`agentrouter-agent:${e.agentId}`,displayName:`${e.roleName} · ${e.agentName}`,source:`agentrouter-agent`,roleId:e.roleId,roleName:e.roleName,agentId:e.agentId,agentName:e.agentName,threadId:e.threadId,websocketUrl:e.endpointUrl,autoConnect:!0}]:[]));",
    "let l=a.openRequest,u=l&&o.find(e=>e.agentId===l.agentId&&e.endpointUrl);",
    "if(u&&typeof l.requestId===`string`&&this.agentRouterLastOpenRequestId!==l.requestId){this.agentRouterLastOpenRequestId=l.requestId;setTimeout(()=>{let e=this.options.windowManager.getPrimaryWindow();e&&!e.isDestroyed()&&(this.options.windowManager.sendMessageToWindow(e,{type:`navigate-to-route`,path:`/local/${encodeURIComponent(u.threadId)}`}),e.isMinimized()&&e.restore(),e.show(),e.focus())},150)}",
    "})},40)};",
    "i();",
    "try{let r=t.watch(n.dirname(e),(t,r)=>{r==null||r.toString()===n.basename(e)?i():void 0});this.disposables.add({dispose:()=>r.close()})}catch{}",
    createAppHostAnchor,
  ].join("");
  code = replaceOnce(
    code,
    createAppHostAnchor,
    directoryMethod,
    "Agent directory watcher method",
  );

  const routeAnchor =
    '"set-remote-connection-auto-connect":async({hostId:e,autoConnect:t})=>this.remoteConnectionsHandler.setRemoteConnectionAutoConnect(e,t),';
  const route =
    '"agentrouter-open-agent":async({agentId:e})=>{if(typeof e!==`string`||!/^[0-9a-f-]{36}$/iu.test(e))throw Error(`Invalid AgentRouter Agent id`);let t=process.env.AGENTROUTER_CLIENT_PROTOCOL??`agentrouter`;if(![`agentrouter`,`agentrouter-dev`,`agentrouter-canary`].includes(t))throw Error(`Invalid AgentRouter Client protocol`);await c.shell.openExternal(`${t}://agent/${encodeURIComponent(e)}`)},';
  code = replaceOnce(code, routeAnchor, route + routeAnchor, "Agent open route");

  fs.writeFileSync(bundle.path, code);
  console.log(`  [ok] ${relPath(bundle.path)}: Agent directory host bridge`);
}

function patchHostConfig(bundle) {
  let code = fs.readFileSync(bundle.path, "utf8");
  if (code.includes("agentrouter_agent_connections")) {
    console.log(`  [ok] ${relPath(bundle.path)}: host config already patched`);
    return;
  }
  code = replaceOnce(
    code,
    "[o]=Lf(`remote_control_connections`),s;bb0:",
    "[o]=Lf(`remote_control_connections`),[ar]=Lf(`agentrouter_agent_connections`),s;bb0:",
    "Agent host list hook",
  );
  code = replaceOnce(
    code,
    "l=[...e,...n,...c]",
    "l=[...e,...n,...c,...ar??[]]",
    "Agent host list merge",
  );
  code = replaceOnce(
    code,
    "function qf(e,t){let n=t?.find(t=>t.hostId===e);return n?fe(n):Yf}",
    "function qf(e,t){let n=t?.find(t=>t.hostId===e);return n?.source===`agentrouter-agent`?{id:n.hostId,display_name:n.displayName,kind:`local`,websocket_url:n.websocketUrl,codex_cli_command:[],terminal_command:[],default_workspaces:[]}:n?fe(n):Yf}",
    "Agent renderer host config",
  );
  fs.writeFileSync(bundle.path, code);
  console.log(`  [ok] ${relPath(bundle.path)}: Agent hosts included`);
}

function patchSidebar(bundle) {
  let code = fs.readFileSync(bundle.path, "utf8");
  if (code.includes("agentrouter.roleAgents")) {
    let upgraded = false;
    if (code.includes("ARBridge.dispatchMessage(`agentrouter-open-agent`")) {
      code = replaceOnce(
        code,
        "c as y,g as ARBridge",
        "c as y,c as ARRequest",
        "Legacy sidebar bridge import",
      );
      code = replaceOnce(
        code,
        "let[d]=ye(`agentrouter_agent_directory`),[c,setC]=Uf.useState(!1),[opening,setOpening]=Uf.useState(null),entries=Array.isArray(d?.entries)?d.entries:[];",
        "let[d]=ye(`agentrouter_agent_directory`),[c,setC]=Uf.useState(!1),[opening,setOpening]=Uf.useState(null),openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),entries=Array.isArray(d?.entries)?d.entries:[];",
        "Legacy Agent request hook",
      );
      code = replaceOnce(
        code,
        "Uf.useEffect(()=>{opening&&entries.some(e=>e.agentId===opening&&e.endpointUrl)&&setOpening(null)},[d?.revision,opening]);",
        "Uf.useEffect(()=>{if(!opening)return;entries.some(e=>e.agentId===opening&&e.endpointUrl)&&setOpening(null);let t=setTimeout(()=>setOpening(e=>e===opening?null:e),15e3);return()=>clearTimeout(t)},[d?.revision,opening]);",
        "Legacy Agent opening effect",
      );
      code = replaceOnce(
        code,
        "setOpening(e.agentId);Promise.resolve(ARBridge.dispatchMessage(`agentrouter-open-agent`,{agentId:e.agentId})).catch(()=>setOpening(null))",
        "setOpening(e.agentId);openAgent.mutate({agentId:e.agentId})",
        "Legacy Agent opening action",
      );
      upgraded = true;
    }
    if (code.includes("currentThreadKey=p(Wt)")) {
      code = replaceOnce(
        code,
        "openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),currentThreadKey=p(Wt),entries=Array.isArray(d?.entries)?d.entries:[];",
        "openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),entries=Array.isArray(d?.entries)?d.entries:[],agentThreadKeys=entries.map(e=>`local:${e.threadId}`),currentThreadKey=p(Nd,agentThreadKeys);",
        "Unsafe Agent current thread hook",
      );
      upgraded = true;
    } else if (!code.includes("currentThreadKey=p(Nd,agentThreadKeys)")) {
      code = replaceOnce(
        code,
        "openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),entries=Array.isArray(d?.entries)?d.entries:[];",
        "openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),entries=Array.isArray(d?.entries)?d.entries:[],agentThreadKeys=entries.map(e=>`local:${e.threadId}`),currentThreadKey=p(Nd,agentThreadKeys);",
        "Agent current thread hook",
      );
      code = replaceOnce(
        code,
        "e.entries.map(e=>{let t=opening===e.agentId;return(0,$.jsxs)(`button`,{type:`button`,className:`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-token-sidebar-item-hover`,onClick:",
        "e.entries.map(e=>{let t=opening===e.agentId,n=String(currentThreadKey??``).replace(/^local:/,``)===e.threadId;return(0,$.jsxs)(`button`,{type:`button`,\"aria-current\":n?`page`:void 0,className:W(`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-token-list-hover-background`,n&&`bg-token-list-hover-background`),onClick:",
        "Agent active thread state",
      );
      upgraded = true;
    }
    if (!upgraded) {
      console.log(`  [ok] ${relPath(bundle.path)}: sidebar already patched`);
      return;
    }
    fs.writeFileSync(bundle.path, code);
    console.log(`  [ok] ${relPath(bundle.path)}: upgraded Agent sidebar behavior`);
    return;
  }
  code = replaceOnce(
    code,
    'import{N as _,b as v,c as y,n as b,o as x,w as S,x as C}from"./vscode-api-',
    'import{N as _,b as v,c as y,c as ARRequest,n as b,o as x,w as S,x as C}from"./vscode-api-',
    "Sidebar bridge import",
  );

  const component = [
    "function ARAgentDirectorySection(){",
    "let[d]=ye(`agentrouter_agent_directory`),[c,setC]=Uf.useState(!1),[opening,setOpening]=Uf.useState(null),openAgent=ARRequest(`agentrouter-open-agent`,{onError:()=>setOpening(null)}),entries=Array.isArray(d?.entries)?d.entries:[],agentThreadKeys=entries.map(e=>`local:${e.threadId}`),currentThreadKey=p(Nd,agentThreadKeys);",
    "Uf.useEffect(()=>{if(!opening)return;entries.some(e=>e.agentId===opening&&e.endpointUrl)&&setOpening(null);let t=setTimeout(()=>setOpening(e=>e===opening?null:e),15e3);return()=>clearTimeout(t)},[d?.revision,opening]);",
    "if(entries.length===0)return null;",
    "let groups=[];",
    "for(let e of entries){let t=groups.find(t=>t.roleId===e.roleId);t?t.entries.push(e):groups.push({roleId:e.roleId,roleName:e.roleName,entries:[e]})}",
    "return(0,$.jsxs)(`section`,{className:`px-row-x pb-2`,\"data-agentrouter-section\":`agentrouter.roleAgents`,children:[",
    "(0,$.jsxs)(`button`,{type:`button`,className:`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium text-token-foreground hover:bg-token-sidebar-item-hover`,onClick:()=>setC(e=>!e),\"aria-expanded\":!c,children:[(0,$.jsx)(`span`,{children:`岗位智能体`}),(0,$.jsx)(`span`,{className:`text-token-description-foreground`,children:c?`›`:`⌄`})]}),",
    "c?null:(0,$.jsx)(`div`,{className:`mt-1 space-y-2`,children:groups.map(e=>(0,$.jsxs)(`div`,{children:[",
    "(0,$.jsx)(`div`,{className:`px-2 pb-1 text-xs text-token-description-foreground`,children:e.roleName}),",
    "(0,$.jsx)(`div`,{className:`space-y-0.5`,children:e.entries.map(e=>{let t=opening===e.agentId,n=String(currentThreadKey??``).replace(/^local:/,``)===e.threadId;return(0,$.jsxs)(`button`,{type:`button`,\"aria-current\":n?`page`:void 0,className:W(`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-token-list-hover-background`,n&&`bg-token-list-hover-background`),onClick:()=>{setOpening(e.agentId);openAgent.mutate({agentId:e.agentId})},children:[",
    "(0,$.jsx)(`span`,{className:`flex size-5 shrink-0 items-center justify-center rounded-full bg-token-sidebar-item-hover text-[10px] font-semibold`,children:e.agentName.trim().slice(0,1).toUpperCase()||`A`}),",
    "(0,$.jsx)(`span`,{className:`min-w-0 flex-1 truncate text-sm text-token-foreground`,children:e.agentName}),",
    "(0,$.jsx)(`span`,{className:`shrink-0 text-xs text-token-description-foreground`,children:t?`连接中…`:e.endpointUrl?`在线`:`待命`})",
    "]},e.agentId)})})",
    "]},e.roleId))})",
    "]})}",
  ].join("");
  code = replaceOnce(code, "function Zf(e){", component + "function Zf(e){", "Role Agent sidebar component");
  code = replaceOnce(
    code,
    "{mode:n,sectionReorderDnd:r,threadKeys:i,threadKeysInDisplayOrder:a}=e,s=o(m),",
    "{mode:n,sectionReorderDnd:r,threadKeys:i,threadKeysInDisplayOrder:a}=e,[arDirectory]=ye(`agentrouter_agent_directory`),arThreadIds=new Set((arDirectory?.entries??[]).map(e=>e.threadId)),s=o(m);i=i.filter(e=>!arThreadIds.has(String(e).replace(/^local:/,``)));a=a.filter(e=>!arThreadIds.has(String(e).replace(/^local:/,``)));let ",
    "Ordinary conversation filter",
  );
  code = replaceOnce(
    code,
    "t[45]=I):I=t[45],I}function Qf(e){",
    "t[45]=I):I=t[45],(0,op.jsxs)(op.Fragment,{children:[(0,op.jsx)(ARAgentDirectorySection,{}),I]})}function Qf(e){",
    "Role Agent section placement",
  );
  fs.writeFileSync(bundle.path, code);
  console.log(`  [ok] ${relPath(bundle.path)}: Role Agent sidebar section`);
}

function main() {
  const platform = process.argv.slice(2).find((arg) =>
    ["mac-arm64", "mac-x64", "win"].includes(arg),
  );
  const mainBundles = locateBundles({ dir: "build", pattern: /^main-.*\.js$/, ...(platform ? { platform } : {}) });
  const hostBundles = locateBundles({ dir: "assets", pattern: /^use-host-config-.*\.js$/, ...(platform ? { platform } : {}) });
  const sidebarBundles = locateBundles({ dir: "assets", pattern: /^sidebar-flat-sections-.*\.js$/, ...(platform ? { platform } : {}) });
  if (!mainBundles.length || !hostBundles.length || !sidebarBundles.length) {
    throw new Error("Required Codex Shell bundles were not found");
  }
  mainBundles.forEach(patchMain);
  hostBundles.forEach(patchHostConfig);
  sidebarBundles.forEach(patchSidebar);
}

main();
