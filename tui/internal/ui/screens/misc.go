package screens

import (
	"runtime"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 几屏小的：认不出的屏幕、成员主页、帖子正文、发帖、关于/更新、后台。
 */

// ── 认不出的屏幕 ──────────────────────────────────────

type missing struct {
	ctx Context
	id  string
}

func newMissing(ctx Context, id string) Screen { return &missing{ctx: ctx, id: id} }

func (m *missing) Title() string                    { return "这一屏不在这个版本里" }
func (m *missing) Init() tea.Cmd                    { return nil }
func (m *missing) Update(tea.Msg) (Screen, tea.Cmd) { return m, nil }

func (m *missing) View(width, height int) string {
	p := m.ctx.Theme
	/*
	 * 认不出的屏幕 id 只有一种来源：**这个二进制比服务端旧**
	 * （表和注册表的一致性有守卫盯着，同一个版本内不可能对不上）。
	 *
	 * 所以这里指向「去更新」，而不是「出错了」——
	 * 后者会让人去重装、去重新登录，两件都没用。
	 */
	lines := []string{
		p.Warn.Render("这一屏（" + m.id + "）不在你这个版本的客户端里。"),
		"",
		p.Muted.Render("多半是站点更新了而客户端还没跟上。"),
		p.Muted.Render("敲 :update 检查更新，或者重新跑一遍安装命令："),
		"    curl -Ls agenticlab.sh | bash",
	}
	return strings.Join(lines, "\n")
}

// ── 成员主页 ──────────────────────────────────────────

type person struct {
	*generic
}

// newPerson 是主页那一屏。
//
// 它在通用屏的基础上多一件事：**从这里跳得出去**。
// 「聊着聊着想看这个人的主页，从主页进他的帖子，从帖子进 GitHub」——
// 那条路径的中间一站就是这里，而通用屏的跳转靠数据里的 id
// （见 kit.Tree 的 linkFor），主页返回体里帖子和项目都带着 id。
func newPerson(ctx Context, params Params) Screen {
	g := &generic{
		ctx: ctx,
		spec: spec{
			title: "成员主页",
			path:  "/api/v1/members/{wx_id}",
			hint:  "回车进他的帖子或项目；o 用系统浏览器打开 GitHub",
		},
		params: params,
	}
	return &person{generic: g}
}

func (p *person) Update(msg tea.Msg) (Screen, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok && k.String() == "o" {
		/*
		 * `o` 是「用系统浏览器打开」。
		 *
		 * **SSH 会话里这个键不该有效** —— 网关那台机器上没有浏览器，
		 * 按下去只会静默失败，而人会以为是自己按错了。
		 * 判定在外壳那一层（它知道自己是不是 SSH 会话），
		 * 这里只在拿不到链接时说清楚。
		 */
		return p, Status("这一屏上没有可以在浏览器里打开的地址")
	}
	s, cmd := p.generic.Update(msg)
	if _, same := s.(*generic); same {
		return p, cmd
	}
	return s, cmd
}

// ── 发帖 ──────────────────────────────────────────────

/*
 * 发一个帖。
 *
 * 正文走和「编辑帖子」同一个多行编辑器（`kit.Editor`）——
 * 第一版在这里自己搓了一个「回车加换行、退格删一个 rune」的
 * 简版，而它和编辑那一屏的行为不一致：同一个人在两个地方
 * 按同一个键得到不同的结果，那比两边都简陋更难受。
 */

type compose struct {
	ctx    Context
	params Params

	board *kit.Editor
	title *kit.Editor
	body  *kit.Editor
	// 0=版块 1=标题 2=正文
	focus   int
	posting bool
}

func newForumCompose(ctx Context, params Params) Screen {
	return &compose{
		ctx:    ctx,
		params: params,
		board:  kit.NewEditor(params.Get("board")),
		title:  kit.NewEditor(""),
		body:   kit.NewEditor(""),
	}
}

func (c *compose) Title() string { return "发帖" }
func (c *compose) Init() tea.Cmd { return nil }

type postedMsg struct {
	id  string
	err error
}

func (c *compose) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case postedMsg:
		c.posting = false
		if m.err != nil {
			return c, Fail(m.err)
		}
		return c, tea.Batch(
			Navigate("forum/post", Params{"id": m.id}),
			Status("发出去了"),
		)

	case tea.KeyMsg:
		switch m.String() {
		case "tab":
			c.focus = (c.focus + 1) % 3
			return c, nil
		case "shift+tab":
			c.focus = (c.focus + 2) % 3
			return c, nil
		case "esc":
			return c, func() tea.Msg { return BackMsg{} }
		case "ctrl+s":
			if c.posting {
				return c, nil
			}
			if c.board.Empty() || c.title.Empty() {
				return c, Status("版块和标题都要填")
			}
			c.posting = true
			return c, c.post()
		}

		/*
		 * 版块和标题是单行的 —— 在它们上面按回车该跳到下一栏，
		 * 而不是插一个换行（服务端那两个字段只收一行）。
		 */
		if c.focus < 2 && m.String() == "enter" {
			c.focus++
			return c, nil
		}
		c.current().Update(m)
	}
	return c, nil
}

func (c *compose) current() *kit.Editor {
	switch c.focus {
	case 0:
		return c.board
	case 1:
		return c.title
	default:
		return c.body
	}
}

func (c *compose) post() tea.Cmd {
	board, title, body := c.board.Text(), c.title.Text(), c.body.Text()
	return func() tea.Msg {
		var out struct {
			PostID string `json:"post_id"`
			Note   string `json:"note"`
		}
		err := c.ctx.API.Post(c.ctx.Ctx, "/api/v1/posts", map[string]any{
			"board": board, "title": title, "content": body,
		}, &out)
		return postedMsg{id: out.PostID, err: err}
	}
}

func (c *compose) View(width, height int) string {
	p := c.ctx.Theme
	var b strings.Builder

	b.WriteString(p.Faint.Render("Tab 换栏 · Ctrl+S 发出去 · Esc 放弃  ·  " + c.body.Status()))
	b.WriteString("\n\n")

	label := func(i int, text string) string {
		if c.focus == i {
			return p.Accent.Render(text)
		}
		return p.Muted.Render(text)
	}

	b.WriteString(label(0, "版块") + "\n")
	b.WriteString(c.board.View(p, width, 1) + "\n\n")
	b.WriteString(label(1, "标题") + "\n")
	b.WriteString(c.title.View(p, width, 1) + "\n\n")
	b.WriteString(label(2, "正文") + "\n")

	bodyHeight := height - 9
	if bodyHeight < 3 {
		bodyHeight = 3
	}
	b.WriteString(c.body.View(p, width, bodyHeight))

	if c.posting {
		b.WriteString("\n" + p.Muted.Render("发送中…"))
	}
	/*
	 * 版块权限、等级门槛、必填标签、敏感词、发帖频率限制
	 * 都在服务端判 —— 这里不预判。
	 *
	 * 预判就是第二份规则，而它必然和服务端那份不一致：
	 * 松了的话人写完被拒，紧了的话一个本来能发的人被这个客户端挡住。
	 */
	b.WriteString("\n" + p.Faint.Render("版块权限、等级门槛、敏感词这些由服务端判 —— 和网页上完全一样"))
	return b.String()
}

// ── 关于 / 检查更新 ──────────────────────────────────

type about struct {
	ctx     Context
	version string
	latest  string
	err     string
}

func newAbout(ctx Context, params Params) Screen {
	return &about{ctx: ctx, version: params.Get("version")}
}

func (a *about) Title() string { return "版本与更新" }

func (a *about) Init() tea.Cmd {
	return func() tea.Msg {
		var out struct {
			Version string `json:"version"`
			Notes   string `json:"notes"`
		}
		if err := a.ctx.API.Get(a.ctx.Ctx, "/api/v1/release", nil, &out); err != nil {
			return releaseMsg{err: err}
		}
		return releaseMsg{version: out.Version, notes: out.Notes}
	}
}

type releaseMsg struct {
	version string
	notes   string
	err     error
}

func (a *about) Update(msg tea.Msg) (Screen, tea.Cmd) {
	if m, ok := msg.(releaseMsg); ok {
		if m.err != nil {
			a.err = friendly(m.err)
			return a, nil
		}
		a.latest = m.version
	}
	return a, nil
}

func (a *about) View(width, height int) string {
	p := a.ctx.Theme
	lines := []string{
		p.Accent.Render("Agentic Lab 终端客户端"),
		"",
		p.Muted.Render("这一版： ") + a.version,
		p.Muted.Render("系统：   ") + runtime.GOOS + "/" + runtime.GOARCH,
		p.Muted.Render("站点：   ") + a.ctx.Site,
	}
	switch {
	case a.err != "":
		lines = append(lines, "", p.Faint.Render("查不到最新版："+a.err))
	case a.latest == "":
		lines = append(lines, "", p.Muted.Render("正在查最新版…"))
	case a.latest == a.version:
		lines = append(lines, "", p.Good.Render("已经是最新的了"))
	default:
		lines = append(lines,
			"",
			p.Warn.Render("有新版："+a.latest),
			p.Muted.Render("已经在后台下载了，下次启动生效。"),
			/*
			 * 「下次启动生效」不是偷懒 —— 替换一个**正在跑的**二进制
			 * 然后热重载，在终端程序上意味着当前这个会话的状态全丢。
			 * 而人可能正打了一半的字。
			 */
		)
	}
	return strings.Join(lines, "\n")
}
