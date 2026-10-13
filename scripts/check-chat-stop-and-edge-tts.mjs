// 回归检查：本轮三件用户反馈。
//   1. 手机操作授权「每次运行只确认一次」并设为默认
//   2. 聊天发送按钮二态（AI 回复中变红色停止）+ 请求可中断
//
// 注：原第 2 节（Edge TTS）已随 Edge TTS provider 一起删除 —— 它断言的
// `speakTextEdge` / `#settingEdgeTtsVoice` / `/api/tts/edge` 都已不存在。
// 现在 TTS 默认走 MiMo（见 check-dom-refs 与前端源码）。
//
// 用法：node scripts/check-chat-stop-and-edge-tts.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontend } from './frontend-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFrontend();
const providers = readFileSync(path.join(ROOT, 'web', 'js', 'chat-providers.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; failures.push(l); console.log('  FAIL  ' + l + (d ? '  -> ' + d : '')); } };

// ============================================================ 1. 授权策略
//
// ★★ 2026-10 权限模型重构：这一节原来验证的是**旧的四档手机策略**
//   （once / run / always / off 的 UI、默认值与豁免语义）。那套已整体删除，
//   改成一个三档设置 agentAccess（strict / auto / full）同时管电脑与手机。
//   所以本节改为断言新模型的三件事：UI 三档齐全、默认最严、迁移向宽松倒。
//   三档的**运行时行为**由 check-agent-access.mjs 覆盖（那里跑真实函数）。
console.log('=== 1. 授权策略：三档 agentAccess ===');
{
    for (const v of ['strict', 'auto', 'full']) {
        ok(new RegExp('name="agentAccess" value="' + v + '"').test(html), `UI 有 ${v} 档`);
    }
    ok(/agentAccess: 'strict'/.test(html), '默认设置是最严的 strict');
    ok(!/name="agentApproval"/.test(html), '★ 旧的四档 agentApproval UI 已彻底移除');
    ok(!/name="agentPermission"/.test(html), '★ 旧的 agentPermission UI 已彻底移除');
    ok(/\['strict', 'auto', 'full'\]\.includes\(state\.settings\.agentAccess\)/.test(html)
        || /\['strict', 'auto', 'full'\]/.test(html), '合法性校验包含三档');
    // 迁移取向：用户选的是"向宽松倒"——旧 computer → full
    ok(/legacyPermission === 'computer'\) \? 'full' : 'strict'/.test(html),
        '★ 迁移：旧 computer → full（用户选择的向宽松倒）');
    ok(/delete state\.settings\.agentPermission/.test(html)
        && /delete state\.settings\.agentApproval/.test(html),
        '迁移后删掉两个旧字段（否则"哪个才是权威"会含糊）');
    // 切到 full 时必须有一次性后果确认（不能静默开启）
    ok(/nextAccess === 'full' && currentAgentAccess\(\) !== 'full'/.test(html),
        '★ 切到「完全访问」时弹一次后果确认');
    ok(/不会询问你/.test(html), '★ 后果说明里点明"这些操作都不会再询问你"');
}

// ============================================================ 2. 停止按钮 + 可中断
console.log('\n=== 2. 聊天停止按钮 ===');
{
    ok(/onclick="handleComposerButtonClick\(\)"/.test(html), '发送按钮走统一入口（不再直连 handleTextSubmit）');
    ok(/function handleComposerButtonClick\(\)/.test(html), '有统一入口函数');
    ok(/function stopAiReply\(\)/.test(html), '有 stopAiReply');
    ok(html.includes('activeReplyAborts'), '有本轮回复的中断器表');
    ok(/replyAbort = new AbortController\(\)/.test(html), '每轮回复创建 AbortController');
    ok(/signal: replyAbort\.signal/.test(html), 'signal 传给 callAI');
    ok(/signal: options\.signal/.test(html), 'callAI 透传给 callChatAPI');
    ok(/async function postJsonFromDevice\(url, body, headers = \{\}, timeoutMs = 120000, signal = null\)/.test(html),
        'postJsonFromDevice 收 signal');
    ok(/Promise\.race\(\[run, abortPromise\]\)/.test(html), 'abort 用 race 立即砍掉等待');
    // 图标二态（DSH 式：同一位置一个图标槽，箭头↔暂停）
    ok(/composer-state-icon/.test(html), '有统一的图标槽（不是两个图标叠着切 hidden）');
    ok(/COMPOSER_ARROW_SVG/.test(html) && /COMPOSER_PAUSE_SVG/.test(html), '箭头与暂停两套 SVG');
    ok(/function swapStopIcons/.test(html), 'swapStopIcons 切换图标');
    ok(/is-stopping/.test(html), '有 is-stopping 样式类');
    ok(!/#ef4444 !important/.test(html), '停止态不做红色突跳（颜色统一，DSH 式）');
    // 设置迁移：★ 2026-10 起旧的两套设置（agentPermission / agentApproval）
    // 合并成三档 agentAccess，所以这里断言的是**新的**迁移逻辑。
    ok(/settingsVersion/.test(html), '有 settingsVersion 迁移标记');
    ok(/legacyPermission === 'computer'\) \? 'full' : 'strict'/.test(html),
        '迁移逻辑：旧 computer → full，其余 → strict');
    // busy 时按钮可见
    ok(/busy \|\| Boolean\(elements\.initialTextInput\.value\.trim\(\)\)/.test(html), 'busy 时按钮强制可见');
    // 停止时安静收尾
    ok(/回复已被用户停止，安静收尾/.test(html), '停止后不弹错误框');
    ok(/stopActiveVoicePlayback\(\)/.test(html.replace(/async function stopActiveVoicePlayback[\s\S]*?\n        \}/, '')) ||
       /void stopActiveVoicePlayback\(\);/.test(html), '停止时同步停掉语音');
    // providers 透传
    ok((providers.match(/opts\.signal/g) || []).length >= 3, '三种协议都透传 signal');
}

console.log('\n' + '='.repeat(46));
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (fail) console.log('  失败项：' + failures.join('、'));
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
