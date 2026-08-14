package screens

import (
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 编辑一篇帖子。
 *
 * ═════════════════════════════════════════
 * 它先把**现在的内容取回来**，而不是给一个空框
 * ═════════════════════════════════════════
 *
 * 服务端那条是**整篇替换**（`PATCH /api/v1/posts/{id}` 要 title 和
 * content 两个都传）—— 那是刻意的：一版只改了标题的历史读起来是
 * 「正文变成空了」还是「正文没动」，取决于实现细节，
 * 而历史是用来事后判断「他改了什么」的。
 *
 * 所以这一屏必须先 GET 一次。给空框让人重打的话，
 * 一次「改个错别字」会变成把整篇重写一遍 —— 或者更糟：
 * 他只填了标题就提交，正文被清空。
 */

type forumEdit struct {
	ctx    Context
	params Params

	title   *kit.Editor
	body    *kit.Editor
	focus   int // 0=标题 1=正文
	note    string
	loading bool
	saving  bool
	err     string
	// 取回来时的原文，用来判断「到底改没改」
	original string
}

func newForumEdit(ctx Context, params Params) Screen {
	return &forumEdit{
		ctx:    ctx,
		params: params,
		title:  kit.NewEditor(""),
		body:   kit.NewEditor(""),
	}
}

func (f *forumEdit) Title() string { return "编辑帖子" }

func (f *forumEdit) Init() tea.Cmd {
	f.loading = true
	id := f.params.Get("id")
	return func() tea.Msg {
		var out postPayload
		if err := f.ctx.API.Get(f.ctx.Ctx, "/api/v1/posts/"+url.PathEscape(id), nil, &out); err != nil {
			return postLoadedMsg{err: err}
		}
		return postLoadedMsg{data: &out}
	}
}

type editSavedMsg struct{ err error }

func (f *forumEdit) save() tea.Cmd {
	id := f.params.Get("id")
	body := map[string]any{
		"title":   f.title.Text(),
		"content": f.body.Text(),
	}
	if n := strings.TrimSpace(f.note); n != "" {
		body["change_note"] = n
	}
	return func() tea.Msg {
		err := f.ctx.API.Patch(f.ctx.Ctx, "/api/v1/posts/"+url.PathEscape(id), body, nil)
		return editSavedMsg{err: err}
	}
}

func (f *forumEdit) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case postLoadedMsg:
		f.loading = false
		if m.err != nil {
			f.err = friendly(m.err)
			return f, Fail(m.err)
		}
		f.title.SetText(m.data.Title)
		f.body.SetText(m.data.Content)
		f.original = m.data.Title + "\x00" + m.data.Content
		return f, nil

	case editSavedMsg:
		f.saving = false
		if m.err != nil {
			return f, Fail(m.err)
		}
		return f, tea.Batch(
			Navigate("forum/post", Params{"id": f.params.Get("id")}),
			Status("改好了。这一版进了编辑历史"),
		)

	case tea.KeyMsg:
		return f.key(m)
	}
	return f, nil
}

func (f *forumEdit) key(m tea.KeyMsg) (Screen, tea.Cmd) {
	// 还没取回原文之前不让编辑 —— 否则打的字会被取回来的内容盖掉
	if f.loading {
		return f, nil
	}

	switch m.String() {
	case "ctrl+s":
		if f.saving {
			return f, nil
		}
		if !surface.HasScope(f.ctx.Scopes, "forum:write") {
			return f, Status("这把令牌不能编辑。:login 重新登录时勾上「以我的名义发帖和回复」")
		}
		if f.title.Empty() || f.body.Empty() {
			/*
			 * 空标题或空正文在服务端会被拒，但那句话到达时
			 * 人已经按过一次提交 —— 而且他多半以为自己填了。
			 */
			return f, Status("标题和正文都不能是空的")
		}
		if f.title.Text()+"\x00"+f.body.Text() == f.original {
			/*
			 * 一个字都没改就提交的话，会在编辑历史里留下一版
			 * 和上一版一模一样的记录 —— 而历史的意义是
			 * 「他改了什么」，一版空改动只会让它变难读。
			 */
			return f, Status("一个字都没改 —— 不用存")
		}
		f.saving = true
		return f, f.save()

	case "esc":
		return f, func() tea.Msg { return BackMsg{} }

	case "tab":
		f.focus = (f.focus + 1) % 2
		return f, nil
	}

	if f.focus == 0 {
		/*
		 * 标题是单行的 —— 在它上面按回车该跳到正文，
		 * 而不是在标题里插一个换行（那会让标题变成两行，
		 * 而服务端只收一行）。
		 */
		if m.String() == "enter" {
			f.focus = 1
			return f, nil
		}
		f.title.Update(m)
		return f, nil
	}
	f.body.Update(m)
	return f, nil
}

func (f *forumEdit) View(width, height int) string {
	p := f.ctx.Theme
	if f.loading {
		return p.Muted.Render("正在取原文…")
	}
	if f.err != "" && f.original == "" {
		return p.Danger.Render(f.err)
	}

	var b strings.Builder
	b.WriteString(p.Faint.Render("Tab 换栏 · Ctrl+S 保存 · Esc 放弃  ·  " + f.body.Status()))
	b.WriteString("\n\n")

	titleStyle, bodyStyle := p.Muted, p.Muted
	if f.focus == 0 {
		titleStyle = p.Accent
	} else {
		bodyStyle = p.Accent
	}

	b.WriteString(titleStyle.Render("标题") + "\n")
	b.WriteString(f.title.View(p, width, 1))
	b.WriteString("\n\n")
	b.WriteString(bodyStyle.Render("正文") + "\n")

	bodyHeight := height - 7
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	b.WriteString(f.body.View(p, width, bodyHeight))

	if f.saving {
		b.WriteString("\n" + p.Muted.Render("保存中…"))
	}
	return b.String()
}
