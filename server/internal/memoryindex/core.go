package memoryindex

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 本文件是「六类目记忆」与 memory_items 行之间的双向转换。
//
// memory_items 是记忆的唯一权威：迁移（Store 的 elaina_open_memory_core）、
// 页面的读写（/api/memory/core）、备份导入都经过这里，所以转换必须**双向无损**——
// 类目里每个字段（含日记的 timestamp / conversationTitle / essences 这类附加字段）
// 都要能从行里原样还原。附加字段统一塞进 meta 列（JSON 对象），content 单独成列。

// Core 是前端 state.memoryCore 的形状（键名与前端现有 JSON 完全一致，前端零改动）。
type Core struct {
	Diary         []DiaryEntry `json:"diary"`
	Promise       []string     `json:"promise"`
	Preference    []string     `json:"preference"`
	Plan          []PlanEntry  `json:"plan"`
	Motivation    []string     `json:"motivation"`
	PivotalMemory []string     `json:"pivotal_memory"`
}

// DiaryEntry / PlanEntry 带 ID 字段：读接口把它一并给前端，前端据此做删除与 dropIds。
type DiaryEntry struct {
	ID                string   `json:"id,omitempty"`
	ConversationID    string   `json:"conversationId,omitempty"`
	ConversationTitle string   `json:"conversationTitle,omitempty"`
	Date              string   `json:"date,omitempty"`
	Content           string   `json:"content"`
	Essences          []string `json:"essences,omitempty"`
	Timestamp         string   `json:"timestamp,omitempty"`
}

type PlanEntry struct {
	ID      string `json:"id,omitempty"`
	Date    string `json:"date,omitempty"`
	Content string `json:"content"`
}

// 六类目在旧版 JSON 里的键顺序（迁移时按它分配 created_at，保证读回的顺序与旧数组一致）。
var coreKindOrder = []string{"diary", "promise", "preference", "plan", "motivation", "pivotal_memory"}

const (
	maxDateChars     = 80
	maxTitleChars    = 200
	maxStampChars    = 40
	maxEssenceCount  = 24
	maxEssenceChars  = 120
	maxMetaRunes     = 4000
	legacyMarkerKey  = "legacy_core_migrated"
	dumpFormatString = "elainachat-memory-dump"
	dumpVersion      = 1
)

// contentHash 与前端 memoryVectorHash 完全一致：FNV-1a 32 位，按 UTF-16 码元逐个喂入。
// 跨端一致是硬要求——前端要自己算 id（dropIds），算出来必须和服务端存下的相同。
func contentHash(text string) string {
	h := uint32(0x811c9dc5)
	for _, r := range text {
		if r > 0xFFFF {
			r -= 0x10000
			h ^= uint32(0xD800 + (r >> 10))
			h *= 0x01000193
			h ^= uint32(0xDC00 + (r & 0x3FF))
			h *= 0x01000193
			continue
		}
		h ^= uint32(r)
		h *= 0x01000193
	}
	return strconv.FormatUint(uint64(h), 16)
}

// kindDefaults 是六类目的默认置信/重要度：旧数据没有这两个字段，但索引需要可排序的值。
var kindDefaults = map[string][2]float64{
	"diary":          {0.8, 0.5},
	"promise":        {0.9, 0.7},
	"preference":     {0.85, 0.6},
	"plan":           {0.8, 0.5},
	"motivation":     {0.85, 0.7},
	"pivotal_memory": {0.95, 0.9},
}

var diaryDateRe = regexp.MustCompile(`(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日`)

// parseDiaryDateMs 与前端 parseDiaryDate 同口径：缺年份按当前年，取本地零点。
func parseDiaryDateMs(date string) int64 {
	m := diaryDateRe.FindStringSubmatch(date)
	if m == nil {
		return 0
	}
	year := time.Now().Year()
	if m[1] != "" {
		parsed, err := strconv.Atoi(m[1])
		if err != nil {
			return 0
		}
		year = parsed
	}
	month, err1 := strconv.Atoi(m[2])
	day, err2 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || month < 1 || month > 12 || day < 1 || day > 31 {
		return 0
	}
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.Local).UnixMilli()
}

// ParseCore 解析 legacy 六类目 JSON。缺的类目补空数组；类目条目里的额外字段原样保留在
// map 里（转行时进 meta），不会因为结构体没声明就丢掉。
func ParseCore(raw []byte) (Core, error) {
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Core{}, fmt.Errorf("%w：记忆 JSON 解析失败：%w", ErrInvalid, err)
	}
	core := Core{
		Diary:         []DiaryEntry{},
		Promise:       []string{},
		Preference:    []string{},
		Plan:          []PlanEntry{},
		Motivation:    []string{},
		PivotalMemory: []string{},
	}
	stringList := func(name string) ([]string, error) {
		rawList, ok := parsed[name]
		if !ok {
			return nil, nil
		}
		var list []string
		if err := json.Unmarshal(rawList, &list); err != nil {
			return nil, fmt.Errorf("%w：类目 %s 必须是字符串数组", ErrInvalid, name)
		}
		return list, nil
	}
	for _, name := range []string{"promise", "preference", "motivation", "pivotal_memory"} {
		list, listErr := stringList(name)
		if listErr != nil {
			return Core{}, listErr
		}
		switch name {
		case "promise":
			core.Promise = list
		case "preference":
			core.Preference = list
		case "motivation":
			core.Motivation = list
		case "pivotal_memory":
			core.PivotalMemory = list
		}
	}

	if rawList, ok := parsed["diary"]; ok {
		var entries []map[string]any
		if err := json.Unmarshal(rawList, &entries); err != nil {
			return Core{}, fmt.Errorf("%w：diary 必须是对象数组：%w", ErrInvalid, err)
		}
		for _, item := range entries {
			if item == nil {
				continue
			}
			core.Diary = append(core.Diary, DiaryEntry{
				ConversationID:    textOf(item["conversationId"]),
				ConversationTitle: textOf(item["conversationTitle"]),
				Date:              textOf(item["date"]),
				Content:           textOf(item["content"]),
				Essences:          stringSliceOf(item["essences"]),
				Timestamp:         textOf(item["timestamp"]),
			})
		}
	}
	if rawList, ok := parsed["plan"]; ok {
		var entries []map[string]any
		if err := json.Unmarshal(rawList, &entries); err != nil {
			return Core{}, fmt.Errorf("%w：plan 必须是对象数组：%w", ErrInvalid, err)
		}
		for _, item := range entries {
			if item == nil {
				continue
			}
			core.Plan = append(core.Plan, PlanEntry{
				Date:    textOf(item["date"]),
				Content: textOf(item["content"]),
			})
		}
	}
	// 日记不设条数上限：条目的删除只在用户手里（界面走 dropIDs），任何自动截断
	// 都会把「保存多、读回少」变成静默丢日记。
	return core, nil
}

func stringSliceOf(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// coreEntryID 与前端的 id 规则逐字一致（diary 用 conversationId|date，plan 用 date·content 的哈希，
// 其余 kind 用正文的哈希）。前端算 dropIds 靠它，两端必须给出同一个 id。
func coreEntryID(kind string, entry map[string]any) string {
	switch kind {
	case "diary":
		return "diary:" + textOf(entry["conversationId"]) + "|" + textOf(entry["date"])
	case "plan":
		parts := make([]string, 0, 2)
		if v := textOf(entry["date"]); v != "" {
			parts = append(parts, v)
		}
		if v := textOf(entry["content"]); v != "" {
			parts = append(parts, v)
		}
		return "plan:" + contentHash(strings.Join(parts, " · "))
	default:
		return kind + ":" + contentHash(textOf(entry["content"]))
	}
}

func textOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

type convertResult struct {
	items   []Item
	skipped []string
}

// coreToItems 把六类目转成行。转换不删任何类目条目；单个条目字段不合法时跳过并记录原因，
// 不让一条坏数据卡死整次迁移/保存。
func coreToItems(core Core) convertResult {
	out := convertResult{items: []Item{}, skipped: []string{}}
	add := func(kind string, entry map[string]any, extra map[string]any) {
		content := strings.TrimSpace(textOf(entry["content"]))
		if content == "" {
			out.skipped = append(out.skipped, kind+"：空内容")
			return
		}
		if runeCount(content) > maxContentRunes {
			out.skipped = append(out.skipped, kind+"：content 超过上限")
			return
		}
		meta := map[string]any{}
		for k, v := range entry {
			if k == "content" || k == "id" {
				continue
			}
			meta[k] = v
		}
		for k, v := range extra {
			meta[k] = v
		}
		metaJSON, err := json.Marshal(meta)
		if err != nil {
			out.skipped = append(out.skipped, kind+"：meta 序列化失败")
			return
		}
		if runeCount(string(metaJSON)) > maxMetaRunes {
			out.skipped = append(out.skipped, kind+"：附加字段超过上限")
			return
		}
		defaults := kindDefaults[kind]
		item := Item{
			ID:          coreEntryID(kind, entry),
			Kind:        kind,
			ScopeType:   "global",
			Content:     content,
			Summary:     "",
			Confidence:  defaults[0],
			Importance:  defaults[1],
			Status:      StatusActive,
			ContentHash: contentHash(content),
			Meta:        string(metaJSON),
		}
		if kind == "diary" {
			if convID := textOf(entry["conversationId"]); convID != "" {
				item.ScopeType = "conversation"
				item.ScopeID = convID
				item.SourceKind = "diary"
				item.SourceConversationID = convID
			}
			item.ValidFrom = parseDiaryDateMs(textOf(entry["date"]))
			if essences, ok := entry["essences"].([]string); ok {
				item.Summary = strings.Join(essences, " ")
			} else if raw, ok := entry["essences"].([]any); ok {
				parts := make([]string, 0, len(raw))
				for _, e := range raw {
					if text := textOf(e); text != "" {
						parts = append(parts, text)
					}
				}
				item.Summary = strings.Join(parts, " ")
			}
		}
		if kind == "plan" {
			item.Summary = textOf(entry["date"])
		}
		out.items = append(out.items, item)
	}

	for _, entry := range core.Diary {
		mapEntry := map[string]any{
			"conversationId":    entry.ConversationID,
			"conversationTitle": entry.ConversationTitle,
			"date":              entry.Date,
			"content":           entry.Content,
			"timestamp":         entry.Timestamp,
		}
		if entry.Essences != nil {
			mapEntry["essences"] = entry.Essences
		}
		add("diary", mapEntry, nil)
	}
	for _, kind := range []string{"promise", "preference", "motivation", "pivotal_memory"} {
		var list []string
		switch kind {
		case "promise":
			list = core.Promise
		case "preference":
			list = core.Preference
		case "motivation":
			list = core.Motivation
		case "pivotal_memory":
			list = core.PivotalMemory
		}
		for _, text := range list {
			add(kind, map[string]any{"content": text}, nil)
		}
	}
	for _, entry := range core.Plan {
		add("plan", map[string]any{"date": entry.Date, "content": entry.Content}, nil)
	}
	return out
}

// itemsToCore 把行还原成六类目。diary 按 valid_from 升序（与前端整理后的排序一致），
// 其余类目按 created_at 升序（等价于旧数组的「后写的排后面」）。
func itemsToCore(items []ItemOut) Core {
	core := Core{
		Diary:         []DiaryEntry{},
		Promise:       []string{},
		Preference:    []string{},
		Plan:          []PlanEntry{},
		Motivation:    []string{},
		PivotalMemory: []string{},
	}
	diary := make([]ItemOut, 0, len(items))
	rest := make(map[string][]ItemOut, len(coreKindOrder))
	for _, item := range items {
		if item.Kind == "diary" {
			diary = append(diary, item)
			continue
		}
		rest[item.Kind] = append(rest[item.Kind], item)
	}
	sort.SliceStable(diary, func(i, j int) bool {
		if diary[i].ValidFrom != diary[j].ValidFrom {
			return diary[i].ValidFrom < diary[j].ValidFrom
		}
		return diary[i].ID < diary[j].ID
	})
	for _, item := range diary {
		entry := DiaryEntry{ID: item.ID, Content: item.Content}
		decodeItemMeta(item.Meta, &metaTargets{
			strs: map[string]*string{
				"conversationId":    &entry.ConversationID,
				"conversationTitle": &entry.ConversationTitle,
				"date":              &entry.Date,
				"timestamp":         &entry.Timestamp,
			},
		})
		if entry.ConversationID == "" {
			entry.ConversationID = item.ScopeID
		}
		var essences []string
		if err := json.Unmarshal([]byte(item.Meta), &struct {
			Essences *[]string `json:"essences"`
		}{&essences}); err == nil && essences != nil {
			entry.Essences = essences
		}
		core.Diary = append(core.Diary, entry)
	}
	planItems := rest["plan"]
	sort.SliceStable(planItems, func(i, j int) bool {
		if planItems[i].CreatedAt != planItems[j].CreatedAt {
			return planItems[i].CreatedAt < planItems[j].CreatedAt
		}
		return planItems[i].ID < planItems[j].ID
	})
	for _, item := range planItems {
		entry := PlanEntry{ID: item.ID, Content: item.Content}
		decodeItemMeta(item.Meta, &metaTargets{strs: map[string]*string{"date": &entry.Date}})
		core.Plan = append(core.Plan, entry)
	}
	for _, kind := range []string{"promise", "preference", "motivation", "pivotal_memory"} {
		list := rest[kind]
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].CreatedAt != list[j].CreatedAt {
				return list[i].CreatedAt < list[j].CreatedAt
			}
			return list[i].ID < list[j].ID
		})
		out := make([]string, 0, len(list))
		for _, item := range list {
			out = append(out, item.Content)
		}
		switch kind {
		case "promise":
			core.Promise = out
		case "preference":
			core.Preference = out
		case "motivation":
			core.Motivation = out
		case "pivotal_memory":
			core.PivotalMemory = out
		}
	}
	return core
}

type metaTargets struct {
	strs map[string]*string
}

func decodeItemMeta(raw string, targets *metaTargets) {
	if strings.TrimSpace(raw) == "" {
		return
	}
	var obj map[string]any
	if json.Unmarshal([]byte(raw), &obj) != nil {
		return
	}
	for key, ptr := range targets.strs {
		if text, ok := obj[key].(string); ok {
			*ptr = text
		}
	}
}
