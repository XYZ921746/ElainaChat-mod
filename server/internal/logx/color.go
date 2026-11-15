package logx

import (
	"os"
	"strings"
)

// 控制台配色：时间（绿）、模块（按名字）、级别（按严重度）、正文（随级别）各占一色，
// 与 Node 版 serve.mjs 使用同一套色板 —— 两个实现的日志可以并排看而不需要重新适应。
//
// 只在控制台生效：落盘文件必须保持纯文本，否则 grep / 导出 / Windows 外壳的日志尾部都会带上转义码。
const (
	ansiReset = "\x1b[0m"
	ansiTime  = "\x1b[32m"
)

// 级别色：DEBUG 亮蓝 / INFO 亮青 / WARN 亮黄 / ERROR 红 / CRITICAL 亮红（AstrBot 同款）。
var levelColor = map[Level]string{
	Debug:    "\x1b[1;34m",
	Info:     "\x1b[1;36m",
	Warn:     "\x1b[1;33m",
	Error:    "\x1b[31m",
	Critical: "\x1b[1;31m",
}

// 正文色：长日志里不必逐行读级别列，扫颜色就能分出提示与报错。
// INFO 用终端默认前景色，深底浅底都可读；DEBUG 压暗，让请求行自然退到背景里。
var bodyColor = map[Level]string{
	Debug:    "\x1b[90m",
	Info:     "",
	Warn:     "\x1b[33m",
	Error:    "\x1b[91m",
	Critical: "\x1b[1;91m",
}

// 模块色板：固定模块用固定下标（排查时"绿的那条是 Chat"能形成肌肉记忆），
// 插件等新模块按名字散列，保证同一模块每次启动都是同一种颜色。
var tagPalette = []string{
	"\x1b[38;5;111m", "\x1b[38;5;141m", "\x1b[38;5;114m", "\x1b[38;5;180m",
	"\x1b[38;5;116m", "\x1b[38;5;176m", "\x1b[38;5;151m", "\x1b[38;5;147m",
	"\x1b[38;5;210m", "\x1b[38;5;117m", "\x1b[38;5;144m", "\x1b[38;5;182m",
}

// 下标必须与 Node 版 TAG_FIXED 一致，否则同一个模块在两个实现里颜色不同。
var tagFixed = map[string]int{
	"Core": 0, "Relay": 1, "Chat": 2, "Agent": 3, "Store": 4, "HTTP": 5,
	"Mod": 6, "Auth": 7, "Cert": 8, "MCP": 9, "Skill": 10, "TTS": 11,
	"ASR": 11, "Vision": 9, "Page": 4, "Live2D": 2,
}

func tagColor(tag string) string {
	if idx, ok := tagFixed[tag]; ok {
		return tagPalette[idx]
	}
	var h uint32
	for _, r := range tag {
		h = h*31 + uint32(r)
	}
	return tagPalette[h%uint32(len(tagPalette))]
}

// colorEnabled 决定控制台是否输出转义码。顺序是：本项目开关 > NO_COLOR > FORCE_COLOR > 自动探测 ——
// 本项目开关排最前，才能在不改通用环境变量的情况下临时覆盖；显式开关让「重定向到文件但就是要颜色」
// 和「终端里但不想看颜色」两种需求都能满足。
func colorEnabled() bool {
	if on, ok := envSwitch("ELAINA_LOG_COLOR"); ok {
		return on
	}
	if v, ok := os.LookupEnv("NO_COLOR"); ok && strings.TrimSpace(v) != "" {
		return false
	}
	if on, ok := envSwitch("FORCE_COLOR"); ok {
		return on
	}
	return consoleSupportsColor()
}

// envSwitch 识别 1/0/true/false/yes/no/on/off；未设置或空串返回 ok=false，交给下一级判断。
func envSwitch(name string) (value, set bool) {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return false, false
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return false, false
	case "0", "false", "no", "off":
		return false, true
	default:
		return true, true
	}
}
