package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/jmr/agenticlab/tui/internal/api"
)

/*
 * 设备码登录 —— 客户端这一半。
 *
 * ═════════════════════════════════════════
 * 屏幕上显示的是 user_code，揣在手里的是 device_code
 * ═════════════════════════════════════════
 *
 * 前者短、会被人念出来、会被旁边的人看到；后者 256 位、从不显示。
 * 换令牌只认后者。
 *
 * 所以这份代码里有一条硬规矩：**`deviceCode` 不许出现在任何
 * 会被打到屏幕上的地方** —— 包括错误信息和调试输出。
 * 打出去一次，「偷看屏幕」就等于「拿到令牌」。
 */

// StartResponse 是服务端给的那一份。
type StartResponse struct {
	UserCode string `json:"user_code"`
	// 不显示。见上
	DeviceCode string `json:"device_code"`
	// 让人打开的地址
	VerificationURI string `json:"verification_uri"`
	// 已经把码拼进去的那一版，画二维码用它
	VerificationURIComplete string   `json:"verification_uri_complete"`
	Interval                int      `json:"interval"`
	ExpiresIn               int      `json:"expires_in"`
	Scopes                  []string `json:"scopes"`
}

type tokenResponse struct {
	AccessToken string   `json:"access_token"`
	Scopes      []string `json:"scopes"`
	ExpiresAt   int64    `json:"expires_at"`
}

// Fingerprint 是报给服务端、显示在确认页上的那几行。
//
// ─────────────────────────────────────────
// 它是**给人核对用的**，不是给机器认的
// ─────────────────────────────────────────
//
// 所以填的是机器名、系统、终端类型 —— 人认得出的东西。
// 报一个设备 id 等于没报：没有人知道自己的设备 id 是什么，
// 于是每个人都会直接点同意，包括被骗的那一个。
//
// 这些字段**服务端不信任**（它们由客户端自己填，可以是假的），
// 而确认页上那句「如果你现在没有在终端里登录，关掉这一页」
// 才是真正的判据。
type Fingerprint struct {
	Host    string `json:"host"`
	OS      string `json:"os"`
	Term    string `json:"term"`
	Version string `json:"version"`
}

// DetectFingerprint 填出这台机器的样子。
func DetectFingerprint(version string) Fingerprint {
	host, _ := os.Hostname()
	term := os.Getenv("TERM")
	if term == "" {
		term = "未知终端"
	}
	return Fingerprint{Host: host, OS: goos(), Term: term, Version: version}
}

// Source 是「本地二进制」还是「SSH 网关」。
//
// 它决定两件事，而两件都是**服务端**判的：
//   - SSH 那边不许申请 groups:send 和 admin:all
//   - SSH 那边签出的令牌 7 天到期，本地的 90 天
//
// 客户端只负责如实上报。报假的没有意义：报成 cli 能多申请两个 scope，
// 但那两个 scope 在网关上恰恰是最危险的，而网关的代码是我们自己的。
type Source string

const (
	SourceCLI Source = "cli"
	SourceSSH Source = "ssh"
)

// Start 要一串码。
func Start(ctx context.Context, c *api.Client, src Source, fp Fingerprint, scopes []string, sshKey string) (*StartResponse, error) {
	body := map[string]any{
		"source":      string(src),
		"fingerprint": fp,
		"scopes":      scopes,
	}
	if sshKey != "" {
		body["ssh_key"] = sshKey
	}
	var out StartResponse
	if err := c.Post(ctx, "/api/v1/auth/device/start", body, &out); err != nil {
		return nil, err
	}
	if out.DeviceCode == "" || out.UserCode == "" {
		return nil, errors.New("服务端没给出验证码 —— 这个站可能还没开终端登录")
	}
	return &out, nil
}

// ErrDenied 是用户在网页上点了「拒绝」。
//
// 单独成一个错误，因为上层对它的处理和别的失败不同：
// 拒绝不该提示「再试一次」—— 那是在劝人推翻自己刚做的决定。
var ErrDenied = errors.New("你在网页上拒绝了这次登录")

// ErrExpired 是码过期了。
var ErrExpired = errors.New("这串码过期了")

// Poll 一直问到有结果。
//
// ─────────────────────────────────────────
// 间隔听服务端的，不是客户端自己定
// ─────────────────────────────────────────
//
// 服务端在 `slow_down` 里会给一个新的间隔。不听它的话，
// 一个写死 1 秒轮询的客户端会被一直推慢，最后慢到人以为它卡住了 ——
// 而它其实每一次都被拒了。
func Poll(ctx context.Context, c *api.Client, start *StartResponse, onWait func(remaining time.Duration)) (Credentials, error) {
	interval := time.Duration(start.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)

	for {
		if onWait != nil {
			onWait(time.Until(deadline))
		}

		select {
		case <-ctx.Done():
			return Credentials{}, ctx.Err()
		case <-time.After(interval):
		}

		var tok tokenResponse
		err := c.Post(ctx, "/api/v1/auth/device/poll",
			map[string]any{"device_code": start.DeviceCode}, &tok)
		if err == nil && tok.AccessToken != "" {
			return Credentials{
				Token:     tok.AccessToken,
				Scopes:    tok.Scopes,
				ExpiresAt: tok.ExpiresAt,
				Site:      c.BaseURL,
			}, nil
		}

		apiErr := api.AsError(err)
		if apiErr == nil {
			return Credentials{}, err
		}

		switch apiErr.Code {
		case "":
			/*
			 * 轮询那条路的错误体不是 `{error:{code,message}}`，
			 * 是 OAuth 那套扁平的 `{error: "..."}`。
			 * 客户端库认不出来，所以这里按状态码兜一遍。
			 */
			switch apiErr.Status {
			case 428:
				continue // authorization_pending
			case 429:
				interval *= 2
				if interval > 30*time.Second {
					interval = 30 * time.Second
				}
				continue
			case 400:
				return Credentials{}, ErrExpired
			}
			return Credentials{}, err
		case "authorization_pending":
			continue
		case "slow_down":
			interval *= 2
			continue
		case "access_denied":
			return Credentials{}, ErrDenied
		case "expired_token":
			return Credentials{}, ErrExpired
		default:
			return Credentials{}, err
		}
	}
}

// Instructions 是屏幕上要显示的那几行。
//
// ─────────────────────────────────────────
// 码要**大**，而且要能被念出来
// ─────────────────────────────────────────
//
// 这串码的使用方式是「盯着这块屏幕，在另一块屏幕上敲」。
// 混在一段说明文字里的话，人要先找到它 ——
// 而找的过程中他会先去看别的字。
func Instructions(start *StartResponse) []string {
	return []string{
		"在任何一个已经登录的浏览器里打开：",
		"    " + start.VerificationURI,
		"",
		"输入这串码：",
		"    " + start.UserCode,
		"",
		fmt.Sprintf("它 %d 分钟后过期。确认之后这里会自己进去。", start.ExpiresIn/60),
	}
}

// goos 单独抽出来是为了能在测试里替换 —— 直接读 runtime.GOOS 测不了
var goos = func() string { return runtime.GOOS }
