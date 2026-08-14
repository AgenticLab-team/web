// Package screens 是终端里的每一屏，以及把它们连起来的注册表。
package screens

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/api"
	"github.com/jmr/agenticlab/tui/internal/theme"
)

// Context 是每一屏都拿得到的东西。
type Context struct {
	API *api.Client
	// 这把令牌有哪些 scope。屏幕靠它决定某个动作是画成按钮还是画成一句解释 ——
	// **在人动手之前**，而不是让他敲完再拿一句 403
	Scopes []string
	Theme  theme.Palette
	Ctx    context.Context
	// 站点地址，拼分享链接用
	Site string
}

// Params 是跳进这一屏时带的参数。
//
// 用 map 而不是每屏一个结构体：跳转是**跨屏**的
// （群聊 → 成员主页 → 帖子 → 项目），而跳的那一方
// 不该 import 目标屏的类型 —— 那会让所有屏互相依赖。
type Params map[string]string

func (p Params) Get(k string) string {
	if p == nil {
		return ""
	}
	return p[k]
}

// Screen 是一屏。
//
// ─────────────────────────────────────────
// 它比 tea.Model 多两件事：标题和「跳到哪」
// ─────────────────────────────────────────
//
// 标题给外壳画面包屑用。跳转做成一个**消息**而不是让屏自己
// 去改导航栈 —— 后者意味着每一屏都要拿到路由器，
// 于是「谁能改导航」这件事没有边界。
type Screen interface {
	Init() tea.Cmd
	Update(msg tea.Msg) (Screen, tea.Cmd)
	// View 拿到的是**主区**的尺寸，不是整个终端 ——
	// 屏不需要知道旁边有没有侧栏
	View(width, height int) string
	Title() string
}

// Factory 造一屏。
type Factory func(ctx Context, params Params) Screen

/*
 * ── 跨屏跳转 ────────────────────────────────────────────
 *
 * 「聊着聊着想看这个人的主页，从主页进他的帖子，从帖子进 GitHub」——
 * 这条路径要一路按回车走下去，且每一步都能按 Esc 原路退回。
 *
 * 实现是一个导航栈（见 ui/router.go）。屏只发消息，不碰栈。
 */

// NavigateMsg 是「去那一屏」。
type NavigateMsg struct {
	Screen string
	Params Params
}

// BackMsg 是「退回上一屏」。
type BackMsg struct{}

// StatusMsg 是底部那一行要说的话。
//
// 错误也走它，而不是在屏中间弹一个框：终端里弹框会盖住内容，
// 而人多半正想照着上面的东西操作。
type StatusMsg struct {
	Text string
	// 出错时染色并且不自动消失
	Err bool
}

// Navigate 是屏里发起跳转的写法。
func Navigate(screen string, params Params) tea.Cmd {
	return func() tea.Msg { return NavigateMsg{Screen: screen, Params: params} }
}

// Status 是屏里说一句话的写法。
func Status(text string) tea.Cmd {
	return func() tea.Msg { return StatusMsg{Text: text} }
}

// Fail 是屏里报一次错的写法。
//
// 收 error 而不是 string：这样 api.Error 里那句已经写成人话的
// `Friendly()` 才会被用上，而不是每一屏各自拼一句自己的。
func Fail(err error) tea.Cmd {
	return func() tea.Msg {
		if e := api.AsError(err); e != nil {
			return StatusMsg{Text: e.Friendly(), Err: true}
		}
		return StatusMsg{Text: err.Error(), Err: true}
	}
}
