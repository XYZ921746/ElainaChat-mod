package auth

import (
	"strings"
	"testing"
)

// 密码强度规则的边界穷举：密码是"能不能操作这台电脑"的唯一那道门，
// 这里钉住长度下界、字符类别、弱口令表及其加缀变体、顺子 / 键盘序、字符种类下限。
// 合格样本刻意不用"弱口令 + 尾数"的写法，避免把规则往松的方向逼。
func TestPasswordStrengthBoundaryTable(t *testing.T) {
	accepted := []string{
		"Elaina2024", "MyPc-2024", "aB3xY9zQ", "Str0ngPassword", "xKp7mNq2",
		"Weather7Sun", "DeepSeek8Ai", "Zz9!aaaa", "Tr4velBug", "Aa1!aaaa",
		"abcde1xy", "ABCDE1XY", "TestPass1234",
	}
	for _, pwd := range accepted {
		if res := ValidatePasswordStrength(pwd); !res.OK {
			t.Errorf("合格密码 %q 被误拒：%s", pwd, res.Message)
		}
	}

	rejected := []string{
		"Ab1",          // 少于 8 位
		"Abc1234",      // 7 位（长度边界）
		"Abcd1234",     // 8 位但弱口令表命中
		"Abcdefgh",     // 缺数字
		"abcdefgh",     // 缺数字
		"12345678",     // 只有数字，缺其他字符
		"11111111",     // 纯重复字符
		"Aaa1aaaa",     // 字符种类太少（只有 3 种）
		"12345678aA",   // 数字顺子 + 尾缀
		"1234567890aA", // 完整数字顺子
		"Qwertyui1A",   // 键盘序 + 尾缀
		"password",     // 常见弱口令
		"Password123",  // 弱口令表命中（忽略大小写）
		"ADMIN123a",    // admin123 大小写变体
		"Abc12345",     // abc12345 命中弱口令表
		"admin123aA",   // 弱口令加两位后缀也在拦截范围内
		"   ",          // 空白
		"",             // 空串
	}
	for _, pwd := range rejected {
		if res := ValidatePasswordStrength(pwd); res.OK {
			t.Errorf("弱密码 %q 不应通过强度校验", pwd)
		}
	}
}

// 拒绝原因必须点名问题：提示说不出"缺什么"，用户就只能瞎猜着换密码。
func TestPasswordStrengthMessagesNameTheProblem(t *testing.T) {
	cases := []struct {
		pwd   string
		piece string
	}{
		{"Ab1", "至少"},
		{"Aa1" + strings.Repeat("x", 200), "过长"},
		{"abcdefgh", "数字"},
		{"12345678", "字母或符号"},
		{"Password123", "常见"},
		{"Aaa1aaaa", "字符"},
	}
	for _, tc := range cases {
		res := ValidatePasswordStrength(tc.pwd)
		if res.OK || !strings.Contains(res.Message, tc.piece) {
			t.Errorf("%q 的提示 %q 应包含 %q", tc.pwd, res.Message, tc.piece)
		}
	}
}

// 弱口令表要有足够规模（否则防不住"图省事"的常见选择），常量与文档语义一致。
func TestPasswordWeakListAndBounds(t *testing.T) {
	if PwdMinLen != 8 {
		t.Fatalf("PwdMinLen 应为 8，实际 %d", PwdMinLen)
	}
	if len(weakPasswords) < 20 {
		t.Fatalf("弱口令表应有至少 20 条，实际 %d 条", len(weakPasswords))
	}
}
