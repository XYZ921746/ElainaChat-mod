package httpapi

import (
	"net/http"

	"elainachat/server/internal/updatecheck"
)

// updateResponse 让 /api/app/update 既有检测结果，又带上当前版本与发行形态：
// 前端据此给出对应安装包的下载入口。
type updateResponse struct {
	updatecheck.Result
	Current string `json:"current"`
	Edition string `json:"edition"`
}

// handleAppUpdate 只做检测与提示，不做自我更新。
func (s *Server) handleAppUpdate(w http.ResponseWriter, r *http.Request) {
	result := s.update.Check(r.Context())
	writeJSON(w, http.StatusOK, updateResponse{
		Result:  result,
		Current: s.cfg.Version,
		Edition: s.cfg.Edition,
	}, nil)
}
