// Package auth 管两件事：怎么登录，以及登录之后那把令牌放哪。
package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/zalando/go-keyring"
)

/*
 * 令牌的保管。
 *
 * ═════════════════════════════════════════
 * 优先系统钥匙串，退回 0600 的文件
 * ═════════════════════════════════════════
 *
 * 钥匙串（macOS Keychain / Linux Secret Service）的好处不是加密本身 ——
 * 是**别的进程读不到**：一个跑在同一个用户下的脚本，
 * 不用任何提权就能读走 `~/.config` 里的任何文件。
 *
 * 但它经常不可用：没有图形会话的服务器、SSH 进来的 shell、
 * 没装 gnome-keyring 的容器。那些恰恰是这个工具最常跑的地方。
 *
 * 所以是「有就用，没有就退回文件」，而不是「必须有」——
 * 后者会让一大半人根本登录不了，而他们的替代方案是
 * 把令牌写进 shell 的环境变量，那比一个 0600 的文件糟得多。
 */

const (
	keyringService = "agenticlab"
	keyringUser    = "ash-token"
)

// Credentials 是一次登录的产物。
type Credentials struct {
	Token  string   `json:"token"`
	Scopes []string `json:"scopes"`
	// 毫秒时间戳。0 = 不过期
	ExpiresAt int64 `json:"expires_at"`
	// 这把是从哪个站换来的 —— 换站要重新登录
	Site string `json:"site"`
}

// Expired 是「这把还能用吗」。
//
// 提前 60 秒判过期：一次调用从发起到服务端验令牌之间有网络延迟，
// 卡着到期时间用的话，最后那一次会拿到 401 而客户端认为它还有效 ——
// 于是它会当成「令牌坏了」而不是「令牌到期了」，
// 提示的话也就跟着错。
func (c Credentials) Expired(now time.Time) bool {
	if c.ExpiresAt == 0 {
		return false
	}
	return now.Add(60*time.Second).UnixMilli() >= c.ExpiresAt
}

// Store 是令牌放哪。
type Store struct {
	// 文件兜底的路径。空串 = 用默认位置
	Path string
	// 关掉钥匙串，只用文件。SSH 网关那侧一定要关 ——
	// 那台机器上没有属于任何一个人的钥匙串
	FileOnly bool
}

func defaultPath() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "agenticlab", "credentials.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".agenticlab-credentials.json")
}

func (s Store) path() string {
	if s.Path != "" {
		return s.Path
	}
	return defaultPath()
}

// Save 存一把令牌。
func (s Store) Save(c Credentials) error {
	blob, err := json.Marshal(c)
	if err != nil {
		return err
	}

	if !s.FileOnly {
		if err := keyring.Set(keyringService, keyringUser, string(blob)); err == nil {
			/*
			 * 存进钥匙串之后**把文件那份删掉**。
			 *
			 * 不删的话，一个人第一次在没有钥匙串的机器上登录、
			 * 后来装上了钥匙串，磁盘上会永远留着一份旧令牌 ——
			 * 而他以为自己的令牌只在钥匙串里。
			 */
			_ = os.Remove(s.path())
			return nil
		}
		// 钥匙串不可用是常态（无图形会话的服务器），不是错误，往下走
	}

	p := s.path()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	/*
	 * 先写临时文件再改名。
	 *
	 * 直接覆盖的话，写到一半掉电会留下一个**半截的凭据文件** ——
	 * 而它解析不出来，表现是「莫名其妙被登出了」。
	 * 改名在同一个文件系统上是原子的。
	 */
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ErrNoCredentials 是「还没登录过」。它是**正常状态**，不是故障 ——
// 上层据此进登录流程，而不是报错。
var ErrNoCredentials = errors.New("还没登录")

// Load 取出令牌。
func (s Store) Load() (Credentials, error) {
	if !s.FileOnly {
		if blob, err := keyring.Get(keyringService, keyringUser); err == nil && blob != "" {
			var c Credentials
			if json.Unmarshal([]byte(blob), &c) == nil && c.Token != "" {
				return c, nil
			}
		}
	}

	blob, err := os.ReadFile(s.path())
	if err != nil {
		if os.IsNotExist(err) {
			return Credentials{}, ErrNoCredentials
		}
		return Credentials{}, err
	}

	var c Credentials
	if err := json.Unmarshal(blob, &c); err != nil || c.Token == "" {
		/*
		 * 文件在但读不出来 —— 当成「没登录」而不是报错。
		 *
		 * 报错的话人会卡在一个他无法处理的状态上（那个文件是我们写的，
		 * 他没有任何理由知道里面该是什么）。当成没登录的话，
		 * 他会走一遍登录，而登录会把它覆盖掉 —— 问题自己就没了。
		 */
		return Credentials{}, ErrNoCredentials
	}
	return c, nil
}

// Clear 退出登录。
//
// 两处都清 —— 只清一处的话，「退出」之后重启一下又进去了，
// 而那是这类工具最让人不安的一种 bug。
func (s Store) Clear() {
	if !s.FileOnly {
		_ = keyring.Delete(keyringService, keyringUser)
	}
	_ = os.Remove(s.path())
}

// Describe 说清楚这把令牌现在放在哪。
//
// 「我的令牌到底存哪了」是一个人会问、而且**有权知道**的问题 ——
// 尤其在他刚被告知「SSH 网关那侧令牌存在服务器上」之后。
func (s Store) Describe() string {
	if s.FileOnly {
		return s.path() + "（权限 0600）"
	}
	if _, err := keyring.Get(keyringService, keyringUser); err == nil {
		switch runtime.GOOS {
		case "darwin":
			return "macOS 钥匙串"
		default:
			return "系统钥匙串（Secret Service）"
		}
	}
	return s.path() + "（权限 0600 —— 这台机器上没有可用的钥匙串）"
}
