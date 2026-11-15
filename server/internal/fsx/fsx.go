// Package fsx 是跨包共用的落盘原语：数据写入时强制到盘，改名带 Windows 短重试。
package fsx

import (
	"os"
	"time"
)

// WriteFileSync 写入并 fsync。rename 只保证原子替换，不保证数据先落盘：
// 掉电时目录项可能先于数据落定，正式文件会以空/半截内容出现，Sync 收窄这个窗口。
// 进程崩溃没有这个窗口（rename 前数据都在页缓存里，进程死了也还在），Sync 是给掉电的。
func WriteFileSync(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// WriteFileAtomic 原子落盘：数据先写临时文件（path+".tmp"）并强制到盘，再改名成正式文件。
// 改名的短重试是对抗 Windows 上杀软/同步盘对文件短暂持锁导致的 Access denied：
// rename 失败于源或目标任一侧被打开时都会发生，稍候重试通常能过；
// 失败期间旧文件原样保留，数据不会坏。
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := WriteFileSync(tmp, data, perm); err != nil {
		return err
	}
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		err = os.Rename(tmp, path)
		if err == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = os.Remove(tmp)
	return err
}
