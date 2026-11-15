package auth

import (
	"strings"
	"unicode/utf16"
)

// 密码是「能不能在这台电脑上执行命令」的唯一那道门，弱口令在跑得动 scrypt 的机器上可被离线秒破。
// 规则只要求「数字 + 其他字符」：强制大小写会把人逼去写 Password1! 这类可预测形态，收益低于「更长 + 两类字符」本身。
const (
	PwdMinLen = 8
	PwdMaxLen = 128
)

var weakPasswords = map[string]struct{}{
	"password": {}, "password1": {}, "password123": {}, "passw0rd": {}, "p@ssw0rd": {},
	"12345678": {}, "123456789": {}, "1234567890": {}, "87654321": {},
	"qwerty123": {}, "qwertyui": {}, "qwertyuiop": {}, "asdfghjkl": {}, "zxcvbnm1": {},
	"abc12345": {}, "abcd1234": {}, "a1234567": {}, "admin123": {}, "administrator1": {},
	"letmein1": {}, "iloveyou1": {}, "welcome1": {}, "monkey123": {}, "dragon123": {},
	"elaina123": {}, "elainachat1": {}, "sunshine1": {}, "princess1": {}, "football1": {},
}

var sequences = []string{
	"0123456789", "9876543210",
	"abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba",
	"qwertyuiop", "poiuytrewq", "asdfghjkl", "lkjhgfdsa", "zxcvbnm", "mnbvcxz",
}

type StrengthResult struct {
	OK      bool
	Message string
}

// ValidatePasswordStrength 返回可直接展示给用户的中文原因。
func ValidatePasswordStrength(pwd string) StrengthResult {
	s := pwd
	if utf16Len(s) < PwdMinLen {
		return StrengthResult{Message: "新密码至少 8 位"}
	}
	if utf16Len(s) > PwdMaxLen {
		return StrengthResult{Message: "新密码过长"}
	}

	if !hasDigit(s) {
		return StrengthResult{Message: "新密码必须同时包含数字和其他字符（字母或符号）（当前缺数字）"}
	}
	if !hasNonDigit(s) {
		return StrengthResult{Message: "新密码必须同时包含数字和其他字符（字母或符号）（当前缺字母或符号）"}
	}

	lower := strings.ToLower(s)
	if msg := weakPasswordMessage(lower); msg != "" {
		return StrengthResult{Message: msg}
	}
	if isRepeatedUnit(s, 1, 4) {
		return StrengthResult{Message: "新密码是同一段内容重复，请换一个"}
	}
	if runeSetSize(s) < 4 {
		return StrengthResult{Message: "新密码用到的字符太少了（至少要用 4 种不同字符），请换一个"}
	}
	longest := longestSequentialRun(lower)
	if longest >= 6 && utf16Len(s)-longest <= 2 {
		return StrengthResult{Message: "新密码里几乎全是连续顺序（如 12345678、qwertyui），请换一个"}
	}
	return StrengthResult{OK: true}
}

func weakPasswordMessage(lower string) string {
	if _, hit := weakPasswords[lower]; hit {
		return "这个密码太常见了，很容易被猜到，请换一个"
	}
	// 常见弱口令后面/前面加一两位也要拦：多一个字符就放行，
	// 而它在任何字典攻击里都是第一梯队。
	for w := range weakPasswords {
		if len(w) < 6 {
			continue
		}
		if strings.HasPrefix(lower, w) && len(lower)-len(w) <= 2 {
			return "这个密码是在常见弱口令后面加了几位，很容易被猜到，请换一个"
		}
		if strings.HasSuffix(lower, w) && len(lower)-len(w) <= 2 {
			return "这个密码是在常见弱口令前面加了几位，很容易被猜到，请换一个"
		}
	}
	return ""
}

// isRepeatedUnit 判定整个字符串是不是某个 1..4 字符单元的整数次重复。
// 用循环而不是正则：Go 的 regexp 不支持反向引用，硬套会写出与语义不符的表达式。
func isRepeatedUnit(s string, minLen, maxLen int) bool {
	runes := []rune(s)
	n := len(runes)
	for size := minLen; size <= maxLen; size++ {
		if size == 0 || n%size != 0 || n/size < 2 {
			continue
		}
		ok := true
		for i := size; i < n; i++ {
			if runes[i] != runes[i%size] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func runeSetSize(s string) int {
	set := make(map[rune]struct{}, len(s))
	for _, r := range s {
		set[r] = struct{}{}
	}
	return len(set)
}

func longestSequentialRun(lower string) int {
	best := 0
	for _, seq := range sequences {
		for start := 0; start < len(seq); start++ {
			for length := maxInt(6, best+1); start+length <= len(seq); length++ {
				if strings.Contains(lower, seq[start:start+length]) {
					if length > best {
						best = length
					}
					continue
				}
				break
			}
		}
	}
	return best
}

func hasDigit(s string) bool {
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}

func hasNonDigit(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return true
		}
	}
	return false
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
