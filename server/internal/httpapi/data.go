package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"elainachat/server/internal/memoryindex"
	"elainachat/server/internal/store"
	"elainachat/server/internal/zipx"
)

const maxBackupUpload = 200 * 1024 * 1024

// buildBackup 打包一份完整备份（data/ + mods/ + skills/）。导出接口与局域网共享
// 共用这一份实现：两处各写一份，插件/技能收集规则会慢慢分叉。
func (s *Server) buildBackup() ([]byte, error) {
	return s.buildBackupWithSecrets(nil)
}

// buildBackupWithSecrets 同上，并把这批密钥合并进备份。
//
// 为什么需要这批参数：APK 上 Key 只住在 Android Keystore，不写进 data/ —— 于是 Load()
// 里根本没有它们，导出的备份天然缺 Key，换机或重装后必须逐个重填。页面在导出前从
// Keystore 读出当前值经 X-Elaina-Secrets 头交过来，备份就与桌面版同形
// （Key 与供应商在备份里、访问密码不在）。局域网共享没有页面上下文，不传这批值。
func (s *Server) buildBackupWithSecrets(secrets map[string]string) ([]byte, error) {
	entries, mods, skills, err := s.packages.Collect()
	if err != nil {
		return nil, err
	}
	// 记忆走逻辑导出（M2b）：权威在 SQLite，.db 不进备份，导入按行重建。
	if s.memory != nil {
		dump, dumpErr := s.memory.ExportItems()
		if dumpErr != nil {
			return nil, dumpErr
		}
		entries = append(entries, zipx.Entry{Name: store.MemoryDumpZipPath, Data: dump})
	}
	return s.store.ExportZipWithSecrets(entries, map[string]int{"mods": mods, "skills": skills}, secrets)
}

// exportSecretsHeader 携带页面从 Keystore 读到的密钥表（JSON 对象：名字 → 值）。
// 走请求头而不是查询串：查询串会进访问日志与浏览器历史，密钥不该出现在那里。
const exportSecretsHeader = "X-Elaina-Secrets"

// readExportSecrets 解析导出请求携带的密钥表。解析不了就当作没带：
// 少几个 Key 的备份仍可用，因解析失败而让整个导出失败则不可接受。
func readExportSecrets(r *http.Request) map[string]string {
	raw := strings.TrimSpace(r.Header.Get(exportSecretsHeader))
	if raw == "" {
		return nil
	}
	// 头部有大小上限（各端 8KB 起），超长会被中间层截断成非法 JSON —— 只当没带。
	var parsed map[string]string
	if json.Unmarshal([]byte(raw), &parsed) != nil || len(parsed) == 0 {
		return nil
	}
	out := map[string]string{}
	for name, value := range parsed {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(value) == "" {
			continue
		}
		out[name] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// handleDataExport 打包完整备份（data/ + mods/ + skills/）。
// 插件目录读不到时不能悄悄退回「只导出 data/」：用户会以为备份是全的。
func (s *Server) handleDataExport(w http.ResponseWriter, r *http.Request) {
	body, err := s.buildBackupWithSecrets(readExportSecrets(r))
	if err != nil {
		s.log.Errorf("Backup", "导出失败：%v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "导出失败：" + err.Error()}, nil)
		return
	}
	stamp := time.Now().UTC().Format("2006-01-02-15-04-05")
	h := w.Header()
	// 刻意不发 Content-Disposition: attachment：迅雷/FDM 这类下载器看到 attachment 就抢走 URL；
	// 前端 fetch 成 blob 后自己保存，文件名走这个自定义头。
	h.Set("Content-Type", "application/zip")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Backup-Filename", "elainachat-backup-"+stamp+".zip")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// handleDataImport 接受 zip 或 v1 单 JSON 备份，按 merge（默认）/ replace 合并。
// 收原始字节而不是 JSON：zip 会被 JSON 解析坏。
func (s *Server) handleDataImport(w http.ResponseWriter, r *http.Request) {
	raw, err := readRawBody(r, maxBackupUpload)
	if err != nil {
		code := http.StatusBadRequest
		msg := "读取备份失败：" + err.Error()
		if err == errBodyTooLarge {
			code = http.StatusRequestEntityTooLarge
			msg = "备份文件过大"
		}
		writeJSON(w, code, map[string]any{"ok": false, "message": msg}, nil)
		return
	}
	mode := "merge"
	if r.URL.Query().Get("mode") == "replace" {
		mode = "replace"
	}

	data := map[string]string{}
	source := "json"
	var dataFiles []zipx.File
	var packageFiles []zipx.File
	var memoryDump []byte
	preview := s.packages.Restore(nil, true)
	if zipx.IsZip(raw) {
		source = "zip"
		// 只解压一遍：数据路径按黑名单从结果里筛出（SplitDataFiles），插件/技能
		// 扫描用全量。全量解压两次会把峰值内存翻倍，几百 MB 的备份足以撑爆进程。
		files, _, err := zipx.Read(raw, zipx.Options{AllowScripts: true})
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "message": "这个文件不是有效的 zip 备份：" + err.Error(),
			}, nil)
			return
		}
		packageFiles = files
		dataFiles, _ = zipx.SplitDataFiles(files)
		data = store.ParseBackup(dataFiles)
		// v4 记忆导出在 memory/ 前缀之外，ParseBackup 不会碰它；这里单独取出来。
		for _, f := range files {
			name := strings.ReplaceAll(f.Name, "\\", "/")
			if name == store.MemoryDumpZipPath || name == "memory-index/items.json" {
				memoryDump = f.Data
			}
		}
		preview = s.packages.Restore(packageFiles, true)
	} else {
		parsed, err := store.ParseLegacyJSON(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "导入失败：" + err.Error()}, nil)
			return
		}
		data = parsed
	}

	// 记忆权威在 SQLite 时，备份里的旧六类目 JSON 在这里换成行，不再写回 Store——
	// 否则导入一次就把刚删掉的权威副本又造出来，回到两份数据的状态。
	var legacyCore []byte
	if s.memory != nil {
		if rawCore, ok := data[store.MemoryKey]; ok {
			legacyCore = []byte(rawCore)
			delete(data, store.MemoryKey)
		}
	}

	hasData := len(data) > 0 || s.memory != nil && (len(memoryDump) > 0 || len(legacyCore) > 0)
	hasPackages := preview.Mods > 0 || preview.Skills > 0
	if !hasData && !hasPackages {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "备份里没有可导入的数据"}, nil)
		return
	}

	// 记忆内容先做纯校验：备份本身坏掉在这里就 400 返回，store 半边一个字节都没动，
	// 不会出现「报导入失败、但会话已被替换」的半生效状态。
	if s.memory != nil {
		if len(memoryDump) > 0 {
			if err := memoryindex.ValidateItemsDump(memoryDump); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "记忆导入失败：" + err.Error()}, nil)
				return
			}
		} else if len(legacyCore) > 0 {
			if _, err := memoryindex.ParseCore(legacyCore); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "记忆导入失败：" + err.Error()}, nil)
				return
			}
		}
	}

	// 数据先落盘：包恢复失败时聊天记录与设置至少已经回来了。
	keys := 0
	var beforeState map[string]string
	if len(data) > 0 {
		beforeState, _ = s.store.Load()
		n, err := s.store.ImportBackup(data, mode)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": "导入失败：" + err.Error()}, nil)
			return
		}
		keys = n
		s.store.RestoreVoiceSamples(dataFiles)
	}

	// 记忆导入：v4 dump 优先，其次旧备份的六类目 JSON 转换；向量是派生的，清空等页面重建。
	// 内容级错误已在上面的预校验挡掉，走到这里还失败就只剩存储层问题（磁盘满 / 库锁），
	// 此时 store 半边已生效，必须如实按 500 报而不是 400。
	if s.memory != nil {
		imported := 0
		replace := mode == "replace"
		if len(memoryDump) > 0 {
			res, err := s.memory.ImportItemsDump(memoryDump, replace, "backup-import")
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "记忆导入失败（数据已替换，请重试导入恢复记忆）：" + err.Error()}, nil)
				return
			}
			imported = res.Upserted
		} else if len(legacyCore) > 0 {
			core, _ := memoryindex.ParseCore(legacyCore)
			res, importErr := s.memory.ImportCore(core, replace, "backup-import")
			if importErr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "记忆导入失败（数据已替换，请重试导入恢复记忆）：" + importErr.Error()}, nil)
				return
			}
			imported = res.Upserted
		}
		// 记忆已进 SQLite：磁盘上残留的六类目 JSON 不再是权威，挪进备份目录并落迁移标记，
		// 否则下次启动的迁移会把这次导入盖回去。
		if _, backupErr := s.store.BackupLegacyMemoryTo(); backupErr != nil {
			s.log.Warnf("Backup", "整理旧记忆文件失败：%v", backupErr)
		}
		if err := s.memory.MarkLegacyMigrated(); err != nil {
			s.log.Warnf("Backup", "写入记忆迁移标记失败：%v", err)
		}
		if _, resetErr := s.memory.Reset(""); resetErr != nil {
			s.log.Warnf("Memory", "导入后清空向量索引失败：%v", resetErr)
		}
		if imported > 0 {
			s.notifyMemoryChange("")
		}
		keys += imported
	}

	var pkg *pkgResult
	if hasPackages {
		res := s.packages.Restore(packageFiles, false)
		errs := res.Errors
		if errs == nil {
			errs = []string{}
		}
		pkg = &pkgResult{res.Mods, res.Skills, res.Files, res.Skipped, errs}
		// 安装目录变了，清单必须重扫：否则前端拿到的还是旧 index.json，
		// 表现为「导入成功但插件列表没变」。
		if res.Mods > 0 || res.Skills > 0 {
			if _, _, err := s.packages.ScanMods(); err != nil {
				s.log.Warnf("Backup", "重扫插件失败：%v", err)
			}
			if _, err := s.packages.ScanSkills(); err != nil {
				s.log.Warnf("Backup", "重扫技能失败：%v", err)
			}
		}
	}

	restoredAny := pkg != nil && (pkg.Mods > 0 || pkg.Skills > 0)
	if keys == 0 && !restoredAny {
		why := "备份里没有可导入的数据"
		if pkg != nil && len(pkg.Errors) > 0 {
			why = pkg.Errors[0]
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "message": why}, nil)
		return
	}

	message := fmt.Sprintf("已导入 %d 项数据", keys)
	if pkg != nil {
		parts := []string{}
		if pkg.Mods > 0 {
			parts = append(parts, fmt.Sprintf("%d 个插件", pkg.Mods))
		}
		if pkg.Skills > 0 {
			parts = append(parts, fmt.Sprintf("%d 个技能", pkg.Skills))
		}
		if len(parts) > 0 {
			prefix := ""
			if keys > 0 {
				prefix = fmt.Sprintf("%d 项数据、", keys)
			}
			message = "已导入 " + prefix + strings.Join(parts, "、") +
				"（" + map[string]string{"replace": "替换", "merge": "合并"}[mode] + "模式）"
		}
		if pkg.Skipped > 0 {
			message += fmt.Sprintf("；跳过 %d 个不安全文件", pkg.Skipped)
		}
		if len(pkg.Errors) > 0 {
			message += fmt.Sprintf("；%d 个包未恢复：%s", len(pkg.Errors), pkg.Errors[0])
		}
	}

	// 导入改写了 store 键却不发 store-change 的话，所有已打开页面的内存缓存停在导入前：
	// 用户继续聊天，下一次保存就把旧会话表整份写回，刚导入的数据被静默回滚。
	// 广播导入后的落盘真值而不是备份原文（merge 模式下部分键的落盘值与备份内容不同）；
	// 导入前存在、导入后消失的键按删除下发，replace 模式清盘靠这一条才能传导到其它页面。
	if len(data) > 0 {
		afterState, err := s.store.Load()
		if err == nil {
			patch := map[string]*string{}
			for k, v := range afterState {
				if k == store.MemoryKey {
					continue // 记忆权威在 SQLite，走 memory-change 通道，不进 store 补丁
				}
				if old, existed := beforeState[k]; !existed || old != v {
					value := v
					patch[k] = &value
				}
			}
			for k := range beforeState {
				if _, exists := afterState[k]; !exists && k != store.MemoryKey {
					patch[k] = nil
				}
			}
			if len(patch) > 0 {
				storePayload := storeChangePayload{Type: "store-change", Keys: sortedKeys(patch), Data: patch}
				if encoded, err := json.Marshal(storePayload); err == nil {
					s.storeHub.broadcast(encoded, "")
				}
			}
		}
	}

	body := map[string]any{
		"ok": true, "mode": mode, "keys": keys, "source": source, "message": message,
	}
	if pkg != nil {
		body["packages"] = pkg
	}
	writeJSON(w, http.StatusOK, body, nil)
}

// pkgResult 是导入结果里 packages 字段的形状。
type pkgResult struct {
	Mods    int      `json:"mods"`
	Skills  int      `json:"skills"`
	Files   int      `json:"files"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors"`
}

// handleDataInfo 返回数据布局与可数统计。数字只用于展示，前端不据此做逻辑判断。
func (s *Server) handleDataInfo(w http.ResponseWriter, r *http.Request) {
	characters, conversations, _, keys, err := s.store.DataCounts()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "message": "读取数据统计失败：" + err.Error()}, nil)
		return
	}
	// 记忆条目数以权威为准：SQLite 在就问库，否则（Node 语义 / 开关关闭）沿用 Store 计数。
	memoryEntries := 0
	if s.memory != nil {
		if n, countErr := s.memory.CountItems(); countErr == nil {
			memoryEntries = n
		}
	} else if _, _, storeCount, _, countErr := s.store.DataCounts(); countErr == nil {
		memoryEntries = storeCount
	}
	mods, skills := s.packages.Counts()
	dir := "data"
	if rel, err := filepath.Rel(s.cfg.AppRoot, s.cfg.DataDir); err == nil && rel != "" && rel != "." {
		dir = filepath.ToSlash(rel)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":  true,
		"dir": dir,
		"layout": map[string]string{
			"settings":      "main/store.json（设置 / API Key / UI 偏好）",
			"characters":    "main/characters/（一卡一文件）",
			"conversations": "conversations/（一对话一文件）",
			// M2b 起记忆正文在 SQLite；类目 JSON 只在迁移备份里留底，不再出现在此处。
			"memory": "main/memory/index.db（SQLite，记忆正文权威）",
			"mods":   "mods/（已安装插件，导入备份时原样写回）",
			"skills": "skills/（本地技能，导入备份时原样写回）",
			"logs":   "logs/",
		},
		"counts": map[string]int{
			"characters":    characters,
			"conversations": conversations,
			"memoryEntries": memoryEntries,
			"mods":          mods,
			"skills":        skills,
		},
		"keys": keys,
	}, nil)
}
