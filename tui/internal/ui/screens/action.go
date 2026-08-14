package screens

import (
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 「在这一屏上做点什么」——声明式的。
 *
 * ═════════════════════════════════════════
 * 为什么不是每屏各写一遍
 * ═════════════════════════════════════════
 *
 * 投票、收藏、举报、报名、下单、关注、加关键词、删草稿…… 二十来个动作，
 * 每一个都是「拼一个路径、发一次 POST、把结果说出来」。
 *
 * 各写一遍的话，那些**共同的坑**要各踩一遍：
 *   · 缺 scope 时该提前说，而不是让人按下去拿 403
 *   · 花积分的动作要先确认一次
 *   · 做完要重新取一次数据，否则屏幕上还是旧的
 *   · 失败时那句话要来自 `api.Error.Friendly()`，不是各自拼一句
 *
 * 二十份实现里，这四条**平均只有两条**会被记得。
 */

// action 是一屏上能做的一件事。
type action struct {
	// 键盘上按哪个键。要避开屏幕本身用掉的那些（j/k/r/enter…）
	key   string
	label string
	// POST / DELETE
	method string
	/*
	 * 路径。`{x}` 会依次从两处取：跳转参数，然后是**光标所在那一行
	 * 所属对象**上的 id（见 kit.Tree.Params）。
	 *
	 * 后者是关键：资源库那一屏上的「投票」作用于光标停在的那条链接，
	 * 而那条链接的 id 在数据里，不在跳转参数里。
	 */
	path string
	// 要人填的东西。空的话按一下就执行（危险动作仍然要确认）
	fields []kit.Field
	// 固定的请求体。像「on: true」这种不需要问人的
	body map[string]any
	/*
	 * 这个动作要哪个 scope。
	 *
	 * 缺了的话按键**根本不响应**，而是给一句解释 ——
	 * 这是「在人动手之前就说清楚」那条原则里最实在的一处：
	 * 一次 403 之后人会以为是自己没资格，而实际是令牌少勾了一项。
	 */
	scope string
	/*
	 * 危险级。>=1 的要先确认一次。
	 *
	 * 判据不是「不可逆」，是**花不花掉真东西**：打赏和下单
	 * 扣的是积分，扣了就没了；而收藏点错了再点一下就好。
	 */
	danger int
}

// runner 是几屏共用的那套「按键 → 表单 → 确认 → 发请求」。
//
// 它被 generic 嵌进去，所以每一屏都白得到同一套行为。
type runner struct {
	actions []action
	form    *kit.Form
	active  *action
	// 这次动作真正要打的路径（表单打开时就算好，免得中途光标动了）
	target  string
	running bool
}

// missingScope 是「这个动作现在能不能用」。
func missingScope(ctx Context, a action) bool {
	return a.scope != "" && !surface.HasScope(ctx.Scopes, a.scope)
}

// resolve 把 `{x}` 换成真值。换不掉就返回空 —— 调用方据此说一句人话，
// 而不是发一个带着 `{id}` 五个字符的请求（那会拿回一句谁也看不懂的 404）。
func resolve(path string, params Params, rowParams map[string]string) string {
	out := path
	for {
		start := strings.Index(out, "{")
		if start < 0 {
			return out
		}
		end := strings.Index(out[start:], "}")
		if end < 0 {
			return ""
		}
		name := out[start+1 : start+end]
		value := params.Get(name)
		if value == "" {
			value = rowParams[name]
		}
		if value == "" {
			return ""
		}
		out = out[:start] + url.PathEscape(value) + out[start+end+1:]
	}
}

type actionDoneMsg struct{ err error }

// begin 开一个动作。返回的 cmd 可能是 nil（表示进了表单/确认态，在等按键）。
func (r *runner) begin(ctx Context, a action, params Params, rowParams map[string]string) (tea.Cmd, bool) {
	if missingScope(ctx, a) {
		spec := surface.ScopeByKey(a.scope)
		return Status("这把令牌不能「" + a.label + "」—— 它要「" + spec.Label +
			"」。:login 重新登录时可以勾上"), true
	}

	target := resolve(a.path, params, rowParams)
	if target == "" {
		/*
		 * 换不出路径，最常见的原因是**光标不在一个具体的东西上**：
		 * 人想给某条链接投票，但光标停在最外层那个「结果 (30)」上。
		 *
		 * 说清楚这一点，而不是「参数缺失」—— 后者不告诉他该做什么。
		 */
		return Status("先把光标移到具体那一条上，再按 " + a.key), true
	}

	r.active = &a
	r.target = target
	r.form = kit.NewForm(a.fields)
	if len(a.fields) == 0 && a.danger == 0 {
		// 不用填、也不危险：直接做
		r.running = true
		return r.submit(ctx), true
	}
	if len(a.fields) == 0 && a.danger > 0 {
		r.form.AskConfirm(a.label + "\n" + target + "\n\n这个动作会花掉真东西，撤不回来。")
		return nil, true
	}
	return Status("填完按 Ctrl+S，Esc 放弃"), true
}

func (r *runner) submit(ctx Context) tea.Cmd {
	body := r.form.Values()
	for k, v := range r.active.body {
		if _, taken := body[k]; !taken {
			body[k] = v
		}
	}
	method := r.active.method
	target := r.target
	return func() tea.Msg {
		var err error
		if method == "DELETE" {
			err = ctx.API.Delete(ctx.Ctx, target, nil, nil)
		} else {
			err = ctx.API.Post(ctx.Ctx, target, body, nil)
		}
		return actionDoneMsg{err: err}
	}
}

// key 在表单/确认态下处理按键。返回 true 表示这次按键被吃掉了。
func (r *runner) key(ctx Context, m tea.KeyMsg) (tea.Cmd, bool) {
	if r.form == nil {
		return nil, false
	}

	if r.form.Confirming() {
		switch m.String() {
		case "y", "Y":
			r.running = true
			return r.submit(ctx), true
		default:
			r.reset()
			return Status("取消了，什么都没做"), true
		}
	}

	switch m.String() {
	case "esc":
		r.reset()
		return Status(""), true
	case "ctrl+s":
		if r.running {
			return nil, true
		}
		if miss := r.form.Missing(); len(miss) > 0 {
			return Status("还差：" + strings.Join(miss, "、")), true
		}
		if r.active.danger > 0 {
			r.form.AskConfirm(r.confirmText())
			return nil, true
		}
		r.running = true
		return r.submit(ctx), true
	}
	r.form.Update(m)
	return nil, true
}

func (r *runner) confirmText() string {
	var b strings.Builder
	b.WriteString(r.active.label + "\n")
	for _, f := range r.active.fields {
		if v := r.form.Values()[f.Name]; v != nil {
			b.WriteString(f.Label + "：")
			b.WriteString(kit.Truncate(sprint(v), 60, "…"))
			b.WriteString("\n")
		}
	}
	b.WriteString("\n这个动作会花掉真东西，撤不回来。")
	return b.String()
}

func (r *runner) reset() {
	r.form = nil
	r.active = nil
	r.target = ""
	r.running = false
}

// hint 是屏幕上那一行「能按什么」。
//
// 缺 scope 的动作**也列出来**，但标成灰的 —— 不列的话，
// 一个人不会知道这一屏本来还能做这件事，
// 而那正是「终端比网页少东西」最没有症状的形态。
func (r *runner) hint(ctx Context) string {
	if len(r.actions) == 0 {
		return ""
	}
	parts := make([]string, 0, len(r.actions))
	for _, a := range r.actions {
		text := a.key + " " + a.label
		if missingScope(ctx, a) {
			text += "（没权限）"
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, " · ")
}

func sprint(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "是"
		}
		return "否"
	default:
		return itoaAny(x)
	}
}

func itoaAny(v any) string {
	if n, ok := v.(int); ok {
		return itoa(n)
	}
	return "—"
}
