package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 本文件是记忆的迁移接口：记忆权威在 SQLite，Store 里的六类目 JSON
// （elaina_open_memory_core）只过渡一次。读由这里提供，清理也在这里，
// 转换与写入在 memoryindex 包（避免包循环，接线在 cmd/elaina-server）。

// legacyBackupPrefix 是六类目文件的备份子目录名前缀。迁移成功后类目文件挪进来
// 而不是删掉：权威库损坏重建时（旧 JSON 已不在顶层）它是唯一完整的副本，
// 启动时据此自动回灌。子目录名不含 .json，readMemory / 导出不会把它当类目读。
const legacyBackupPrefix = "legacy-backup-"

// LegacyMemoryJSON 读回六类目 JSON（与 GET /api/store 里 MemoryKey 的值同源）。
// 第二个返回值表示磁盘上是否还有类目文件——迁移挪走后这里返回 false。
func (s *Store) LegacyMemoryJSON() (string, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	raw, ok := s.readMemory()
	return raw, ok, nil
}

// BackupLegacyMemoryTo 把六类目 JSON 挪进 memory/ 下的备份子目录，返回目录名
// （没有可挪的文件时返回空串）。只挪不删：直接删掉的话，权威库损坏重建后就
// 没有任何服务端副本可以恢复，记忆整体不可见只剩 .bad 文件里的一堆碎片。
func (s *Store) BackupLegacyMemoryTo() (string, error) {
	entries, err := os.ReadDir(s.memoryDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		files = append(files, entry.Name())
	}
	if len(files) == 0 {
		return "", nil
	}
	backupDir := filepath.Join(s.memoryDir, legacyBackupPrefix+time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return "", err
	}
	moved := 0
	for _, name := range files {
		from := filepath.Join(s.memoryDir, name)
		to := filepath.Join(backupDir, name)
		if renameErr := renameWithRetry(from, to); renameErr != nil {
			// 整批语义：任何一个搬不动就回滚已搬的，绝不能留下“看起来完整、其实少一类”的备份目录。
			for _, done := range files[:moved] {
				if backErr := renameWithRetry(filepath.Join(backupDir, done), filepath.Join(s.memoryDir, done)); backErr != nil {
					s.logf("warn", "[store] 回滚记忆类目 %s 失败：%v", done, backErr)
				}
			}
			_ = os.Remove(backupDir)
			return "", fmt.Errorf("搬移记忆类目 %s 失败：%w", name, renameErr)
		}
		moved++
	}
	if moved == 0 {
		_ = os.Remove(backupDir)
		return "", nil
	}
	// 缓存里的 MemoryKey 指向刚挪走的文件，必须整体失效：下一次 Load 从磁盘重建，
	// 不会再把已搬走的记忆拼回来。
	s.Invalidate()
	s.logf("info", "[store] 已把 %d 个记忆类目文件挪进备份目录 %s", moved, legacyBackupPrefix)
	return backupDir, nil
}

// LegacyMemoryBackupJSON 合并所有迁移备份目录，供权威库损坏重建后回灌。
// 只信最新目录会在“上一次备份只搬了一半”时丢类目；按时间从旧到新叠，后写覆盖先写，
// 既保住旧备份里独有的类目，也让新备份里的空数组/新值覆盖旧值。
func (s *Store) LegacyMemoryBackupJSON() (string, bool, error) {
	entries, err := os.ReadDir(s.memoryDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), legacyBackupPrefix) {
			dirs = append(dirs, entry.Name())
		}
	}
	if len(dirs) == 0 {
		return "", false, nil
	}
	sort.Strings(dirs)
	merged := make(map[string]json.RawMessage)
	for _, dir := range dirs {
		raw, ok, err := readMemoryCategories(filepath.Join(s.memoryDir, dir))
		if err != nil {
			s.logf("warn", "[store] 读取记忆备份目录 %s 失败（跳过）：%v", dir, err)
			continue
		}
		if !ok {
			continue
		}
		var categories map[string]json.RawMessage
		if json.Unmarshal([]byte(raw), &categories) != nil {
			s.logf("warn", "[store] 记忆备份目录 %s 内容损坏（跳过）", dir)
			continue
		}
		for name, value := range categories {
			merged[name] = value
		}
	}
	if len(merged) == 0 {
		return "", false, nil
	}
	text, err := marshalCompact(merged)
	if err != nil {
		return "", false, err
	}
	return string(text), true, nil
}

// readMemoryCategories 把目录里的类目文件拼成六类目 JSON（与 readMemory 同形状，
// 只是目录可指定：备份子目录与顶层 memory/ 用同一条读取规则）。
func readMemoryCategories(dir string) (string, bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	out := make(map[string]json.RawMessage)
	for _, name := range names {
		category := strings.TrimSuffix(name, ".json")
		if !safeID.MatchString(category) {
			continue
		}
		raw, ok := readJSONFile(filepath.Join(dir, name))
		if !ok {
			continue
		}
		var rec struct {
			Value *json.RawMessage `json:"value"`
		}
		if json.Unmarshal(raw, &rec) != nil || rec.Value == nil {
			continue
		}
		out[category] = *rec.Value
	}
	if len(out) == 0 {
		return "", false, nil
	}
	text, err := marshalCompact(out)
	if err != nil {
		return "", false, err
	}
	return string(text), true, nil
}
