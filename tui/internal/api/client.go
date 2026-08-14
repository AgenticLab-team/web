// Package api 是开放 API 的客户端。
//
// ═════════════════════════════════════════
// 它只做一件事：把 HTTP 翻译成人话
// ═════════════════════════════════════════
//
// 业务判定一条都不在这里 —— 那些全在服务端，而终端和网页调的是
// 同一段实现（见 src/lib/api-tokens/route-helpers.ts 与
// tests/api-surface.test.ts）。
//
// 这里唯一有分量的设计是**错误信息**：一个终端用户看到的
// 「403」和「你这把令牌缺 forum:write」是完全不同的两件事，
// 而前者会让他去重新登录 —— 那不会解决任何问题。
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client 是一个已经带上令牌的调用者。没有令牌的那些接口（设备码、
// 发布清单）走 Anonymous。
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
	// 客户端版本，进 User-Agent。服务端日志里要分得出哪一版在调
	Version string
}

// New 建一个客户端。
//
// 超时定在 30 秒：这个站里最慢的接口是全站检索和数据导出预览，
// 实测个位数秒。定成 5 秒的话，那两条在网络差一点的时候
// 会**一直失败**，而失败信息是「超时」——没有人会想到是接口本身慢。
func New(baseURL, token, version string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		Version: version,
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

// Error 是一次调用没成的结果。
//
// ─────────────────────────────────────────
// 状态码要留着，因为**上层要按它分支**
// ─────────────────────────────────────────
//
//   - 401 → 令牌不对/过期了，该重新登录
//   - 403 → 令牌对，但缺权限，重新登录**不会**解决
//   - 429 → 太快了，等一会儿
//
// 只留一句话的话，上层只能全都当成「出错了」，
// 于是它会在 403 时也提示「要不要重新登录一下」——
// 而那正是最伤人的一种错误提示：它让人去做一件确定无效的事。
type Error struct {
	Status int
	Code   string
	Msg    string
	// 429 时服务端给的建议等待秒数
	RetryAfter int
}

func (e *Error) Error() string { return e.Msg }

// NeedsLogin 是「重新登录能解决吗」。
func (e *Error) NeedsLogin() bool { return e.Status == 401 }

// Forbidden 是「令牌是好的，但缺权限」。
func (e *Error) Forbidden() bool { return e.Status == 403 }

// Friendly 是给人看的那一句。
//
// 服务端已经把话说成人话了（`insufficient_scope` 那条会写
// 「这把令牌缺少权限：forum:write」），所以绝大多数情况直接用它。
// 只有几种服务端说不清楚的才在这里补。
func (e *Error) Friendly() string {
	switch {
	case e.Status == 0:
		// 连不上。这一条服务端说不了话，只能在这儿写
		return "连不上服务器 —— 检查一下网络，或者站是不是在维护"
	case e.Status == 401:
		return e.Msg + "（敲 :login 重新登录）"
	case e.Status == 429 && e.RetryAfter > 0:
		return fmt.Sprintf("%s（%d 秒后再试）", e.Msg, e.RetryAfter)
	case e.Status >= 500:
		/*
		 * 5xx 不要把服务端的原话直接给人看。
		 *
		 * 那多半是一段栈或者一句英文的框架报错，对用户没有任何
		 * 可做的事，而它会让人以为是自己弄坏了什么。
		 */
		return "服务端出错了。这不是你的问题 —— 过一会儿再试，一直这样的话跟站长说一声"
	default:
		return e.Msg
	}
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	full := c.BaseURL + path
	if len(query) > 0 {
		full += "?" + query.Encode()
	}

	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return &Error{Msg: "请求体拼不出来：" + err.Error()}
		}
		reader = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, full, reader)
	if err != nil {
		return &Error{Msg: err.Error()}
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", "ash/"+c.Version)
	req.Header.Set("Accept", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		/*
		 * 网络层失败 —— Status 留 0。
		 *
		 * 不塞一个 500 进去：上层按 5xx 分支时会说
		 * 「服务端出错了」，而实际是这台机器连不上网。
		 * 那句话会让人去找站长，而站长什么也做不了。
		 */
		return &Error{Msg: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return decodeError(resp)
	}

	if out == nil {
		// 只关心成没成的那些调用，把响应体读完丢掉 —— 不读完连接就没法复用
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return &Error{Status: resp.StatusCode, Msg: "服务端返回的不是预期的格式：" + err.Error()}
	}
	return nil
}

func decodeError(resp *http.Response) *Error {
	e := &Error{Status: resp.StatusCode, Msg: resp.Status}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if n, err := strconv.Atoi(ra); err == nil {
			e.RetryAfter = n
		}
	}

	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if json.Unmarshal(body, &payload) == nil && payload.Error.Message != "" {
		e.Code = payload.Error.Code
		e.Msg = payload.Error.Message
		return e
	}

	/*
	 * 解析不出结构化错误。
	 *
	 * 这通常意味着**打到了别的东西上**：一个反代的错误页、
	 * 一个登录门户、或者 BaseURL 配错了打到了别的站。
	 *
	 * 所以这里的提示要指向那个方向，而不是复述一句 HTTP 状态 ——
	 * 「502 Bad Gateway」对用户没有任何可做的事。
	 */
	if len(body) > 0 && bytes.Contains(bytes.ToLower(body[:min(len(body), 512)]), []byte("<html")) {
		e.Msg = fmt.Sprintf("服务器返回的是一个网页而不是接口数据（HTTP %d）—— 站点地址可能配错了", resp.StatusCode)
	}
	return e
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Get 读一条。
func (c *Client) Get(ctx context.Context, path string, query url.Values, out any) error {
	return c.do(ctx, http.MethodGet, path, query, nil, out)
}

// Post 写一条。
func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPost, path, nil, body, out)
}

// Patch 改一条。
func (c *Client) Patch(ctx context.Context, path string, body any, out any) error {
	return c.do(ctx, http.MethodPatch, path, nil, body, out)
}

// Delete 删一条。
func (c *Client) Delete(ctx context.Context, path string, query url.Values, out any) error {
	return c.do(ctx, http.MethodDelete, path, query, nil, out)
}

// AsError 把一个 error 还原成 *Error。不是的话返回 nil。
//
// 上层靠它分支（401 去重新登录、403 去解释缺什么），
// 而不是去 match 错误信息里的字 —— 那种写法会在文案改一个字时静默失效。
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := err.(*Error); ok {
		return e
	}
	return nil
}
