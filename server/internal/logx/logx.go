// Package logx 是服务的日志出口：控制台按行输出，文件按启动分组并做体积轮转。
// 启动窗口与「设置 → 日志」看的是同一份事实，所以级别、标签与脱敏必须集中在这里，
// 不能由各模块自己拼字符串。
package logx

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	Debug Level = iota
	Info
	Warn
	Error
	Critical
)

var levelNames = map[Level]string{
	Debug:    "DEBUG",
	Info:     "INFO",
	Warn:     "WARN",
	Error:    "ERROR",
	Critical: "CRITICAL",
}

// 控制台与文件都用四位短名：日志查看器按固定宽度对齐，长短不一会让整列跳位。
var levelShort = map[Level]string{
	Debug:    "DBUG",
	Info:     "INFO",
	Warn:     "WARN",
	Error:    "ERRO",
	Critical: "CRIT",
}

func (l Level) String() string {
	if name, ok := levelNames[l]; ok {
		return name
	}
	return "INFO"
}

// 日志文件按「一次启动一组」落盘：同一次运行的所有行住在一个文件里，排查问题时不用跨文件拼。
const (
	maxFileBytes = 8 * 1024 * 1024
	keepStarts   = 10
	ringCapacity = 3000
)

// Entry 是内存日志缓冲的一条。字段在写入时解析好，读取端零解析成本；
// 级别用完整名（DEBUG/INFO/…），前端按它做过滤与配色。
type Entry struct {
	TS      int64  `json:"ts"`
	Seq     int64  `json:"seq"`
	Level   string `json:"level"`
	Tag     string `json:"tag"`
	Loc     string `json:"loc,omitempty"`
	Message string `json:"message"`
}

type QueryResult struct {
	Entries []Entry `json:"entries"`
	Total   int     `json:"total"`
	Dropped int64   `json:"dropped"`
}

type Query struct {
	MinLevel string
	Tags     []string
	Search   string
	Limit    int
	Since    int64
	SinceSeq *int64
}

var levelNumber = map[string]int{
	"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40, "CRITICAL": 50,
}

// secretPatterns 每条带自己的替换模板：userinfo 那条要把结尾的 @ 留下来，
// 统一用 "${1}******" 会把它吃掉，地址就拼不回去了。
var secretPatterns = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?i)((?:apiKey|api_key|api-key|accessKey|access_key|authorization|password|secret)"?\s*[:=]\s*"?)([A-Za-z0-9._\-]{12,})`), "${1}******"},
	{regexp.MustCompile(`(?i)(Bearer\s+)([A-Za-z0-9._\-]{12,})`), "${1}******"},
	// URL 的 userinfo：https://user:pass@host 里的口令部分。
	{regexp.MustCompile(`(?i)(://[^/\s:@]+:)([^/\s@]+)(@)`), "${1}******${3}"},
	// 查询串里的凭据：MCP 地址常写成 https://host/mcp?token=…
	{regexp.MustCompile(`(?i)([?&](?:token|access_token|refresh_token|api_?key|key|secret|password|auth|sig|signature|code)=)([^&\s"'#]{4,})`), "${1}******"},
	// 命令行参数：--api-key sk-… / -token xxx。空格分隔，按 : 与 = 的规则覆盖不到。
	{regexp.MustCompile(`(?i)(--?(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|auth)[= ]\s*)([^\s"']{6,})`), "${1}******"},
}

type Logger struct {
	mu       sync.Mutex
	out      io.Writer
	file     *os.File
	basePath string
	logDir   string
	part     int
	written  int64
	toFile   bool
	color    bool

	consoleMin Level
	fileMin    Level
	trace      bool

	ring    [ringCapacity]Entry
	head    int
	size    int
	dropped int64
	seq     int64
}

// 控制台与落盘默认只收 INFO 及以上：请求日志是 DEBUG 级，全收会把终端和日志文件刷成每个请求一行。
// 与 Node 版同名环境变量（LOG_CONSOLE / LOG_LEVEL）语义一致，需要排查时再显式打开 DEBUG。
func defaultLevels() (console, file Level) {
	console, file = Info, Info
	if lv, ok := ParseLevel(os.Getenv("LOG_CONSOLE")); ok {
		console = lv
	}
	if lv, ok := ParseLevel(os.Getenv("LOG_LEVEL")); ok {
		file = lv
	}
	return console, file
}

// New 创建日志器。dir 为空或 toFile 为 false 时只输出到控制台。
func New(dir string, toFile bool) *Logger {
	consoleMin, fileMin := defaultLevels()
	l := &Logger{
		out: os.Stdout, toFile: toFile && dir != "", logDir: dir, trace: true, color: colorEnabled(),
		consoleMin: consoleMin, fileMin: fileMin,
	}
	if l.toFile {
		l.part = 1
		l.basePath = filepath.Join(dir, time.Now().Format("2006-01-02_15-04-05")+".log")
		l.openLocked()
		l.pruneOldStarts(dir)
	}
	return l
}

// Discard 返回不输出任何内容的日志器：测试与不需要日志的嵌入场景用，
// 否则每条用例都会往 stdout 打一遍启动行。
func Discard() *Logger {
	consoleMin, fileMin := defaultLevels()
	return &Logger{out: io.Discard, trace: true, consoleMin: consoleMin, fileMin: fileMin}
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func (l *Logger) Debugf(tag, format string, args ...any) { l.logf(Debug, tag, format, args...) }
func (l *Logger) Infof(tag, format string, args ...any)  { l.logf(Info, tag, format, args...) }
func (l *Logger) Warnf(tag, format string, args ...any)  { l.logf(Warn, tag, format, args...) }
func (l *Logger) Errorf(tag, format string, args ...any) { l.logf(Error, tag, format, args...) }
func (l *Logger) Criticalf(tag, format string, args ...any) {
	l.logf(Critical, tag, format, args...)
}

// Tracef 是「完整问答内容」类日志：运行期可以经 /api/logs/settings 关掉，
// 关掉只影响全文，主日志里的 提问/回复 摘要仍然保留。
func (l *Logger) Tracef(tag, format string, args ...any) {
	l.mu.Lock()
	on := l.trace
	l.mu.Unlock()
	if !on {
		return
	}
	l.logf(Debug, tag, format, args...)
}

func (l *Logger) logf(level Level, tag, format string, args ...any) {
	msg := Redact(fmt.Sprintf(format, args...))
	now := time.Now()
	normalized := normalizeTag(tag)
	console := l.consoleLine(now, normalized, level, msg)
	line := fmt.Sprintf("%s [%s] [%s] %s\n", now.Format("2006-01-02 15:04:05.000"), normalized, levelShort[level], msg)

	l.mu.Lock()
	defer l.mu.Unlock()

	// 缓冲收全量，不受落盘级别约束：过滤发生在读取时，
	// 写入时就按级别丢的话，调过级别后 DEBUG 就永远回不来了。
	l.pushLocked(Entry{TS: now.UnixMilli(), Level: level.String(), Tag: normalized, Message: msg})

	if l.out != nil && level >= l.consoleMin {
		_, _ = io.WriteString(l.out, console)
	}
	if l.file != nil && level >= l.fileMin {
		if l.written+int64(len(line)) > maxFileBytes {
			l.rotateLocked()
		}
		if l.file != nil {
			n, _ := io.WriteString(l.file, line)
			l.written += int64(n)
		}
	}
}

// consoleLine 拼一行控制台日志：时间、模块、级别、正文各占一色。
// 关掉颜色时退化成与日志文件同样的纯文本排布（字段顺序不变，彩色与纯文本能逐列对照）。
func (l *Logger) consoleLine(now time.Time, tag string, level Level, msg string) string {
	stamp := now.Format("15:04:05.000")
	if !l.color {
		return fmt.Sprintf("[%s] [%s] [%s] %s\n", stamp, tag, levelShort[level], msg)
	}
	body := msg
	if c := bodyColor[level]; c != "" {
		body = c + msg + ansiReset
	}
	return fmt.Sprintf("%s[%s]%s %s[%s]%s %s[%s]%s %s\n",
		ansiTime, stamp, ansiReset,
		tagColor(tag), tag, ansiReset,
		levelColor[level], levelShort[level], ansiReset,
		body)
}

// rotateLocked 在当前启动组内递增 _2、_3；超过上限就丢弃后续行，
// 而不是无限建文件把磁盘写满。
func (l *Logger) rotateLocked() {
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
	l.part++
	if l.part > 3 {
		return
	}
	l.openLocked()
}

func (l *Logger) openLocked() {
	if !l.toFile || l.basePath == "" {
		return
	}
	path := l.basePath
	if l.part > 1 {
		path = strings.TrimSuffix(l.basePath, ".log") + fmt.Sprintf("_%d.log", l.part)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	if st, statErr := f.Stat(); statErr == nil {
		l.written = st.Size()
	}
	l.file = f
}

// pruneOldStarts 只保留最近 keepStarts 组启动日志：日志是排查用的，不是归档。
func (l *Logger) pruneOldStarts(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasSuffix(name, ".log") && len(name) >= 19 {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) <= keepStarts*3 {
		return
	}
	for _, name := range names[:len(names)-keepStarts*3] {
		_ = os.Remove(filepath.Join(dir, name))
	}
}

var tagAliases = map[string]string{
	"boot": "Core", "core": "Core", "log": "Core",
	"store": "Store", "relay": "Relay", "live2d": "Live2D",
	"agent": "Agent", "chat": "Chat", "http": "HTTP", "page": "Page",
	"鉴权": "Auth", "auth": "Auth", "https": "Cert", "tls": "Cert", "cert": "Cert",
	"tts": "TTS", "asr": "ASR", "vision": "Vision",
}

func normalizeTag(raw string) string {
	key := strings.TrimSpace(raw)
	if key == "" {
		return "Core"
	}
	if hit, ok := tagAliases[key]; ok {
		return hit
	}
	if hit, ok := tagAliases[strings.ToLower(key)]; ok {
		return hit
	}
	if len([]rune(key)) <= 12 {
		return key
	}
	return "Core"
}

// Redact 把明显是密钥的串打码：日志会被用户导出贴到 issue 里，原样带出等于泄漏。
func Redact(text string) string {
	for _, p := range secretPatterns {
		text = p.re.ReplaceAllString(text, p.repl)
	}
	return text
}

// RedactURL 只保留协议、主机与端口，丢掉路径与查询串。
// 用于「连不上 <地址>」这类要给人看的错误：路径里可能带凭据（?token=…），
// 而错误文案还会进工具结果、被模型转述给 AI 服务商，不能只靠日志层的脱敏。
func RedactURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return Redact(raw)
	}
	u.User = nil
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// LevelNames 是 /api/logs/settings 暴露的合法级别；顺序即严重度。
func LevelNames() []string { return []string{"DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"} }

// ParseLevel 接受完整名与四位短名（DBUG/ERRO/CRIT）以及 WARNING 别名。
func ParseLevel(raw string) (Level, bool) {
	name := normalizeLevelName(raw)
	if name == "" {
		return 0, false
	}
	for level, levelName := range levelNames {
		if levelName == name {
			return level, true
		}
	}
	return 0, false
}

func normalizeLevelName(raw string) string {
	s := strings.ToUpper(strings.TrimSpace(raw))
	switch s {
	case "DBUG":
		return "DEBUG"
	case "WARNING":
		return "WARN"
	case "ERRO":
		return "ERROR"
	case "CRIT":
		return "CRITICAL"
	}
	if _, ok := levelNumber[s]; ok {
		return s
	}
	return ""
}

func (l *Logger) ConsoleLevel() Level {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.consoleMin
}

func (l *Logger) FileLevel() Level {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.fileMin
}

func (l *Logger) SetConsoleLevel(level Level) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.consoleMin == level {
		return false
	}
	l.consoleMin = level
	return true
}

func (l *Logger) SetFileLevel(level Level) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fileMin == level {
		return false
	}
	l.fileMin = level
	return true
}

func (l *Logger) TraceEnabled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.trace
}

func (l *Logger) SetTraceEnabled(on bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.trace == on {
		return false
	}
	l.trace = on
	return true
}

func (l *Logger) FileEnabled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.toFile
}

func (l *Logger) LogDir() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.logDir
}

func (l *Logger) CurrentFile() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.currentPathLocked()
}

func (l *Logger) Keep() int  { return keepStarts }
func (l *Logger) MaxMB() int { return maxFileBytes / 1024 / 1024 }

func (l *Logger) currentPathLocked() string {
	if l.basePath == "" {
		return ""
	}
	if l.part > 1 {
		return strings.TrimSuffix(l.basePath, ".log") + fmt.Sprintf("_%d.log", l.part)
	}
	return l.basePath
}

func (l *Logger) pushLocked(e Entry) {
	e.Seq = l.seq
	l.seq++
	l.ring[l.head] = e
	l.head = (l.head + 1) % ringCapacity
	if l.size < ringCapacity {
		l.size++
	} else {
		l.dropped++
	}
}

// Query 从新到旧过滤。since 是时间戳游标，sinceSeq 是同一毫秒内的写入序号：
// 只给 since 时保持严格的 ">" 语义（宁可重复也不改变旧调用方的预期）。
func (l *Logger) Query(q Query) QueryResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	min := levelNumber[normalizeLevelName(q.MinLevel)]
	var tagSet map[string]bool
	if len(q.Tags) > 0 {
		tagSet = make(map[string]bool, len(q.Tags))
		for _, tag := range q.Tags {
			tagSet[tag] = true
		}
	}
	search := strings.ToLower(q.Search)
	limit := q.Limit
	if limit <= 0 {
		limit = 500
	}
	if limit > ringCapacity {
		limit = ringCapacity
	}

	out := make([]Entry, 0, limit)
	for i := 0; i < l.size && len(out) < limit; i++ {
		entry := l.ring[(l.head-1-i+ringCapacity*2)%ringCapacity]
		if q.Since > 0 {
			if entry.TS < q.Since {
				break // 再往前都更旧
			}
			if entry.TS == q.Since {
				if q.SinceSeq == nil {
					continue
				}
				if entry.Seq <= *q.SinceSeq {
					continue
				}
			}
		}
		if levelNumber[entry.Level] < min {
			continue
		}
		if tagSet != nil && !tagSet[entry.Tag] {
			continue
		}
		if search != "" && !strings.Contains(strings.ToLower(entry.Message), search) {
			continue
		}
		out = append(out, entry)
	}
	return QueryResult{Entries: out, Total: l.size, Dropped: l.dropped}
}

// Tags 返回缓冲里出现过的模块名，给前端做过滤下拉框。
func (l *Logger) Tags() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	set := make(map[string]bool, 16)
	for i := 0; i < l.size; i++ {
		entry := l.ring[(l.head-1-i+ringCapacity*2)%ringCapacity]
		set[entry.Tag] = true
	}
	out := make([]string, 0, len(set))
	for tag := range set {
		out = append(out, tag)
	}
	sort.Strings(out)
	return out
}
