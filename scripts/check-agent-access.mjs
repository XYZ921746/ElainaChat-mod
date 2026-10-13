// 三档 AI 权限（strict / auto / full）的行为验证。
//
// ★ 本文件的前身是 check-agent-once-policy.mjs —— 它验证的是旧的四档手机策略
//   （once / run / always / off）在"AI 续跑间隔超过 600ms"时还会不会重复弹窗。
//   那套策略已在 2026-10 整体删除（手机端改为"全部放行"，电脑端改为三档），
//   所以旧断言全部失效 —— 不是"实现坏了"，是**被测对象不存在了**。
//
// 新模型要钉住的事实（每条都对应一个真实的设计决定）：
//
//   1. 手机操作**全部不弹确认**（用户明确要求"手机不做确认，全部放行"）。
//      模块后端（KernelSU / root）的风险由设置页的免责声明承担，而不是靠弹窗。
//   2. 电脑命令：strict 每条都问 / auto 只问危险 / full 从不问。
//   3. 停止优先：stopRequested 时一律拒绝，任何档位都不能绕过。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

// 抠 agentRuntime 的完整 IIFE
const rtStart = html.indexOf('const agentRuntime = (function ()');
const rtEnd = html.indexOf('window.agentRuntime = agentRuntime;');
if (rtStart < 0 || rtEnd < 0) { console.error('抠不到 agentRuntime'); process.exit(1); }
let rtSrc = html.slice(rtStart, rtEnd);

const state = { settings: { agentAccess: 'strict', agentPhoneEnabled: true } };
let resolveModal = null;   // 应用内弹窗的"人工点按"由测试脚本代替
const sandbox = {
    console,
    state,
    document: {
        getElementById: () => null,   // render() 里的元素拿不到 → 内部直接 return，安全
        querySelectorAll: () => [],
    },
    AGENT_RISK: {
        '手机状态': 'safe', '手机查看界面': 'safe', '手机截图': 'safe', '手机等待': 'safe',
        '手机点击': 'sensitive', '手机滑动': 'sensitive', '手机输入': 'sensitive',
        '手机按键': 'sensitive', '手机打开': 'sensitive', '手机命令': 'dangerous',
        '手机应用列表': 'safe', '手机通知': 'safe', '手机设备信息': 'safe',
        '手机短信': 'safe', '手机通讯录': 'safe', '手机日历': 'safe',
        '手机列出文件': 'safe', '手机读文件': 'safe', '手机写文件': 'sensitive', '手机删除文件': 'sensitive',
        '电脑命令': 'sensitive',
    },
    showCustomModal: () => new Promise((resolve) => { resolveModal = resolve; }),
    DOMException, AbortController,
    Set, Map, Promise, Date, Number, String, Boolean, Error, setTimeout, clearTimeout,
    requestApprovalViaOverlay: () => Promise.resolve(null),   // 无悬浮窗 → 走应用内弹窗
    deviceBridge: () => null,
    // ★ 三档模型的判据函数（真实定义在 app-03-agent.js 顶部，这里按同样语义注入）
    currentAgentAccess: () => state.settings.agentAccess || 'strict',
    // phoneTierAllows 的真实实现见 app-03-agent.js —— 这里从源码里抠出来跑，
    // 避免"测试里抄一份、实现改了两边不一致"。
    phoneTierAllows: null,
    window: {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 从真实源码里抠 phoneTierAllows，保证测的是实现本身
const ptStart = html.indexOf('function phoneTierAllows(');
if (ptStart < 0) { console.error('抠不到 phoneTierAllows'); process.exit(1); }
let depth = 0, ptEnd = html.indexOf('{', ptStart);
for (; ptEnd < html.length; ptEnd++) {
    if (html[ptEnd] === '{') depth++;
    else if (html[ptEnd] === '}') { depth--; if (depth === 0) { ptEnd++; break; } }
}
vm.runInContext(html.slice(ptStart, ptEnd) + '\nwindow.phoneTierAllows = phoneTierAllows;', sandbox);
sandbox.phoneTierAllows = sandbox.window.phoneTierAllows;

// requestStop 里引用了 elements —— 沙箱里没有，换成安全占位
rtSrc = rtSrc.replace('elements.customModalCancelBtn?.click()', 'null');

vm.runInContext(rtSrc + '\nwindow.agentRuntime = agentRuntime;', sandbox);
const rt = sandbox.window.agentRuntime;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 走一次真实授权判定，返回"弹了没有" */
async function ask(action) {
    if (!rt.isRunning()) rt.beginRun();
    rt.setStep(1, action);
    resolveModal = null;
    const p = rt.requestApproval(action, action + ' 测试');
    let waited = 0;
    while (!resolveModal && waited < 300) { await sleep(10); waited += 10; }
    const asked = Boolean(resolveModal);
    if (resolveModal) { const r = resolveModal; resolveModal = null; r(true); }
    const allowed = await p;
    return { asked, allowed };
}

console.log('=== 手机操作：全部放行（含「手机命令」，风险由免责声明承担）===\n');
rt.beginBatch();
for (const access of ['strict', 'auto', 'full']) {
    state.settings.agentAccess = access;
    for (const action of ['手机状态', '手机查看界面', '手机截图', '手机点击', '手机滑动',
        '手机输入', '手机按键', '手机打开', '手机应用列表', '手机通知',
        '手机设备信息', '手机短信', '手机通讯录', '手机日历',
        '手机列出文件', '手机读文件', '手机写文件', '手机删除文件']) {
        const r = await ask(action);
        ok(r.asked === false, `${access} 档下「${action}」不弹确认`,
            r.asked ? '仍然弹了确认！' : '');
        ok(r.allowed === true, `${access} 档下「${action}」被放行`);
    }
    // ★ 唯一的例外曾经是「手机命令」，但用户明确答复"全部放行但是模块加免责声明"，
    //   所以现在**连它也不问** —— 风险由设置页的免责声明承担。
    //   这条断言钉住的就是"确实全部放行"，防止有人悄悄把它加回确认。
    const cmd = await ask('手机命令');
    ok(cmd.asked === false, `${access} 档下「手机命令」也不弹确认（用户选择全部放行 + 免责声明）`,
        cmd.asked ? '又加回确认了？' : '');
}

console.log('\n=== 电脑命令：按档位决定问不问 ===\n');
state.settings.agentAccess = 'full';
let r = await ask('电脑命令');
ok(r.asked === false, 'full 档：电脑命令不弹确认（完全访问的定义）');

state.settings.agentAccess = 'auto';
r = await ask('电脑命令');
ok(r.asked === false, 'auto 档：普通电脑命令不弹（由服务端 needApproval 驱动危险命令）');

state.settings.agentAccess = 'strict';
r = await ask('电脑命令');
ok(r.asked === true, 'strict 档：电脑命令弹确认（逐条确认的定义）');

// forceAsk 必须能穿透任何档位 —— 这是"服务端判定为危险"的唯一表达方式
state.settings.agentAccess = 'full';
rt.beginBatch();
resolveModal = null;
{
    const p = rt.requestApproval('电脑命令', '危险命令', { forceAsk: true });
    let waited = 0;
    while (!resolveModal && waited < 300) { await sleep(10); waited += 10; }
    ok(Boolean(resolveModal), '★ forceAsk 穿透 full 档（危险命令必须问，档位豁免不了）');
    if (resolveModal) { const f = resolveModal; resolveModal = null; f(true); }
    await p;
}

console.log('\n=== 停止优先 ===\n');
state.settings.agentAccess = 'full';
rt.beginBatch();
rt.requestStop('测试停止');
const stopped = await ask('手机点击');
ok(stopped.allowed === false, '★ 已停止时任何档位都拒绝执行（停止优先于档位）');

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
