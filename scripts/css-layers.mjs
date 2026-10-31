// CSS 分层分析：内联 <style> 与外链样式表谁在赢。
//
// 为什么需要它：外链样式表在 <style> 之后加载，又普遍带 `html.rd` 前缀和
// !important。于是内联里写的规则可能**整条都轮不到生效** —— 看起来能改，
// 改了却没反应。这类规则不是"重复"，是"注定输"，应当被检查挡住。
//
// 判据（可证明，不是启发式）：一条内联规则被判为"整条被覆盖"，当且仅当它的
// 每一个属性声明，都能在外链里找到一条规则满足：
//   · 选择器最右复合部分相同（作用于同一类元素）；
//   · 前缀为空或 `html.rd`（匹配集合是内联规则的超集，不依赖特定容器）；
//   · 声明了同一属性，且 !important 等级不低于内联、特异性更高。
// 这样的外链规则必然胜出（它加载更晚、权重不低），删掉内联那条不会改变任何
// 元素的最终计算值。

/** 把注释替换成等长空白（保留换行），这样偏移与行号仍然对得上原文。 */
export function blankComments(css) {
    let out = '';
    let i = 0;
    let inComment = false;
    while (i < css.length) {
        if (inComment) {
            if (css[i] === '*' && css[i + 1] === '/') { inComment = false; out += '  '; i += 2; continue; }
            out += css[i] === '\n' ? '\n' : ' ';
            i++;
            continue;
        }
        if (css[i] === '/' && css[i + 1] === '*') { inComment = true; out += '  '; i += 2; continue; }
        out += css[i];
        i++;
    }
    return out;
}

/** 解析顶层规则（跳过 @ 块内部，条件规则不算"无条件覆盖"）。 */
export function parseTopLevelRules(css) {
    const text = blankComments(css);
    const rules = [];
    const atStack = [];
    let i = 0;
    let buf = '';
    const lineAt = (offset) => text.slice(0, offset).split('\n').length;
    // 扫描时要跳过引号内的 { } ; —— data: URL 与 content 值里会出现这些字符，
    // 不跳过会把一条声明劈成两半（多出来的碎片会被当成不存在的属性）。
    const matchClose = (open) => {
        let depth = 1;
        let j = open + 1;
        let quote = '';
        while (j < text.length && depth > 0) {
            const ch = text[j];
            if (quote) {
                if (ch === '\\') { j += 2; continue; }
                if (ch === quote) quote = '';
                j++;
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; j++; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            j++;
        }
        return j;
    };
    /** 按 ; 切声明，跳过引号内的分号（data: URL 里就有）。 */
    const splitDecls = (from, to) => {
        const parts = [];
        let start = from;
        let quote = '';
        for (let k = from; k < to; k++) {
            const ch = text[k];
            if (quote) {
                if (ch === '\\') { k++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === ';') { parts.push(text.slice(start, k)); start = k + 1; }
        }
        parts.push(text.slice(start, to));
        return parts;
    };
    while (i < text.length) {
        const ch = text[i];
        if (ch === '{') {
            const prelude = buf.trim().replace(/\s+/g, ' ');
            buf = '';
            if (prelude.startsWith('@')) { atStack.push(prelude); i++; continue; }
            const close = matchClose(i);
            const decls = [];
            for (const part of splitDecls(i + 1, close - 1)) {
                const colon = part.indexOf(':');
                if (colon < 0) continue;
                const prop = part.slice(0, colon).trim().toLowerCase();
                if (!/^[a-z-]+$/.test(prop)) continue;
                const raw = part.slice(colon + 1);
                decls.push({ prop, important: /!important/i.test(raw) });
            }
            rules.push({ line: lineAt(i), selector: prelude, at: atStack.join(' >> '), decls });
            i = close;
            continue;
        }
        if (ch === '}') { atStack.pop(); buf = ''; i++; continue; }
        buf += ch;
        i++;
    }
    return rules;
}

/** 选择器最右一段复合选择器（`.a > .b:hover` → `.b:hover`）。 */
export function rightmostCompound(selector) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of selector) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts[parts.length - 1];
}

/** 粗略特异性：id × 10000 + 类/属性/伪类 × 100 + 元素/伪元素。比较够用即可。 */
export function specificity(selector) {
    const s = selector.replace(/\[[^\]]*\]/g, (m) => '.' + 'x'.repeat(m.length));
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+/g) || []).length + (s.match(/:(?!:)[\w-]+/g) || []).length;
    const elements = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length + (s.match(/::[\w-]+/g) || []).length;
    return ids * 10000 + classes * 100 + elements;
}

function prefixOf(selector) {
    const rm = rightmostCompound(selector);
    return selector.slice(0, selector.lastIndexOf(rm)).trim();
}

/** 覆盖层里"可能无条件胜出"的选择器（前缀为空或 html.rd），按选择器展开。 */
function collectExternal(externalCssList) {
    const external = [];
    for (const { file, css } of externalCssList) {
        for (const rule of parseTopLevelRules(css)) {
            if (rule.at) continue;
            for (const selector of rule.selector.split(',').map((s) => s.trim())) {
                const prefix = prefixOf(selector);
                if (prefix !== '' && prefix !== 'html.rd') continue;
                external.push({ file, ...rule, selector, spec: specificity(selector), rm: rightmostCompound(selector) });
            }
        }
    }
    return external;
}

/**
 * 这条声明是否"注定输"：对规则里的**每个**选择器，都能在覆盖层找到
 * 最右复合选择器相同、同属性、权重更高的声明。
 */
function isDeclarationOverridden(decl, selectors, external) {
    return selectors.every((selector) => {
        const rm = rightmostCompound(selector);
        const spec = specificity(selector);
        return external.some((e) => e.rm === rm
            && e.decls.some((d) => d.prop === decl.prop
                && ((d.important && !decl.important) || (d.important === decl.important && e.spec > spec))));
    });
}

/**
 * @param {string} layerCss 先加载的那一层（基础样式层）
 * @param {{file: string, css: string}[]} externalCssList 覆盖层（按加载顺序）
 * @returns {{line: number, selector: string}[]} 整条被外链覆盖的规则
 */
export function findFullyOverriddenRules(layerCss, externalCssList) {
    const external = collectExternal(externalCssList);
    const dead = [];
    for (const rule of parseTopLevelRules(layerCss)) {
        if (rule.at || !rule.decls.length) continue;
        const selectors = rule.selector.split(',').map((s) => s.trim());
        if (rule.decls.every((decl) => isDeclarationOverridden(decl, selectors, external))) {
            dead.push({ line: rule.line, selector: rule.selector });
        }
    }
    return dead;
}

/**
 * 逐条声明的同一判据：整条规则没死，里面的某条声明仍可能死。
 * 删掉这种声明不改变任何元素的最终计算值，但改它不会有任何反应。
 *
 * @returns {{line: number, selector: string, prop: string}[]}
 */
export function findOverriddenDeclarations(layerCss, externalCssList) {
    const external = collectExternal(externalCssList);
    const dead = [];
    for (const rule of parseTopLevelRules(layerCss)) {
        if (rule.at || !rule.decls.length) continue;
        const selectors = rule.selector.split(',').map((s) => s.trim());
        for (const decl of rule.decls) {
            if (isDeclarationOverridden(decl, selectors, external)) {
                dead.push({ line: rule.line, selector: rule.selector, prop: decl.prop });
            }
        }
    }
    return dead;
}
