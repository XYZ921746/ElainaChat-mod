package memoryindex

import (
	"fmt"
	"testing"
)

// 日记不设条数上限（截断与总量上限都已移除）：超量的条目必须原样入库、原样读回。
// 条目只允许用户手动删除，任何自动裁剪都是替用户丢日记。
func TestDiaryHasNoEntryCap(t *testing.T) {
	s, _ := newTestStore(t)
	const total = 5100
	core := Core{}
	for i := 0; i < total; i++ {
		core.Diary = append(core.Diary, DiaryEntry{
			ConversationID: fmt.Sprintf("c%d", i),
			Date:           uncappedDiaryDate(i),
			Content:        fmt.Sprintf("第 %d 篇日记", i),
		})
	}
	if _, _, err := s.MergeCore(core, nil, "test"); err != nil {
		t.Fatalf("MergeCore: %v", err)
	}
	got, err := s.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != total {
		t.Fatalf("日记应全量保留 %d 条，实际 %d", total, len(got.Diary))
	}
}

// 旧版 JSON 导入路径（ParseCore）同样不截断。
func TestLegacyCoreImportHasNoDiaryCap(t *testing.T) {
	s, _ := newTestStore(t)
	const total = 5001
	diary := make([]map[string]any, 0, total)
	for i := 0; i < total; i++ {
		diary = append(diary, map[string]any{
			"date":    uncappedDiaryDate(i),
			"content": fmt.Sprintf("第 %d 篇日记", i),
		})
	}
	raw := mustJSON(t, map[string]any{"diary": diary})
	if _, err := s.ImportLegacyCore(raw, true, "test"); err != nil {
		t.Fatalf("ImportLegacyCore: %v", err)
	}
	got, err := s.Core()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Diary) != total {
		t.Fatalf("旧版导入的日记应全量保留 %d 条，实际 %d", total, len(got.Diary))
	}
}

// 生成彼此不同的日期：日记条目 id = diary:conversationId|date，日期相同会被 upsert 合并。
func uncappedDiaryDate(i int) string {
	y := 2000 + i/366
	d := i % 366
	return fmt.Sprintf("%d年%d月%d日", y, d/31+1, d%31+1)
}
