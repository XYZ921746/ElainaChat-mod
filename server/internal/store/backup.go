package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"elainachat/server/internal/zipx"
)

// 备份格式版本与 server/store.mjs 对齐：v1 是单个 JSON，v2 是 zip（数据摊在根上），
// v3 是 zip + data/ 目录；v4 = v3 目录 + 记忆为 data/memory-index/items.json 逻辑导出
// （记忆权威在 SQLite，.db 文件不进备份，导入即按行重建）。
// 导入三种都要认，换机器 / 重装 / 回滚才能连续。
const (
	BackupFormat  = "elainachat-backup"
	BackupVersion = 4
	dataPrefix    = "data/"
)

// MemoryDumpZipPath 是 v4 备份里记忆逻辑导出的固定路径。
// 刻意放在 memory/ 前缀之外：ParseBackup 只认 memory/<类目>.json，
// 其他实现导入 v4 备份时会把它当未知文件忽略，不会解析出垃圾类目。
const MemoryDumpZipPath = dataPrefix + "memory-index/items.json"

// voiceSampleFileRe 限定 voice-samples/ 下的合法文件名，防路径穿越。
var voiceSampleFileRe = map[string]bool{
	"mimo-clone.wav": true, "mimo-clone.mp3": true,
	"mimo-clone.bin": true, "mimo-clone.json": true,
}

type exportEntry struct {
	Name string
	Data any
}

// ExportZip 生成完整数据备份（不含插件与技能；那部分由 packages.Collect 传入，
// 因为安装目录与聊天数据的生命周期不同）。
func (s *Store) ExportZip(extra []zipx.Entry, extraCounts map[string]int) ([]byte, error) {
	return s.ExportZipWithSecrets(extra, extraCounts, nil)
}

// ExportZipWithSecrets 与 ExportZip 相同，但把调用方给的密钥表合并进备份的 settings.json。
//
// 为什么需要这个入口：APK 上 Key 只住在 Android Keystore，不写进 data/ ——
// 于是 Load() 里根本没有它们，导出的备份天然缺 Key，换机/重装后必须逐个重填。
// 页面导出前先从 Keystore 读出 Key 交给这里，备份就与桌面版同形（Key 在备份里、密码不在）。
//
// 只在内存里合并，不写回 data/：写回去就等于在设备上多存一份明文 Key，
// 与「Key 只住 Keystore」的约定冲突，也让 data/ 目录被拷走时连带泄露密钥。
func (s *Store) ExportZipWithSecrets(extra []zipx.Entry, extraCounts map[string]int, secrets map[string]string) ([]byte, error) {
	data, err := s.Load()
	if err != nil {
		return nil, err
	}
	if len(secrets) > 0 {
		merged := map[string]string{}
		if raw := strings.TrimSpace(data[SecretsKey]); raw != "" {
			if json.Unmarshal([]byte(raw), &merged) != nil || merged == nil {
				merged = map[string]string{}
			}
		}
		// 调用方给的（Keystore 现值）优先：data/ 里那份可能是旧的。
		for name, value := range secrets {
			if strings.TrimSpace(value) != "" {
				merged[name] = value
			}
		}
		if text, err := marshalCompact(merged); err == nil {
			data[SecretsKey] = string(text)
		}
	}
	entries := []zipx.Entry{}
	appendJSON := func(name string, value any) error {
		raw, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		entries = append(entries, zipx.Entry{Name: name, Data: raw})
		return nil
	}

	cardCount, convCount := 0, 0
	if items, err := parseArray(data[CharacterListKey]); err == nil {
		cardCount = len(items)
	}
	if items, err := parseArray(data[ConversationKey]); err == nil {
		convCount = len(items)
	}
	manifest := map[string]any{
		"format":     BackupFormat,
		"version":    BackupVersion,
		"exportedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"note":       "这是 ElainaChat 的数据备份（含已安装插件与技能）。导入时请选择本 zip 文件。",
		"counts": map[string]int{
			"characters":    cardCount,
			"conversations": convCount,
			"mods":          extraCounts["mods"],
			"skills":        extraCounts["skills"],
		},
	}
	if err := appendJSON("manifest.json", manifest); err != nil {
		return nil, err
	}

	settings := map[string]string{}
	for k, v := range data {
		if isClassifiedKey(k) {
			continue
		}
		// 向量索引是派生数据：服务端有 SQLite、页面可按当前模型重建；打进备份只会把
		// 几百 KB 到几 MB 的旧向量和模型指纹一起带走，导入后还可能是失效桶。
		if k == "elaina_memory_vectors" {
			continue
		}
		settings[k] = v
	}
	// 参考音频已经由 exportVoiceSamples 单独打进 data/voice-samples/，这里不能再来一份：
	// data 是 Load() 的结果，其中样本字段已被 joinVoiceSamples 拼成完整 data URL，
	// 原样写进 settings.json 会让同一段音频在备份里存两遍（实测 2.9MB 的 wav 变成 3.8MB base64）。
	// 导入时 RestoreVoiceSamples 会把音频落回 voice-samples/，joinVoiceSamples 再拼回去。
	s.stripVoiceSamplesForExport(settings)
	if err := appendJSON(dataPrefix+"settings.json", settings); err != nil {
		return nil, err
	}

	chars, err := s.exportCollection(s.charsDir, dataPrefix+"characters/")
	if err != nil {
		return nil, err
	}
	entries = append(entries, chars...)
	convs, err := s.exportCollection(s.convDir, dataPrefix+"conversations/")
	if err != nil {
		return nil, err
	}
	entries = append(entries, convs...)
	entries = append(entries, s.exportMemory()...)
	entries = append(entries, s.exportVoiceSamples()...)
	entries = append(entries, extra...)
	return zipx.Write(entries)
}

// exportCollection 导出「索引 + 一条一文件」的集合。
//
// 索引按**实际打进 zip 的条目**重建，而不是原样拷贝磁盘上的 index.json：
// 磁盘索引可能指向读不出来的条目、含非法 / 重复 ID，原样带走就产出一个自己导不回来的
// 备份（导入侧对这类不一致是整包拒绝）。宁可少带一条读不出的条目并留下日志，
// 也不要让整份备份因为一条坏数据全部作废。
func (s *Store) exportCollection(dir, prefix string) ([]zipx.Entry, error) {
	indexPath := filepath.Join(dir, "index.json")
	raw, readErr := os.ReadFile(indexPath)
	if readErr != nil {
		// 索引缺失可能是「这个集合还没迁移出来」，也可能是「索引损坏后已被
		// readCollection 隔离成 .bad-*」——后者条目文件还在，必须抢救：
		// 备份里缺这个键，replace 导入会把这台机器的同名集合清成空集合。
		salvaged, err := s.salvageCollection(dir, prefix)
		if err != nil {
			return nil, err
		}
		if len(salvaged) > 1 {
			s.logf("warn", "[store] 备份按目录扫描抢救 %s：index.json 缺失，带上 %d 个条目", dir, len(salvaged)-1)
		}
		return salvaged, nil
	}
	var idx collectionIndex
	if json.Unmarshal(raw, &idx) != nil {
		// 索引读不出来：顺序与当前指针都不可信，但条目文件可能还在。
		// 必须把能读出来的条目带上 —— 备份里缺这个键，replace 导入会把这台机器
		// 的同名集合清成空集合，用户以为恢复了其实什么都没恢复。
		salvaged, err := s.salvageCollection(dir, prefix)
		if err != nil {
			return nil, err
		}
		s.logf("warn", "[store] 备份按目录扫描抢救 %s：index.json 无法解析，带上 %d 个条目", dir, len(salvaged)-1)
		return salvaged, nil
	}
	entries := make([]zipx.Entry, 0, len(idx.Order)+1)
	order := make([]string, 0, len(idx.Order))
	seen := make(map[string]struct{}, len(idx.Order))
	skipped := make([]string, 0)
	for _, id := range idx.Order {
		if !safeID.MatchString(id) {
			skipped = append(skipped, id)
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		item, readOK := readJSONFile(filepath.Join(dir, id+".json"))
		if !readOK {
			skipped = append(skipped, id)
			continue
		}
		seen[id] = struct{}{}
		order = append(order, id)
		entries = append(entries, zipx.Entry{Name: prefix + id + ".json", Data: item})
	}
	if len(skipped) > 0 {
		s.logf("warn", "[store] 备份跳过 %s 下 %d 个无法导出的条目：%s",
			dir, len(skipped), strings.Join(skipped, "、"))
	}
	current := ""
	if _, kept := seen[idx.CurrentCardID]; kept {
		current = idx.CurrentCardID
	}
	indexRaw, err := marshalIndent(collectionIndex{Version: 1, Order: order, CurrentCardID: current})
	if err != nil {
		return nil, err
	}
	return append([]zipx.Entry{{Name: prefix + "index.json", Data: indexRaw}}, entries...), nil
}

// salvageCollection 在 index.json 不可解析时按目录扫描重建集合：
// 只认文件名是合法 ID 且内容是 JSON 对象的条目，按文件名排序给一个稳定顺序。
// 顺序信息已经丢了，但「有数据」比「顺序对」重要得多。
func (s *Store) salvageCollection(dir, prefix string) ([]zipx.Entry, error) {
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			// 目录本身不存在：这个集合还没有任何数据，备份里也就不该出现这个键。
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(dirEntries))
	for _, entry := range dirEntries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || name == "index.json" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]zipx.Entry, 0, len(names)+1)
	order := make([]string, 0, len(names))
	skipped := make([]string, 0)
	for _, name := range names {
		id := strings.TrimSuffix(name, ".json")
		if !safeID.MatchString(id) {
			skipped = append(skipped, name)
			continue
		}
		item, readOK := readJSONFile(filepath.Join(dir, name))
		if !readOK {
			skipped = append(skipped, name)
			continue
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil || fields == nil {
			skipped = append(skipped, name)
			continue
		}
		order = append(order, id)
		entries = append(entries, zipx.Entry{Name: prefix + name, Data: item})
	}
	if len(skipped) > 0 {
		s.logf("warn", "[store] 备份跳过 %s 下 %d 个无法导出的条目：%s",
			dir, len(skipped), strings.Join(skipped, "、"))
	}
	indexRaw, err := marshalIndent(collectionIndex{Version: 1, Order: order})
	if err != nil {
		return nil, err
	}
	return append([]zipx.Entry{{Name: prefix + "index.json", Data: indexRaw}}, entries...), nil
}

func (s *Store) exportMemory() []zipx.Entry {
	entries, err := os.ReadDir(s.memoryDir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	out := make([]zipx.Entry, 0, len(names))
	skipped := make([]string, 0)
	for _, name := range names {
		// 类目名直接当文件名：导入侧按 safeID 校验类目，带出去只会让整包被拒。
		if !safeID.MatchString(strings.TrimSuffix(name, ".json")) {
			skipped = append(skipped, name)
			continue
		}
		raw, ok := readJSONFile(filepath.Join(s.memoryDir, name))
		if !ok {
			skipped = append(skipped, name)
			continue
		}
		// 导入侧要求每条记录是 {"version":1,"value":…}：形状不对的记录打进备份会让
		// 整包被拒，所以这里按同一判据先筛一遍，坏记录跳过并留日志。
		var rec struct {
			Value *json.RawMessage `json:"value"`
		}
		if json.Unmarshal(raw, &rec) != nil || rec.Value == nil || !json.Valid(*rec.Value) {
			skipped = append(skipped, name)
			continue
		}
		out = append(out, zipx.Entry{Name: dataPrefix + "memory/" + name, Data: raw})
	}
	if len(skipped) > 0 {
		s.logf("warn", "[store] 备份跳过 %d 个无法导出的记忆记录：%s",
			len(skipped), strings.Join(skipped, "、"))
	}
	return out
}

// stripVoiceSamplesForExport 把设置包里的参考音频字段换回 `file:<槽位>` 引用。
//
// 备份里音频的字节只应出现一次（data/voice-samples/）。settings.json 里的那份是
// Load() 拼出来的派生值，留着就是重复存储，而且 base64 比原始 wav 还大三分之一。
// 导入侧认这个引用：RestoreVoiceSamples 先把音频落回 voice-samples/，
// 随后 joinVoiceSamples 再按引用拼回完整 data URL，前端无感。
func (s *Store) stripVoiceSamplesForExport(settings map[string]string) {
	raw, ok := settings[SettingsKey]
	if !ok {
		return
	}
	parsed, ok := parseSettings(raw)
	if !ok {
		return
	}
	changed := false
	for _, vs := range voiceSlots {
		value, _ := parsed[vs.field].(string)
		// 空值、已经是引用的，都不用动；只有完整 data URL 才是重复的那份。
		if value == "" || strings.HasPrefix(value, "file:") {
			continue
		}
		parsed[vs.field] = "file:" + vs.slot
		changed = true
	}
	if changed {
		settings[SettingsKey] = mustMarshalCompact(parsed)
	}
}

func (s *Store) exportVoiceSamples() []zipx.Entry {
	entries, err := os.ReadDir(s.voiceDir)
	if err != nil {
		return nil
	}
	out := []zipx.Entry{}
	for _, entry := range entries {
		if entry.IsDir() || !voiceSampleFileRe[entry.Name()] {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.voiceDir, entry.Name()))
		if err != nil || len(raw) == 0 {
			continue
		}
		out = append(out, zipx.Entry{Name: dataPrefix + "voice-samples/" + entry.Name(), Data: raw})
	}
	return out
}

func parseArray(raw string) ([]json.RawMessage, error) {
	var items []json.RawMessage
	if raw == "" {
		return nil, nil
	}
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, err
	}
	return items, nil
}

var ErrCorruptBackup = errors.New("备份数据损坏")

// ParseBackup 从 zip 条目还原前端看到的键值表，v2/v3 两种目录布局共用同一份校验。
// 已识别的数据文件损坏时必须报错：缺键与坏数据在替换导入里是完全不同的语义。
func ParseBackup(files []zipx.File) (map[string]string, error) {
	byName := make(map[string][]byte, len(files))
	for _, f := range files {
		byName[f.Name] = f.Data
	}
	data := map[string]string{}
	readText := func(name string) (string, bool) {
		if raw, ok := byName[name]; ok {
			return string(raw), true
		}
		if raw, ok := byName[dataPrefix+name]; ok {
			return string(raw), true
		}
		return "", false
	}
	corrupt := func(name, reason string) error {
		return fmt.Errorf("%w：%s（%s）", ErrCorruptBackup, name, reason)
	}

	if text, ok := readText("settings.json"); ok {
		var obj map[string]json.RawMessage
		if json.Unmarshal([]byte(text), &obj) != nil || obj == nil {
			return nil, corrupt("settings.json", "不是合法的键值对象")
		}
		for k, v := range obj {
			var str string
			if json.Unmarshal(v, &str) != nil {
				return nil, corrupt("settings.json", "键 "+k+" 的值不是字符串")
			}
			data[k] = str
		}
	}

	readCollection := func(dir, key string, currentKey bool) error {
		indexName := dir + "/index.json"
		text, ok := readText(indexName)
		if !ok {
			return nil
		}
		var idx collectionIndex
		if json.Unmarshal([]byte(text), &idx) != nil || idx.Order == nil {
			return corrupt(indexName, "索引不是合法 JSON 或缺少 order")
		}
		items := make([]json.RawMessage, 0, len(idx.Order))
		seen := make(map[string]struct{}, len(idx.Order))
		for _, id := range idx.Order {
			if !safeID.MatchString(id) {
				return corrupt(indexName, "索引含非法条目 ID")
			}
			if _, duplicate := seen[id]; duplicate {
				return corrupt(indexName, "索引含重复条目 ID："+id)
			}
			seen[id] = struct{}{}
			name := dir + "/" + id + ".json"
			item, exists := readText(name)
			if !exists {
				return corrupt(name, "索引引用的条目缺失")
			}
			var fields map[string]json.RawMessage
			if json.Unmarshal([]byte(item), &fields) != nil || fields == nil {
				return corrupt(name, "条目不是合法 JSON 对象")
			}
			items = append(items, json.RawMessage(item))
		}
		raw, err := marshalCompact(items)
		if err != nil {
			return corrupt(indexName, "集合无法序列化")
		}
		data[key] = string(raw)
		if currentKey && idx.CurrentCardID != "" {
			data[CharacterCurrentKey] = idx.CurrentCardID
		}
		return nil
	}
	if err := readCollection("characters", CharacterListKey, true); err != nil {
		return nil, err
	}
	if err := readCollection("conversations", ConversationKey, false); err != nil {
		return nil, err
	}

	memObj := map[string]json.RawMessage{}
	for _, f := range files {
		name := f.Name
		var rest string
		if strings.HasPrefix(name, dataPrefix+"memory/") {
			rest = strings.TrimPrefix(name, dataPrefix+"memory/")
		} else if strings.HasPrefix(name, "memory/") {
			rest = strings.TrimPrefix(name, "memory/")
		} else {
			continue
		}
		if !strings.HasSuffix(rest, ".json") {
			continue
		}
		category := strings.TrimSuffix(rest, ".json")
		if !safeID.MatchString(category) {
			return nil, corrupt(name, "记忆类目名不合法")
		}
		var rec struct {
			Value *json.RawMessage `json:"value"`
		}
		if json.Unmarshal(f.Data, &rec) != nil || rec.Value == nil || !json.Valid(*rec.Value) {
			return nil, corrupt(name, "记忆记录不是合法 JSON 或缺少 value")
		}
		memObj[category] = *rec.Value
	}
	if len(memObj) > 0 {
		raw, err := marshalCompact(memObj)
		if err != nil {
			return nil, corrupt("memory/", "记忆无法序列化")
		}
		data[MemoryKey] = string(raw)
	} else if text, ok := readText("memory.json"); ok {
		var rec struct {
			Value *string `json:"value"`
		}
		if json.Unmarshal([]byte(text), &rec) != nil || rec.Value == nil {
			return nil, corrupt("memory.json", "旧记忆记录不是合法 JSON 或缺少 value")
		}
		data[MemoryKey] = *rec.Value
	}

	return normalizeData(data), nil
}

// ParseLegacyJSON 认 v1 的单个 JSON 备份：{data:{…}} 或直接一份键值表。
func ParseLegacyJSON(raw []byte) (map[string]string, error) {
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, errors.New("这个文件既不是 zip 也不是有效的 JSON 备份")
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil, errors.New("这个文件既不是 zip 也不是有效的 JSON 备份")
	}
	if nested, ok := obj["data"].(map[string]any); ok {
		obj = nested
	}
	out := map[string]string{}
	for k, v := range obj {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	return normalizeData(out), nil
}

// 长度按 UTF-16 码元计：与 store.go 的存盘校验、JS string.length 的语义一致。
// 按 UTF-8 字节判会让以中日韩文字为主的大历史在导入时被误判超限而丢弃。
func normalizeData(raw map[string]string) map[string]string {
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		if k == "" || utf16Len(k) > maxKeyChars || utf16Len(v) > maxValue {
			continue
		}
		out[k] = v
	}
	return out
}

// RestoreVoiceSamples 把备份里的参考音频落回 data/voice-samples/，
// 设置里的 `file:<槽位>` 引用才能成立；单文件失败不挡整包导入。
// 拿写锁：虽然 writeBinAtomic 不碰写盘去重表，但 replace 导入刚清过音频目录，
// 与并发的 Save 往同一批文件里交错写没有任何收益。
func (s *Store) RestoreVoiceSamples(files []zipx.File) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := os.MkdirAll(s.voiceDir, 0o755); err != nil {
		return
	}
	for _, f := range files {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		rest := ""
		if strings.HasPrefix(name, dataPrefix+voiceDirName+"/") {
			rest = strings.TrimPrefix(name, dataPrefix+voiceDirName+"/")
		} else if strings.HasPrefix(name, voiceDirName+"/") {
			rest = strings.TrimPrefix(name, voiceDirName+"/")
		}
		if rest == "" || !voiceSampleFileRe[rest] {
			continue
		}
		_ = writeBinAtomic(filepath.Join(s.voiceDir, rest), f.Data)
	}
}

// ImportBackup 把键值表合并进本地数据。mode=replace 时把备份里没有的分类写成空集合，
// 否则「替换」只覆盖备份里有的键，备份里没有的旧对话会原样留下。
//
// 全程持有写锁：改缓存、写分类文件与 Save 碰的是同一批磁盘文件与写盘去重表，
// 拆成两截就会与并发的 Save 交错（最重会踩出 map 并发写的 fatal）。
func (s *Store) ImportBackup(incoming map[string]string, mode string) (int, error) {
	keys := len(incoming)
	if keys == 0 {
		return 0, errors.New("备份里没有可导入的数据")
	}
	if mode == "replace" {
		for _, key := range []string{CharacterListKey, ConversationKey} {
			raw, exists := incoming[key]
			if !exists {
				continue
			}
			var items []json.RawMessage
			if json.Unmarshal([]byte(raw), &items) != nil {
				return 0, fmt.Errorf("%w：%s 不是合法 JSON 数组", ErrCorruptBackup, key)
			}
		}
		if raw, exists := incoming[MemoryKey]; exists {
			var memory map[string]json.RawMessage
			if json.Unmarshal([]byte(raw), &memory) != nil || memory == nil {
				return 0, fmt.Errorf("%w：记忆不是合法 JSON 对象", ErrCorruptBackup)
			}
		}
	}

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
	if mode == "replace" {
		for k := range s.cache {
			delete(s.cache, k)
		}
		for k, v := range incoming {
			s.cache[k] = normalizeCollectionValue(k, v)
		}
	} else {
		// merge 的集合键不能整表赋缓存：writeCollection 以缓存数组为 keep 集删条目，
		// 备份里没有的本地会话会被物理删掉。这里按 id 合并进磁盘（同 id 本机赢、
		// 本地独有条目保留），与迁移路径 mergeCollection 同一语义；杂项键才是键级覆盖。
		for k, v := range incoming {
			switch k {
			case CharacterListKey:
				if changed, ok := s.mergeCollection(v, s.charsDir, "card", ""); ok && changed {
					if items, _, readOK := s.readCollection(s.charsDir); readOK && items != "" {
						s.cache[k] = items
					}
				}
			case ConversationKey:
				if changed, ok := s.mergeCollection(v, s.convDir, "conv", ""); ok && changed {
					if items, _, readOK := s.readCollection(s.convDir); readOK && items != "" {
						s.cache[k] = items
					}
				}
			case MemoryKey:
				s.cache[k] = mergeMemoryByKey(s.cache[k], v)
			case CharacterCurrentKey:
				// 本机已有当前人设指针时保持不动，与集合键的「同 id 本机赢」一致。
				if _, exists := s.cache[k]; !exists {
					s.cache[k] = v
				}
			default:
				s.cache[k] = normalizeCollectionValue(k, v)
			}
		}
	}
	if mode == "replace" {
		// 备份里没有的分类写成空集合，交给 saveLocked 统一落盘：writeCollection /
		// writeMemory 都是「先写新数据、再删旧条目」，Save 成功后才清盘，
		// Save 失败时旧数据不会被先物理删掉。
		if _, ok := incoming[MemoryKey]; !ok {
			s.cache[MemoryKey] = "{}"
		}
		if _, ok := incoming[CharacterListKey]; !ok {
			s.cache[CharacterListKey] = "[]"
			delete(s.cache, CharacterCurrentKey)
		}
		if _, ok := incoming[ConversationKey]; !ok {
			s.cache[ConversationKey] = "[]"
		}
	}
	s.mu.Unlock()

	if err := s.saveLocked(); err != nil {
		// 缓存里已经是导入后的状态而磁盘还是旧数据，放着不管的话下一次任意保存
		// 会把这份半成品冲盘；失效让缓存从磁盘重建。
		s.Invalidate()
		return 0, err
	}
	if mode == "replace" {
		// 清盘哨兵（"{}"/"[]"）不能留在缓存里：Load 快路径会把它们当成
		// 「存在但为空」的键发出去，而磁盘上这些分类已经没有条目了。
		s.Invalidate()
	}
	if mode == "replace" {
		// 设置被整份替换后，备份里没有的参考音频已经失去引用；数据落盘成功后才清文件。
		if _, ok := incoming[SettingsKey]; !ok {
			if entries, err := os.ReadDir(s.voiceDir); err == nil {
				for _, entry := range entries {
					_ = os.Remove(filepath.Join(s.voiceDir, entry.Name()))
				}
			}
		}
	}
	return keys, nil
}

// mergeMemoryByKey 按条目 id 把备份的记忆六类目并进本机：同 id 本机赢，只补本机没有的条目。
// 没带 id 的条目跳过——导入主链路会给它们生成 id，这里补进去只会制造重复。
// 仅在记忆索引不可用（SQLite 半边缺席）时被走到；权威在 SQLite 时记忆键在
// httpapi 层就已摘走，不经过这里。
func mergeMemoryByKey(existingRaw, incomingRaw string) string {
	var incoming map[string]json.RawMessage
	if json.Unmarshal([]byte(incomingRaw), &incoming) != nil {
		return existingRaw
	}
	existing := map[string]json.RawMessage{}
	if existingRaw != "" {
		if json.Unmarshal([]byte(existingRaw), &existing) != nil {
			existing = map[string]json.RawMessage{}
		}
	}
	for category, rawItems := range incoming {
		var items []json.RawMessage
		if json.Unmarshal(rawItems, &items) != nil {
			continue
		}
		var current []json.RawMessage
		if raw, ok := existing[category]; ok && json.Unmarshal(raw, &current) != nil {
			current = nil
		}
		ids := make(map[string]bool, len(current))
		for _, item := range current {
			if id := rawFieldString(item, "id"); id != "" {
				ids[id] = true
			}
		}
		for _, item := range items {
			id := rawFieldString(item, "id")
			if id == "" || ids[id] {
				continue
			}
			ids[id] = true
			current = append(current, item)
		}
		// 类目在本地不存在且一条都没补进来时保持缺席：写盘侧会补 []，
		// 这里落个 null 反而会被读侧当成类目损坏。
		if current != nil {
			if encoded, err := marshalCompact(current); err == nil {
				existing[category] = encoded
			}
		}
	}
	encoded, err := marshalCompact(existing)
	if err != nil {
		return existingRaw
	}
	return string(encoded)
}

func rawFieldString(item json.RawMessage, field string) string {
	fields := map[string]json.RawMessage{}
	if json.Unmarshal(item, &fields) != nil {
		return ""
	}
	var value string
	if json.Unmarshal(fields[field], &value) != nil {
		return ""
	}
	return value
}

// DataCounts 给 /api/data/info 用：只解析内存里的键值，不读磁盘目录。
func (s *Store) DataCounts() (characters, conversations, memoryEntries, keyCount int, err error) {
	data, err := s.Load()
	if err != nil {
		return 0, 0, 0, 0, err
	}
	if items, err := parseArray(data[CharacterListKey]); err == nil {
		characters = len(items)
	}
	if items, err := parseArray(data[ConversationKey]); err == nil {
		conversations = len(items)
	}
	var mem map[string]json.RawMessage
	if json.Unmarshal([]byte(data[MemoryKey]), &mem) == nil {
		var diary []json.RawMessage
		if json.Unmarshal(mem["diary"], &diary) == nil {
			memoryEntries = len(diary)
		}
	}
	return characters, conversations, memoryEntries, len(data), nil
}
