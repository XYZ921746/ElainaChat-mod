package fsx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PathInside 只回答路径形状是否位于 root 内，不承诺文件真实位置。
func PathInside(target, root string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// ExistingPathWithin 把链接解析后再检查边界；中间目录的链接同样会被跟随。
func ExistingPathWithin(target, root string) (string, error) {
	realTarget, err := RealPath(target)
	if err != nil {
		return "", err
	}
	realRoot, err := RealPath(root)
	if err != nil {
		return "", err
	}
	if !PathInside(realTarget, realRoot) {
		return "", fmt.Errorf("路径越出了允许目录：%s", target)
	}
	return realTarget, nil
}

// WritablePathWithin 允许目标尚不存在，但最深的现存祖先必须落在真实 root 内。
// 链接不能替换成真实路径后再操作，否则删除或重命名链接会意外操作其目标。
func WritablePathWithin(target, root string) error {
	realRoot, err := RealPath(root)
	if err != nil {
		return err
	}
	parent := target
	var suffix []string
	for {
		realParent, statErr := RealPath(parent)
		if statErr == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				realParent = filepath.Join(realParent, suffix[i])
			}
			if !PathInside(realParent, realRoot) {
				return fmt.Errorf("路径越出了允许目录：%s", target)
			}
			return nil
		}
		if !os.IsNotExist(statErr) {
			return statErr
		}
		next := filepath.Dir(parent)
		if next == parent {
			return statErr
		}
		suffix = append(suffix, filepath.Base(parent))
		parent = next
	}
}

// ExistingDirectoryWithin 同时确认目标是真实 root 内的现存目录。
func ExistingDirectoryWithin(target, root string) (string, error) {
	resolved, err := ExistingPathWithin(target, root)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", target)
	}
	return resolved, nil
}
