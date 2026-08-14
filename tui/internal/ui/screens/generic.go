package screens

import (
	"encoding/json"
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 一屏「取一份数据、把它铺出来」。
 *
 * ═════════════════════════════════════════
 * 为什么大多数屏共用一个实现
 * ═════════════════════════════════════════
 *
 * 站里六十来个面，其中绝大多数的形状是同一个：
 * 调一个接口、把结果列出来、能上下选、回车进详情。
 *
 * 为它们各写一份的话，加一个「按 / 搜索」这样的能力
 * 要改六十处 —— 而实际改到的会是其中十几处，
 * 剩下的悄悄地少一个功能。
 *
 * 需要特殊对待的那几屏（群聊、帖子正文、成员主页、后台）
 * 各自有自己的文件，它们值得。
 *
 * ─────────────────────────────────────────
 * 它渲染的是**服务端返回的 JSON**，不是写死的字段
 * ─────────────────────────────────────────
 *
 * 这一条是「网页加了字段，终端跟得上」的底层保证：
 * 服务端多返回一个字段，这里就多显示一行，
 * 不需要重新发一个客户端。
 *
 * 代价是它显示得比手写的丑一点。那个代价换来的是
 * **不会悄悄少东西** —— 而后者才是这整套设计要防的。
 */

type spec struct {
	title string
	// 接口路径。`{x}` 会用跳转参数替换
	path string
	// 这些跳转参数会作为查询串带上
	query []string
	// 支持按 `/` 搜索
	search bool
	// 屏顶上那句话。写的是「这一屏有什么反直觉的地方」
	hint string
	// 这一屏上能做的事。见 action.go
	actions []action
}

func genericFactory(s spec) Factory {
	return func(ctx Context, params Params) Screen {
		return &generic{ctx: ctx, spec: s, params: params, runner: runner{actions: s.actions}}
	}
}

type generic struct {
	ctx    Context
	spec   spec
	params Params
	runner runner

	tree    *kit.Tree
	loading bool
	err     string
	filter  string
	// 正在输搜索词
	searching bool
	input     string
}

type loadedMsg struct {
	body json.RawMessage
	err  error
}

func (g *generic) Title() string { return g.spec.title }

func (g *generic) Init() tea.Cmd {
	g.loading = true
	return g.load()
}

func (g *generic) load() tea.Cmd {
	path := g.spec.path
	for k, v := range g.params {
		path = strings.ReplaceAll(path, "{"+k+"}", url.PathEscape(v))
	}

	q := url.Values{}
	for _, k := range g.spec.query {
		if v := g.params.Get(k); v != "" {
			q.Set(k, v)
		}
	}
	if g.filter != "" {
		q.Set("q", g.filter)
	}

	return func() tea.Msg {
		var raw json.RawMessage
		err := g.ctx.API.Get(g.ctx.Ctx, path, q, &raw)
		return loadedMsg{body: raw, err: err}
	}
}

func (g *generic) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case loadedMsg:
		g.loading = false
		if m.err != nil {
			/*
			 * 出错时**不清掉已有内容**。
			 *
			 * 一次刷新失败（网络抖一下）把整屏清空，比不刷新糟得多：
			 * 人刚才还在读的东西没了，而他什么也没做。
			 */
			g.err = friendly(m.err)
			return g, Fail(m.err)
		}
		g.err = ""
		g.tree = kit.Parse(m.body)
		return g, nil

	case actionDoneMsg:
		g.runner.running = false
		g.runner.reset()
		if m.err != nil {
			return g, Fail(m.err)
		}
		/*
		 * 做完立刻重取一次。
		 *
		 * 不取的话屏幕上还是动作之前的样子 —— 而人刚刚投了一票，
		 * 看到票数没变会以为没成功，然后再按一次。
		 */
		g.loading = true
		return g, tea.Batch(g.load(), Status("做完了"))

	case tea.KeyMsg:
		if g.searching {
			return g.updateSearch(m)
		}
		// 表单/确认态优先 —— 那时候每一个键都是在填表，不是快捷键
		if cmd, handled := g.runner.key(g.ctx, m); handled {
			return g, cmd
		}
		for _, a := range g.spec.actions {
			if m.String() != a.key {
				continue
			}
			var rowParams map[string]string
			if g.tree != nil {
				rowParams = g.tree.Params()
			}
			cmd, _ := g.runner.begin(g.ctx, a, g.params, rowParams)
			return g, cmd
		}
		switch m.String() {
		case "/":
			if g.spec.search {
				g.searching = true
				g.input = g.filter
				return g, Status("输入要搜的词，回车确认，Esc 取消")
			}
		case "r":
			g.loading = true
			return g, g.load()
		case "up", "k":
			if g.tree != nil {
				g.tree.Up()
			}
		case "down", "j":
			if g.tree != nil {
				g.tree.Down()
			}
		case "enter", "right", "l":
			if g.tree != nil {
				/*
				 * 回车先试「这一行指向站里的另一个东西吗」。
				 *
				 * 指向的话就跳过去 —— 那是「聊着聊着想看这个人的主页」
				 * 那条路径的实现：不需要每一屏各写一遍跳转，
				 * 数据里带着 wx_id / post id 就够了。
				 */
				if target, params := g.tree.Link(); target != "" {
					return g, Navigate(target, params)
				}
				g.tree.Toggle()
			}
		case "left", "h":
			if g.tree != nil && !g.tree.Collapse() {
				return g, func() tea.Msg { return BackMsg{} }
			}
		}
	}
	return g, nil
}

func (g *generic) updateSearch(m tea.KeyMsg) (Screen, tea.Cmd) {
	switch m.String() {
	case "esc":
		g.searching = false
		return g, Status("")
	case "enter":
		g.searching = false
		g.filter = strings.TrimSpace(g.input)
		g.loading = true
		return g, g.load()
	case "backspace":
		if len(g.input) > 0 {
			r := []rune(g.input)
			g.input = string(r[:len(r)-1])
		}
	default:
		if len(m.Runes) > 0 {
			g.input += string(m.Runes)
		}
	}
	return g, nil
}

func (g *generic) View(width, height int) string {
	p := g.ctx.Theme
	var b strings.Builder

	// 填表/确认的时候只显示表单 —— 见 kit.Form 里那段
	if g.runner.form != nil {
		b.WriteString(p.Accent.Render(g.runner.active.label) + "\n\n")
		b.WriteString(g.runner.form.View(p, width))
		if g.runner.running {
			b.WriteString("\n" + p.Muted.Render("正在做…"))
		} else if !g.runner.form.Confirming() {
			b.WriteString("\n" + p.Faint.Render("Tab 换栏 · Ctrl+S 提交 · Esc 放弃"))
		}
		return b.String()
	}

	if len(g.spec.actions) > 0 {
		b.WriteString(p.Faint.Render(kit.Truncate(g.runner.hint(g.ctx), width, p.Ellipsis())))
		b.WriteString("\n")
		height--
	}

	if g.spec.hint != "" {
		b.WriteString(p.Faint.Render(kit.Truncate(g.spec.hint, width, p.Ellipsis())))
		b.WriteString("\n\n")
		height -= 2
	}
	if g.searching {
		b.WriteString(p.Accent.Render("搜索: ") + g.input + "▏\n\n")
		height -= 2
	} else if g.filter != "" {
		b.WriteString(p.Muted.Render("筛选: "+g.filter+"（按 / 改，r 刷新）") + "\n\n")
		height -= 2
	}

	switch {
	case g.loading && g.tree == nil:
		b.WriteString(p.Muted.Render("正在取…"))
	case g.err != "" && g.tree == nil:
		b.WriteString(p.Danger.Render(g.err))
	case g.tree == nil:
		b.WriteString(p.Muted.Render("空的"))
	default:
		if g.err != "" {
			// 有旧内容时，错误只占一行，内容留着
			b.WriteString(p.Danger.Render(kit.Truncate("刷新失败："+g.err, width, p.Ellipsis())))
			b.WriteString("\n")
			height--
		}
		b.WriteString(g.tree.View(p, width, height))
	}
	return b.String()
}

func friendly(err error) string {
	if e := apiError(err); e != nil {
		return e.Friendly()
	}
	return err.Error()
}
