// MCP 两种传输（stdio / Streamable HTTP）共用的协议细节。
//
// 握手参数与"把 content 数组拍平成一段文本"必须两边一致：拍平结果里带用户可见的
// 中文说明（图片 / 资源降级成一句话），各写一份时两边会各自漂移，同一份工具在
// 两种传输下给出不同的提示。协议常量仍留在各自文件：它属于传输层的版本约定。

/** 握手参数：协议版本与客户端身份。 */
export function buildInitializeParams({ protocolVersion, version }) {
    return {
        protocolVersion,
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: 'ElainaChat', version: String(version || '2.0.1') },
    };
}

/**
 * 把 MCP 的 content 数组拍平成一段文本。
 *
 * 为什么拍平：宿主的工具通道只接受"一段结果文本"（回灌成 role:'tool'）。
 *   MCP 允许多种 content（text / image / resource），模型读得了的只有文本，
 *   所以图片与资源在这里降级成一句说明 —— 直接丢 JSON 会让模型对它做二次猜测。
 */
export function flattenToolResult(result) {
    const parts = [];
    for (const item of (Array.isArray(result?.content) ? result.content : [])) {
        if (item?.type === 'text') parts.push(String(item.text || ''));
        else if (item?.type === 'image') parts.push('（该工具返回了一张图片，这里只能显示文字）');
        else if (item?.type === 'resource') parts.push('（该工具返回了一个资源引用：' + String(item.resource?.uri || '无地址') + '）');
        else parts.push('（该工具返回了 ' + String(item?.type || '未知') + ' 类型的内容）');
    }
    const text = parts.join('\n').trim();
    return { ok: result?.isError !== true, text: text || '（工具没有返回内容）' };
}
