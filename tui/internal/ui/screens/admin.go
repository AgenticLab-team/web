package screens

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 后台。三十个分区共用这一屏。
 *
 * ═════════════════════════════════════════
 * 它读什么、能做什么，全部由**服务端**说了算
 * ═════════════════════════════════════════
 *
 * `GET /api/v1/admin/sections` 按这个人的身份组算出：
 * 他能进哪几个分区、每个分区有哪些动作、每个动作要哪些字段、
 * 哪些动作危险到要额外确认。终端照着画。
 *
 * 在这里为三十个分区各写一份表单的话，后台加一个字段时
 * 那三十份里没有一份会知道 —— 而那正是这整套东西要防的退化。
 *
 * ═════════════════════════════════════════
 * 权限判定一个字都不在这里
 * ═════════════════════════════════════════
 *
 * 终端画不画某个按钮，和他能不能做那件事，是两回事：
 * 前者只是「别让他白按一次」，后者由服务端的
 * `requireWritableAdmin("权限点")` 说了算，而那是网页那边用的同一段。
 *
 * 所以这里的清单**只用来画界面**。就算有人改了这个二进制、
 * 把所有动作都画出来，服务端那侧一个都不会放过去。
 */

type adminScreen struct {
	ctx     Context
	section string
	label   string

	// 数据那一半
	tree    *kit.Tree
	loading bool
	err     string

	// 动作那一半
	actions []adminAction
	picking bool
	pickIdx int
	form    *kit.Form
	active  *adminAction
	running bool
	// 上一次动作的结果，显示在顶上
	outcome string
	ok      bool
}

type adminAction struct {
	Key          string      `json:"key"`
	Label        string      `json:"label"`
	Danger       int         `json:"danger"`
	NeedsConfirm bool        `json:"needs_confirm"`
	Fields       []kit.Field `json:"fields"`
}

type adminSectionsMsg struct {
	actions []adminAction
	err     error
}

type adminDataMsg struct {
	raw json.RawMessage
	err error
}

type adminDoneMsg struct {
	err error
}

func newAdmin(ctx Context, params Params) Screen {
	section := params.Get("section")
	if section == "" {
		/*
		 * 没带 section 就落在仪表盘上。
		 *
		 * 报「缺参数」是错的：人是从最左那一竖点进来的，
		 * 而那一竖上「管理」这一格本来就该有个落点。
		 */
		section = "dashboard"
	}
	return &adminScreen{ctx: ctx, section: section, label: adminLabel(section)}
}

func adminLabel(section string) string {
	for _, s := range surface.AdminSections {
		if s.Key == section {
			return s.Label
		}
	}
	return "后台 · " + section
}

func (a *adminScreen) Title() string { return a.label }

func (a *adminScreen) Init() tea.Cmd {
	a.loading = true
	return tea.Batch(a.loadData(), a.loadActions())
}

func (a *adminScreen) loadData() tea.Cmd {
	path := "/api/v1/admin/" + url.PathEscape(a.section)
	return func() tea.Msg {
		/*
		 * 收成 RawMessage 而不是先解成 map 再重新序列化 ——
		 * 后者会把数字全变成 float64，于是一个 id 会显示成
		 * `1.234567891e+09`，而人完全看不出那是什么。
		 */
		var raw json.RawMessage
		if err := a.ctx.API.Get(a.ctx.Ctx, path, nil, &raw); err != nil {
			return adminDataMsg{err: err}
		}
		return adminDataMsg{raw: raw}
	}
}

// loadActions 问「我在这个分区能做什么」。
//
// 每次进这一屏都问一次，不缓存 —— 一个人的身份组可能刚被改过，
// 而缓存下来的清单会让他看到一个已经没了的按钮。
// 这条接口很轻（它只读注册表和权限矩阵）。
func (a *adminScreen) loadActions() tea.Cmd {
	return func() tea.Msg {
		var out struct {
			Sections []struct {
				Key     string        `json:"key"`
				Actions []adminAction `json:"actions"`
			} `json:"sections"`
		}
		if err := a.ctx.API.Get(a.ctx.Ctx, "/api/v1/admin/sections", nil, &out); err != nil {
			return adminSectionsMsg{err: err}
		}
		for _, s := range out.Sections {
			if s.Key == a.section {
				return adminSectionsMsg{actions: s.Actions}
			}
		}
		return adminSectionsMsg{}
	}
}

func (a *adminScreen) submit() tea.Cmd {
	body := a.form.Values()
	body["action"] = a.active.Key
	if a.active.NeedsConfirm {
		body["confirm"] = true
	}
	path := "/api/v1/admin/" + url.PathEscape(a.section)
	return func() tea.Msg {
		err := a.ctx.API.Post(a.ctx.Ctx, path, body, nil)
		return adminDoneMsg{err: err}
	}
}

func (a *adminScreen) Update(msg tea.Msg) (Screen, tea.Cmd) {
	switch m := msg.(type) {
	case adminDataMsg:
		a.loading = false
		if m.err != nil {
			a.err = friendly(m.err)
			return a, Fail(m.err)
		}
		a.err = ""
		a.tree = kit.Parse(m.raw)
		return a, nil

	case adminSectionsMsg:
		if m.err == nil {
			a.actions = m.actions
		}
		return a, nil

	case adminDoneMsg:
		a.running = false
		a.form = nil
		a.active = nil
		if m.err != nil {
			a.ok = false
			a.outcome = friendly(m.err)
			return a, Fail(m.err)
		}
		a.ok = true
		a.outcome = "做完了。这一条已经记进审计日志。"
		// 做完立刻重读一次 —— 否则屏幕上还是动作之前的样子
		return a, tea.Batch(a.loadData(), Status(a.outcome))

	case tea.KeyMsg:
		return a.key(m)
	}
	return a, nil
}

func (a *adminScreen) key(m tea.KeyMsg) (Screen, tea.Cmd) {
	// ── 确认态：只认 y / n ──────────────────────────
	if a.form != nil && a.form.Confirming() {
		switch m.String() {
		case "y", "Y":
			a.running = true
			return a, a.submit()
		default:
			a.form.CancelConfirm()
			return a, Status("取消了，什么都没做")
		}
	}

	// ── 正在填表 ────────────────────────────────────
	if a.form != nil {
		switch m.String() {
		case "esc":
			a.form = nil
			a.active = nil
			return a, Status("")
		case "ctrl+s":
			if a.running {
				return a, nil
			}
			if missing := a.form.Missing(); len(missing) > 0 {
				/*
				 * 必填项在**本地**先拦一次。
				 *
				 * 服务端那句「必须填写理由」是对的，但它到达时
				 * 人已经按过一次提交，而且那句话没说是哪一栏。
				 */
				return a, Status("还差：" + strings.Join(missing, "、"))
			}
			if a.active.NeedsConfirm {
				a.form.AskConfirm(a.confirmText())
				return a, nil
			}
			a.running = true
			return a, a.submit()
		}
		a.form.Update(m)
		return a, nil
	}

	// ── 选动作 ──────────────────────────────────────
	if a.picking {
		switch m.String() {
		case "esc":
			a.picking = false
			return a, Status("")
		case "up", "k":
			if a.pickIdx > 0 {
				a.pickIdx--
			}
		case "down", "j":
			if a.pickIdx < len(a.actions)-1 {
				a.pickIdx++
			}
		case "enter":
			if a.pickIdx < len(a.actions) {
				a.active = &a.actions[a.pickIdx]
				a.form = kit.NewForm(a.active.Fields)
				a.picking = false
				return a, Status("填完按 Ctrl+S，Esc 放弃")
			}
		}
		return a, nil
	}

	// ── 看数据 ──────────────────────────────────────
	switch m.String() {
	case "a":
		if len(a.actions) == 0 {
			/*
			 * 一个动作都没有有两种可能：这个分区本来就只能看，
			 * 或者他的身份组不允许。两种说法都对，但对他来说
			 * 能做的事是一样的 —— 所以合成一句，别让他去猜。
			 */
			return a, Status("这个分区在你这里是只读的")
		}
		a.picking = true
		a.pickIdx = 0
		return a, Status("选一个动作，回车填参数")
	case "r":
		a.loading = true
		return a, a.loadData()
	case "up", "k":
		if a.tree != nil {
			a.tree.Up()
		}
	case "down", "j":
		if a.tree != nil {
			a.tree.Down()
		}
	case "enter", "right", "l":
		if a.tree != nil {
			if target, params := a.tree.Link(); target != "" {
				return a, Navigate(target, params)
			}
			a.tree.Toggle()
		}
	case "left", "h":
		if a.tree != nil && !a.tree.Collapse() {
			return a, func() tea.Msg { return BackMsg{} }
		}
	}
	return a, nil
}

// confirmText 是危险动作按下去之前那一屏。
//
// ═════════════════════════════════════════
// 它要**复述一遍即将发生的事**，不是问「确定吗」
// ═════════════════════════════════════════
//
// 「确定吗？」是一个所有人都会按 y 的问题 —— 它没有提供任何
// 新信息。而这一步存在的意义是让人看清楚**参数**：
// 手滑最常见的形态不是按错按钮，是对着错的对象按了对的按钮。
func (a *adminScreen) confirmText() string {
	var b strings.Builder
	b.WriteString(a.active.Label + "  （" + a.label + "）\n")
	for _, f := range a.active.Fields {
		v := a.form.Values()[f.Name]
		if v == nil {
			continue
		}
		b.WriteString(fmt.Sprintf("%s：%v\n", f.Label, v))
	}
	b.WriteString("\n这一条会以**你的名义**写进审计日志，而且多半撤不回来。")
	return b.String()
}

func (a *adminScreen) View(width, height int) string {
	p := a.ctx.Theme
	var b strings.Builder

	// 顶上一行：上一次动作的结果
	if a.outcome != "" {
		style := p.Good
		if !a.ok {
			style = p.Danger
		}
		b.WriteString(kit.Truncate(style.Render(a.outcome), width, p.Ellipsis()) + "\n\n")
		height -= 2
	}

	switch {
	case a.form != nil:
		b.WriteString(p.Accent.Render(a.active.Label) + "\n")
		if a.active.Danger >= 2 {
			b.WriteString(p.Danger.Render("这是一个不可逆或影响面很大的动作") + "\n")
		}
		b.WriteString("\n")
		b.WriteString(a.form.View(p, width))
		if a.running {
			b.WriteString("\n" + p.Muted.Render("正在做…"))
		} else if !a.form.Confirming() {
			b.WriteString("\n" + p.Faint.Render("Tab 换栏 · Ctrl+S 提交 · Esc 放弃"))
		}
		return b.String()

	case a.picking:
		b.WriteString(p.Accent.Render("能做的动作") + "\n\n")
		for i, act := range a.actions {
			mark := "  "
			if i == a.pickIdx {
				mark = p.Accent.Render(p.Cursor()) + " "
			}
			name := act.Label
			if act.Danger >= 2 {
				name += p.Danger.Render("  ⚠ 要确认")
			} else if act.Danger == 1 {
				name += p.Warn.Render("  ·")
			}
			b.WriteString(kit.Truncate(mark+name, width, p.Ellipsis()) + "\n")
		}
		b.WriteString("\n" + p.Faint.Render("回车选中 · Esc 返回"))
		return b.String()
	}

	// 平时：数据 + 一行提示
	hint := "a 做点什么 · r 刷新"
	if len(a.actions) == 0 {
		hint = "这个分区在你这里是只读的 · r 刷新"
	}
	b.WriteString(p.Faint.Render(hint) + "\n\n")
	height -= 2

	switch {
	case a.loading && a.tree == nil:
		b.WriteString(p.Muted.Render("正在取…"))
	case a.err != "" && a.tree == nil:
		b.WriteString(p.Danger.Render(a.err))
	case a.tree == nil:
		b.WriteString(p.Muted.Render("空的"))
	default:
		if height < 1 {
			height = 1
		}
		b.WriteString(a.tree.View(p, width, height))
	}
	return b.String()
}
