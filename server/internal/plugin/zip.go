package plugin

import (
	"elainachat/server/internal/zipx"
)

// 上传压缩包上限：桌面端、手机端与插件必须吃同一个数，分叉就是
// 「同一接口在电脑上能传、在手机上 413」。
const MaxUpload = 200 * 1024 * 1024

type ZipFile = zipx.File

// readZip 是插件契约里的解压入口；实现住在 zipx，保证插件、备份导入、模型包
// 吃的是同一份安全规则（危险扩展名 / 路径穿越 / 体积上限）。
func readZip(data []byte) ([]ZipFile, []string, error) {
	return zipx.Read(data, zipx.Options{})
}

func effectiveExt(name string) string {
	return zipx.EffectiveExt(name)
}

func isUnsafeEntryName(name string) bool {
	return zipx.IsUnsafeEntryName(name)
}
