// Package zipx 是服务端唯一的解压/打包实现：危险扩展名、路径穿越与体积上限必须在
// 实现内部拦。分散到各调用方时，漏一处就是一个洞（插件安装、备份导入、上级模型包都吃这一份）。
package zipx

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// File 是一条解压结果。Name 已归一成正斜杠。
type File struct {
	Name string
	Data []byte
}

// Entry 是打包输入；Data 可以是文本或二进制。
type Entry struct {
	Name string
	Data []byte
}

// Options 只暴露调用方真正需要区分的两件事：体积上限与是否放行脚本。
type Options struct {
	MaxTotal     int64
	MaxEntry     int64
	AllowScripts bool
}

// 解压后的默认上限：备份与插件包都不该超过这个量级。
const (
	DefaultMaxTotal = 512 * 1024 * 1024
	DefaultMaxEntry = 256 * 1024 * 1024
)

// blockedExt 是"解压落盘"的安全底线，不是业务判断：模型与备份都是数据，
// 不该带可执行或可被同源渲染的内容。
var blockedExt = map[string]bool{
	".html": true, ".htm": true, ".xhtml": true, ".shtml": true, ".hta": true, ".mhtml": true,
	".js": true, ".mjs": true, ".cjs": true, ".jsx": true, ".ts": true,
	".svg": true, ".xml": true, ".xsl": true,
	".exe": true, ".dll": true, ".com": true, ".scr": true, ".msi": true, ".bat": true, ".cmd": true,
	".ps1": true, ".psm1": true, ".vbs": true, ".wsf": true, ".jar": true, ".sh": true,
}

// pluginExt 是插件安装时额外放行的类型：插件本体就是 JS，面板页是 HTML；
// .exe / .dll / .bat 不在其中，落盘只会在误双击时变成风险。
var pluginExt = map[string]bool{
	".js": true, ".mjs": true, ".cjs": true, ".jsx": true, ".ts": true,
	".html": true, ".htm": true,
}

// EffectiveExt 取「最终落盘名」的扩展名：Windows 上 x.html::$DATA、x.html.（尾随点）、
// x.html␠（尾随空格）落盘时都等于 x.html，直接看 path.Ext 会绕过黑名单。
func EffectiveExt(name string) string {
	s := name
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimRight(s, ". ")
	return strings.ToLower(path.Ext(s))
}

// IsUnsafeEntryName 挡绝对路径与 .. 段；反斜杠也按分隔符算，
// 因为调用方可能漏掉一次归一，而 `..\x` 在 Windows 上就是真实的穿越。
func IsUnsafeEntryName(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasPrefix(name, "/") || (len(name) >= 2 && name[1] == ':') {
		return true
	}
	for _, seg := range strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return true
		}
	}
	return false
}

// Read 解析 zip。返回被拦下的条目名，调用方可以据此告诉用户"哪些文件没落盘"。
func Read(data []byte, opts Options) ([]File, []string, error) {
	if len(data) < 22 || string(data[:4]) != "PK\x03\x04" {
		return nil, nil, errors.New("不是有效的 zip 文件")
	}
	maxTotal := opts.MaxTotal
	if maxTotal <= 0 {
		maxTotal = DefaultMaxTotal
	}
	maxEntry := opts.MaxEntry
	if maxEntry <= 0 {
		maxEntry = DefaultMaxEntry
	}

	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, err
	}
	files := make([]File, 0, len(reader.File))
	blocked := []string{}
	var total int64

	for _, entry := range reader.File {
		name := entry.Name
		if entry.NonUTF8 || !utf8.ValidString(name) {
			if decoded, decErr := simplifiedchinese.GBK.NewDecoder().String(name); decErr == nil {
				name = decoded
			}
		}
		if strings.HasSuffix(name, "/") || strings.HasSuffix(name, "\\") {
			continue
		}
		name = strings.ReplaceAll(name, "\\", "/")
		if IsUnsafeEntryName(name) {
			continue
		}
		ext := EffectiveExt(path.Base(name))
		if blockedExt[ext] && !(opts.AllowScripts && pluginExt[ext]) {
			blocked = append(blocked, name)
			continue
		}

		rc, err := entry.Open()
		if err != nil {
			return nil, nil, err
		}
		limit := maxEntry
		if remaining := maxTotal - total; remaining < limit {
			limit = remaining
		}
		content, readErr := io.ReadAll(io.LimitReader(rc, limit+1))
		closeErr := rc.Close()
		if readErr != nil {
			return nil, nil, readErr
		}
		if closeErr != nil {
			return nil, nil, closeErr
		}
		if int64(len(content)) > limit {
			return nil, nil, errors.New("解压后体积超过上限，已拒绝")
		}
		total += int64(len(content))
		if total > maxTotal {
			return nil, nil, errors.New("解压后总大小超过上限")
		}
		files = append(files, File{Name: name, Data: content})
	}
	if len(files) == 0 {
		return nil, blocked, errors.New("zip 内没有可用文件")
	}
	return files, blocked, nil
}

// IsZip 只认本地文件头 PK\x03\x04；备份导入要靠它区分 zip 与 v1 单 JSON。
func IsZip(data []byte) bool {
	return len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 3 && data[3] == 4
}

// SplitDataFiles 把 AllowScripts 读取的结果分成数据路径可用 / 数据路径会拦下两份，
// 让备份导入只解压一遍：数据遍（不开 allowScripts）与脚本扫描遍共享同一次解压，
// 整包只解压一次，避免峰值内存翻倍。返回的 blocked 与「按数据路径重新 Read」一致。
func SplitDataFiles(files []File) (data []File, blocked []string) {
	data = make([]File, 0, len(files))
	blocked = []string{}
	for _, f := range files {
		if blockedExt[EffectiveExt(path.Base(f.Name))] {
			blocked = append(blocked, f.Name)
			continue
		}
		data = append(data, f)
	}
	return data, blocked
}

// Write 生成最保守的 zip：只用 deflate、文件名统一 UTF-8 并置 EFS 位、不写 data descriptor
// 与 zip64。7-Zip / WinRAR / Windows 自带解压都能直接打开。
func Write(entries []Entry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		name := strings.ReplaceAll(e.Name, "\\", "/")
		if name == "" || IsUnsafeEntryName(name) {
			return nil, errors.New("备份条目名不安全：" + e.Name)
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(e.Data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
