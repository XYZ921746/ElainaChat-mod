package memoryindex

import (
	"strings"
	"unicode"

	"github.com/ncruces/go-sqlite3/ext/fts5"
)

// bigramTokenizer 是给 FTS5 用的中文分词器。
//
// 为什么必须自带：ncruces 的 SQLite 构建里 FTS5 只带 unicode61 / trigram / ascii / porter。
// unicode61 把一整段连续汉字切成一个 token（「今天的日记」是一个词），查「日记」永远 0 条；
// trigram 只支持 ≥3 字的子串，中文最常见的两字词（约定、计划、咖啡）全部落空。
// 所以这里按「汉字两两成词」切，拉丁字母与数字按词切并转小写 —— 索引与查询走同一套规则，
// 口径才不会一边宽一边窄。
type bigramTokenizer struct{}

// tokenize 是索引与查询共用的唯一实现。emit 拿到词与它在原文里的字节区间。
func tokenize(text string, emit func(token string, start, end int) error) error {
	runes := []rune(text)
	// 预计算字节偏移：每个词都要报 [start,end)，逐次重算会让长文本退化成 O(n²)。
	byteAt := make([]int, len(runes)+1)
	for i, r := range runes {
		byteAt[i+1] = byteAt[i] + len(string(r))
	}
	wordStart := -1
	flush := func(end int) error {
		if wordStart < 0 {
			return nil
		}
		token := strings.ToLower(string(runes[wordStart:end]))
		start := wordStart
		wordStart = -1
		return emit(token, byteAt[start], byteAt[end])
	}
	for i := 0; i < len(runes); {
		if isCJK(runes[i]) {
			if err := flush(i); err != nil {
				return err
			}
			j := i
			for j < len(runes) && isCJK(runes[j]) {
				j++
			}
			if j-i == 1 {
				if err := emit(string(runes[i:j]), byteAt[i], byteAt[j]); err != nil {
					return err
				}
			} else {
				for k := i; k+1 < j; k++ {
					if err := emit(string(runes[k:k+2]), byteAt[k], byteAt[k+2]); err != nil {
						return err
					}
				}
			}
			i = j
			continue
		}
		if unicode.IsLetter(runes[i]) || unicode.IsDigit(runes[i]) {
			if wordStart < 0 {
				wordStart = i
			}
			i++
			continue
		}
		if err := flush(i); err != nil {
			return err
		}
		i++
	}
	return flush(len(runes))
}

func (bigramTokenizer) Tokenize(_ fts5.TokenizeFlag, text, _ string, xToken fts5.TokenCallback) error {
	return tokenize(text, func(token string, start, end int) error {
		return xToken(0, token, start, end)
	})
}

// isCJK 只圈「按字成词」的文字：汉字、假名、谚文。全角标点不是词，交给分隔符处理。
func isCJK(r rune) bool {
	switch {
	case r >= 0x3400 && r <= 0x4DBF: // CJK 扩展 A
		return true
	case r >= 0x4E00 && r <= 0x9FFF: // 基本区
		return true
	case r >= 0xF900 && r <= 0xFAFF: // 兼容汉字
		return true
	case r >= 0x20000 && r <= 0x2FA1F: // 扩展 B–F
		return true
	case r >= 0x3040 && r <= 0x30FF: // 平假名 + 片假名
		return true
	case r >= 0xAC00 && r <= 0xD7AF: // 谚文音节
		return true
	}
	return false
}

// tokenizeQuery 把用户输入切成与索引同一口径的词，供 MATCH 表达式拼装。
// 只保留词本身：查询用 AND 组合，长句按全部词命中才返回。
func tokenizeQuery(text string) []string {
	out := make([]string, 0, 32)
	_ = tokenize(text, func(token string, _, _ int) error {
		out = append(out, token)
		return nil
	})
	// 同一个词重复出现只会让 MATCH 变长，不影响结果。
	seen := make(map[string]struct{}, len(out))
	uniq := out[:0]
	for _, token := range out {
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		uniq = append(uniq, token)
	}
	return uniq
}

// buildMatchExpr 把词拼成 FTS5 的 MATCH 表达式。词只含字母/数字/汉字，
// 但仍逐个加引号：避免用户输入被当成 FTS5 的列名、NEAR 之类的运算符。
func buildMatchExpr(tokens []string) string {
	quoted := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token == "" {
			continue
		}
		quoted = append(quoted, `"`+strings.ReplaceAll(token, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, " AND ")
}
