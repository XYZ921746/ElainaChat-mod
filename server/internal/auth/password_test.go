package auth

import (
	"strings"
	"testing"
)

func TestValidatePasswordStrength(t *testing.T) {
	cases := []struct {
		pwd       string
		ok        bool
		wantPiece string
	}{
		{"", false, "至少"},
		{strings.Repeat("a", 7), false, "至少"},
		{"Password1", false, "常见"},
		{"Abcdefg1", false, "连续顺序"},
		{"Ab1Ab1Ab1", false, "重复"},
		{"Aa1aaaaa", false, "字符太少"},
		{"abcdefgh", false, "缺数字"},
		{"12345678", false, "字母或符号"},
		{"Abc123xy", true, ""},
		{"abcde1xy", true, ""},
		{"ABCDE1XY", true, ""},
	}
	for _, tc := range cases {
		got := ValidatePasswordStrength(tc.pwd)
		if got.OK != tc.ok {
			t.Fatalf("%q 期望 ok=%v，实际 ok=%v（%s）", tc.pwd, tc.ok, got.OK, got.Message)
		}
		if tc.wantPiece != "" && !strings.Contains(got.Message, tc.wantPiece) {
			t.Fatalf("%q 的提示 %q 应包含 %q", tc.pwd, got.Message, tc.wantPiece)
		}
	}
}

func TestValidatePasswordLengthLimit(t *testing.T) {
	long := "Aa1" + strings.Repeat("x", PwdMaxLen)
	if res := ValidatePasswordStrength(long); res.OK || !strings.Contains(res.Message, "过长") {
		t.Fatalf("超长密码应被拒绝，实际：%+v", res)
	}
}
