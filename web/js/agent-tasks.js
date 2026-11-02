/* ============================================================================
 * AI 定时任务（从 agent.js 拆出）
 *
 * [任务:...] 解析、创建 / 取消 / 列表、到期触发、设置页列表渲染。
 * 依赖宿主的 Store / callAI / 会话与消息函数（经典脚本全局）。
 * ========================================================================== */
'use strict';

// ==================== AI 定时任务（未来任务） ====================
// LLM 回复可用 [任务:每天 09:00 提醒我喝水] 创建定时任务；到点 AI 以角色身份发消息。
// 支持格式：每天 / 明天 / 每周X + HH:MM；每N小时/分钟/天；N分钟后；仅 HH:MM（今天该时间）。
const TASK_STORE_KEY = 'elaina_open_tasks';

function loadScheduledTasks() {
    try {
        const arr = JSON.parse(Store.getItem(TASK_STORE_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function saveScheduledTasks(tasks) {
    try { Store.setItem(TASK_STORE_KEY, JSON.stringify(tasks)); } catch { /* ignore */ }
}

// 解析单个 [任务:...] 标签 → { content, intervalMs, nextAt }
function parseTaskTag(text) {
    if (!text) return null;
    // 剥掉 [任务: ] 外壳（兼容传入完整标签或纯内容）
    const m = String(text).match(/\[任务[:：]\s*([^\]]+)\]/);
    const raw = (m ? m[1] : String(text)).trim();
    if (!raw) return null;
    const now = new Date();
    let content = raw;
    let intervalMs = 0;
    let nextAt = null;
    let timeMatch = raw.match(/(\d{1,2}):(\d{2})/);
    let freqMatch;

    if ((freqMatch = raw.match(/每\s*(\d+)\s*(小时|分钟|天)/))) {
        const n = parseInt(freqMatch[1], 10);
        const unit = freqMatch[2];
        intervalMs = unit === '小时' ? n * 3600000 : (unit === '天' ? n * 86400000 : n * 60000);
        nextAt = now.getTime() + intervalMs;
        content = raw.replace(freqMatch[0], '');
    } else if ((freqMatch = raw.match(/每周([一二三四五六日天])/))) {
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        const daysAhead = (weekMap[freqMatch[1]] - d.getDay() + 7) % 7;
        d.setDate(d.getDate() + daysAhead);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 7);
        nextAt = d.getTime();
        intervalMs = 7 * 86400000;
        content = raw.replace(freqMatch[0], '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if (raw.includes('每天')) {
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        nextAt = d.getTime();
        intervalMs = 86400000;
        content = raw.replace(/每天/, '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if (raw.includes('明天')) {
        const hh = timeMatch ? parseInt(timeMatch[1], 10) : 9;
        const mm = timeMatch ? parseInt(timeMatch[2], 10) : 0;
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        d.setHours(hh, mm, 0, 0);
        nextAt = d.getTime();
        content = raw.replace(/明天/, '').replace(/(\d{1,2}):(\d{2})/, '');
    } else if ((freqMatch = raw.match(/(\d+)\s*分钟\s*后/))) {
        nextAt = now.getTime() + parseInt(freqMatch[1], 10) * 60000;
        content = raw.replace(freqMatch[0], '');
    } else if (timeMatch) {
        const hh = parseInt(timeMatch[1], 10);
        const mm = parseInt(timeMatch[2], 10);
        const d = new Date(now);
        d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
        nextAt = d.getTime();
        content = raw.replace(/(\d{1,2}):(\d{2})/, '');
    } else {
        nextAt = now.getTime() + 3600000; // 无时间信息默认 1 小时后
    }
    content = content.replace(/[，,。.\s]+$/g, '').trim();
    if (!content) content = '定时提醒';
    return { content, intervalMs, nextAt };
}

function createScheduledTask(desc) {
    const parsed = parseTaskTag(desc);
    if (!parsed || !parsed.nextAt) return null;
    const task = {
        id: generateId(),
        content: parsed.content,
        intervalMs: parsed.intervalMs,
        nextAt: parsed.nextAt,
        createdAt: Date.now()
    };
    const tasks = loadScheduledTasks();
    tasks.push(task);
    saveScheduledTasks(tasks);
    return task;
}

function cancelScheduledTask(id) {
    saveScheduledTasks(loadScheduledTasks().filter(t => t.id !== id));
}

function listScheduledTasks() {
    return loadScheduledTasks().sort((a, b) => a.nextAt - b.nextAt);
}

// 从 AI 回复提取 [任务:...] 标签并注册，返回创建数量
function extractAndCreateTasks(text) {
    if (!text) return 0;
    const matches = String(text).match(/\[任务[:：][^\]]*\]/g);
    if (!matches) return 0;
    let count = 0;
    let nextTime = null;
    for (const m of matches) {
        const task = createScheduledTask(m);
        if (task) {
            count++;
            if (!nextTime || task.nextAt < nextTime) nextTime = task.nextAt;
            console.log('[任务] 已创建:', task.content, new Date(task.nextAt).toLocaleString());
        }
    }
    if (count) {
        const tip = nextTime ? `下次：${new Date(nextTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
        showCustomAlert(`✅ 已为你创建 ${count} 个定时任务（${tip}），到点我会主动提醒你。`, '定时任务');
    }
    return count;
}

// 到期触发：AI 以角色身份生成提醒消息，插入当前对话
async function fireScheduledTask(task) {
    const conv = getCurrentConversation();
    if (!conv) {
        console.warn('[任务] 无当前对话，跳过触发:', task.content);
        return;
    }
    try {
        const raw = await callAI(`（定时提醒任务）请以你的角色身份，用一两句话自然提醒我这件事，不要提及"定时任务"或"提醒"：${task.content}`);
        const text = window.ElainaTags ? window.ElainaTags.strip(raw) : raw;
        const aiMessage = { id: generateId(), role: 'ai', text, timestamp: new Date().toLocaleTimeString() };
        conv.messages.push(aiMessage);
        saveConversations();
        if (window.ElainaTags) window.ElainaTags.drive(raw);
        if (state.currentConversationId === conv.id) {
            renderMessage(aiMessage);
        }
        // 浏览器通知（可选）
        try {
            if (window.Notification && Notification.permission === 'granted') {
                new Notification('ElainaChat · ' + (state.characterCard.name || '伊蕾娜'), { body: task.content });
            }
        } catch { /* ignore */ }
        console.log('[任务] 已触发:', task.content);
    } catch (error) {
        console.error('[任务] 触发失败:', error?.message || error);
    }
}

// 调度检查：每 30s 扫一次到期任务
function checkScheduledTasks() {
    const now = Date.now();
    const tasks = loadScheduledTasks();
    const due = tasks.filter(t => t.nextAt && t.nextAt <= now);
    if (!due.length) return;
    let changed = false;
    for (const t of due) {
        void fireScheduledTask(t);
        if (t.intervalMs > 0) {
            t.nextAt = now + t.intervalMs;
            changed = true;
        } else {
            tasks.splice(tasks.indexOf(t), 1);
            changed = true;
        }
    }
    if (changed) saveScheduledTasks(tasks);
}

// 设置页任务列表渲染
function renderScheduledTaskList() {
    const listEl = document.getElementById('scheduledTaskList');
    if (!listEl) return;
    const tasks = listScheduledTasks();
    if (!tasks.length) {
        listEl.innerHTML = '<p class="text-[11px] text-indigo-300">（暂无任务）</p>';
        return;
    }
    listEl.innerHTML = tasks.map(t => `
        <div class="flex items-center justify-between gap-2 bg-white/60 border border-indigo-100 rounded-lg px-3 py-2">
            <div class="min-w-0">
                <div class="text-xs text-indigo-800 truncate">${escapeHtml(t.content)}</div>
                <div class="text-[11px] text-indigo-400">下次：${new Date(t.nextAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${t.intervalMs > 0 ? '（周期）' : '（一次）'}</div>
            </div>
            <button type="button" class="btn-secondary text-xs text-red-500" onclick="window.__cancelScheduledTask('${safeAttrId(t.id)}')">取消</button>
        </div>
    `).join('');
}
window.__cancelScheduledTask = function (id) {
    cancelScheduledTask(id);
    renderScheduledTaskList();
};


