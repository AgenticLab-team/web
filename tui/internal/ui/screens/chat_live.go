package screens

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/api"
	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 群聊。
 *
 * ═════════════════════════════════════════
 * 它看起来像 IRC，但底下不是
 * ═════════════════════════════════════════
 *
 * 有两条改不掉的物理限制，而它们**都不符合人对聊天的预期**，
 * 所以两条都要在界面上直说，不能等人自己发现：
 *
 * ① **收到的消息最多晚 2 分钟。** 群消息是镜像，靠定时任务每
 *    2 分钟从上游拉一次，而上游那 27 个端点里没有 webhook、
 *    没有长连接。这不是我们的实现问题，是数据来源的形状。
 *
 *    不写出来的话：人发一条、等了 90 秒没看见回应，
 *    会以为是自己网络断了 —— **而他的下一个动作是去按重连**，
 *    那什么也解决不了。
 *
 * ② **每条发出去的消息都带一行代发署名，去不掉。** 消息是机器人
 *    账号发出去的，群里看到的是机器人在说话；不署名的话
 *    群里没有人知道是谁说的。
 *
 *    所以输入框下面**实时显示拼好之后的整条**，包括那行署名和
 *    剩余字数 —— 人在按回车之前就知道群里会看到什么。
 *
 * 还有一条不是限制，是权限：能往哪个群发由站长逐群授权。
 * 没有授权的群，输入框不显示成一个能打字然后被拒的框。
 */

type chatLive struct {
	ctx    Context
	params Params

	convID   string
	convName string
	groups   []groupRow
	messages []messageRow
	// 上一次同步是什么时候（服务端给的）
	syncedAt time.Time
	loadedAt time.Time

	// 这个群能不能代发
	canSend bool
	// 为什么不能 —— 直接显示给人看
	whyNot string

	input   string
	sending bool
	loading bool
	err     string

	/*
	 * 往上翻。
	 *
	 * `scroll` 是「从最新那条往回退了几行」，`loadedPages` 是
	 * 「已经从服务端要了几批」。两者分开的原因有两个：
	 *
	 *   ① 滚到顶**不等于**没有更多了 —— 那时候要再去要一批，
	 *      而不是停在那儿。停住的话，这个界面看起来就是
	 *      「只有最近 80 条」，而人不知道是自己没按够还是真到头了。
	 *   ② 取过第二批之后，**自动刷新要停掉**（见 tickMsg）：
	 *      刷新会把翻出来的历史全丢掉。而这一点光看 `scroll` 判不出来 ——
	 *      一个人可能取了三批之后又滚回了底部。
	 */
	scroll      int
	loadedPages int
	loadingMore bool
	// 服务端说一共有多少条 —— 用来判断「真的到头了」
	total int
	// 我的显示名，拼署名预览用
	myName string
}

type groupRow struct {
	ConvID   string `json:"conv_id"`
	Name     string `json:"name"`
	CanSend  bool   `json:"can_send"`
	Members  int    `json:"members"`
	Messages int    `json:"messages"`
}

type messageRow struct {
	ID      string `json:"id"`
	Sender  string `json:"sender"`
	Content string `json:"content"`
	TS      int64  `json:"ts"`
	Type    string `json:"type"`
}

func newChatLive(ctx Context, params Params) Screen {
	return &chatLive{ctx: ctx, params: params, convID: params.Get("conv_id")}
}

func (c *chatLive) Title() string {
	if c.convName != "" {
		return c.convName
	}
	return "群聊"
}

func (c *chatLive) Init() tea.Cmd {
	c.loading = true
	return tea.Batch(c.loadGroups(), tickCmd())
}

type groupsMsg struct {
	groups []groupRow
	me     string
	err    error
}
type messagesMsg struct {
	messages []messageRow
	total    int
	// 这是「再往前一批」而不是一次刷新
	appended bool
	err      error
}
type sentMsg struct{ err error }
type tickMsg time.Time

/*
 * 自动刷新的节奏跟着**数据的节奏**走，不跟着「看起来实时」走。
 *
 * 上游 2 分钟同步一次，所以比 30 秒更勤的轮询拿到的是同一批消息 ——
 * 那只是在浪费服务端的额度（上游那份配额是全站共用的）。
 */
const refreshEvery = 30 * time.Second

func tickCmd() tea.Cmd {
	return tea.Tick(refreshEvery, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (c *chatLive) loadGroups() tea.Cmd {
	return func() tea.Msg {
		var out struct {
			Groups []groupRow `json:"groups"`
		}
		if err := c.ctx.API.Get(c.ctx.Ctx, "/api/v1/groups", nil, &out); err != nil {
			return groupsMsg{err: err}
		}
		// 顺手把自己的名字取回来 —— 署名预览要用
		var me struct {
			Name string `json:"name"`
		}
		_ = c.ctx.API.Get(c.ctx.Ctx, "/api/v1/me", nil, &me)
		return groupsMsg{groups: out.Groups, me: me.Name}
	}
}

const pageSize = 80

func (c *chatLive) loadMessages() tea.Cmd { return c.fetch(0, false) }

// loadMore 再往前要一批。
func (c *chatLive) loadMore() tea.Cmd {
	c.loadingMore = true
	return c.fetch(len(c.messages), true)
}

func (c *chatLive) fetch(offset int, appended bool) tea.Cmd {
	conv := c.convID
	return func() tea.Msg {
		var out struct {
			Messages []messageRow `json:"messages"`
			Total    int          `json:"total"`
		}
		q := url.Values{}
		q.Set("limit", strconv.Itoa(pageSize))
		if offset > 0 {
			q.Set("offset", strconv.Itoa(offset))
		}
		err := c.ctx.API.Get(c.ctx.Ctx, "/api/v1/groups/"+url.PathEscape(conv)+"/messages", q, &out)
		return messagesMsg{messages: out.Messages, total: out.Total, appended: appended, err: err}
	}
}

func (c *chatLive) send() tea.Cmd {
	conv := c.convID
	text := strings.TrimSpace(c.input)
	return func() tea.Msg {
		err := c.ctx.API.Post(c.ctx.Ctx, "/api/v1/groups/"+url.PathEscape(conv)+"/messages",
			map[string]any{"text": text}, nil)
		return sentMsg{err: err}
	}
}

func (c *chatLive) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case groupsMsg:
		c.loading = false
		if m.err != nil {
			c.err = friendly(m.err)
			return c, Fail(m.err)
		}
		c.groups = m.groups
		c.myName = m.me
		if c.convID == "" && len(c.groups) > 0 {
			c.convID = c.groups[0].ConvID
		}
		c.applyGroup()
		if c.convID != "" {
			return c, c.loadMessages()
		}
		return c, nil

	case messagesMsg:
		c.loadedAt = time.Now()
		c.loadingMore = false
		if m.err != nil {
			c.err = friendly(m.err)
			return c, Fail(m.err)
		}
		c.err = ""
		c.total = m.total
		if m.appended {
			/*
			 * 往前那一批**接在后面**，因为服务端是按时间倒序给的：
			 * `messages[0]` 是最新的。渲染时再倒过来。
			 *
			 * 接反了的话，往上翻会看到时间在乱跳 ——
			 * 而那种错很难被一眼看出是顺序问题。
			 */
			c.messages = append(c.messages, m.messages...)
			c.loadedPages++
			if len(m.messages) == 0 {
				return c, Status("到头了，这个群没有更早的消息")
			}
			return c, Status(fmt.Sprintf("又往前取了 %d 条（共 %d 条）", len(m.messages), c.total))
		}
		c.messages = m.messages
		c.loadedPages = 1
		return c, nil

	case sentMsg:
		c.sending = false
		if m.err != nil {
			return c, Fail(m.err)
		}
		c.input = ""
		/*
		 * 发完立刻刷新一次，但**它多半看不到自己刚发的那条** ——
		 * 那条要等下一轮同步才回到镜像里。
		 *
		 * 所以这里给一句明确的话，而不是让人盯着屏幕等。
		 */
		return c, tea.Batch(
			c.loadMessages(),
			Status("发出去了。它要等下一次同步（最多 2 分钟）才会出现在上面"),
		)

	case tickMsg:
		if c.convID == "" {
			return c, tickCmd()
		}
		/*
		 * ─────────────────────────────────────────
		 * 翻在历史里的时候**不自动刷新**
		 * ─────────────────────────────────────────
		 *
		 * 刷新会把已经往前取的那几批全部丢掉、跳回最新 ——
		 * 而人正读到一半。那一下比「消息晚 2 分钟」难受得多：
		 * 后者是他知道的限制，前者看起来像是程序自己乱跳。
		 *
		 * 心跳照常排下去，他按 End 回到最新时会立刻续上。
		 */
		if c.scroll > 0 || c.loadedPages > 1 {
			return c, tickCmd()
		}
		return c, tea.Batch(c.loadMessages(), tickCmd())

	case tea.KeyMsg:
		switch m.String() {
		case "enter":
			if !c.canSend || c.sending {
				return c, nil
			}
			if strings.TrimSpace(c.input) == "" {
				return c, nil
			}
			c.sending = true
			return c, c.send()
		case "backspace":
			if len(c.input) > 0 {
				r := []rune(c.input)
				c.input = string(r[:len(r)-1])
			}
		case "tab":
			// 切下一个群
			c.nextGroup(1)
			return c, c.loadMessages()
		case "shift+tab":
			c.nextGroup(-1)
			return c, c.loadMessages()
		case "pgup":
			c.scroll += 10
			/*
			 * 快滚到顶了就提前去要下一批 —— 不是等真的到顶。
			 *
			 * 等到顶再要的话，中间有一次明显的停顿，
			 * 而那一下会让人以为「没有更多了」然后放弃。
			 */
			if c.scroll+20 > len(c.messages) && !c.loadingMore && c.hasMore() {
				return c, c.loadMore()
			}
		case "pgdown":
			c.scroll -= 10
			if c.scroll < 0 {
				c.scroll = 0
			}
		case "home":
			if !c.loadingMore && c.hasMore() {
				return c, c.loadMore()
			}
		case "end":
			c.scroll = 0
			if c.loadedPages > 1 {
				/*
				 * 翻过历史之后回到底部，要重新拉一次干净的最新批。
				 *
				 * 不拉的话，自动刷新在上面那一条里被停掉了，
				 * 于是他回到「最新」看到的其实是几分钟前的最新 ——
				 * 而屏幕上那行同步时间会说得像是刚取过。
				 */
				return c, c.loadMessages()
			}
		default:
			if len(m.Runes) > 0 && c.canSend {
				c.input += string(m.Runes)
			}
		}
	}
	return c, nil
}

func (c *chatLive) nextGroup(delta int) {
	if len(c.groups) == 0 {
		return
	}
	idx := 0
	for i, g := range c.groups {
		if g.ConvID == c.convID {
			idx = i
			break
		}
	}
	idx = (idx + delta + len(c.groups)) % len(c.groups)
	c.convID = c.groups[idx].ConvID
	c.messages = nil
	c.scroll = 0
	c.loadedPages = 0
	c.applyGroup()
}

// applyGroup 算出「这个群能不能发，不能的话为什么」。
//
// ═════════════════════════════════════════
// 三种「不能发」要分开说，因为下一步动作完全不同
// ═════════════════════════════════════════
//
//   - 令牌没有 groups:send → 重新登录时勾上它
//   - 这个群没被授权       → 去找站长
//   - 从 SSH 网关进来的     → 换成本地客户端
//
// 合成一句「你不能在这里发言」的话，人只能挨个去猜。
func (c *chatLive) applyGroup() {
	var g *groupRow
	for i := range c.groups {
		if c.groups[i].ConvID == c.convID {
			g = &c.groups[i]
			break
		}
	}
	if g == nil {
		c.convName = ""
		c.canSend = false
		c.whyNot = "先选一个群（Tab 切换）"
		return
	}
	c.convName = g.Name

	if !surface.HasScope(c.ctx.Scopes, "groups:send") {
		c.canSend = false
		c.whyNot = "这把令牌没有「往群里发消息」的权限。重新登录时勾上它（:login）—— " +
			"从 SSH 网关进来的话这一项根本不给，要用本地客户端"
		return
	}
	if !g.CanSend {
		c.canSend = false
		c.whyNot = "这个群没有开代发。要开的话找站长说一声 —— " +
			"他给的是**这一个群**的发言权，不是一个身份"
		return
	}
	c.canSend = true
	c.whyNot = ""
}

// 一条最长 500 字，而署名要从这个预算里扣掉。
//
// 不扣的话，一条刚好压线的正文加上署名会在上游那边被拒，
// 而失败信息是「上游拒绝」—— 没有人会想到是署名撑破的。
const maxMessageChars = 500

func (c *chatLive) attribution() string {
	name := c.myName
	if name == "" {
		name = "某位成员"
	}
	return fmt.Sprintf("本消息由「%s」使用 AgenticLab.sh 代发", name)
}

func (c *chatLive) View(width, height int) string {
	p := c.ctx.Theme
	var b strings.Builder

	// ── 顶上一行：群名 + 同步状态 ──────────────────────
	head := c.convName
	if head == "" {
		head = "还没选群"
	}
	if len(c.groups) > 1 {
		head += p.Faint.Render(fmt.Sprintf("  （Tab 切换，共 %d 个群）", len(c.groups)))
	}
	if c.scroll > 0 {
		// 翻上去之后要有个明确的「回到最新」—— 否则人不知道自己在哪
		head += p.Warn.Render("  ↑ 在历史里（End 回到最新）")
	}
	b.WriteString(kit.Truncate(p.Accent.Render(head), width, p.Ellipsis()))
	b.WriteString("\n")
	b.WriteString(kit.Truncate(p.Faint.Render(c.syncLine()), width, p.Ellipsis()))
	b.WriteString("\n\n")

	// ── 输入区先算高度，剩下的给消息 ──────────────────
	inputBlock := c.inputView(width)
	inputHeight := strings.Count(inputBlock, "\n") + 1
	msgHeight := height - 3 - inputHeight
	if msgHeight < 1 {
		msgHeight = 1
	}

	b.WriteString(c.messagesView(width, msgHeight))
	b.WriteString("\n")
	b.WriteString(inputBlock)
	return b.String()
}

// syncLine 是那句「上次同步 1 分 12 秒前」。
//
// 它常驻在屏幕上，不是一个提示条 —— 提示条会被划走，
// 而这条限制**一直**成立。
func (c *chatLive) syncLine() string {
	if c.loadedAt.IsZero() {
		return "正在取…"
	}
	ago := time.Since(c.loadedAt).Round(time.Second)
	return fmt.Sprintf("上次取到 %s 前 · 群消息是每 2 分钟同步一次的镜像，收到新消息最多晚 2 分钟", ago)
}

// hasMore 是「还翻得动吗」。
//
// 用服务端给的 total 判，而不是「上一批是不是满 80 条」——
// 后者在恰好整除时会多要一次空的，而那一次会显示成
// 「到头了」，紧接着人再按一下又能翻出东西来。
func (c *chatLive) hasMore() bool {
	return c.total == 0 || len(c.messages) < c.total
}

func (c *chatLive) messagesView(width, height int) string {
	p := c.ctx.Theme
	if c.loading {
		return p.Muted.Render("正在取…")
	}
	if len(c.messages) == 0 {
		if c.err != "" {
			return p.Danger.Render(c.err)
		}
		return p.Muted.Render("这个群还没有同步到消息")
	}

	/*
	 * 服务端按时间倒序给（[0] 最新），而屏幕上要正序 ——
	 * 最新的在最下面，和所有聊天软件一样。
	 */
	lines := make([]string, 0, len(c.messages))
	for i := len(c.messages) - 1; i >= 0; i-- {
		m := c.messages[i]
		ts := time.UnixMilli(m.TS).Format("01-02 15:04")
		sender := m.Sender
		if sender == "" {
			sender = "某位成员"
		}
		style := p.Ink
		if sender == c.myName {
			style = p.Mine
		}
		head := p.Faint.Render(ts) + " " + style.Render(sender) + p.Faint.Render("： ")
		lines = append(lines, kit.Truncate(head+m.Content, width, p.Ellipsis()))
	}

	if c.loadingMore {
		lines = append([]string{p.Faint.Render("  正在往前取…")}, lines...)
	} else if !c.hasMore() {
		lines = append([]string{p.Faint.Render("  —— 这个群的开头 ——")}, lines...)
	}

	// 窗口：从底部往上退 c.scroll 行
	end := len(lines) - c.scroll
	if end < 1 {
		end = 1
	}
	if end > len(lines) {
		end = len(lines)
	}
	start := end - height
	if start < 0 {
		start = 0
	}
	/* 滚过头了就夹回去 —— 越界会 panic，而那是终端突然回到 shell */
	if c.scroll > len(lines) {
		c.scroll = len(lines)
	}
	return strings.Join(lines[start:end], "\n")
}

// inputView 是这一屏最要紧的一块。
//
// 能发的时候它显示**拼好署名之后的整条** —— 也就是群里真正会看到的那一条。
// 不能发的时候它显示一句解释，而不是一个能打字然后被拒的框。
func (c *chatLive) inputView(width int) string {
	p := c.ctx.Theme
	if !c.canSend {
		return p.Warn.Render(kit.Truncate(c.whyNot, width, p.Ellipsis()))
	}

	sign := c.attribution()
	budget := maxMessageChars - len([]rune(sign)) - 1
	used := len([]rune(c.input))

	var b strings.Builder
	b.WriteString(p.Faint.Render(strings.Repeat("─", maxInt(1, minInt(width, 40)))))
	b.WriteString("\n")

	line := "> " + c.input
	if c.sending {
		line = "> " + c.input + p.Faint.Render("  发送中…")
	} else {
		line += "▏"
	}
	b.WriteString(kit.Truncate(line, width, p.Ellipsis()))
	b.WriteString("\n")

	/*
	 * 署名那一行永远显示，包括输入框是空的时候。
	 *
	 * 只在有内容时才显示的话，人是在**打完字之后**才第一次看到它 ——
	 * 而那时候他已经写好了一段以为不会带署名的话。
	 */
	b.WriteString(p.Attribution.Render(kit.Truncate(sign, width, p.Ellipsis())))

	counter := fmt.Sprintf("  %d/%d", used, budget)
	if used > budget {
		b.WriteString(p.Danger.Render(counter + "  超了，发不出去"))
	} else {
		b.WriteString(p.Faint.Render(counter))
	}
	return b.String()
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// apiError 让 generic.go 那边也能拿到类型化的错误
func apiError(err error) *api.Error { return api.AsError(err) }
