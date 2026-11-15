package store

// 本文件把「住在设置包字段里的 Key」就地转进密钥表（elainachat_open_api_secrets）。
// 很早的版本把 apiKey / 各家语音 Key 直接放进 elaina_open_settings 字段里；升级后 Key 只走密钥表。
// 前端 loadSettings 会在页面加载时做同样的转存，但那只覆盖「打开过页面」的场景 ——
// 只起服务不开页面、或手机旧数据在服务端导入后还没开过页面时，Key 会一直留在设置包里；
// 服务端在这里就地转存一次，密钥升级才不依赖页面是否打开过。

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// SecretsKey 是密钥表在 Store 里的键名，与前端 API_SECRET_NAMES 的落点、
// ByokSecretsPlugin.ALLOWED_NAMES 的白名单是同一套约定。
const SecretsKey = "elainachat_open_api_secrets"

// legacySecretNames 是「可能内嵌在设置包里的 Key 字段名」，与前端 API_SECRET_NAMES
// （web/js/core-config.js）一一对应；chatProviderKeys 是对象值，单独按 providerId 合并。
// 漏一个名字，那家服务的老 Key 就永远留在设置包里、前端一删就丢。
var legacySecretNames = []string{
	"apiKey", "minimaxApiKey", "dashscopeApiKey",
	"asrApiKey", "mimoApiKey", "mimoTtsApiKey", "openaiTtsApiKey",
	"searchApiKey_tavily", "searchApiKey_custom",
}

// MigrateEmbeddedLegacySecrets 把设置包里内嵌的 Key 字段转进密钥表：
// 密钥表已有值优先（不能被旧值覆盖），转存成功后才把设置包里的字段删掉。
// 返回是否发生了写入；设置包不存在 / 没有可搬字段时不写盘。
func (s *Store) MigrateEmbeddedLegacySecrets() (bool, error) {
	legacy, ok := s.readStoreFile()
	if !ok {
		return false, nil
	}
	settingsRaw := legacy[SettingsKey]
	if strings.TrimSpace(settingsRaw) == "" {
		return false, nil
	}
	var settings map[string]any
	if json.Unmarshal([]byte(settingsRaw), &settings) != nil || settings == nil {
		return false, fmt.Errorf("设置包不是合法 JSON，跳过内嵌 Key 转存")
	}
	secrets := map[string]string{}
	if raw := strings.TrimSpace(legacy[SecretsKey]); raw != "" {
		if json.Unmarshal([]byte(raw), &secrets) != nil || secrets == nil {
			// 密钥表坏了就当空表：设置包里还有完整副本，这次转存是恢复而不是覆盖。
			secrets = map[string]string{}
		}
	}
	changed := false
	for _, name := range legacySecretNames {
		text := secretTextOf(settings[name])
		if text == "" {
			continue
		}
		if strings.TrimSpace(secrets[name]) == "" {
			secrets[name] = text
			changed = true
		}
		// 字段无论有没有搬进密钥表都从设置包删掉：留着它，前端每次 loadSettings 都会再走一遍转存。
		delete(settings, name)
		changed = true
	}
	if raw, ok := settings["chatProviderKeys"]; ok {
		merged, mergedAny := mergeLegacyChatProviderKeys(secrets["chatProviderKeys"], raw)
		if mergedAny {
			secrets["chatProviderKeys"] = merged
			changed = true
		}
		delete(settings, "chatProviderKeys")
		changed = true
	}
	if !changed {
		return false, nil
	}
	settingsText, err := marshalCompact(settings)
	if err != nil {
		return false, err
	}
	secretsText, err := marshalCompact(secrets)
	if err != nil {
		return false, err
	}
	legacy[SettingsKey] = string(settingsText)
	legacy[SecretsKey] = string(secretsText)
	if err := s.writeJSONAtomic(s.storeFile, legacy); err != nil {
		return false, err
	}
	s.Invalidate()
	s.logf("info", "[store] 设置包内嵌 Key 已转存进密钥表")
	return true, nil
}

// mergeLegacyChatProviderKeys 把设置包里的 chatProviderKeys（对象或 JSON 串）按 providerId
// 合并进密钥表的同名条目（密钥表里它也是 JSON 串）。已有值优先；返回合并后的 JSON 串与
// 「是否真的合并进了新值」。
func mergeLegacyChatProviderKeys(existingJSON string, raw any) (string, bool) {
	existing := map[string]string{}
	if strings.TrimSpace(existingJSON) != "" {
		if json.Unmarshal([]byte(existingJSON), &existing) != nil || existing == nil {
			existing = map[string]string{}
		}
	}
	var incoming map[string]string
	switch value := raw.(type) {
	case string:
		if strings.TrimSpace(value) == "" {
			return existingJSON, false
		}
		if json.Unmarshal([]byte(value), &incoming) != nil || incoming == nil {
			return existingJSON, false
		}
	case map[string]any:
		incoming = map[string]string{}
		for id, val := range value {
			if text := secretTextOf(val); text != "" {
				incoming[id] = text
			}
		}
	default:
		return existingJSON, false
	}
	mergedAny := false
	for id, key := range incoming {
		if id == "" || strings.TrimSpace(key) == "" {
			continue
		}
		if strings.TrimSpace(existing[id]) != "" {
			continue
		}
		existing[id] = key
		mergedAny = true
	}
	if !mergedAny {
		return existingJSON, false
	}
	text, err := marshalCompact(existing)
	if err != nil {
		return existingJSON, false
	}
	return string(text), true
}

// secretTextOf 把设置包字段值规整成密钥表的字符串形态；对象型字段（除 chatProviderKeys 外
// 不该出现）返回空串，避免把 map 强转成乱码存进密钥表。
func secretTextOf(v any) string {
	switch value := v.(type) {
	case string:
		return strings.TrimSpace(value)
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(value)
	default:
		return ""
	}
}
