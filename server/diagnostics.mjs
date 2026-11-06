// 诊断输出：让完全不了解本软件的人（或 AI）也能从日志里看懂「这是什么」「我该做什么」「哪里有问题」「怎么修」—— 文案是纯函数产出，能穷举断言"每条问题都必须有原因和下一步"。
// 排版按"用户要做什么"排序、一个意思只说一遍、要照着敲的东西单独成块、技术细节收进「技术信息」块；每条问题三段式（发生了什么 / 为什么 / 怎么办），怎么办必须具体到能照做。

/** 状态图标。四个符号语义固定，不要混用。 */
export const MARK = {
    ok: '✔',        // 正常
    note: '○',      // 正常，但用户可能想知道（如"默认关闭"）
    warn: '⚠',      // 能跑，但可能不是用户想要的状态
    bad: '✘',       // 坏了，功能不可用
};

const IND = '  ';
const SUB = '      ';
const RULE = '='.repeat(64);

/** 启动头：极简，只回答"这是什么" —— 说明性内容该由文档承担，放进每次启动都要滚过去的日志只会变成噪音。 */
export function banner(ctx) {
    return [
        RULE,
        ` ${ctx.name} v${ctx.version}`,
        ` ${ctx.tagline || '本地运行的 AI 角色聊天应用 —— 数据都存在这台电脑上，不经过第三方服务器'}`,
        RULE,
    ].join('\n');
}

/** 「怎么用」块：地址和密码是要照着输入的内容，和说明文字混排时很容易被看漏，这里用缩进 + 图标把它们顶出来。 */
export function usage(items, heading = '怎么用') {
    const rows = [section(heading)];
    for (const it of items) {
        const mark = MARK[it.state || 'ok'];
        rows.push(`${IND}${mark} ${it.label}`);
        if (it.value) rows.push(`${SUB}${it.value}`);
        if (it.hint) rows.push(`${SUB}${it.hint}`);
    }
    return rows.join('\n');
}

export function section(title) {
    return `\n【${title}】`;
}

export function checklist(items, title = '启动检查') {
    const rows = [title ? section(title) : ''];
    for (const it of items) {
        const mark = MARK[it.state] || MARK.note;
        rows.push(`${IND}${mark} ${it.label}${it.detail ? '   ' + it.detail : ''}`);
        if (it.hint) rows.push(`${SUB}${it.hint}`);
    }
    return rows.join('\n');
}

/** 技术信息块：Node 版本、进程号、日志路径这些每次启动都打、但 99% 的时候用户不需要看的东西 —— 放最后、统一缩进，既不挡视线又好找。 */
export function techInfo(pairs, heading = '技术信息（出问题时连同上面的内容一起复制给别人）') {
    const rows = [section(heading)];
    for (const [k, v] of pairs) {
        if (v === undefined || v === null || v === '') continue;
        rows.push(`${IND}${k}：${v}`);
    }
    return rows.join('\n');
}

/** 单个问题的三段式报告：what 说清发生了什么，why 说清原因，how 给出具体到能照做的下一步 —— 三者缺一，用户就得自己猜，而"猜"正是这个模块要消灭的东西。 */
export function problem(p) {
    const rows = [`${MARK.bad} ${p.what}`];
    if (p.where) rows.push(`${IND}位置：${p.where}`);
    if (p.why) rows.push(`${IND}原因：${p.why}`);
    const how = Array.isArray(p.how) ? p.how : (p.how ? [p.how] : []);
    if (how.length === 1) {
        rows.push(`${IND}怎么办：${how[0]}`);
    } else if (how.length > 1) {
        rows.push(`${IND}怎么办（任选一种）：`);
        how.forEach((h, i) => rows.push(`${SUB}${i + 1}) ${h}`));
    }
    return rows.join('\n');
}

/** 收尾：只在真有问题时出现（开头已经说清"服务已启动，可以用了"，再打一条"一切正常"只是重复）；无问题时返回空串（调用方 console.log 空串会被日志系统丢弃）。 */
export function summary(problems) {
    if (!problems || !problems.length) return '';
    const rows = ['', RULE, `${MARK.bad} 有 ${problems.length} 项需要处理（逐条见上）：`];
    problems.forEach((t, i) => rows.push(`${IND}${i + 1}. ${String(t).split('\n')[0]}`));
    rows.push('');
    rows.push(`${IND}处理完后重新启动本程序即可。`);
    rows.push(RULE);
    return rows.join('\n');
}

/** 插件状态的中文说明。状态名（ready/disabled/blocked/error/pending）与 web/js/mods-summary.js 的 STATE_LABEL 是同一套；中文措辞两侧按版面取舍，但同一状态的语义必须对应，不能一边读着像成功、另一边像失败。 */
export const MOD_STATE_LABEL = {
    ready: '已加载',
    disabled: '未启用（插件默认关闭，属正常状态）',
    blocked: '已拒绝加载（它依赖的前置插件不可用）',
    error: '加载失败',
    pending: '正在加载',
};

/** 把插件清单渲染成人能读懂的说明：`elaina-avatar=disabled galgame=ready` 那种键值对是机器视角，看不出"前置没启用、依赖它的却起来了"这个关键矛盾。 */
export function describePlugins(plugins) {
    const problems = [];
    if (!plugins.length) {
        return {
            text: `${IND}${MARK.note} 没有安装任何插件（程序本体的文字聊天不受影响）。\n`
                + `${SUB}想加功能就到「设置 → 插件」上传扩展包。`,
            problems,
        };
    }

    const byState = { ready: [], disabled: [], bad: [] };
    const label = (p) => (p.name && p.name !== p.id ? `${p.name}（${p.id}）` : p.id);
    for (const p of plugins) {
        if (p.state === 'ready') byState.ready.push(p);
        else if (p.state === 'disabled') byState.disabled.push(p);
        else byState.bad.push(p);
    }

    const rows = [];
    rows.push(`${IND}共 ${plugins.length} 个：`
        + `可用 ${byState.ready.length}`
        + (byState.disabled.length ? ` · 未启用 ${byState.disabled.length}` : '')
        + (byState.bad.length ? ` · 有问题 ${byState.bad.length}` : ''));

    if (byState.ready.length) {
        rows.push(`${SUB}${MARK.ok} 可用：${byState.ready.map(label).join('、')}`);
        for (const p of byState.ready) {
            if (p.dir && p.dir !== p.id) {
                rows.push(`${SUB}   · ${p.name || p.id} 实际装在目录 ${p.dir}/（它的 id 是 ${p.id}）`);
            }
        }
    }
    if (byState.disabled.length) {
        rows.push(`${SUB}${MARK.note} 未启用（正常的，插件默认关闭）：${byState.disabled.map(label).join('、')}`);
        rows.push(`${SUB}  需要用就到「设置 → 插件」打开开关，然后刷新页面。`);
    }
    for (const p of byState.bad) {
        const dirNote = p.dir && p.dir !== p.id ? `（装在 ${p.dir}/）` : '';
        rows.push(`${SUB}${MARK.bad} ${label(p)}${dirNote}：${MOD_STATE_LABEL[p.state] || p.state}`);
        if (p.error) rows.push(`${SUB}   ${p.error}`);
        problems.push(`${MARK.bad} 插件「${label(p)}」${MOD_STATE_LABEL[p.state] || p.state}`);
    }
    return { text: rows.join('\n'), problems };
}
