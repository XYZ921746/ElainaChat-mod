package logx

import (
	"strings"
	"testing"
	"time"
)

func TestQueryFilters(t *testing.T) {
	l := Discard()
	l.Debugf("Store", "debug one")
	l.Infof("Relay", "info two")
	l.Warnf("Store", "warn secret")

	res := l.Query(Query{MinLevel: "WARN"})
	if len(res.Entries) != 1 || res.Entries[0].Level != "WARN" {
		t.Fatalf("级别过滤失败：%+v", res.Entries)
	}

	res = l.Query(Query{Tags: []string{"Store"}})
	if len(res.Entries) != 2 {
		t.Fatalf("模块过滤失败：%+v", res.Entries)
	}
	if res.Entries[0].Level != "WARN" {
		t.Fatalf("应按新→旧返回：%+v", res.Entries)
	}

	res = l.Query(Query{Search: "SECRET"})
	if len(res.Entries) != 1 || !strings.Contains(res.Entries[0].Message, "secret") {
		t.Fatalf("关键词过滤应大小写不敏感：%+v", res.Entries)
	}

	res = l.Query(Query{Limit: 1})
	if len(res.Entries) != 1 || res.Entries[0].Level != "WARN" {
		t.Fatalf("limit 应取最新：%+v", res.Entries)
	}

	tags := l.Tags()
	if len(tags) != 2 || tags[0] != "Relay" || tags[1] != "Store" {
		t.Fatalf("tags 应去重并排序：%v", tags)
	}
}

func TestQuerySinceCursor(t *testing.T) {
	l := Discard()
	l.Infof("A", "old-1")
	l.Infof("A", "old-2")
	before := l.Query(Query{})
	if len(before.Entries) != 2 {
		t.Fatalf("初始条数不对：%+v", before.Entries)
	}
	oldest := before.Entries[len(before.Entries)-1]
	newest := before.Entries[0]

	l.Infof("A", "new-1")
	l.Infof("A", "new-2")

	// 带序号游标：同毫秒内也不会重复或漏掉。
	res := l.Query(Query{Since: oldest.TS, SinceSeq: &newest.Seq})
	if len(res.Entries) != 2 {
		t.Fatalf("增量游标应只返回 2 条新记录，实际 %+v", res.Entries)
	}
	for _, entry := range res.Entries {
		if !strings.HasPrefix(entry.Message, "new-") {
			t.Fatalf("增量游标返回了旧记录：%+v", entry)
		}
	}

	// 不带序号游标：保持严格 ">" 语义，同毫秒的旧记录不会回来。
	res = l.Query(Query{Since: oldest.TS})
	for _, entry := range res.Entries {
		if strings.HasPrefix(entry.Message, "old-") && entry.TS == oldest.TS {
			t.Fatalf("旧语义不应返回同毫秒旧记录：%+v", entry)
		}
	}
}

func TestLevelControls(t *testing.T) {
	l := Discard()
	if l.ConsoleLevel() != Info || l.FileLevel() != Info {
		t.Fatal("默认应为 INFO（与 Node 版一致，DEBUG 请求日志不刷屏）")
	}
	if !l.SetConsoleLevel(Warn) || l.ConsoleLevel() != Warn {
		t.Fatal("控制台级别未生效")
	}
	if l.SetConsoleLevel(Warn) {
		t.Fatal("重复设置应返回 false")
	}
	if !l.SetTraceEnabled(false) || l.TraceEnabled() {
		t.Fatal("追踪开关未生效")
	}

	if level, ok := ParseLevel("DBUG"); !ok || level != Debug {
		t.Fatalf("DBUG 别名解析失败：%v %v", level, ok)
	}
	if level, ok := ParseLevel("critical"); !ok || level != Critical {
		t.Fatalf("小写级别解析失败：%v %v", level, ok)
	}
	if _, ok := ParseLevel("LOG"); ok {
		t.Fatal("未知级别应被拒绝")
	}
	if len(LevelNames()) != 5 {
		t.Fatalf("级别清单不对：%v", LevelNames())
	}
}

func TestTraceOffStillBuffersMainLines(t *testing.T) {
	l := Discard()
	l.SetTraceEnabled(false)
	l.Tracef("Trace", "完整请求正文")
	l.Infof("Chat", "提问：摘要")
	res := l.Query(Query{})
	if len(res.Entries) != 1 || res.Entries[0].Tag != "Chat" {
		t.Fatalf("关闭追踪后只应保留主日志摘要：%+v", res.Entries)
	}
}

func TestConsoleLineColors(t *testing.T) {
	at := time.Date(2026, 11, 9, 12, 34, 56, 789_000_000, time.UTC)

	plain := (&Logger{color: false}).consoleLine(at, "Relay", Warn, "hello")
	if want := "[12:34:56.789] [Relay] [WARN] hello\n"; plain != want {
		t.Fatalf("无色输出应保持纯文本排布：%q", plain)
	}
	if strings.Contains(plain, "\x1b[") {
		t.Fatalf("无色输出不应带转义码：%q", plain)
	}

	colored := (&Logger{color: true}).consoleLine(at, "Relay", Warn, "hello")
	for _, code := range []string{ansiTime, tagColor("Relay"), levelColor[Warn], bodyColor[Warn]} {
		if !strings.Contains(colored, code) {
			t.Fatalf("彩色输出缺少 %q：%q", code, colored)
		}
	}
	if !strings.Contains(colored, "[Relay]") || !strings.Contains(colored, "[WARN]") || !strings.Contains(colored, "hello") {
		t.Fatalf("彩色输出丢了字段：%q", colored)
	}
	if !strings.HasSuffix(colored, ansiReset+"\n") {
		t.Fatalf("正文颜色必须在行尾复位，否则会串到下一行：%q", colored)
	}

	// 同一模块恒为一色，不同模块（固定表里的）互不相同：靠颜色认模块的前提。
	if tagColor("Core") != tagColor("Core") || tagColor("Relay") == tagColor("Chat") {
		t.Fatal("模块配色不满足「同名同色、异名异色」")
	}
}

func TestColorEnvSwitches(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("FORCE_COLOR", "1")
	if colorEnabled() {
		t.Fatal("NO_COLOR 应优先关闭颜色")
	}

	t.Setenv("NO_COLOR", "")
	t.Setenv("FORCE_COLOR", "1")
	if !colorEnabled() {
		t.Fatal("FORCE_COLOR=1 应强制上色")
	}

	t.Setenv("FORCE_COLOR", "0")
	t.Setenv("ELAINA_LOG_COLOR", "1")
	if !colorEnabled() {
		t.Fatal("ELAINA_LOG_COLOR=1 应强制上色")
	}

	t.Setenv("ELAINA_LOG_COLOR", "off")
	if colorEnabled() {
		t.Fatal("ELAINA_LOG_COLOR=off 应关闭颜色")
	}
}

// 与 Node 版同名的两个环境变量：LOG_CONSOLE 管控制台，LOG_LEVEL 管落盘。
func TestLevelEnv(t *testing.T) {
	t.Setenv("LOG_CONSOLE", "DEBUG")
	t.Setenv("LOG_LEVEL", "WARN")
	l := Discard()
	if l.ConsoleLevel() != Debug || l.FileLevel() != Warn {
		t.Fatalf("环境变量未生效：console=%v file=%v", l.ConsoleLevel(), l.FileLevel())
	}

	t.Setenv("LOG_CONSOLE", "LOG")
	t.Setenv("LOG_LEVEL", "")
	l = Discard()
	if l.ConsoleLevel() != Info || l.FileLevel() != Info {
		t.Fatalf("非法/空环境变量应回落到 INFO：console=%v file=%v", l.ConsoleLevel(), l.FileLevel())
	}
}

// 脱敏覆盖日志里实际会出现的密钥形态：日志会被用户导出贴到 issue。
func TestRedactCoversSecretsInLogs(t *testing.T) {
	cases := []struct {
		name string
		in   string
		leak string // 打码后仍不应出现的原文
	}{
		{"JSON 字段", `{"apiKey":"sk-abcdefghijklmn"}`, "sk-abcdefghijklmn"},
		{"Bearer", `Authorization: Bearer sk-abcdefghijklmn`, "sk-abcdefghijklmn"},
		{"URL 查询串", `连不上 https://mcp.example.com/mcp?token=supersecret123 了`, "supersecret123"},
		{"URL userinfo", `https://user:hunter2pass@mcp.example.com/mcp`, "hunter2pass"},
		{"空格分隔的命令行参数", `npx server --api-key sk-abcdefghijklmn --port 3000`, "sk-abcdefghijklmn"},
		{"等号分隔的命令行参数", `node srv.js --token=abcdef123456`, "abcdef123456"},
	}
	for _, tc := range cases {
		got := Redact(tc.in)
		if strings.Contains(got, tc.leak) {
			t.Errorf("%s：脱敏后仍含 %q：%q", tc.name, tc.leak, got)
		}
	}
	// 非密钥内容不能被误伤：参数名、端口、主机必须留着，否则日志失去诊断价值。
	got := Redact(`npx server --api-key sk-abcdefghijklmn --port 3000`)
	if !strings.Contains(got, "--port 3000") || !strings.Contains(got, "npx server") {
		t.Errorf("脱敏不应吃掉非密钥内容：%q", got)
	}
}

// RedactURL 只留协议 + 主机 + 端口：这段文案会进工具结果、被模型转述给上游服务商。
func TestRedactURLDropsPathAndQuery(t *testing.T) {
	got := RedactURL("https://mcp.example.com:8443/mcp/endpoint?token=supersecret123#frag")
	if strings.Contains(got, "supersecret123") || strings.Contains(got, "/mcp/endpoint") {
		t.Errorf("路径与查询串都应丢掉：%q", got)
	}
	if !strings.Contains(got, "mcp.example.com:8443") {
		t.Errorf("主机与端口要保留（诊断需要）：%q", got)
	}
	if got := RedactURL("not a url"); got == "" {
		t.Errorf("无法解析时也要给出可读结果：%q", got)
	}
}
