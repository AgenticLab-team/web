package screens

import (
	"encoding/json"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/api"
	"github.com/jmr/agenticlab/tui/internal/surface"
)

/*
 * 通知的实时流，接进 Bubble Tea。
 *
 * ═════════════════════════════════════════
 * 它是**外壳**的事，不是某一屏的事
 * ═════════════════════════════════════════
 *
 * 网页那边有一个常驻的角标和一排吐司 —— 不管你在哪一页。
 * 做成「通知那一屏订阅一下」的话，人只有站在那一屏上才收得到，
 * 而那正好是他最不需要提醒的时候。
 *
 * 所以订阅挂在外壳上，从启动一直连到退出。
 */

// LiveNotificationMsg 是收到一条新通知。
type LiveNotificationMsg struct {
	Title string
	// 补漏回放出来的那些。成片的时候要折叠成一条提示，
	// 而不是一条一条弹 —— 断线一小时之后回来弹五十条，
	// 那不是提醒，是刷屏
	Replay bool
}

// UnreadMsg 是角标该显示几。
type UnreadMsg struct{ Count int }

type liveEvent struct {
	Unread int    `json:"unread"`
	Title  string `json:"title"`
	Replay bool   `json:"replay"`
}

// SubscribeLive 起一条 SSE，把事件翻译成 Bubble Tea 的消息。
//
// ─────────────────────────────────────────
// 没有 `notifications:read` 就**根本不连**
// ─────────────────────────────────────────
//
// 连了也只会拿到 403，而那会让重连逻辑每 30 秒敲一次服务器 ——
// 一个只勾了「读论坛」的令牌不该产生任何流量。
func SubscribeLive(ctx Context) tea.Cmd {
	if !surface.HasScope(ctx.Scopes, "notifications:read") {
		return nil
	}

	events := make(chan api.Event, 32)
	go api.Stream(ctx.Ctx, ctx.API, "/api/v1/me/notifications/stream", 0, events)

	/*
	 * 一个 tea.Cmd 只能产出**一条**消息，所以这里做成
	 * 「收一条、报一条、再排一个自己」的链子。
	 *
	 * 用 `tea.Every` 轮询那个 channel 是另一种写法，但它会引入
	 * 一个固定的延迟 —— 而这条流存在的全部意义就是没有延迟。
	 */
	var next func() tea.Msg
	next = func() tea.Msg {
		select {
		case <-ctx.Ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				return nil
			}
			var payload liveEvent
			_ = json.Unmarshal(ev.Data, &payload)

			switch ev.Name {
			case "sync":
				return liveBatch{msgs: []tea.Msg{UnreadMsg{Count: payload.Unread}}, next: next}
			case "notification":
				return liveBatch{
					msgs: []tea.Msg{LiveNotificationMsg{Title: payload.Title, Replay: payload.Replay}},
					next: next,
				}
			}
			return liveBatch{next: next}
		}
	}
	return next
}

// liveBatch 是「这条消息 + 接着听下一条」。
//
// 外壳收到它之后把 msgs 派发掉，再把 next 排回去 ——
// 不排的话流只收得到第一条，而那种 bug 看起来像是
// 「实时通知偶尔不工作」。
type liveBatch struct {
	msgs []tea.Msg
	next func() tea.Msg
}

// Unwrap 把一批消息和「继续听」拆出来。
func (b liveBatch) Unwrap() ([]tea.Msg, tea.Cmd) {
	if b.next == nil {
		return b.msgs, nil
	}
	return b.msgs, tea.Cmd(b.next)
}

// LiveBatch 让外壳能认出这个类型（它在别的包里）。
type LiveBatch = liveBatch
