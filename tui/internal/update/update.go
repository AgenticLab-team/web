package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

/*
 * 下载、校验、原子替换。
 *
 * ═════════════════════════════════════════
 * 没有校验和的自更新等于一条远程执行
 * ═════════════════════════════════════════
 *
 * 这段代码做的事是：拿一个从网上下来的文件，**替换掉正在跑的自己**。
 * 下一次启动跑的就是它。
 *
 * HTTPS 挡住了链路上的人，但它挡不住：
 *   · 一次写错的发布（传了半个文件、传了上一个架构的二进制）
 *   · 对象存储那边被改掉
 *   · 以及最常见的 —— 下载中断，只落了 3 MB
 *
 * 所以 sha256 是**硬性的**：对不上就删掉临时文件、什么都不做，
 * 而不是「记一条日志然后照装」。
 */

// Manifest 是 `/api/v1/release` 返回的那份。
type Manifest struct {
	Version      string  `json:"version"`
	Notes        string  `json:"notes"`
	MinSupported string  `json:"min_supported"`
	Assets       []Asset `json:"assets"`
}

type Asset struct {
	Platform string `json:"platform"`
	URL      string `json:"url"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
}

// Platform 是这台机器的 `GOOS-GOARCH`。
func Platform() string { return runtime.GOOS + "-" + runtime.GOARCH }

// AssetFor 挑出这台机器该下哪一个。
func (m Manifest) AssetFor(platform string) *Asset {
	for i := range m.Assets {
		if m.Assets[i].Platform == platform {
			return &m.Assets[i]
		}
	}
	return nil
}

var (
	// ErrNoAsset 是「这个平台没有预编译的二进制」。
	//
	// 它不是故障 —— 一个跑在 FreeBSD 上的人本来就该自己 go build。
	// 报成错误的话，他每次启动都会看到一句他无能为力的提示。
	ErrNoAsset = errors.New("这个平台没有预编译的二进制")
	// ErrChecksum 是校验和对不上。**这一条要吵**。
	ErrChecksum = errors.New("下载的文件校验和对不上")
)

// Apply 下载新版并原子替换掉当前这个二进制。
//
// ─────────────────────────────────────────
// 它换的是**磁盘上那个文件**，不是正在跑的这个进程
// ─────────────────────────────────────────
//
// Unix 上把一个正在执行的文件 rename 掉是允许的：老的 inode
// 还活着，当前进程照常跑完。所以「下次启动生效」不是偷懒，
// 是这条路上唯一安全的做法 —— 热替换意味着当前会话的状态全丢，
// 而人可能正打了一半的字。
func Apply(ctx context.Context, a Asset, httpClient *http.Client) error {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Minute}
	}

	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到自己在哪：%w", err)
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return fmt.Errorf("解析不了自己的路径：%w", err)
	}

	/*
	 * 临时文件放在**目标同一个目录**里。
	 *
	 * 放 /tmp 的话，rename 会跨文件系统失败（那是很常见的布局：
	 * /tmp 是 tmpfs，而 ~/.local/bin 在磁盘上）。
	 * 跨设备的 rename 只能退回「复制再删」，而那不是原子的 ——
	 * 中间掉电会留下一个半截的可执行文件。
	 */
	dir := filepath.Dir(self)
	tmp, err := os.CreateTemp(dir, ".ash-update-*")
	if err != nil {
		return fmt.Errorf("在 %s 里建不了临时文件（没有写权限？）：%w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName) // 成功路径上它已经被 rename 走了，这里是兜底
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("下载失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载失败：HTTP %d", resp.StatusCode)
	}

	// 边下边算哈希 —— 下完再读一遍要多一次完整的磁盘读
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, sum), resp.Body)
	if err != nil {
		return fmt.Errorf("下载中断：%w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	got := hex.EncodeToString(sum.Sum(nil))
	if got != a.SHA256 {
		/*
		 * 对不上就到此为止，临时文件由上面的 defer 删掉。
		 *
		 * 这句话要说得让人愿意转述给站长 —— 因为它有两种可能：
		 * 一次半截下载（无害），或者有人在中间换了文件（很严重），
		 * 而客户端分不出是哪一种。
		 */
		return fmt.Errorf("%w：期望 %s，实际 %s（下了 %d 字节）—— 没有替换任何东西，把这行贴给站长",
			ErrChecksum, a.SHA256, got, n)
	}

	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmpName, self); err != nil {
		return fmt.Errorf("替换失败（%s 没有写权限？）：%w", self, err)
	}
	return nil
}
