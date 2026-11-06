// 流式输出：SSE 增量解析 + 各协议增量合成，合成为与非流式同构的 payload 交回 chat-providers.js 解析。
// APK 原生请求没有流通道、部分中转不支持 stream，调用方失败即退回非流式。

(function () {
    'use strict';

    function parseSseData(data) {
        const text = String(data || '').trim();
        if (!text || text === '[DONE]') return null;
        try { return JSON.parse(text); } catch { return null; }
    }

    // 带空闲超时地读一块：SSE 只可能在两块数据之间卡死，计时按间隔算、每块重置；错误里带 "timeout" 字样供上游归为可重试。
    async function readChunkWithIdleTimeout(reader, idleMs) {
        if (!(idleMs > 0)) return reader.read();
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error('流式读取超时（timeout）：'
                    + Math.round(idleMs / 1000) + ' 秒没有收到新数据，连接已断开。');
                err.name = 'StreamIdleTimeout';
                reader.cancel().catch(() => {});
                reject(err);
            }, idleMs);
        });
        try {
            return await Promise.race([reader.read(), timeoutPromise]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function readSse(reader, onEvent, idleTimeoutMs = 0) {
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let eventName = null;
        let dataLines = [];

        const flush = () => {
            if (dataLines.length) onEvent({ event: eventName, data: dataLines.join('\n') });
            eventName = null;
            dataLines = [];
        };

        for (;;) {
            const { done, value } = await readChunkWithIdleTimeout(reader, idleTimeoutMs);
            if (done) break;
            // stream: true 让多字节 UTF-8 跨块时不被截断成乱码。
            buffer += decoder.decode(value, { stream: true });

            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                let line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);

                if (line === '') { flush(); continue; }        // 空行 = 事件结束
                if (line.startsWith(':')) continue;             // 注释/心跳，忽略
                if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
                if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); continue; }
            }
        }
        if (buffer.trim()) {
            const line = buffer.replace(/\r$/, '');
            if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        flush();
    }

    // 各协议的增量提取：返回 { kind: 'text'|'reasoning'|'toolcall'|'done', … }，空数组表示无贡献；
    // toolcall 是一片，必须按 index 累积，不能逐片用。
    function extractOpenAICompatible(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const choice = payload.choices?.[0];
        if (!choice) return [];
        const delta = choice.delta || {};
        const out = [];
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) out.push({ kind: 'reasoning', text: String(reasoning) });
        if (delta.content) out.push({ kind: 'text', text: String(delta.content) });
        if (Array.isArray(delta.tool_calls)) {
            for (const part of delta.tool_calls) out.push({ kind: 'toolcall', part });
        }
        if (choice.finish_reason) out.push({ kind: 'done', finishReason: String(choice.finish_reason) });
        return out;
    }

    function extractAnthropic(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const type = payload.type || event.event;
        if (type === 'content_block_delta') {
            const delta = payload.delta || {};
            if (delta.type === 'thinking_delta' && delta.thinking) {
                return [{ kind: 'reasoning', text: String(delta.thinking) }];
            }
            if (delta.type === 'text_delta' && delta.text) {
                return [{ kind: 'text', text: String(delta.text) }];
            }
            if (delta.type === 'input_json_delta') {
                return [{
                    kind: 'toolcall',
                    part: { index: payload.index, function: { arguments: String(delta.partial_json || '') } },
                }];
            }
            return [];
        }
        if (type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
            const block = payload.content_block;
            return [{
                kind: 'toolcall',
                part: { index: payload.index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
            }];
        }
        if (type === 'message_delta' && payload.delta?.stop_reason) {
            return [{ kind: 'done', finishReason: String(payload.delta.stop_reason) }];
        }
        if (type === 'message_stop') return [{ kind: 'done' }];
        return [];
    }

    /** openai-responses：response.output_text.delta / reasoning 摘要增量 */
    function extractOpenAIResponses(event) {
        const payload = parseSseData(event.data);
        if (!payload) return [];
        const type = payload.type || event.event;
        if (type === 'response.output_text.delta' && payload.delta) {
            return [{ kind: 'text', text: String(payload.delta) }];
        }
        if ((type === 'response.reasoning_summary_text.delta'
            || type === 'response.reasoning_text.delta') && payload.delta) {
            return [{ kind: 'reasoning', text: String(payload.delta) }];
        }
        if (type === 'response.completed' || type === 'response.failed') return [{ kind: 'done' }];
        return [];
    }

    const EXTRACTORS = Object.freeze({
        'openai-compatible': extractOpenAICompatible,
        'anthropic': extractAnthropic,
        'openai-responses': extractOpenAIResponses,
    });

    // 合成：把增量拼回与非流式同构的 payload，chat-providers.js 的解析代码一个字都不用改（流式与非流式走同一段解析）。
    function accumulateToolCall(acc, part) {
        if (!part) return;
        const known = [...acc.toolCalls.keys()];
        const index = Number.isInteger(part.index) ? part.index : (known.length ? known[known.length - 1] : 0);
        const rec = acc.toolCalls.get(index) || { index, id: '', name: '', args: '' };
        if (part.id) rec.id = String(part.id);
        const fn = part.function || {};
        if (fn.name) rec.name += String(fn.name);
        if (fn.arguments) rec.args += String(fn.arguments);
        acc.toolCalls.set(index, rec);
    }

    function collectToolCalls(acc) {
        if (!acc.toolCalls || !acc.toolCalls.size) return [];
        return [...acc.toolCalls.values()]
            .filter((c) => c.name)
            .map((c) => ({ id: c.id || '', type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
    }

    function parseToolArgs(text) {
        try { return JSON.parse(text || '{}'); } catch { return {}; }
    }

    function composeOpenAICompatible(acc) {
        const calls = collectToolCalls(acc);
        const message = { role: 'assistant', content: acc.text };
        if (acc.reasoning) message.reasoning_content = acc.reasoning;
        if (calls.length) message.tool_calls = calls;
        return { choices: [{ message, finish_reason: acc.finishReason || (calls.length ? 'tool_calls' : 'stop') }] };
    }

    function composeAnthropic(acc) {
        const content = [];
        if (acc.reasoning) content.push({ type: 'thinking', thinking: acc.reasoning });
        content.push({ type: 'text', text: acc.text });
        const calls = collectToolCalls(acc);
        for (const call of calls) {
            content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseToolArgs(call.function.arguments) });
        }
        return { content, stop_reason: acc.finishReason || (calls.length ? 'tool_use' : 'end_turn') };
    }

    function composeOpenAIResponses(acc) {
        const output = [];
        if (acc.reasoning) output.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: acc.reasoning }] });
        output.push({
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: acc.text }],
        });
        return { output };
    }

    const COMPOSERS = Object.freeze({
        'openai-compatible': composeOpenAICompatible,
        'anthropic': composeAnthropic,
        'openai-responses': composeOpenAIResponses,
    });

    // onDelta 只回调正文与思维链（工具片段要整路拼完才有意义）；回调里抛错会中断整条流。
    async function consumeStream(response, format, onDelta, idleTimeoutMs = 0) {
        const extractor = EXTRACTORS[format] || extractOpenAICompatible;
        const acc = { text: '', reasoning: '', toolCalls: new Map(), finishReason: '' };
        if (!response.body || typeof response.body.getReader !== 'function') {
            throw new Error('响应没有可读流（该环境不支持流式）');
        }
        const reader = response.body.getReader();
        let drained = false;
        try {
            await readSse(reader, (event) => {
                for (const chunk of extractor(event)) {
                    if (chunk.kind === 'text' || chunk.kind === 'reasoning') {
                        acc[chunk.kind] += chunk.text;
                        if (onDelta) onDelta(chunk);
                    } else if (chunk.kind === 'toolcall') {
                        accumulateToolCall(acc, chunk.part);
                    } else if (chunk.finishReason) {
                        acc.finishReason = chunk.finishReason;
                    }
                }
            }, idleTimeoutMs);
            drained = true;
        } finally {
            // 提前退出必须 cancel：releaseLock 只解除占用、不关闭流，否则连接挂到服务端超时。
            if (!drained) { try { await reader.cancel(); } catch { /* 已经关闭 */ } }
            try { reader.releaseLock(); } catch { /* 已经释放过就算了 */ }
        }
        const compose = COMPOSERS[format] || composeOpenAICompatible;
        return {
            payload: compose(acc),
            text: acc.text,
            reasoning: acc.reasoning,
            toolCalls: collectToolCalls(acc),
            finishReason: acc.finishReason,
        };
    }

    function withStreamFlag(body, format, enabled) {
        if (!enabled) return body;
        return { ...body, stream: true };
    }

    window.ChatStream = {
        consumeStream,
        withStreamFlag,
        readSse,
        extractors: EXTRACTORS,
        composers: COMPOSERS,
        _internal: {
            parseSseData, extractOpenAICompatible, extractAnthropic, extractOpenAIResponses,
            accumulateToolCall, collectToolCalls, parseToolArgs,
        },
    };
})();