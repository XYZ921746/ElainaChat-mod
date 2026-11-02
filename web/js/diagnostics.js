// 前端诊断输出：与 server/diagnostics.mjs 同一套格式，两端日志读起来是一回事。
// 日志是给用户看的（贴出来求助时也能看懂），所以每条输出必须：
//   ① 自报家门：哪个模块在说话、负责什么；
//   ② 三段式：发生了什么 / 为什么 / 怎么办；
//   ③ 怎么办要能照做（给出界面位置），而不是"请检查配置"；
//   ④ 区分正常与故障：默认关闭、尚未配置属于正常，不该报警；
//   ⑤ 不用内部标识符当主语（「桌宠（pet）」而不是裸 pet）。
// 状态图标、文案与 server/diagnostics.mjs 保持一致；改动时两边一起改，
// 由 scripts/check-log.mjs 的"文案一致"断言盯着。
// 普通脚本（非 ES module），以 window.ElainaDiag 暴露。
(function () {
    'use strict';

    /** 状态图标。与 server/diagnostics.mjs 的 MARK 一一对应。 */
    var MARK = {
        ok: '✔',      // 正常
        note: '○',    // 正常，但用户可能想知道
        warn: '⚠',    // 能跑，但可能不是用户想要的状态
        bad: '✘',     // 坏了，功能不可用
    };

    var IND = '  ';
    var SUB = '      ';

    /**
     * 一个模块的自述标题。
     *
     * 为什么要它：日志里同时有 Live2D、语音、插件、Agent 在说话。
     * 每条输出前面带上"我是谁、我负责什么"，读者才知道该往哪看。
     *
     * @param {string} name 模块名（如「插件系统」）
     * @param {string} duty 一句话职责（写给外行）
     * @returns {string}
     */
    function title(name, duty) {
        return '【' + name + '】' + (duty ? '（' + duty + '）' : '');
    }

    /**
     * 检查清单：逐项给状态与说明。
     * @param {Array<{state:string,label:string,detail?:string,hint?:string}>} items
     * @param {string} [heading]
     */
    function checklist(items, heading) {
        var rows = [heading ? title(heading) : ''];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var mark = MARK[it.state] || MARK.note;
            rows.push(IND + mark + ' ' + it.label + (it.detail ? '   ' + it.detail : ''));
            if (it.hint) rows.push(SUB + it.hint);
        }
        return rows.join('\n');
    }

    /**
     * 三段式问题报告。what / why / how 缺一，用户就得自己猜。
     * @param {{what:string, why?:string, how?:string|string[], where?:string}} p
     */
    function problem(p) {
        var rows = [MARK.bad + ' ' + p.what];
        if (p.where) rows.push(IND + '位置：' + p.where);
        if (p.why) rows.push(IND + '原因：' + p.why);
        var how = Array.isArray(p.how) ? p.how : (p.how ? [p.how] : []);
        if (how.length === 1) rows.push(IND + '怎么办：' + how[0]);
        else if (how.length > 1) {
            rows.push(IND + '怎么办（任选一种）：');
            for (var i = 0; i < how.length; i++) rows.push(SUB + (i + 1) + ') ' + how[i]);
        }
        return rows.join('\n');
    }

    /**
     * 收尾汇总：把"需要处理"的集中列一遍，或明确说"一切正常"。
     *
     * 为什么"一切正常"也必须打一句：日志里"什么都没有"与"一切正常"
     * 在视觉上无法区分 —— 用户会以为日志坏了（这个坑实际发生过）。
     */
    function summary(problems, opts) {
        opts = opts || {};
        var rows = [];
        if (!problems || !problems.length) {
            rows.push(MARK.ok + ' 一切正常。');
            var notes = opts.notes || [];
            for (var i = 0; i < notes.length; i++) rows.push(IND + MARK.note + ' ' + notes[i]);
        } else {
            rows.push(MARK.bad + ' 有 ' + problems.length + ' 项需要处理（逐条见上）：');
            for (var j = 0; j < problems.length; j++) {
                rows.push(IND + (j + 1) + '. ' + String(problems[j]).split('\n')[0]);
            }
            if (opts.after) rows.push(IND + opts.after);
        }
        return rows.join('\n');
    }

    window.ElainaDiag = {
        MARK: MARK,
        title: title,
        checklist: checklist,
        problem: problem,
        summary: summary,
    };
})();
