package memoryindex

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cache", "memory_index.db")
	s, err := Open(path, nil)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(s.Close)
	return s, path
}

func vec(dims int, fill byte) string {
	raw := make([]byte, dims)
	for i := range raw {
		raw[i] = fill
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func TestUpsertLoadDelete(t *testing.T) {
	s, path := newTestStore(t)
	batch := Batch{
		Fingerprint: "fp-a",
		Dims:        4,
		Items: []Vector{
			{ID: "diary:1", Hash: "h1", Vec: vec(4, 1)},
			{ID: "msg:1", Hash: "h2", Vec: vec(4, 2)},
		},
	}
	n, err := s.Upsert(batch)
	if err != nil || n != 2 {
		t.Fatalf("Upsert = %d, %v", n, err)
	}
	status, err := s.Status("fp-a")
	if err != nil || status.Count != 2 || status.Dims != 4 {
		t.Fatalf("Status = %+v, %v", status, err)
	}
	index, err := s.Load("fp-a")
	if err != nil || len(index.Items) != 2 || index.Dims != 4 {
		t.Fatalf("Load = %+v, %v", index, err)
	}
	if index.Items["diary:1"].H != "h1" || index.Items["diary:1"].V != vec(4, 1) {
		t.Fatalf("Load item 内容不对：%+v", index.Items["diary:1"])
	}

	// 同一 id 在不同指纹下必须共存：换模型不能把旧桶的行搬走。
	if _, err := s.Upsert(Batch{
		Fingerprint: "fp-b", Dims: 4,
		Items: []Vector{{ID: "diary:1", Hash: "h1b", Vec: vec(4, 3)}},
	}); err != nil {
		t.Fatalf("覆盖 Upsert: %v", err)
	}
	if got, _ := s.Status("fp-a"); got.Count != 2 {
		t.Fatalf("旧指纹应保留 2 条，实得 %+v", got)
	}
	if got, _ := s.Status("fp-b"); got.Count != 1 {
		t.Fatalf("新指纹应 1 条，实得 %+v", got)
	}

	// 关掉再开：索引必须还在。
	s.Close()
	reopened, err := Open(path, nil)
	if err != nil {
		t.Fatalf("重开: %v", err)
	}
	defer reopened.Close()
	loaded, err := reopened.Load("fp-b")
	if err != nil || loaded.Items["diary:1"].H != "h1b" {
		t.Fatalf("重开后 Load = %+v, %v", loaded, err)
	}

	if n, err := reopened.Delete("fp-b", []string{"diary:1"}); err != nil || n != 1 {
		t.Fatalf("Delete = %d, %v", n, err)
	}
	empty, err := reopened.Load("fp-b")
	if err != nil || len(empty.Items) != 0 || empty.Dims != 0 {
		t.Fatalf("删除后 Load = %+v, %v", empty, err)
	}
}

func TestFingerprintIsolationAndReset(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.Upsert(Batch{Fingerprint: "fp-a", Dims: 2, Items: []Vector{{ID: "x", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Load("fp-b"); err != nil || len(got.Items) != 0 {
		t.Fatalf("别的指纹不应看到向量：%+v, %v", got, err)
	}
	if _, err := s.Reset("fp-b"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Status("fp-a"); got.Count != 1 {
		t.Fatalf("清空别的指纹不应动 fp-a：%+v", got)
	}
	if n, err := s.Reset("fp-a"); err != nil || n != 1 {
		t.Fatalf("Reset fp-a = %d, %v", n, err)
	}
	if got, _ := s.Status(""); got.Count != 0 {
		t.Fatalf("Reset 后应为空：%+v", got)
	}
}

func TestBatchValidation(t *testing.T) {
	s, _ := newTestStore(t)
	cases := []struct {
		name  string
		batch Batch
		want  error
	}{
		{"空指纹", Batch{Dims: 2, Items: []Vector{{ID: "a", Hash: "h", Vec: vec(2, 1)}}}, ErrBadFingerprint},
		{"零维度", Batch{Fingerprint: "fp", Dims: 0}, ErrBadDims},
		{"维度超限", Batch{Fingerprint: "fp", Dims: maxDims + 1}, ErrBadDims},
		{"空 id", Batch{Fingerprint: "fp", Dims: 2, Items: []Vector{{ID: "", Hash: "h", Vec: vec(2, 1)}}}, nil},
		{"坏 base64", Batch{Fingerprint: "fp", Dims: 2, Items: []Vector{{ID: "a", Hash: "h", Vec: "!!!"}}}, nil},
		{"长度不符", Batch{Fingerprint: "fp", Dims: 3, Items: []Vector{{ID: "a", Hash: "h", Vec: vec(2, 1)}}}, nil},
		{"空 hash", Batch{Fingerprint: "fp", Dims: 2, Items: []Vector{{ID: "a", Hash: "", Vec: vec(2, 1)}}}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.Upsert(tc.batch)
			if err == nil {
				t.Fatalf("应拒绝：%+v", tc.batch)
			}
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("错误类型不对：%v", err)
			}
		})
	}

	tooMany := make([]Vector, maxBatchItems+1)
	for i := range tooMany {
		tooMany[i] = Vector{ID: "id-" + string(rune('a'+i%26)), Hash: "h", Vec: vec(2, 1)}
	}
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2, Items: tooMany}); !errors.Is(err, ErrTooManyItems) {
		t.Fatalf("超批应拒绝：%v", err)
	}
}

func TestCorruptFileIsRebuilt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cache", "memory_index.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("not a sqlite database\n", 64)), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, nil)
	if err != nil {
		t.Fatalf("损坏库应能重建：%v", err)
	}
	defer s.Close()
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2, Items: []Vector{{ID: "a", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatalf("重建后写入：%v", err)
	}
	matches, _ := filepath.Glob(path + ".bad-*")
	if len(matches) == 0 {
		t.Fatalf("损坏文件应改名留证，目录：%v", path)
	}
}

// 降级运行（库版本比程序新）时文件是健康的：隔离重建等于销毁数据，
// 必须原样报错并把文件留在原地。
func TestOpenSchemaTooNewKeepsFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.db")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err := Open(path, nil)
	if !errors.Is(err, ErrSchemaTooNew) {
		t.Fatalf("应报 ErrSchemaTooNew：%v", err)
	}
	if s != nil {
		t.Fatalf("不应返回可用的库")
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("健康的库被隔离重建了：%v", statErr)
	}
	matches, _ := filepath.Glob(path + ".bad-*")
	if len(matches) != 0 {
		t.Errorf("不应产生留证文件：%v", matches)
	}
}

func TestVectorBucketsAcceptSameID(t *testing.T) {
	s, _ := newTestStore(t)
	for _, fp := range []string{"fp-a", "fp-b"} {
		if _, err := s.Upsert(Batch{Fingerprint: fp, Dims: 2,
			Items: []Vector{{ID: "same", Hash: "h-" + fp, Vec: vec(2, 1)}}}); err != nil {
			t.Fatalf("写入 %s: %v", fp, err)
		}
	}
	for _, fp := range []string{"fp-a", "fp-b"} {
		idx, err := s.Load(fp)
		if err != nil || len(idx.Items) != 1 || idx.Items["same"].H != "h-"+fp {
			t.Fatalf("%s 应保留自己的同 id 向量：%+v, %v", fp, idx, err)
		}
	}
	// 按指纹删除只影响该桶。
	if n, err := s.Delete("fp-a", []string{"same"}); err != nil || n != 1 {
		t.Fatalf("Delete fp-a = %d, %v", n, err)
	}
	if idx, _ := s.Load("fp-b"); len(idx.Items) != 1 {
		t.Fatalf("删 fp-a 不应影响 fp-b：%+v", idx)
	}
}

func TestVectorBucketDimsMismatch(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2,
		Items: []Vector{{ID: "a", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatal(err)
	}
	_, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 4,
		Items: []Vector{{ID: "b", Hash: "h", Vec: vec(4, 1)}}})
	if !errors.Is(err, ErrBadDims) {
		t.Fatalf("同指纹换维度应报 ErrBadDims：%v", err)
	}
	if status, _ := s.Status("fp"); status.Dims != 2 || status.Count != 1 {
		t.Fatalf("维度冲突不应污染现有桶：%+v", status)
	}
}

func TestBeginCommitLifecycle(t *testing.T) {
	s, _ := newTestStore(t)
	build1, err := s.Begin("fp", 4)
	if err != nil || build1 == "" {
		t.Fatalf("Begin = %q, %v", build1, err)
	}
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 4, BuildID: build1,
		Items: []Vector{{ID: "a", Hash: "h", Vec: vec(4, 1)}}}); err != nil {
		t.Fatalf("构建中 Upsert: %v", err)
	}
	// 未 commit 的桶必须读成空，不能把半成品当完整索引。
	if idx, err := s.Load("fp"); err != nil || len(idx.Items) != 0 || idx.Dims != 4 {
		t.Fatalf("未 commit 应返回空桶：%+v, %v", idx, err)
	}
	if status, _ := s.Status("fp"); status.Ready || status.Count != 0 {
		t.Fatalf("未 commit 的 Status 应 ready=false/count=0：%+v", status)
	}
	if err := s.Commit("fp", build1); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if idx, err := s.Load("fp"); err != nil || len(idx.Items) != 1 {
		t.Fatalf("commit 后应可读：%+v, %v", idx, err)
	}

	// Begin 不 Commit 后再次 Begin：新构建无条件接管，旧 build 的写入/提交都要被拒绝。
	build2, err := s.Begin("fp", 4)
	if err != nil || build2 == "" || build2 == build1 {
		t.Fatalf("第二次 Begin = %q, %v", build2, err)
	}
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 4, BuildID: build1,
		Items: []Vector{{ID: "stale", Hash: "h", Vec: vec(4, 2)}}}); !errors.Is(err, ErrStaleBuild) {
		t.Fatalf("旧 build 的 Upsert 应被拒绝：%v", err)
	}
	if err := s.Commit("fp", build1); !errors.Is(err, ErrStaleBuild) {
		t.Fatalf("旧 build 的 Commit 应被拒绝：%v", err)
	}
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 4, BuildID: build2,
		Items: []Vector{{ID: "b", Hash: "h2", Vec: vec(4, 3)}}}); err != nil {
		t.Fatalf("新 build Upsert: %v", err)
	}
	if err := s.Commit("fp", build2); err != nil {
		t.Fatalf("新 build Commit: %v", err)
	}
	if idx, err := s.Load("fp"); err != nil || len(idx.Items) != 1 || idx.Items["b"].H != "h2" {
		t.Fatalf("新构建应成为唯一内容：%+v, %v", idx, err)
	}
}

func TestUpsertWithoutBeginKeepsCompatibility(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.Upsert(Batch{Fingerprint: "fp", Dims: 2,
		Items: []Vector{{ID: "a", Hash: "h", Vec: vec(2, 1)}}}); err != nil {
		t.Fatal(err)
	}
	status, err := s.Status("fp")
	if err != nil || !status.Ready || status.Count != 1 || status.BuildID != "" {
		t.Fatalf("无 begin 的直接写入应建成 ready 桶：%+v, %v", status, err)
	}
}

func TestResetClearsBucketMetadata(t *testing.T) {
	s, _ := newTestStore(t)
	if _, err := s.Begin("fp", 2); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reset("fp"); err != nil {
		t.Fatal(err)
	}
	status, err := s.Status("fp")
	if err != nil || status.Count != 0 || status.Dims != 0 || !status.Ready {
		t.Fatalf("Reset 后桶元数据应清空：%+v, %v", status, err)
	}
}
