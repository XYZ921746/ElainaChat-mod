package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"elainachat/server/internal/plugin"
)

// handlePluginsList 每次请求都重新扫描：用户可能在服务运行期间把 zip 拷进 mods/，
// 启动时扫一次会让他以为没生效。
func (s *Server) handlePluginsList(w http.ResponseWriter, r *http.Request) {
	modules, results, err := s.packages.ScanMods()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "扫描插件目录失败：" + err.Error()}, nil)
		return
	}
	plugins := make([]map[string]any, 0, len(modules))
	for _, module := range modules {
		plugins = append(plugins, module.IndexEntry())
	}
	var serverRoutes any = nil
	if s.plugins != nil {
		serverRoutes = s.plugins.StatusFor(modules)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"plugins":        plugins,
		"installResults": results,
		"serverRoutes":   serverRoutes,
	}, nil)
}

// handlePluginOpenFolder 是让服务进程唤起本机程序的特权操作：只限本机，
// 且只认 ?id=<插件id> 或 ?dir=1，不把任意路径交给 shell。
func (s *Server) handlePluginOpenFolder(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只有本机可以打开文件夹"}, nil)
		return
	}
	q := r.URL.Query()
	if q.Get("dir") == "1" {
		entries, _ := os.ReadDir(s.cfg.ModsDir)
		list := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			list = append(list, map[string]any{"name": entry.Name(), "dir": entry.IsDir()})
		}
		shown := "mods/"
		if runtime.GOOS == "windows" {
			shown = s.cfg.ModsDir
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": shown, "entries": list}, nil)
		return
	}

	target := s.cfg.ModsDir
	if id := strings.TrimSpace(q.Get("id")); id != "" {
		if !plugin.ValidModID(id) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "插件名不合法"}, nil)
			return
		}
		dir, ok := s.packages.FindModDirByID(id)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "目录不存在：" + id}, nil)
			return
		}
		target = dir
		// sub：插件目录内的一层子路径（如 models/deepseek）；逐段白名单 + 拼完必须仍在插件目录内。
		if sub := strings.TrimSpace(q.Get("sub")); sub != "" {
			sub = strings.ReplaceAll(sub, "\\", "/")
			pluginDir := target
			for _, seg := range strings.Split(sub, "/") {
				if seg == "" {
					continue
				}
				if seg == "." || seg == ".." || strings.HasPrefix(seg, ".") || strings.ContainsAny(seg, `<>:"|?*`) {
					writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "子路径不合法"}, nil)
					return
				}
				target = filepath.Join(target, seg)
			}
			if !pathInside(target, pluginDir) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "路径越界"}, nil)
				return
			}
		}
		if info, err := os.Stat(target); err != nil || !info.IsDir() {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": "目录不存在：" + id}, nil)
			return
		}
	} else {
		// 全新安装、一个插件都没装时根目录可能还不存在。
		_ = os.MkdirAll(s.cfg.ModsDir, 0o755)
	}

	cmd := "xdg-open"
	if runtime.GOOS == "windows" {
		cmd = "explorer"
	} else if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	// explorer 打开目录是正常用法，退出码可能非 0，不能据此判失败；
	// 只认启动时的同步错误（命令不存在 / 没权限）。
	c := exec.Command(cmd, target)
	if err := c.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok":      false,
			"message": fmt.Sprintf("打不开系统文件管理器（%s）：%v。插件目录是 %s，可改用「浏览目录」查看。", cmd, err, target),
			"path":    target,
		}, nil)
		return
	}
	_ = c.Process.Release()
	s.log.Infof("Mod", "已请求打开插件目录：%s", target)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": target}, nil)
}

// handlePluginDelete 卸载插件：删目录 + 安装包，避免下一次扫描把 zip 重新装回来。
func (s *Server) handlePluginDelete(w http.ResponseWriter, r *http.Request, id string) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只有本机可以卸载插件"}, nil)
		return
	}
	if err := s.packages.UninstallMod(id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true}, nil)
}

// handlePluginReadme 走接口而不是让前端 fetch：目录名与 id 可能不一致，
// .md 不在 MIME 表里会被当下载，且这里用白名单文件名读。
func (s *Server) handlePluginReadme(w http.ResponseWriter, r *http.Request, id string) {
	name, text, err := s.packages.ReadModReadme(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "text": text}, nil)
}

// handlePluginInstall 请求体是 zip 原始字节（非 multipart），插件名从 query 取。
func (s *Server) handlePluginInstall(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只有本机可以安装插件"}, nil)
		return
	}
	rawName := strings.TrimSpace(r.URL.Query().Get("name"))
	if rawName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少插件名（请把 zip 文件名作为 name 参数）"}, nil)
		return
	}
	// 先拒绝名字里带路径成分的请求，再净化：先净化会把 ../../hack.zip 静默改成 hack 并安装成功。
	if strings.ContainsAny(rawName, `/\`) || strings.Contains(rawName, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "插件名不能包含路径成分（/ \\ ..）"}, nil)
		return
	}
	id := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(rawName, ".zip"), ".ZIP"), ".Zip")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少插件名（请把 zip 文件名作为 name 参数）"}, nil)
		return
	}
	buf, err := readRawBody(r, plugin.MaxUpload)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "message": "上传失败或文件过大：" + err.Error()}, nil)
		return
	}
	if len(buf) < 22 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "文件为空或不是有效的 zip"}, nil)
		return
	}
	res, err := s.packages.InstallMod(buf, id)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	if _, _, err := s.packages.ScanMods(); err != nil {
		s.log.Warnf("Mod", "重扫插件失败：%v", err)
	}
	s.log.Infof("Mod", "已通过上传安装插件：%s（%d 个文件，跳过 %d 个）", res.ID, res.Files, res.Skip)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "id": res.ID, "files": res.Files, "skipped": res.Skip,
		"message": fmt.Sprintf("已安装 %s（%d 个文件）", res.ID, res.Files),
	}, nil)
}

// handleSkillsList 每次请求都重新扫描（同插件）。
func (s *Server) handleSkillsList(w http.ResponseWriter, r *http.Request) {
	skills, err := s.packages.ScanSkills()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "扫描技能目录失败：" + err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "skills": skills}, nil)
}

func (s *Server) handleSkillInstall(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只有本机可以安装技能"}, nil)
		return
	}
	rawName := strings.TrimSpace(r.URL.Query().Get("name"))
	if rawName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少技能名（请把 zip 文件名作为 name 参数）"}, nil)
		return
	}
	if strings.ContainsAny(rawName, `/\`) || strings.Contains(rawName, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "技能名不能包含路径成分（/ \\ ..）"}, nil)
		return
	}
	id := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(rawName, ".zip"), ".ZIP"), ".Zip")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "缺少技能名（请把 zip 文件名作为 name 参数）"}, nil)
		return
	}
	buf, err := readRawBody(r, plugin.MaxUpload)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "message": "上传失败或文件过大：" + err.Error()}, nil)
		return
	}
	if len(buf) < 22 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "文件为空或不是有效的 zip"}, nil)
		return
	}
	res, err := s.packages.InstallSkill(buf, id)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	if _, err := s.packages.ScanSkills(); err != nil {
		s.log.Warnf("Skill", "重扫技能失败：%v", err)
	}
	s.log.Infof("Skill", "已通过上传安装技能：%s（%d 个文件，跳过 %d 个）", res.ID, res.Files, res.Skip)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "id": res.ID, "files": res.Files, "skipped": res.Skip,
		"message": fmt.Sprintf("已安装 %s（%d 个文件）", res.ID, res.Files),
	}, nil)
}

func (s *Server) handleSkillDelete(w http.ResponseWriter, r *http.Request, id string) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "message": "只有本机可以卸载技能"}, nil)
		return
	}
	if err := s.packages.UninstallSkill(id); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true}, nil)
}

// handleSkillContent 用 (.+) 允许 id 含斜杠（插件随附技能的 id 是 <owner>/<rel>），
// 安全性靠 packages 反查注册过的目录，而不是把 id 拼进路径。
func (s *Server) handleSkillContent(w http.ResponseWriter, r *http.Request, id string) {
	text, err := s.packages.ReadSkill(id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "message": err.Error()}, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": "SKILL.md", "text": text}, nil)
}
