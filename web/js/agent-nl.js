/* ============================================================================
 * Agent 自然语言表情与记忆整理（从 agent.js 拆出）
 *
 * maybeAutoExpression / NL_EXPRESSION_MAP / runManualMemorySummary。
 * 依赖宿主 callAI / 消息与存储函数（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== 自然语言触发表情 =====
// 用户说「做出XX表情」时直接驱动 Live2D 表情（不依赖 AI 输出标签）。
const NL_EXPRESSION_MAP = {
    '星星眼': '星星眼', '星星眼表情': '星星眼',
    '开心': 'happy', '高兴': 'happy', '微笑': 'smile', '笑': 'happy', '笑容': 'smile',
    '难过': 'sad', '伤心': 'sad', '悲伤': 'sad', '哭': 'cry', '委屈': 'cry', '哭哭': 'cry',
    '生气': 'angry', '愤怒': 'angry', '凶': 'angry', '气鼓鼓': 'angry',
    '害羞': 'shy', '脸红': 'blush', '娇羞': 'shy',
    '惊讶': 'surprised', '震惊': 'surprised', '吃惊': 'surprised',
    '思考': 'think', '疑惑': 'think', '晕': 'dizzy', '头晕': 'dizzy',
    '平静': 'calm', '淡定': 'calm', '正常': 'default'
};
function maybeAutoExpression(text) {
    const s = String(text || '');
    // 直接说特征表情名（星星眼等）或带"表情/脸"字样都算
    const featureHit = Object.keys(NL_EXPRESSION_MAP).find(k => s.includes(k));
    if (!/(表情|脸)/.test(s) && !featureHit) return false;
    // "做出/做个/表演/展示/来一个/露出 + 表情名 + (的)表情/脸"
    const m = s.match(/(?:做出|做|表演|展示|摆出|来一个|来个|露出|弄个?|换)\s*(?:一个|个|一下)?\s*([\u4e00-\u9fff]{2,4}?)(?:的)?(?:表情|脸)/);
    let name = m ? m[1] : '';
    if (!name) name = featureHit || '';
    if (!name) return false;
    // 去掉尾部可能带上的"的"
    name = name.replace(/的$/, '');
    const target = NL_EXPRESSION_MAP[name] || name;
    const l2d = live2dService();
    if (l2d && typeof l2d.setExpression === 'function') {
        console.log('[Live2D] 自然语言触发表情:', name, '→', target);
        void l2d.setExpression(target);
        return true;
    }
    return false;
}


// ===== 自然语言触发文件写入（不提供）=====
// 文件写入一律走 AI 输出 [操作:保存文件 …]：前端用正则解析用户消息会绕过 AI、正则容易误伤、与授权流程脱节。
// 也别加回「待写入 AI 留言」这类中间状态：它唯一的写入者是一个前端正则，留着就是「看起来能用、实际永不可达」的陷阱代码。

async function runManualMemorySummary() {
    // 返回值是**给工具通道用的**：这条函数经 ElainaOps.invoke → runToolCalls 调用，
    //   没有返回值就会被读成「没有返回结果」，模型分不清"整理好了"和"整理失败"。
    if (state.memorySummaryRunning) {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
        return { ok: false, text: '记忆整理正在进行中' };
    }

    setManualMemoryUi(true);
    let result;
    try {
        result = await requestMemorySummary();
    } catch (error) {
        console.error('[记忆] 手动整理失败:', error);
        result = { ok: false, reason: 'failed', error };
    } finally {
        setManualMemoryUi(false);
        closeComposerToolsMenu();
    }

    if (result.ok) {
        if (state.diaryMode) renderDiaryPage();
        const preview = formatMemoryForPrompt(1);
        showCustomAlert('当前对话已整理完毕，经历已汇入伊蕾娜的通用记忆本，所有对话都会记得。\n\n' + (preview || '（记忆内容已保存）').slice(0, 400), '记忆整理完成');
        return { ok: true, text: '当前对话已整理完毕，经历已汇入长期记忆。' };
    }
    if (result.reason === 'empty') {
        showCustomAlert('当前会话还没有可整理的内容，先和伊蕾娜聊几句吧。', '记忆整理');
        return { ok: false, text: '当前会话还没有可整理的内容' };
    }
    if (result.reason === 'parse-fail') {
        showCustomAlert('模型返回的整理结果格式异常，请稍后再试。', '记忆整理');
        return { ok: false, text: '模型返回的整理结果格式异常' };
    }
    if (result.reason === 'busy') {
        showCustomAlert('记忆整理正在进行中，请稍候。', '记忆整理');
        return { ok: false, text: '记忆整理正在进行中' };
    }
    if (result.error) {
        showClientApiError(result.error);
        return { ok: false, text: '记忆整理失败：' + String((result.error && result.error.message) || result.error) };
    }
    showCustomAlert('记忆整理失败，请检查 API 配置。', '记忆整理');
    return { ok: false, text: '记忆整理失败，请检查 API 配置' };
}


