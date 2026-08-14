package screens

import (
	"net/url"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 帖子正文。
 *
 * ═════════════════════════════════════════
 * 这一屏是全站唯一「非读不可」的地方
 * ═════════════════════════════════════════
 *
 * 别的屏是查东西的（列表、状态、数字），扫一眼就走。
 * 这一屏是**读**的，而且要读完 —— 深潜那一栏存在的理由就是
 * 「全站长文平均 2.3 次浏览，短帖 8.2 次」。
 *
 * 所以它不走通用的 JSON 树：那个渲染法能保证「不会少东西」，
 * 但读一段带代码块的长文时，缩进和引用全平了。
 * 这里用 Glamour。
 *
 * ─────────────────────────────────────────
 * 动作不可用时**提前说**，不是按下去才说
 * ─────────────────────────────────────────
 *
 * 回复要 `forum:write`、打赏要 `economy:write`、收藏要 `me:write` ——
 * 三个不同的 scope。一把只勾了「读」的令牌会让这三个都拿回 403，
 * 而人会以为是自己没权限发言（那是另一回事）。
 */

type forumPost struct {
	ctx    Context
	params Params
	/*
	 * 表情、投票、采纳、举报、打赏、收藏走和通用屏**同一套**动作机制
	 * （见 action.go）—— 那样它们白得到「缺 scope 提前说」、
	 * 「花积分先确认」、「做完重新取一次」这三条。
	 *
	 * 各写一遍的话，这三条平均只有两条会被记得。
	 */
	runner runner

	data    *postPayload
	loading bool
	err     string

	// 滚到第几行
	offset int
	// 正在写回复
	replying bool
	reply    string
	sending  bool
}

type postPayload struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	Content   string      `json:"content"`
	Board     string      `json:"board"`
	Author    string      `json:"author"`
	AuthorWx  string      `json:"author_wx_id"`
	CreatedAt int64       `json:"created_at"`
	Replies   []postReply `json:"replies"`
}

type postReply struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Author    string `json:"author"`
	AuthorWx  string `json:"author_wx_id"`
	CreatedAt int64  `json:"created_at"`
}

type postLoadedMsg struct {
	data *postPayload
	err  error
}

type replySentMsg struct{ err error }

// postActions 是帖子正文那一屏上能做的事。
//
// ─────────────────────────────────────────
// 三个不同的 scope，所以要分开声明
// ─────────────────────────────────────────
//
// 回复/表情/投票/采纳/举报要 `forum:write`，打赏要 `economy:write`
// （它花积分），收藏要 `me:write`（那是「我的东西」）。
//
// 一把只勾了「读」的令牌会让这三类都拿回 403 —— 而那时候
// 人会以为是自己没资格发言，不是令牌少勾了一项。
func postActions() []action {
	return []action{
		{key: "t", label: "态度", method: "POST", path: "/api/v1/posts/{id}/react",
			scope: "forum:write",
			fields: []kit.Field{
				{Name: "kind", Label: "useful / insight / precise / love", Type: "string", Required: true},
				{Name: "reply_id", Label: "给某条回复（留空 = 给帖子）", Type: "string"},
			}},
		{key: "v", label: "投票", method: "POST", path: "/api/v1/posts/{id}/vote",
			scope: "forum:write",
			fields: []kit.Field{
				{Name: "options", Label: "选项 id（多选用逗号分隔）", Type: "string", Required: true},
			}},
		{key: "y", label: "采纳一条回复", method: "POST", path: "/api/v1/posts/{id}/accept",
			scope: "forum:write",
			fields: []kit.Field{
				{Name: "reply_id", Label: "采纳哪一条", Type: "string", Required: true},
			}},
		{key: "!", label: "举报", method: "POST", path: "/api/v1/posts/{id}/report",
			scope: "forum:write",
			fields: []kit.Field{
				{Name: "reason", Label: "spam / abuse / porn / illegal / privacy / offtopic / other",
					Type: "string", Required: true},
				{Name: "detail", Label: "补充说明", Type: "string"},
				{Name: "reply_id", Label: "举报某条回复（留空 = 举报帖子）", Type: "string"},
			}},
		/*
		 * 打赏危险级 1：它花掉真积分，而且**没有幂等** ——
		 * 重发一次就是再送一次。所以要先确认。
		 */
		{key: "$", label: "打赏", method: "POST", path: "/api/v1/posts/{id}/tip",
			scope: "economy:write", danger: 1,
			fields: []kit.Field{
				{Name: "amount", Label: "送多少积分", Type: "number", Required: true},
				{Name: "note", Label: "说一句（可不填）", Type: "string"},
			}},
		{key: "b", label: "收藏", method: "POST", path: "/api/v1/posts/{id}/bookmark",
			scope: "me:write", body: map[string]any{"on": true}},
	}
}

func newForumPost(ctx Context, params Params) Screen {
	return &forumPost{ctx: ctx, params: params, runner: runner{actions: postActions()}}
}

func (f *forumPost) Title() string {
	if f.data != nil && f.data.Title != "" {
		return f.data.Title
	}
	return "帖子"
}

func (f *forumPost) Init() tea.Cmd {
	f.loading = true
	return f.load()
}

func (f *forumPost) load() tea.Cmd {
	id := f.params.Get("id")
	return func() tea.Msg {
		var out postPayload
		if err := f.ctx.API.Get(f.ctx.Ctx, "/api/v1/posts/"+url.PathEscape(id), nil, &out); err != nil {
			return postLoadedMsg{err: err}
		}
		return postLoadedMsg{data: &out}
	}
}

func (f *forumPost) send() tea.Cmd {
	id := f.params.Get("id")
	body := strings.TrimSpace(f.reply)
	return func() tea.Msg {
		err := f.ctx.API.Post(f.ctx.Ctx, "/api/v1/posts/"+url.PathEscape(id)+"/replies",
			map[string]any{"content": body}, nil)
		return replySentMsg{err: err}
	}
}

func (f *forumPost) canReply() bool {
	return surface.HasScope(f.ctx.Scopes, "forum:write")
}

func (f *forumPost) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case postLoadedMsg:
		f.loading = false
		if m.err != nil {
			f.err = friendly(m.err)
			return f, Fail(m.err)
		}
		f.err = ""
		f.data = m.data
		return f, nil

	case replySentMsg:
		f.sending = false
		if m.err != nil {
			return f, Fail(m.err)
		}
		f.reply = ""
		f.replying = false
		return f, tea.Batch(f.load(), Status("回复发出去了"))

	case actionDoneMsg:
		f.runner.running = false
		f.runner.reset()
		if m.err != nil {
			return f, Fail(m.err)
		}
		// 做完重新取一次 —— 否则票数、表情数还是动作之前的
		return f, tea.Batch(f.load(), Status("做完了"))

	case tea.KeyMsg:
		if f.replying {
			return f.updateReply(m)
		}
		// 表单/确认态优先：那时候每一个键都是在填表
		if cmd, handled := f.runner.key(f.ctx, m); handled {
			return f, cmd
		}
		for _, a := range f.runner.actions {
			if m.String() != a.key {
				continue
			}
			cmd, _ := f.runner.begin(f.ctx, a, f.params, nil)
			return f, cmd
		}
		switch m.String() {
		case "down", "j":
			f.offset++
		case "up", "k":
			if f.offset > 0 {
				f.offset--
			}
		case "pgdown", " ":
			f.offset += 10
		case "pgup":
			f.offset -= 10
			if f.offset < 0 {
				f.offset = 0
			}
		case "g":
			f.offset = 0
		case "r":
			if !f.canReply() {
				/*
				 * 这句话要说清楚**下一步能做什么**。
				 *
				 * 「没有权限」是一个死胡同 —— 而实际上他多半只是
				 * 登录时没勾那一项，重新登录一次就有了。
				 */
				return f, Status("这把令牌不能发回复。:login 重新登录时勾上「以我的名义发帖和回复」")
			}
			f.replying = true
			return f, Status("写完按 Ctrl+S 发出去，Esc 放弃")
		case "a":
			// 作者主页 —— 「从帖子进这个人的主页」那条路径
			if f.data != nil && f.data.AuthorWx != "" {
				return f, Navigate("community/person", Params{"wx_id": f.data.AuthorWx})
			}
			return f, Status("这是一篇匿名帖，没有可以跳过去的作者")
		case "h":
			return f, Navigate("forum/history", Params{"id": f.params.Get("id")})
		}
	}
	return f, nil
}

func (f *forumPost) updateReply(m tea.KeyMsg) (Screen, tea.Cmd) {
	switch m.String() {
	case "esc":
		f.replying = false
		f.reply = ""
		return f, Status("")
	case "ctrl+s":
		if f.sending || strings.TrimSpace(f.reply) == "" {
			return f, nil
		}
		f.sending = true
		return f, f.send()
	case "enter":
		f.reply += "\n"
	case "backspace":
		r := []rune(f.reply)
		if len(r) > 0 {
			f.reply = string(r[:len(r)-1])
		}
	default:
		if len(m.Runes) > 0 {
			f.reply += string(m.Runes)
		}
	}
	return f, nil
}

func (f *forumPost) View(width, height int) string {
	p := f.ctx.Theme

	// 填表/确认时只显示表单 —— 见 kit.Form 里那段
	if f.runner.form != nil {
		var b strings.Builder
		b.WriteString(p.Accent.Render(f.runner.active.label) + "\n\n")
		b.WriteString(f.runner.form.View(p, width))
		if f.runner.running {
			b.WriteString("\n" + p.Muted.Render("正在做…"))
		} else if !f.runner.form.Confirming() {
			b.WriteString("\n" + p.Faint.Render("Tab 换栏 · Ctrl+S 提交 · Esc 放弃"))
		}
		return b.String()
	}

	switch {
	case f.loading && f.data == nil:
		return p.Muted.Render("正在取…")
	case f.data == nil:
		if f.err != "" {
			return p.Danger.Render(f.err)
		}
		return p.Muted.Render("没有这篇帖子")
	}

	// 回复输入区先占位，剩下的给正文
	var input string
	if f.replying {
		input = f.replyView(width)
	}
	inputHeight := 0
	if input != "" {
		inputHeight = strings.Count(input, "\n") + 2
	}
	bodyHeight := height - inputHeight
	if bodyHeight < 3 {
		bodyHeight = 3
	}

	lines := f.render(width)

	// 夹住滚动位置 —— 越界的话下面 slice 会 panic
	maxOffset := len(lines) - bodyHeight
	if maxOffset < 0 {
		maxOffset = 0
	}
	if f.offset > maxOffset {
		f.offset = maxOffset
	}

	end := f.offset + bodyHeight
	if end > len(lines) {
		end = len(lines)
	}

	var b strings.Builder
	b.WriteString(strings.Join(lines[f.offset:end], "\n"))
	if input != "" {
		b.WriteString("\n\n" + input)
	}
	return b.String()
}

// render 把整篇帖子铺成一行一行的，滚动按行走。
//
// 一次全铺出来（而不是只渲染可见的那几行）是因为 Markdown
// **不能按行渲染**：一个代码块的第 5 行离开了上下文就不知道
// 自己在代码块里。所以整篇渲染一次，然后切窗口。
func (f *forumPost) render(width int) []string {
	p := f.ctx.Theme
	d := f.data
	var out []string

	out = append(out, p.Accent.Render(kit.Truncate(d.Title, width, p.Ellipsis())))

	meta := d.Author
	if meta == "" {
		meta = "匿名"
	}
	meta += "  ·  " + d.Board
	if d.CreatedAt > 0 {
		meta += "  ·  " + time.UnixMilli(d.CreatedAt).Format("2006-01-02 15:04")
	}
	out = append(out, p.Faint.Render(kit.Truncate(meta, width, p.Ellipsis())))

	// 这一屏能做什么，写在最上面而不是最下面 —— 长文里最下面看不到
	out = append(out, p.Faint.Render(f.keyHint()))
	out = append(out, "")

	out = append(out, strings.Split(kit.Markdown(d.Content, p, width), "\n")...)

	if len(d.Replies) > 0 {
		out = append(out, "", p.Faint.Render(strings.Repeat("─", minInt(width, 60))))
		out = append(out, p.Muted.Render(pluralReplies(len(d.Replies))), "")
		for _, r := range d.Replies {
			author := r.Author
			if author == "" {
				author = "匿名"
			}
			head := p.Mine.Render(author)
			if r.CreatedAt > 0 {
				head += p.Faint.Render("  " + time.UnixMilli(r.CreatedAt).Format("01-02 15:04"))
			}
			out = append(out, head)
			out = append(out, strings.Split(kit.Markdown(r.Content, p, width-2), "\n")...)
			out = append(out, "")
		}
	}
	return out
}

func (f *forumPost) keyHint() string {
	parts := []string{"↑↓ 滚动", "a 作者主页", "h 编辑历史"}
	if f.canReply() {
		parts = append(parts, "r 回复")
	} else {
		parts = append(parts, "回复要 forum:write（:login 可以加上）")
	}
	/*
	 * 动作那一行也列出来，**缺权限的也列**。
	 *
	 * 不列的话，一个人不会知道这一屏本来还能打赏、还能采纳 ——
	 * 而那正是「终端比网页少东西」最没有症状的形态。
	 */
	if hint := f.runner.hint(f.ctx); hint != "" {
		parts = append(parts, hint)
	}
	return strings.Join(parts, " · ")
}

func (f *forumPost) replyView(width int) string {
	p := f.ctx.Theme
	var b strings.Builder
	b.WriteString(p.Faint.Render(strings.Repeat("─", minInt(width, 60))) + "\n")
	b.WriteString(p.Accent.Render("回复：") + "\n")
	for _, line := range strings.Split(f.reply, "\n") {
		b.WriteString(kit.Truncate("  "+line, width, p.Ellipsis()) + "\n")
	}
	if f.sending {
		b.WriteString(p.Muted.Render("  发送中…"))
	} else {
		b.WriteString(p.Faint.Render("  Ctrl+S 发出去 · Esc 放弃"))
	}
	return b.String()
}

func pluralReplies(n int) string {
	if n == 1 {
		return "1 条回复"
	}
	return itoa(n) + " 条回复"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
