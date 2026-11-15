package relay

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 追踪埋在中转这一层：/api/relay 是所有对外 AI 请求的唯一出口，
// 埋在这里就覆盖对话、模型列表、语音、视觉，前端一行都不用改。
// 主日志只留一行摘要，完整内容进追踪日志 —— 排查时必须能还原「问了什么、答了什么、上游为什么拒」。

type chatMessage struct {
	Role string
	Text string
}

type chatSummary struct {
	Model    string
	Messages []chatMessage
}

var chatPathRe = regexp.MustCompile(`(?i)/chat/completions|/responses|/messages`)

func (h *Handler) traceRequest(method string, target *url.URL, reqText string) *chatSummary {
	if h.log == nil {
		return nil
	}
	summary := summarizeChat(reqText)
	if summary == nil || len(summary.Messages) == 0 {
		return nil
	}
	where := target.Host + target.Path
	h.log.Tracef("Trace", "===== 请求 %s %s =====", method, where)
	h.log.Tracef("Trace", "模型 %s · %d 条消息 · %d 字节", fallback(summary.Model, "(未指定)"),
		len(summary.Messages), len(reqText))
	for i, message := range summary.Messages {
		h.log.Tracef("Trace", "[%d/%d] %s（%d 字）\n%s", i+1, len(summary.Messages), message.Role,
			len([]rune(message.Text)), clip(message.Text, traceMessageMax))
	}
	for i := len(summary.Messages) - 1; i >= 0; i-- {
		message := summary.Messages[i]
		if message.Role != "user" {
			continue
		}
		text := strings.TrimSpace(message.Text)
		if text == "" {
			break
		}
		// 桌宠「主动搭话」这类 mod 注入的系统提示不是用户打的话；
		// 原样打印会把整段提示词灌进主日志，还长得像用户发了句怪话。
		if strings.HasPrefix(text, "（系统提示：") {
			h.log.Infof("Chat", "提问来自自动功能（mod 注入的系统提示，全文见追踪日志）")
		} else {
			h.log.Infof("Chat", "提问：%s", clip(collapseSpaces(text), 200))
		}
		break
	}
	return summary
}

func (h *Handler) traceExchange(method string, target *url.URL, reqText string, status int, elapsed time.Duration, respText string) {
	if h.log == nil {
		return
	}
	where := target.Host + target.Path
	tail := method + " " + where + " -> " + itoa(status) + " 上游 " + itoa(int(elapsed.Milliseconds())) + "ms"
	summary := h.traceRequest(method, target, reqText)
	if summary == nil && chatPathRe.MatchString(target.Path) {
		h.log.Tracef("Trace", "===== 请求 %s %s =====\n（请求体未解析或为空，%d 字节）", method, where, len(reqText))
	}

	if status >= 400 {
		h.log.Tracef("Trace", "===== 响应 %d · %dms（上游报错）=====\n%s", status, elapsed.Milliseconds(),
			clip(respText, TraceBodyMax))
		reason := extractErrorText(respText)
		if reason == "" {
			reason = "(上游没有给出原因)"
		}
		h.log.Errorf("Relay", "%s << 上游报错：%s", tail, clip(collapseSpaces(reason), 400))
		return
	}

	reply := ""
	if len(respText) > 0 {
		var parsed any
		if json.Unmarshal([]byte(respText), &parsed) == nil {
			reply = extractReplyText(parsed)
		}
		if reply == "" {
			reply = parseSSEReply(respText)
		}
	}
	if reply != "" {
		h.log.Tracef("Trace", "===== 响应 %d · %dms =====\n%s", status, elapsed.Milliseconds(), clip(reply, traceMessageMax))
		h.log.Infof("Relay", "%s", tail)
		h.log.Infof("Chat", "回复：%s", clip(collapseSpaces(reply), 200))
		return
	}

	// 状态码 200、却一个字都没抽出来 —— 流式接口把报错塞在 data: 行里就是这种形态。
	if sseErr := parseSSEError(respText); sseErr != "" {
		h.log.Tracef("Trace", "===== 响应 %d · %dms（流式响应内报错）=====\n%s", status, elapsed.Milliseconds(),
			clip(respText, TraceBodyMax))
		h.log.Errorf("Relay", "%s << 响应内报错：%s", tail, clip(collapseSpaces(sseErr), 400))
		return
	}

	if respText != "" && chatPathRe.MatchString(target.Path) {
		h.log.Tracef("Trace", "===== 响应 %d · %dms =====\n%s", status, elapsed.Milliseconds(),
			clip(respText, TraceBodyMax))
	}
	h.log.Infof("Relay", "%s", tail)
}

func summarizeChat(reqText string) *chatSummary {
	if len(reqText) == 0 || len(reqText) > TraceParseMax {
		return nil
	}
	var root map[string]any
	if json.Unmarshal([]byte(reqText), &root) != nil {
		return nil
	}
	messages := []chatMessage{}
	if system, ok := root["system"]; ok {
		messages = append(messages, chatMessage{Role: "system", Text: flattenContent(system)})
	}
	var list []any
	if raw, ok := root["messages"].([]any); ok {
		list = raw
	} else if raw, ok := root["input"].([]any); ok {
		list = raw
	}
	if list == nil {
		if len(messages) == 0 {
			return nil
		}
		return &chatSummary{Model: stringOf(root["model"]), Messages: messages}
	}
	for _, raw := range list {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		role := stringOf(item["role"])
		if role == "" {
			if stringOf(item["type"]) == "message" {
				role = "assistant"
			} else {
				role = "user"
			}
		}
		content := item["content"]
		if content == nil {
			content = item
		}
		messages = append(messages, chatMessage{Role: role, Text: flattenContent(content)})
	}
	return &chatSummary{Model: stringOf(root["model"]), Messages: messages}
}

// flattenContent 把消息内容拍平成可读文本；图片只记大小，绝不记 base64。
func flattenContent(content any) string {
	switch value := content.(type) {
	case nil:
		return ""
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if text := flattenContent(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		kind := strings.ToLower(stringOf(value["type"]))
		if strings.Contains(kind, "image") {
			data := ""
			if image, ok := value["image_url"].(map[string]any); ok {
				data = stringOf(image["url"])
			}
			if data == "" {
				if source, ok := value["source"].(map[string]any); ok {
					data = stringOf(source["data"])
				}
			}
			if data == "" {
				data = stringOf(value["data"])
			}
			if data != "" {
				return "[图片 约 " + itoa(len(data)*3/4) + " 字节]"
			}
			return "[图片]"
		}
		if text, ok := value["text"]; ok {
			return stringOf(text)
		}
		if nested, ok := value["content"]; ok {
			return flattenContent(nested)
		}
		if kind != "" {
			return "[" + kind + "]"
		}
		return ""
	default:
		raw, _ := json.Marshal(value)
		return string(raw)
	}
}

func extractReplyText(root any) string {
	obj, ok := root.(map[string]any)
	if !ok || obj["error"] != nil {
		return ""
	}
	if choices, ok := obj["choices"].([]any); ok && len(choices) > 0 {
		if choice, ok := choices[0].(map[string]any); ok {
			if message, ok := choice["message"].(map[string]any); ok {
				if text := flattenContent(message["content"]); text != "" {
					return text
				}
			}
			if delta, ok := choice["delta"].(map[string]any); ok {
				if text := flattenContent(delta["content"]); text != "" {
					return text
				}
			}
		}
	}
	if delta, ok := obj["delta"].(map[string]any); ok {
		if text := stringOf(delta["text"]); text != "" {
			return text
		}
	}
	if text := stringOf(obj["delta"]); text != "" {
		return text
	}
	if text := stringOf(obj["output_text"]); text != "" {
		return text
	}
	if output, ok := obj["output"].([]any); ok {
		parts := []string{}
		for _, item := range output {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if content, ok := entry["content"].([]any); ok {
				for _, c := range content {
					if part, ok := c.(map[string]any); ok {
						if text := stringOf(part["text"]); text != "" {
							parts = append(parts, text)
						}
					}
				}
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	if content, ok := obj["content"].([]any); ok {
		parts := []string{}
		for _, c := range content {
			if part, ok := c.(map[string]any); ok {
				if text := stringOf(part["text"]); text != "" {
					parts = append(parts, text)
				}
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

// extractErrorText 挖到底：FastAPI 系网关会把真正的文案套在 detail.error.message 里。
func extractErrorText(rawText string) string {
	var root any
	if json.Unmarshal([]byte(rawText), &root) != nil {
		return strings.TrimSpace(rawText)
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return strings.TrimSpace(rawText)
	}
	candidates := []any{obj["error"], obj["message"]}
	if errObj, ok := obj["error"].(map[string]any); ok {
		candidates = append([]any{errObj["message"]}, candidates...)
		if inner, ok := errObj["error"].(map[string]any); ok {
			candidates = append([]any{inner["message"]}, candidates...)
		}
	}
	if detail, ok := obj["detail"].(map[string]any); ok {
		if inner, ok := detail["error"].(map[string]any); ok {
			candidates = append(candidates, inner["message"])
		}
		candidates = append(candidates, detail["message"])
	} else if detail, ok := obj["detail"].(string); ok {
		candidates = append(candidates, detail)
	}
	for _, candidate := range candidates {
		if text, ok := candidate.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	if errObj, ok := obj["error"].(map[string]any); ok {
		raw, _ := json.Marshal(errObj)
		return string(raw)
	}
	return strings.TrimSpace(rawText)
}

func parseSSEReply(rawText string) string {
	parts := []string{}
	for _, line := range strings.Split(rawText, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var piece any
		if json.Unmarshal([]byte(data), &piece) != nil {
			continue
		}
		if text := extractReplyText(piece); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "")
}

// parseSSEError 处理「状态码 200、错在 data: 行里」的流式响应。
func parseSSEError(rawText string) string {
	for _, line := range strings.Split(rawText, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var obj map[string]any
		if json.Unmarshal([]byte(data), &obj) != nil {
			continue
		}
		if obj["error"] != nil || stringOf(obj["type"]) == "error" {
			return extractErrorText(data)
		}
	}
	return ""
}

func collapseSpaces(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func stringOf(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func fallback(value, whenEmpty string) string {
	if value == "" {
		return whenEmpty
	}
	return value
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
