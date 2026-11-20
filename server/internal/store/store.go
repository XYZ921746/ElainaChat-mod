// Package store 是端侧数据的落盘层：前端仍按键值同步，磁盘上则按用途拆开。
// 拆分的目的不是好看——聊天记录一次消息就会整份提交，若全住在一个 store.json 里，
// 每发一条消息都要重写全部会话；一条一文件后，写入量与增长的是同一处。
package store

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"elainachat/server/internal/fsx"
	"elainachat/server/internal/logx"
)

const (
	CharacterListKey    = "elaina_open_character_cards"
	CharacterCurrentKey = "elaina_open_current_card"
	CharacterActiveKey  = "elaina_open_character_card"
	ConversationKey     = "elaina_open_conversations"
	MemoryKey           = "elaina_open_memory_core"
	SettingsKey         = "elaina_open_settings"

	maxKeyChars = 120
	maxValue    = 8 * 1024 * 1024
)

var (
	charactersDir = "characters"
	conversations = "conversations"
	memoryDirName = "memory"
	mainDirName   = "main"
	voiceDirName  = "voice-samples"

	safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
)

// 记忆六类目：写盘时必须全量落，空类目写 []。这样“文件存在但类目缺失”只代表半套数据，
// 而不是用户主动清空；Load 才能安全地从旧 store.json 补缺失类目。
var memoryCategoryNames = []string{"diary", "promise", "preference", "plan", "motivation", "pivotal_memory"}

const legacyConversationsMarkerName = ".legacy-migrated"

type voiceSlot struct {
	field string
	slot  string
}

// 设置里只登记一个参考音频槽位；槽位 id 就是 voice-samples/ 下的文件名。
var voiceSlots = []voiceSlot{{field: "mimoTtsCloneSample", slot: "mimo-clone"}}

// Store 的缓存与写盘队列：Save 串行执行，避免两次保存交错删掉对方刚写出的条目。
type Store struct {
	mu sync.RWMutex

	dataDir   string
	mainDir   string
	storeFile string
	charsDir  string
	convDir   string
	memoryDir string
	voiceDir  string

	cache      map[string]string
	cacheStamp string
	cacheValid bool

	writeMu       sync.Mutex
	writtenHashes map[string]string

	// 读健康信号：readCollection 失败过的目录与条目 id。写侧据此防
	// 「读侧瞬时失败 → 前端拿到缺条目快照 → 整表写回 → 物理删除旧条目」。
	healthMu       sync.Mutex
	missingEntries map[string]map[string]bool
	dirBlocked     map[string]bool
	skipWarned     map[string]string

	// writeCollection 在本次保存里回填过条目：缓存里的集合值已落后于磁盘，见 saveLocked。
	recoveredDuringSave bool

	log *logx.Logger
}

func New(dataDir string, log *logx.Logger) *Store {
	main := filepath.Join(dataDir, mainDirName)
	return &Store{
		dataDir:        dataDir,
		mainDir:        main,
		storeFile:      filepath.Join(main, "store.json"),
		charsDir:       filepath.Join(main, charactersDir),
		convDir:        filepath.Join(dataDir, conversations),
		memoryDir:      filepath.Join(main, memoryDirName),
		voiceDir:       filepath.Join(main, voiceDirName),
		writtenHashes:  make(map[string]string),
		missingEntries: make(map[string]map[string]bool),
		dirBlocked:     make(map[string]bool),
		skipWarned:     make(map[string]string),
		log:            log,
	}
}

func isClassifiedKey(key string) bool {
	switch key {
	case CharacterListKey, CharacterCurrentKey, CharacterActiveKey, ConversationKey, MemoryKey:
		return true
	}
	return false
}

// normalizeCollectionValue 在入缓存前补齐条目 id：磁盘上写出的条目带 id，
// 缓存若仍是原样字符串，下一次读取会看到「刚存进去的对话没有 id」。
func normalizeCollectionValue(key, raw string) string {
	prefix := ""
	switch key {
	case CharacterListKey:
		prefix = "card"
	case ConversationKey:
		prefix = "conv"
	default:
		return raw
	}
	var items []json.RawMessage
	if json.Unmarshal([]byte(raw), &items) != nil {
		return raw
	}
	out := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		trimmed := bytes.TrimSpace(item)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			continue
		}
		fields := map[string]json.RawMessage{}
		if json.Unmarshal(trimmed, &fields) != nil {
			continue
		}
		ensureID(fields, prefix)
		encoded, err := marshalCompact(fields)
		if err != nil {
			return raw
		}
		out = append(out, encoded)
	}
	text, err := marshalCompact(out)
	if err != nil {
		return raw
	}
	return string(text)
}

// Load 返回前端看到的键值表。先读分类文件、再读 store.json：
// 过渡期两边都有值时，已经拆出去的新值不会被 store.json 里的旧值盖回去。
// 读盘段必须全程持有 writeMu：读文件与盖缓存图章之间若插进一次 Save，
// 旧数据会被盖上更新的图章当成合法缓存，之后的合并保存就会整份覆盖刚落盘的键
// （设置与密钥表是整份覆盖，多设备下表现为刚保存的值被静默回滚）。
func (s *Store) Load() (map[string]string, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.loadLocked()
}

// loadLocked 是 Load 的内核，要求调用方已持有 writeMu：ImportBackup 在写锁内
// 需要按「缓存失效就从盘上重读」拿底稿，走 Load 会和自己死锁。
func (s *Store) loadLocked() (map[string]string, error) {
	s.mu.RLock()
	if s.cacheValid && s.cacheStamp == s.stampLocked() {
		out := cloneMap(s.cache)
		s.mu.RUnlock()
		return out, nil
	}
	s.mu.RUnlock()

	out := make(map[string]string)

	legacy, hasLegacy := s.readStoreFile()
	if mem, ok := s.readMemory(); ok {
		// 分类文件可能只写了一半（崩溃或写入方分类不全）；缺的类目从 store.json 的整份记忆里补，
		// 不能因为“有一个文件”就把整份旧值丢掉。
		if hasLegacy && legacy[MemoryKey] != "" {
			mem = mergeMemoryCategories(mem, legacy[MemoryKey])
		}
		out[MemoryKey] = mem
	}
	if items, idx, ok := s.readCollection(s.charsDir); ok && len(items) > 0 {
		out[CharacterListKey] = items
		if idx.CurrentCardID != "" {
			out[CharacterCurrentKey] = idx.CurrentCardID
		}
	}
	if items, _, ok := s.readCollection(s.convDir); ok && len(items) > 0 {
		out[ConversationKey] = items
	}

	if hasLegacy {
		for k, v := range legacy {
			if _, exists := out[k]; !exists {
				out[k] = v
			}
		}
	}
	s.joinVoiceSamples(out)

	s.mu.Lock()
	s.cache = cloneMap(out)
	s.cacheStamp = s.stampLocked()
	s.cacheValid = true
	s.mu.Unlock()
	return out, nil
}

// Save 把整份缓存拆到各自文件。分类键写分类目录，其余键留在 store.json。
func (s *Store) Save() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.saveLocked()
}

// saveLocked 是 Save 的内核，要求调用方已持有写锁：ImportBackup 需要把改缓存、
// 清分类与落盘框进同一段锁里，拆成两次获取会与并发的 Save 交错踩同一批文件。
func (s *Store) saveLocked() error {
	s.mu.RLock()
	cache := cloneMap(s.cache)
	s.mu.RUnlock()
	if cache == nil {
		return nil
	}

	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return err
	}
	s.recoveredDuringSave = false
	before := s.snapshotCollectionEntries()
	if err := s.writeClassified(cache); err != nil {
		// 进程内已报错的失败写入：新落盘的条目文件是孤儿（索引没更新成功），
		// 留着会被下一次保存的恢复护栏当成丢失数据回填，等于把用户已收到
		// 失败答复的补丁悄悄提交。崩溃留下的孤儿没有这份记录，仍走回填。
		s.rollbackNewCollectionEntries(before)
		return err
	}
	recovered := s.recoveredDuringSave
	if err := s.writeMisc(cache); err != nil {
		return err
	}

	s.mu.Lock()
	if recovered {
		// 写入过程回填了磁盘上读失败过的条目，缓存里的集合值（来自提交方）缺这些条目；
		// 盖图章会把毒化缓存当合法，作废让下一次 Load 从盘上重建。
		s.cache = nil
		s.cacheValid = false
	} else {
		s.cacheStamp = s.stampLocked()
		s.cacheValid = true
	}
	s.mu.Unlock()
	return nil
}

// MergeAndSave 是 POST /api/store 的核心：只覆盖本次提交的键，nil 表示删除。
// 删除必须真的从 map 与磁盘上消失，否则「清掉插件失败记录」这类操作永远不生效。
func (s *Store) MergeAndSave(patch map[string]*string) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.mu.Lock()
	if !s.cacheValid || s.cache == nil {
		s.mu.Unlock()
		if _, err := s.loadLocked(); err != nil {
			return 0, err
		}
		s.mu.Lock()
	}
	for key, value := range patch {
		if value == nil {
			delete(s.cache, key)
			continue
		}
		s.cache[key] = normalizeCollectionValue(key, *value)
	}
	keys := len(patch)
	s.mu.Unlock()

	if err := s.saveLocked(); err != nil {
		s.Invalidate()
		return 0, err
	}
	return keys, nil
}

func (s *Store) Invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.cacheValid = false
	s.cacheStamp = ""
	s.mu.Unlock()
}

// MigrateIfNeeded 把「全部挤在 store.json」的数据迁到分类文件。
// 幂等：迁移完成后分类键消失，再跑一次什么也不做。旧副本按 id/类目合并，冲突保留新值。
func (s *Store) MigrateIfNeeded() ([]string, error) {
	if err := s.moveIntoMain(); err != nil {
		return nil, err
	}
	s.pruneTrash()
	// 设置包里可能还内嵌着很早版本的 Key 字段：先就地转进密钥表（已有值优先），
	// 密钥升级才不依赖「页面打开过」。失败只告警，字段留在设置包里，前端还会再试。
	if _, err := s.MigrateEmbeddedLegacySecrets(); err != nil {
		s.logf("warn", "[store] 设置包内嵌 Key 转存密钥表失败（保留原字段）：%v", err)
	}
	legacy, _ := s.readStoreFile()
	moved := []string{}

	legacySingleConv, hasSingleConv := readObjectValue(filepath.Join(s.dataDir, "conversations.json"))
	legacySingleMem, hasSingleMem := readObjectValue(filepath.Join(s.dataDir, "memory.json"))

	// 参考音频要独立判断：分类类目可能早已拆完，音频拆分不能等那个提前返回。
	if settings, ok := legacy[SettingsKey]; ok {
		probe := map[string]string{SettingsKey: settings}
		if changed := s.splitVoiceSamples(probe); changed {
			misc := make(map[string]string)
			for k, v := range legacy {
				if !isClassifiedKey(k) {
					misc[k] = v
				}
			}
			misc[SettingsKey] = probe[SettingsKey]
			if err := s.writeJSONAtomic(s.storeFile, misc); err != nil {
				return moved, err
			}
			s.logf("info", "[store] 参考音频已拆分到 voice-samples/（store.json 只留引用）")
		}
	}

	hasMemKey := false
	hasCharKey := false
	needsClean := false
	for key := range legacy {
		if !isClassifiedKey(key) {
			continue
		}
		needsClean = true
		switch key {
		case MemoryKey:
			hasMemKey = true
		case CharacterListKey:
			hasCharKey = true
		case ConversationKey:
			// 会话统一走下面按 id 合并；这里只需要 needsClean。
		}
	}

	if hasMemKey || hasSingleMem {
		if _, ok := s.readMemory(); !ok {
			source := legacy[MemoryKey]
			if source == "" && hasSingleMem {
				source = legacySingleMem
			}
			if source != "" && s.writeMemory(source) {
				moved = append(moved, "memory")
			}
		}
	}

	if hasCharKey && legacy[CharacterListKey] != "" {
		current := legacy[CharacterCurrentKey]
		if _, idx, ok := s.readCollection(s.charsDir); ok && idx.CurrentCardID != "" {
			current = idx.CurrentCardID
		}
		if changed, ok := s.mergeCollection(legacy[CharacterListKey], s.charsDir, "card", current); ok && changed {
			moved = append(moved, "characters")
		}
	}

	convSource := legacy[ConversationKey]
	if convSource == "" && hasSingleConv {
		convSource = legacySingleConv
	}
	convMarker := filepath.Join(s.convDir, legacyConversationsMarkerName)
	if convSource != "" && !fileExists(convMarker) {
		// 按 id 合并：转换成功但重命名失败时，下次再跑不会插出重复会话；已有 id 保留新值。
		if changed, ok := s.mergeCollection(convSource, s.convDir, "conv", ""); ok {
			if changed {
				moved = append(moved, "conversations")
			}
			if err := s.writeMarker(convMarker); err != nil {
				s.logf("warn", "[store] 写会话迁移标记失败（下次仍会按 id 合并，不会重复）：%v", err)
			}
		}
	}
	// 标记存在（或本次刚写）才允许清理旧单文件：清理失败就留在原地，下次只重试重命名。
	if hasSingleConv && fileExists(convMarker) {
		if err := renameLegacySingle(filepath.Join(s.dataDir, "conversations.json")); err != nil {
			s.logf("warn", "[store] 旧单文件 conversations.json 重命名失败（数据已在新位置）：%v", err)
		}
	}
	if hasSingleMem {
		if _, ok := s.readMemory(); ok {
			if err := renameLegacySingle(filepath.Join(s.dataDir, "memory.json")); err != nil {
				s.logf("warn", "[store] 旧单文件 memory.json 重命名失败（数据已在新位置）：%v", err)
			}
		}
	}

	// 分类键即使本次没有搬数据，也要从 main/store.json 里清掉：否则旧页面会一直读回旧值，
	// 下次备份也会把它再带出去。
	if len(moved) > 0 || needsClean {
		s.Invalidate()
		cache, err := s.Load()
		if err != nil {
			return moved, err
		}
		if _, exists := cache[MemoryKey]; !exists && hasMemKey {
			cache[MemoryKey] = legacy[MemoryKey]
		}
		if _, exists := cache[CharacterListKey]; !exists && hasCharKey {
			cache[CharacterListKey] = legacy[CharacterListKey]
			if current := legacy[CharacterCurrentKey]; current != "" {
				cache[CharacterCurrentKey] = current
			}
		}
		if err := s.Save(); err != nil {
			return moved, err
		}
		if len(moved) > 0 {
			s.logf("info", "[store] 已迁移到分类存储: %s", strings.Join(moved, ", "))
		}
		if needsClean {
			s.logf("info", "[store] main/store.json 里的旧分类键已清理")
		}
	}
	return moved, nil
}

func (s *Store) logf(level, format string, args ...any) {
	if s.log == nil {
		return
	}
	switch level {
	case "warn":
		s.log.Warnf("Store", format, args...)
	case "error":
		s.log.Errorf("Store", format, args...)
	default:
		s.log.Infof("Store", format, args...)
	}
}

// moveIntoMain 把还住在 data/ 顶层的软件级记录收进 main/。
// conversations/ 本来就在顶层，不动它；必须早于键值迁移，否则迁移读的还是旧位置。
// 两边都存在时不能静默忽略：store.json 先补缺失键，目录类旧副本归档留底。
func (s *Store) moveIntoMain() error {
	moves := [][3]string{
		{"store.json", filepath.Join(s.dataDir, "store.json"), s.storeFile},
		{charactersDir, filepath.Join(s.dataDir, charactersDir), s.charsDir},
		{memoryDirName, filepath.Join(s.dataDir, memoryDirName), s.memoryDir},
		{voiceDirName, filepath.Join(s.dataDir, voiceDirName), s.voiceDir},
	}
	for _, mv := range moves {
		label, from, to := mv[0], mv[1], mv[2]
		oldExists := fileExists(from)
		newExists := fileExists(to)
		if !oldExists {
			continue
		}
		if !newExists {
			if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
				s.logf("warn", "[store] 目录整理失败（%s）：%v", label, err)
				continue
			}
			if err := os.Rename(from, to); err != nil {
				s.logf("warn", "[store] 目录整理失败（%s，数据留在原位，不影响读取）：%v", label, err)
				continue
			}
			s.logf("info", "[store] 目录整理：%s 已收进 main/", label)
			continue
		}
		// 目标已经存在：旧文件里可能有新文件没有的键，先补再归档，不能直接丢掉。
		if label == "store.json" {
			if err := s.mergeStoreFileMissing(from, to); err != nil {
				s.logf("warn", "[store] 顶层 store.json 合并失败（旧文件保留）：%v", err)
				continue
			}
		}
		if err := archiveLegacyPath(s.dataDir, label, from); err != nil {
			s.logf("warn", "[store] 顶层旧路径归档失败（%s，留在原位不读取）：%v", label, err)
			continue
		}
		s.logf("info", "[store] 顶层旧路径已归档到 legacy-backup：%s", label)
	}
	return nil
}

// mergeStoreFileMissing 把旧 store.json 里新文件缺失的键补进 main/store.json。
// 分类键也先补进来，随后由 MigrateIfNeeded 统一转成分类文件/清理。
func (s *Store) mergeStoreFileMissing(from, to string) error {
	oldRaw, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	newRaw, err := os.ReadFile(to)
	if err != nil {
		return err
	}
	var oldMap, newMap map[string]string
	if json.Unmarshal(oldRaw, &oldMap) != nil {
		return fmt.Errorf("旧 store.json 不是合法 JSON")
	}
	if json.Unmarshal(newRaw, &newMap) != nil {
		return fmt.Errorf("main/store.json 不是合法 JSON，拒绝覆盖")
	}
	changed := false
	for key, value := range oldMap {
		if _, exists := newMap[key]; !exists {
			newMap[key] = value
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.writeJSONAtomic(to, newMap)
}

func archiveLegacyPath(dataDir, label, from string) error {
	root := filepath.Join(dataDir, "legacy-backup-"+time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	return os.Rename(from, filepath.Join(root, label))
}

// 读写原语

func (s *Store) readStoreFile() (map[string]string, bool) {
	raw, err := os.ReadFile(s.storeFile)
	if err != nil {
		if os.IsNotExist(err) {
			// store.json 不在（首次启动，或上次隔离后还没重建）：抢救文件是杂项键唯一的残存来源。
			return s.readSalvageFile()
		}
		return map[string]string{}, false
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		// 读得出但解析不了＝文件损坏。不隔离的话，下一次 Save 会把空杂项表当最新状态
		// 整份写回去，设置与密钥就此静默消失；改名留证后尽力抢救键值。
		s.quarantineCorruptFile(s.storeFile, raw)
		return s.salvageFromRaw(raw)
	}
	return storeKeysFromObject(obj), true
}

// storeKeysFromObject 只收字符串值（与 localStorage 语义一致），键长/值长超限的丢弃。
func storeKeysFromObject(obj map[string]any) map[string]string {
	out := make(map[string]string)
	for k, v := range obj {
		if k == "" || utf16Len(k) > maxKeyChars {
			continue
		}
		str, ok := v.(string)
		if !ok || utf16Len(str) > maxValue {
			continue
		}
		out[k] = str
	}
	return out
}

// salvageFromRaw 尽力从损坏的 store.json 抢救杂项键。抢救结果落一份
// store.salvage.json：隔离发生在两次保存之间时，重启也能找回来。
func (s *Store) salvageFromRaw(raw []byte) (map[string]string, bool) {
	keys := salvageParseStoreKeys(raw)
	if len(keys) == 0 {
		s.logf("warn", "[store] store.json 损坏已留证（store.json.bad-*），且抢救不出任何键")
		return map[string]string{}, false
	}
	if err := s.writeJSONAtomic(filepath.Join(s.mainDir, "store.salvage.json"), keys); err != nil {
		s.logf("warn", "[store] 抢救键写入 salvage 文件失败（仅本次内存留存）：%v", err)
	}
	s.logf("warn", "[store] store.json 损坏已留证（store.json.bad-*），抢救出 %d 个键并回填，原值不会因下一次保存而丢失", len(keys))
	return keys, true
}

func tryParseStoreKeys(raw []byte) map[string]string {
	if len(raw) == 0 {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return nil
	}
	return storeKeysFromObject(obj)
}

// salvageParseStoreKeys 按损坏形态逐级尝试：原样解析；尾部有垃圾时裁到最后一个
// 顶层闭合括号；写盘中途截断时补收尾括号、不行再从后往前丢不完整的键值对。
// store.json 是扁平对象且落盘走原子写，半截文件只出现在截断写盘，损坏必然在尾部。
func salvageParseStoreKeys(raw []byte) map[string]string {
	if keys := tryParseStoreKeys(raw); keys != nil {
		return keys
	}
	if keys := tryParseStoreKeys(truncateToBalancedBrace(raw)); keys != nil {
		return keys
	}
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	commas := topLevelCommas(raw)
	cuts := make([]int, 0, len(commas)+1)
	cuts = append(cuts, len(raw))
	for i := len(commas) - 1; i >= 0; i-- {
		cuts = append(cuts, commas[i])
	}
	for _, cut := range cuts {
		prefix := bytes.TrimRight(raw[:cut], " \t\r\n")
		if len(prefix) < 2 || endsWithOpenString(prefix) {
			continue
		}
		last := prefix[len(prefix)-1]
		if last == ':' || last == ',' || last == '{' {
			continue
		}
		candidate := make([]byte, 0, len(prefix)+1)
		candidate = append(candidate, prefix...)
		candidate = append(candidate, '}')
		if keys := tryParseStoreKeys(candidate); keys != nil {
			return keys
		}
	}
	return nil
}

// topLevelCommas 返回深度为 1（顶层键值对之间）且不在字符串里的逗号位置。
func topLevelCommas(raw []byte) []int {
	var commas []int
	depth, inString, escaped := 0, false, false
	for i, b := range raw {
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		switch b {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
		case ',':
			if depth == 1 {
				commas = append(commas, i)
			}
		}
	}
	return commas
}

func endsWithOpenString(raw []byte) bool {
	inString, escaped := false, false
	for _, b := range raw {
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		if b == '"' {
			inString = true
		}
	}
	return inString
}

// truncateToBalancedBrace 返回最后一个顶层对象闭合位置为止的前缀（尾部垃圾形态）；找不到返回 nil。
func truncateToBalancedBrace(raw []byte) []byte {
	depth, inString, escaped, cut := 0, false, false, -1
	for i, b := range raw {
		if inString {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				inString = false
			}
			continue
		}
		switch b {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				cut = i
			}
		}
	}
	if cut < 0 {
		return nil
	}
	return raw[:cut+1]
}

// readSalvageFile 读上次抢救落盘的键。loadLocked 只用它补缺失键，不会覆盖磁盘上的新值。
func (s *Store) readSalvageFile() (map[string]string, bool) {
	raw, err := os.ReadFile(filepath.Join(s.mainDir, "store.salvage.json"))
	if err != nil {
		return map[string]string{}, false
	}
	var keys map[string]string
	if json.Unmarshal(raw, &keys) != nil {
		return map[string]string{}, false
	}
	return keys, len(keys) > 0
}

func (s *Store) writeJSONAtomic(path string, value any) error {
	text, err := marshalIndent(value)
	if err != nil {
		return err
	}
	sum := sha1.Sum(text)
	hash := hex.EncodeToString(sum[:])
	if s.writtenHashes[path] == hash && fileExists(path) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := fsx.WriteFileAtomic(path, text, 0o644); err != nil {
		return err
	}
	s.writtenHashes[path] = hash
	return nil
}

func writeBinAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return fsx.WriteFileAtomic(path, data, 0o644)
}

// renameWithRetry 对抗 Windows 上杀软/同步盘对文件短暂持锁导致的 Access denied：
// rename 失败于源或目标任一侧被打开时都会发生，稍候重试通常能过。
func renameWithRetry(from, to string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		err = os.Rename(from, to)
		if err == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return err
}

func readJSONFile(path string) (json.RawMessage, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var probe any
	if json.Unmarshal(raw, &probe) != nil {
		return nil, false
	}
	return raw, true
}

// quarantineCorruptFile 把解析失败的数据文件改名留证，与记忆索引库的 .bad 同一约定。
// 保留原始字节而不是删掉：这是唯一还能手工恢复数据的出处。
func (s *Store) quarantineCorruptFile(path string, raw []byte) {
	bad := path + ".bad-" + time.Now().Format("20060102-150405")
	if _, err := os.Stat(bad); err == nil {
		// 同一秒内重复隔离（写入侧与读取侧各发现一次）：加序号，别让第二次的留证静默失败。
		bad = path + ".bad-" + time.Now().Format("20060102-150405") + "-" + strconv.FormatInt(time.Now().UnixNano()%1000000, 10)
	}
	if err := os.Rename(path, bad); err != nil {
		s.logf("warn", "[store] 损坏文件留证失败（%s）：%v", path, err)
		return
	}
	s.logf("warn", "[store] %s 解析失败，已留证到 %s；本次按没有该文件处理", path, bad)
}

type collectionIndex struct {
	Version       int      `json:"version"`
	Order         []string `json:"order"`
	CurrentCardID string   `json:"currentCardId,omitempty"`
}

// mergeCollection 按 id 合并旧数组：已有 id 保留新值，只补缺失条目。
// 转换成功但重命名失败时，下一次启动再合并也不会插出重复会话。
func (s *Store) mergeCollection(raw, dir, prefix, currentCardID string) (bool, bool) {
	var legacyItems []json.RawMessage
	if raw == "" || json.Unmarshal([]byte(raw), &legacyItems) != nil {
		return false, false
	}
	existingRaw, idx, _ := s.readCollection(dir)
	merged := make([]json.RawMessage, 0, len(legacyItems)+8)
	ids := make(map[string]bool)
	if existingRaw != "" {
		var existing []json.RawMessage
		if json.Unmarshal([]byte(existingRaw), &existing) == nil {
			for _, item := range existing {
				fields := map[string]json.RawMessage{}
				if json.Unmarshal(item, &fields) != nil {
					continue
				}
				id := ensureID(fields, prefix)
				if id == "" || ids[id] {
					continue
				}
				ids[id] = true
				merged = append(merged, item)
			}
		}
	}
	current := currentCardID
	if idx.CurrentCardID != "" {
		current = idx.CurrentCardID
	}
	changed := false
	for _, item := range legacyItems {
		fields := map[string]json.RawMessage{}
		if json.Unmarshal(item, &fields) != nil {
			continue
		}
		id := ensureID(fields, prefix)
		if id == "" || ids[id] {
			continue
		}
		ids[id] = true
		merged = append(merged, item)
		changed = true
	}
	if !changed && existingRaw != "" {
		return false, true
	}
	text, err := marshalCompact(merged)
	if err != nil {
		return changed, false
	}
	return changed, s.writeCollection(string(text), dir, prefix, current)
}

func (s *Store) writeMarker(path string) error {
	if fileExists(path) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}

// renameLegacySingle 把旧单文件改成非 .json 后缀留底：不再参与任何读取，也不会被备份当成新格式。
func renameLegacySingle(path string) error {
	if !fileExists(path) {
		return nil
	}
	target := path + ".migrated-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	return os.Rename(path, target)
}

// writeCollection 把数组字符串拆成「一条一文件 + index」。
// 非法 JSON 时不动磁盘：宁可保留上一次的数据，也不要因为一次坏提交清空聊天记录。
func (s *Store) writeCollection(raw, dir, prefix, currentCardID string) bool {
	var items []json.RawMessage
	if json.Unmarshal([]byte(raw), &items) != nil {
		return false
	}
	order := make([]string, 0, len(items))
	keep := make(map[string]struct{}, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		fields := map[string]json.RawMessage{}
		trimmed := bytes.TrimSpace(item)
		if len(trimmed) == 0 || trimmed[0] != '{' || json.Unmarshal(trimmed, &fields) != nil {
			continue
		}
		id := ensureID(fields, prefix)
		// 同一 id 只登记一次：index.order 里出现两次时，重启后两条 order 都指向同一个
		// 条目文件，读出来是两份相同内容、其中一条的正文永久丢失。
		// 位置取首次出现，内容仍由后面的写盘覆盖（与逐条写入的最终结果一致）。
		if _, dup := seen[id]; !dup {
			seen[id] = struct{}{}
			order = append(order, id)
		}
		keep[id+".json"] = struct{}{}
		if err := s.writeJSONAtomic(filepath.Join(dir, id+".json"), fields); err != nil {
			return false
		}
	}
	// 删旧分三档：读取健康且不在本次提交里＝正常删除，移入回收站留底；
	// 读取可疑（index 损坏/缺失，或本进程读到过失败）的条目先当场重读——读得出来
	// 回填进集合（自愈），读不出来留原文件下次再试。这一步挡的是「读侧失败 → 前端
	// 拿到缺条目快照 → 整表写回 → 物理删除」。
	// 判定必须看磁盘：POST 走 MergeAndSave 时缓存有效、不会重读集合，进程内信号是空的。
	suspect := s.collectionReadSuspect(dir)
	var toTrash, toQuarantine, skipped []string
	recovered := false
	if entries, err := os.ReadDir(dir); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") || name == "index.json" {
				continue
			}
			if _, ok := keep[name]; ok {
				continue
			}
			id := strings.TrimSuffix(name, ".json")
			if !suspect && !s.entryNeedsProtection(dir, id) {
				toTrash = append(toTrash, name)
				continue
			}
			_, exists := readJSONFile(filepath.Join(dir, name))
			if !exists {
				if _, readErr := os.ReadFile(filepath.Join(dir, name)); readErr == nil {
					// 读得出但解析不了＝文件本身坏了，走隔离留证，不再反复重试。
					toQuarantine = append(toQuarantine, name)
					continue
				}
				// 文件暂时读不出（杀软/同步盘持锁）：留原文件，index 里也没有它，下次写入再试回填。
				skipped = append(skipped, id)
				continue
			}
			keep[name] = struct{}{}
			order = append(order, id)
			recovered = true
			s.logf("warn", "[store] 条目 %s 上次读取失败、本次写入前已恢复可读，已回填进集合", id)
		}
	}
	// 索引先于任何文件移除落盘：反过来时一旦写索引失败（磁盘满），旧条目已删而索引还
	// 指着它们，整个集合两头空；先写索引最多留下几个孤儿文件，下次成功的写入会清掉。
	if err := s.writeJSONAtomic(filepath.Join(dir, "index.json"), collectionIndex{
		Version: 1, Order: order, CurrentCardID: currentCardID,
	}); err != nil {
		return false
	}
	// 索引已重写成功，index 级的阻塞不再成立；条目级的 missing 保留——
	// 留底未回填的文件还要靠它触发下次重试。
	s.healthMu.Lock()
	delete(s.dirBlocked, dir)
	s.healthMu.Unlock()
	for _, name := range toTrash {
		s.trashCollectionEntry(dir, name)
	}
	for _, name := range toQuarantine {
		if rawBytes, readErr := os.ReadFile(filepath.Join(dir, name)); readErr == nil {
			s.quarantineCorruptFile(filepath.Join(dir, name), rawBytes)
		}
	}
	if len(skipped) > 0 {
		s.warnSkippedEntries(dir, skipped)
	}
	if recovered {
		s.recoveredDuringSave = true
		s.clearSkipWarn(dir)
	}
	return true
}

// collectionReadSuspect 报告磁盘上的 index 是否不可信：缺失、损坏、或条目数与目录里
// 实际条目文件数对不上。index 不可信时，目录里每个不在本次提交中的条目都可能是
// 「读侧没读到」，一律先重读而不是直接删。
func (s *Store) collectionReadSuspect(dir string) bool {
	raw, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		// 没有 index 但目录里已有条目文件：上一次写入没落完或 index 被删，按可疑处理。
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			return true
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasSuffix(name, ".json") && name != "index.json" {
				return true
			}
		}
		return false
	}
	var idx collectionIndex
	if json.Unmarshal(raw, &idx) != nil || idx.Order == nil {
		// 留证（唯一还能手工恢复的出处）后按可疑处理，让条目重读回填而不是直接删。
		// readCollection 读到同一份损坏 index 时会重复调用一次，重名失败只打日志、无副作用。
		s.quarantineCorruptFile(filepath.Join(dir, "index.json"), raw)
		return true
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true
	}
	onDisk := make(map[string]struct{})
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".json") && name != "index.json" {
			id := strings.TrimSuffix(name, ".json")
			if !safeID.MatchString(id) {
				return true
			}
			onDisk[id] = struct{}{}
		}
	}
	indexIDs := make(map[string]struct{}, len(idx.Order))
	for _, id := range idx.Order {
		if !safeID.MatchString(id) {
			return true
		}
		if _, duplicate := indexIDs[id]; duplicate {
			return true
		}
		indexIDs[id] = struct{}{}
		if _, exists := onDisk[id]; !exists {
			return true
		}
	}
	for id := range onDisk {
		if _, exists := indexIDs[id]; !exists {
			return true
		}
	}
	return false
}

// entryNeedsProtection 报告该条目是否属于「本进程读到过失败」的范畴。
func (s *Store) entryNeedsProtection(dir, id string) bool {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	if s.dirBlocked[dir] {
		return true
	}
	return s.missingEntries[dir][id]
}

func (s *Store) markCollectionRead(dir string, missing map[string]bool) {
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	if len(missing) == 0 {
		delete(s.missingEntries, dir)
		delete(s.dirBlocked, dir)
		return
	}
	s.missingEntries[dir] = missing
	delete(s.dirBlocked, dir)
}

func (s *Store) markCollectionBlocked(dir string) {
	// 目录里还没有任何条目文件时谈不上「有数据要保护」：全新集合的首读本来就没有 index，
	// 标了阻塞只会让第一次有数据的写入误走回填。
	if entries, err := os.ReadDir(dir); err == nil {
		hasEntry := false
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasSuffix(name, ".json") && name != "index.json" {
				hasEntry = true
				break
			}
		}
		if !hasEntry {
			return
		}
	}
	s.healthMu.Lock()
	defer s.healthMu.Unlock()
	s.dirBlocked[dir] = true
}

// warnSkippedEntries 对反复读不出的条目只告警一次（按目录去重），避免每次保存都刷日志。
func (s *Store) warnSkippedEntries(dir string, ids []string) {
	sig := strings.Join(ids, ",")
	s.healthMu.Lock()
	unchanged := s.skipWarned[dir] == sig
	s.skipWarned[dir] = sig
	s.healthMu.Unlock()
	if unchanged {
		return
	}
	s.logf("warn", "[store] %s 里的条目暂时读不出（可能被杀软/同步盘占用），本轮不删除、文件留底：%s",
		filepath.Base(dir), sig)
}

func (s *Store) clearSkipWarn(dir string) {
	s.healthMu.Lock()
	delete(s.skipWarned, dir)
	s.healthMu.Unlock()
}

const trashRetention = 7 * 24 * time.Hour

func (s *Store) trashDir() string {
	return filepath.Join(s.dataDir, "trash")
}

// trashCollectionEntry 把正常删除的条目移入回收站而不是直接抹掉：用户手滑删掉的会话
// 7 天内还能找回。改名失败（目标被占用）时退回直接删，不阻塞保存。
func (s *Store) trashCollectionEntry(dir, name string) {
	target := filepath.Join(s.trashDir(), filepath.Base(dir), name+"."+strconv.FormatInt(time.Now().UnixNano(), 10))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
		if err := renameWithRetry(filepath.Join(dir, name), target); err == nil {
			return
		}
	}
	_ = os.Remove(filepath.Join(dir, name))
}

// pruneTrash 清掉超过保留期的回收站文件。文件名尾部是纳秒时间戳，解析不出的跳过。
func (s *Store) pruneTrash() {
	collections, err := os.ReadDir(s.trashDir())
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-trashRetention)
	for _, collection := range collections {
		if !collection.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(s.trashDir(), collection.Name()))
		if err != nil {
			continue
		}
		for _, file := range files {
			dot := strings.LastIndexByte(file.Name(), '.')
			if dot < 0 {
				continue
			}
			ts, err := strconv.ParseInt(file.Name()[dot+1:], 10, 64)
			if err != nil {
				continue
			}
			if time.Unix(0, ts).Before(cutoff) {
				_ = os.Remove(filepath.Join(s.trashDir(), collection.Name(), file.Name()))
			}
		}
	}
}

func (s *Store) readCollection(dir string) (itemsJSON string, idx collectionIndex, ok bool) {
	indexPath := filepath.Join(dir, "index.json")
	raw, err := os.ReadFile(indexPath)
	if err != nil {
		s.markCollectionBlocked(dir)
		return "", collectionIndex{}, false
	}
	var probe collectionIndex
	if json.Unmarshal(raw, &probe) != nil || probe.Order == nil {
		// 与 store.json 同一待遇：损坏的索引静默当成「空集合」的话，
		// 下一次写入会把旧条目文件全部清掉，整段对话就这么消失。
		s.quarantineCorruptFile(indexPath, raw)
		s.markCollectionBlocked(dir)
		return "", collectionIndex{}, false
	}
	idx = probe
	missing := map[string]bool{}
	items := make([]json.RawMessage, 0, len(idx.Order))
	for _, id := range idx.Order {
		if !safeID.MatchString(id) {
			continue
		}
		item, exists := readJSONFile(filepath.Join(dir, id+".json"))
		if !exists {
			missing[id] = true
			continue
		}
		items = append(items, item)
	}
	s.markCollectionRead(dir, missing)
	if len(items) == 0 {
		return "", idx, true
	}
	text, err := marshalCompact(items)
	if err != nil {
		return "", idx, false
	}
	return string(text), idx, true
}

func (s *Store) writeMemory(raw string) bool {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &obj) != nil {
		return false
	}
	// 迁移/保存时把六个类目补齐：空类目也写 []，否则“类目缺失”会被读侧当成还没迁移。
	for _, name := range memoryCategoryNames {
		if _, ok := obj[name]; !ok {
			obj[name] = json.RawMessage("[]")
		}
	}
	keep := make(map[string]struct{}, len(obj))
	for name, value := range obj {
		if !safeID.MatchString(name) {
			continue
		}
		keep[name+".json"] = struct{}{}
		rec := map[string]any{"version": 1, "value": value}
		if err := s.writeJSONAtomic(filepath.Join(s.memoryDir, name+".json"), rec); err != nil {
			return false
		}
	}
	if entries, err := os.ReadDir(s.memoryDir); err == nil {
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			if _, ok := keep[name]; ok {
				continue
			}
			_ = os.Remove(filepath.Join(s.memoryDir, name))
		}
	}
	return true
}

// mergeMemoryCategories 以分类文件为主、旧 store.json 的整份记忆补缺失类目。
// 分类文件里已经出现的类目（哪怕值是空数组）就是用户当前状态，不能被旧值覆盖。
func mergeMemoryCategories(primary, fallback string) string {
	var p, f map[string]json.RawMessage
	if json.Unmarshal([]byte(primary), &p) != nil {
		return primary
	}
	if json.Unmarshal([]byte(fallback), &f) != nil {
		return primary
	}
	changed := false
	for name, value := range f {
		if _, ok := p[name]; !ok {
			p[name] = value
			changed = true
		}
	}
	if !changed {
		return primary
	}
	text, err := marshalCompact(p)
	if err != nil {
		return primary
	}
	return string(text)
}

func (s *Store) readMemory() (string, bool) {
	entries, err := os.ReadDir(s.memoryDir)
	if err != nil {
		return "", false
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	out := make(map[string]json.RawMessage)
	for _, name := range names {
		category := strings.TrimSuffix(name, ".json")
		if !safeID.MatchString(category) {
			continue
		}
		raw, ok := readJSONFile(filepath.Join(s.memoryDir, name))
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
		return "", false
	}
	text, err := marshalCompact(out)
	if err != nil {
		return "", false
	}
	return string(text), true
}

// snapshotCollectionEntries 记录两个集合目录里已有的条目文件名，供失败回滚比对。
// 读不到目录时记 nil（未知）而不是空集合：回滚会把“空快照”当成目录里原本什么都没有，
// 从而把原有条目误判成本次新写入删掉。
func (s *Store) snapshotCollectionEntries() map[string]map[string]struct{} {
	snapshot := make(map[string]map[string]struct{}, 2)
	for _, dir := range []string{s.convDir, s.charsDir} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			// 目录不存在 = 确实没有旧条目（空快照安全）；其它读取失败（权限 / IO）时
			// 记 nil（未知），回滚跳过该目录，免得把原有条目误判成本次新写入删掉。
			if os.IsNotExist(err) {
				snapshot[dir] = map[string]struct{}{}
			} else {
				snapshot[dir] = nil
			}
			continue
		}
		names := make(map[string]struct{})
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasSuffix(name, ".json") && name != "index.json" {
				names[name] = struct{}{}
			}
		}
		snapshot[dir] = names
	}
	return snapshot
}

// rollbackNewCollectionEntries 只删除「本次失败保存新写出的」条目文件：
// 旧条目在索引写成功前不会被动（删除走回收站，且在索引成功之后），所以这里
// 不可能碰到用户已有数据；memory 的写入是先解析后落盘，失败时不产生新文件。
func (s *Store) rollbackNewCollectionEntries(before map[string]map[string]struct{}) {
	for dir, names := range before {
		// 快照阶段读不到目录：判断不了哪些文件是本次新写的，宁可不删。
		if names == nil {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".json") || name == "index.json" {
				continue
			}
			if _, existed := names[name]; existed {
				continue
			}
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}

func (s *Store) writeClassified(cache map[string]string) error {
	if raw, ok := cache[MemoryKey]; ok {
		if !s.writeMemory(raw) {
			return fmt.Errorf("记忆数据不是合法 JSON")
		}
	}
	if raw, ok := cache[CharacterListKey]; ok {
		current := cache[CharacterCurrentKey]
		if !s.writeCollection(raw, s.charsDir, "card", current) {
			return fmt.Errorf("人设卡数据不是合法 JSON 数组")
		}
	}
	if raw, ok := cache[ConversationKey]; ok {
		if !s.writeCollection(raw, s.convDir, "conv", "") {
			return fmt.Errorf("对话数据不是合法 JSON 数组")
		}
	}
	return nil
}

func (s *Store) writeMisc(cache map[string]string) error {
	misc := make(map[string]string, len(cache))
	for k, v := range cache {
		if isClassifiedKey(k) {
			continue
		}
		misc[k] = v
	}
	if s.splitVoiceSamples(misc) {
		cache[SettingsKey] = misc[SettingsKey]
	}
	return s.writeJSONAtomic(s.storeFile, misc)
}

// splitVoiceSamples 把设置里的音频字段落成独立文件，设置里只留 `file:<槽位>` 引用。
// 整段 base64 再转 JSON 会让几 MB 的音频在磁盘和内存里各翻一倍。
func (s *Store) splitVoiceSamples(obj map[string]string) bool {
	settingsRaw, ok := obj[SettingsKey]
	if !ok {
		return false
	}
	settings, ok := parseSettings(settingsRaw)
	if !ok {
		return false
	}
	changed := false
	for _, vs := range voiceSlots {
		value, _ := settings[vs.field].(string)
		if strings.HasPrefix(value, "file:") {
			continue
		}
		if value == "" {
			_, exists := settings[vs.field]
			if !exists {
				// 字段缺失 ≠ 用户清空：客户端可能发来一份不带样本字段的设置包
				//（缓存兜底丢字段后的整包保存就是实例）。把"没带"当成"清空"会删掉
				// voice-samples/ 下唯一一份音频字节，且 joinVoiceSamples 之后也拼不回来。
				// 真正的清空走显式空串（前端 clearMimoTtsCloneSample 设置 ''）。
				continue
			}
			delete(settings, vs.field)
			changed = true
			for _, ext := range []string{".wav", ".bin", ".json", ".mp3"} {
				_ = os.Remove(filepath.Join(s.voiceDir, vs.slot+ext))
			}
			continue
		}

		payload, mime, ok := decodeDataURL(value)
		if !ok || len(payload) == 0 {
			continue
		}
		ext := ".wav"
		if strings.Contains(strings.ToLower(mime), "mp3") {
			ext = ".mp3"
		}
		if err := s.writeJSONAtomic(filepath.Join(s.voiceDir, vs.slot+".json"),
			map[string]any{"version": 1, "mime": mime, "bytes": len(payload)}); err != nil {
			continue
		}
		if err := writeBinAtomic(filepath.Join(s.voiceDir, vs.slot+ext), payload); err != nil {
			continue
		}
		for _, other := range []string{".wav", ".mp3", ".bin"} {
			if other != ext {
				_ = os.Remove(filepath.Join(s.voiceDir, vs.slot+other))
			}
		}
		settings[vs.field] = "file:" + vs.slot
		changed = true
	}
	if changed {
		obj[SettingsKey] = mustMarshalCompact(settings)
	}
	return changed
}

// joinVoiceSamples 把 `file:<槽位>` 拼回完整 data URL；引用悬空就删字段，
// 前端会当成「没设置样本」重新上传，而不是拿着一个坏地址反复失败。
func (s *Store) joinVoiceSamples(obj map[string]string) {
	settingsRaw, ok := obj[SettingsKey]
	if !ok {
		return
	}
	settings, ok := parseSettings(settingsRaw)
	if !ok {
		return
	}
	changed := false
	for _, vs := range voiceSlots {
		value, _ := settings[vs.field].(string)
		if !strings.HasPrefix(value, "file:") {
			continue
		}
		if value != "file:"+vs.slot {
			delete(settings, vs.field)
			changed = true
			continue
		}
		var payload []byte
		metaMime := ""
		raw, hasMeta := readJSONFile(filepath.Join(s.voiceDir, vs.slot+".json"))
		if !hasMeta {
			// 元数据没了就等于样本损坏：删字段让前端重新上传，而不是拼一个空引用。
			delete(settings, vs.field)
			changed = true
			continue
		}
		var meta struct {
			Mime string `json:"mime"`
		}
		if json.Unmarshal(raw, &meta) == nil {
			metaMime = meta.Mime
		}
		for _, ext := range []string{".wav", ".mp3", ".bin"} {
			if data, err := os.ReadFile(filepath.Join(s.voiceDir, vs.slot+ext)); err == nil && len(data) > 0 {
				payload = data
				break
			}
		}
		if len(payload) == 0 {
			delete(settings, vs.field)
			changed = true
			continue
		}
		if metaMime == "" {
			metaMime = "audio/wav"
		}
		settings[vs.field] = "data:" + metaMime + ";base64," + base64.StdEncoding.EncodeToString(payload)
		changed = true
	}
	if changed {
		obj[SettingsKey] = mustMarshalCompact(settings)
	}
}

func (s *Store) stampLocked() string {
	parts := make([]string, 0, 3)
	for _, dir := range []string{s.dataDir, s.mainDir, s.convDir} {
		if info, err := os.Stat(dir); err == nil {
			parts = append(parts, strconv.FormatInt(info.ModTime().UnixMilli(), 10))
		} else {
			parts = append(parts, "-1")
		}
	}
	return strings.Join(parts, ",")
}

// 小工具

func cloneMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readObjectValue(path string) (string, bool) {
	raw, ok := readJSONFile(path)
	if !ok {
		return "", false
	}
	var rec struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(raw, &rec) != nil || rec.Value == "" {
		return "", false
	}
	return rec.Value, true
}

func ensureID(fields map[string]json.RawMessage, prefix string) string {
	if raw, ok := fields["id"]; ok {
		var id string
		if json.Unmarshal(raw, &id) == nil && safeID.MatchString(id) {
			return id
		}
	}
	id := prefix + "_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + randomBase36(6)
	encoded, _ := json.Marshal(id)
	fields["id"] = encoded
	return id
}

func randomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		now := time.Now().UnixNano()
		for i := range buf {
			buf[i] = byte(now >> (i % 8 * 8))
		}
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf)
}

func parseSettings(raw string) (map[string]any, bool) {
	var parsed map[string]any
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&parsed) != nil || parsed == nil {
		return nil, false
	}
	return parsed, true
}

// decodeDataURL 接受 data:...;base64,AAAA 与裸 base64 两种写法。
func decodeDataURL(value string) ([]byte, string, bool) {
	mime := "audio/wav"
	payload := value
	if strings.HasPrefix(value, "data:") {
		comma := strings.Index(value, ",")
		if comma < 0 {
			return nil, "", false
		}
		header := value[len("data:"):comma]
		if !strings.HasSuffix(header, ";base64") {
			return nil, "", false
		}
		mime = strings.TrimSuffix(header, ";base64")
		payload = value[comma+1:]
	}
	payload = strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', ' ', '\t':
			return -1
		}
		return r
	}, payload)
	if data, err := base64.StdEncoding.DecodeString(payload); err == nil {
		return data, mime, true
	}
	if data, err := base64.RawStdEncoding.DecodeString(payload); err == nil {
		return data, mime, true
	}
	return nil, "", false
}

func marshalIndent(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func marshalCompact(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func mustMarshalCompact(value any) string {
	text, err := marshalCompact(value)
	if err != nil {
		return "{}"
	}
	return string(text)
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}
