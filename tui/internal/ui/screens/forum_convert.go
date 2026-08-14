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
 * 把一段群聊整理成帖子。
 *
 * ═════════════════════════════════════════
 * 它是这个站里最容易把「群内的话」变成「站外可搜」的动作
 * ═════════════════════════════════════════
 *
 * 所以这一屏上有两件事必须显式：
 *
 * ① **挑哪几条是人一条一条选的**，不是「选一个范围」。
 *    范围选择看起来更快，但它会顺手把中间那几条不相干的
 *    也带进去 —— 而带进去的是**别人**说的话。
 *
 * ② **被引用的人同意没同意，由服务端判**，这里不预判。
 *    没同意的会被隐去（`convertMessagesToPost` 里那一段）。
 *    在这里也写一份判定的话，两份里更松的那一份会被找到。
 */

type forumConvert struct {
	ctx    Context
	params Params

	convID   string
	convName string
	groups   []groupRow
	messages []messageRow
	// 选中了哪几条（按消息 id）
	picked map[string]bool

	cursor  int
	loading bool
	err     string

	// 挑完之后填标题那一步
	naming bool
	title  *kit.Editor
	intro  *kit.Editor
	focus  int
	saving bool
}

func newForumConvert(ctx Context, params Params) Screen {
	return &forumConvert{
		ctx:    ctx,
		params: params,
		convID: params.Get("conv_id"),
		picked: map[string]bool{},
		title:  kit.NewEditor(""),
		intro:  kit.NewEditor(""),
	}
}

func (f *forumConvert) Title() string { return "群消息转帖" }

func (f *forumConvert) Init() tea.Cmd {
	f.loading = true
	return f.loadGroups()
}

func (f *forumConvert) loadGroups() tea.Cmd {
	return func() tea.Msg {
		var out struct {
			Groups []groupRow `json:"groups"`
		}
		if err := f.ctx.API.Get(f.ctx.Ctx, "/api/v1/groups", nil, &out); err != nil {
			return groupsMsg{err: err}
		}
		return groupsMsg{groups: out.Groups}
	}
}

func (f *forumConvert) loadMessages() tea.Cmd {
	conv := f.convID
	return func() tea.Msg {
		var out struct {
			Messages []messageRow `json:"messages"`
			Total    int          `json:"total"`
		}
		q := url.Values{}
		q.Set("limit", "120")
		err := f.ctx.API.Get(f.ctx.Ctx, "/api/v1/groups/"+url.PathEscape(conv)+"/messages", q, &out)
		return messagesMsg{messages: out.Messages, total: out.Total, err: err}
	}
}

type convertedMsg struct {
	id  string
	err error
}

func (f *forumConvert) submit() tea.Cmd {
	/*
	 * 按**屏幕上的顺序**发过去，不是按 map 的遍历顺序。
	 *
	 * map 在 Go 里是无序的 —— 直接遍历的话，整理出来的帖子里
	 * 那几条对话是乱的，而人挑的时候看到的是有序的。
	 */
	var ids []string
	for i := len(f.messages) - 1; i >= 0; i-- {
		if f.picked[f.messages[i].ID] {
			ids = append(ids, f.messages[i].ID)
		}
	}

	conv := f.convID
	title := f.title.Text()
	intro := f.intro.Text()
	return func() tea.Msg {
		var out struct {
			PostID string `json:"post_id"`
		}
		body := map[string]any{"conv_id": conv, "message_ids": ids, "title": title}
		if strings.TrimSpace(intro) != "" {
			body["intro"] = intro
		}
		err := f.ctx.API.Post(f.ctx.Ctx, "/api/v1/forum/convert", body, &out)
		return convertedMsg{id: out.PostID, err: err}
	}
}

func (f *forumConvert) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case groupsMsg:
		if m.err != nil {
			f.loading = false
			f.err = friendly(m.err)
			return f, Fail(m.err)
		}
		f.groups = m.groups
		if f.convID == "" && len(f.groups) > 0 {
			f.convID = f.groups[0].ConvID
		}
		f.applyGroupName()
		if f.convID == "" {
			f.loading = false
			return f, nil
		}
		return f, f.loadMessages()

	case messagesMsg:
		f.loading = false
		if m.err != nil {
			f.err = friendly(m.err)
			return f, Fail(m.err)
		}
		f.messages = m.messages
		f.cursor = 0
		return f, nil

	case convertedMsg:
		f.saving = false
		if m.err != nil {
			return f, Fail(m.err)
		}
		return f, tea.Batch(
			Navigate("forum/post", Params{"id": m.id}),
			Status("整理好了。被引用的人里没同意过的，正文里已经隐去"),
		)

	case tea.KeyMsg:
		if f.naming {
			return f.keyNaming(m)
		}
		return f.keyPicking(m)
	}
	return f, nil
}

func (f *forumConvert) keyPicking(m tea.KeyMsg) (Screen, tea.Cmd) {
	switch m.String() {
	case "up", "k":
		if f.cursor > 0 {
			f.cursor--
		}
	case "down", "j":
		if f.cursor < len(f.messages)-1 {
			f.cursor++
		}
	case " ":
		if f.cursor < len(f.messages) {
			id := f.messages[f.cursor].ID
			if f.picked[id] {
				delete(f.picked, id)
			} else {
				f.picked[id] = true
			}
			// 选完自动往下走一格 —— 连着选几条时不用按两个键
			if f.cursor < len(f.messages)-1 {
				f.cursor++
			}
		}
	case "tab":
		f.nextGroup()
		return f, f.loadMessages()
	case "enter":
		if len(f.picked) == 0 {
			return f, Status("先用空格选几条要引用的消息")
		}
		if !surface.HasScope(f.ctx.Scopes, "forum:write") {
			return f, Status("这把令牌不能发帖。:login 重新登录时勾上「以我的名义发帖和回复」")
		}
		f.naming = true
		return f, Status("给它起个标题，Ctrl+S 发出去")
	case "esc":
		return f, func() tea.Msg { return BackMsg{} }
	}
	return f, nil
}

func (f *forumConvert) keyNaming(m tea.KeyMsg) (Screen, tea.Cmd) {
	switch m.String() {
	case "esc":
		// 退回挑选那一步，**选中的不清掉** —— 清掉的话人要重挑一遍
		f.naming = false
		return f, Status("")
	case "tab":
		f.focus = (f.focus + 1) % 2
		return f, nil
	case "ctrl+s":
		if f.saving {
			return f, nil
		}
		if f.title.Empty() {
			return f, Status("标题不能是空的")
		}
		f.saving = true
		return f, f.submit()
	}
	if f.focus == 0 {
		if m.String() == "enter" {
			f.focus = 1
			return f, nil
		}
		f.title.Update(m)
		return f, nil
	}
	f.intro.Update(m)
	return f, nil
}

func (f *forumConvert) nextGroup() {
	if len(f.groups) == 0 {
		return
	}
	idx := 0
	for i, g := range f.groups {
		if g.ConvID == f.convID {
			idx = i
			break
		}
	}
	f.convID = f.groups[(idx+1)%len(f.groups)].ConvID
	f.messages = nil
	/*
	 * 换群时把选中的清掉。
	 *
	 * 不清的话，那些 id 属于上一个群 —— 提交时服务端会拒
	 * （它只收这个群里的消息），而错误信息说不清是为什么。
	 */
	f.picked = map[string]bool{}
	f.applyGroupName()
}

func (f *forumConvert) applyGroupName() {
	for _, g := range f.groups {
		if g.ConvID == f.convID {
			f.convName = g.Name
			return
		}
	}
	f.convName = ""
}

func (f *forumConvert) View(width, height int) string {
	p := f.ctx.Theme
	if f.naming {
		return f.namingView(width, height)
	}

	var b strings.Builder
	head := f.convName
	if head == "" {
		head = "还没选群"
	}
	b.WriteString(p.Accent.Render(head))
	b.WriteString(p.Faint.Render("  （Tab 换群）"))
	b.WriteString("\n")
	b.WriteString(p.Faint.Render("空格选中 · 回车继续 · Esc 放弃  ·  已选 " + itoa(len(f.picked)) + " 条"))
	b.WriteString("\n")
	/*
	 * 这句话要一直在。
	 *
	 * 整理出来的帖子会被站外搜到，而里面是**别人**说的话 ——
	 * 挑的时候就该知道这一点，而不是发出去之后。
	 */
	b.WriteString(p.Warn.Render("这些话是别人说的。没同意过被引用的人，正文里会被隐去"))
	b.WriteString("\n\n")
	height -= 4

	if f.loading {
		return b.String() + p.Muted.Render("正在取…")
	}
	if len(f.messages) == 0 {
		if f.err != "" {
			return b.String() + p.Danger.Render(f.err)
		}
		return b.String() + p.Muted.Render("这个群还没有同步到消息")
	}

	if height < 1 {
		height = 1
	}
	start := f.cursor - height/2
	if start < 0 {
		start = 0
	}
	if start+height > len(f.messages) {
		start = len(f.messages) - height
		if start < 0 {
			start = 0
		}
	}

	for i := start; i < len(f.messages) && i < start+height; i++ {
		msg := f.messages[i]
		mark := "[ ] "
		if f.picked[msg.ID] {
			mark = p.Good.Render("[✓] ")
		}
		cursor := "  "
		if i == f.cursor {
			cursor = p.Accent.Render(p.Cursor()) + " "
		}
		ts := time.UnixMilli(msg.TS).Format("01-02 15:04")
		line := cursor + mark + p.Faint.Render(ts) + " " +
			p.Ink.Render(msg.Sender) + p.Faint.Render("： ") + msg.Content
		b.WriteString(kit.Truncate(line, width, p.Ellipsis()))
		if i < start+height-1 && i < len(f.messages)-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

func (f *forumConvert) namingView(width, height int) string {
	p := f.ctx.Theme
	var b strings.Builder
	b.WriteString(p.Accent.Render("整理成一个帖子"))
	b.WriteString(p.Faint.Render("  （已选 " + itoa(len(f.picked)) + " 条 · Esc 回去改选）"))
	b.WriteString("\n")
	b.WriteString(p.Faint.Render("Tab 换栏 · Ctrl+S 发出去"))
	b.WriteString("\n\n")

	label := func(i int, text string) string {
		if f.focus == i {
			return p.Accent.Render(text)
		}
		return p.Muted.Render(text)
	}
	b.WriteString(label(0, "标题") + "\n")
	b.WriteString(f.title.View(p, width, 1))
	b.WriteString("\n\n")
	b.WriteString(label(1, "开头说一句（可不填）") + "\n")

	introHeight := height - 8
	if introHeight < 2 {
		introHeight = 2
	}
	b.WriteString(f.intro.View(p, width, introHeight))

	if f.saving {
		b.WriteString("\n" + p.Muted.Render("整理中…"))
	}
	return b.String()
}
