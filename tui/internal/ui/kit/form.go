package kit

import (
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/theme"
)

/*
 * 一个按**服务端下发的字段表**画出来的表单。
 *
 * ═════════════════════════════════════════
 * 字段不是写死的，是问来的
 * ═════════════════════════════════════════
 *
 * 后台三十个分区、七十来个动作，每个动作要的字段都不一样。
 * 在 Go 这边为它们各写一份表单的话，后台加一个字段时
 * 那七十份里没有一份会知道 —— 而那正是这整套东西要防的退化。
 *
 * 所以 `/api/v1/admin/sections` 把 `fields` 一起发下来，
 * 这里照着画。后台加一个必填项，终端下一次启动就多一个输入框。
 */

// Field 是一个输入框。字段名和类型来自服务端。
type Field struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	// string / number / boolean
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// Form 是一组输入框加上「现在光标在第几个」。
type Form struct {
	Fields []Field
	values []string
	focus  int
	// 提交前的确认。危险动作用它
	confirming bool
	// 确认时显示的那句话
	ConfirmText string
}

func NewForm(fields []Field) *Form {
	return &Form{Fields: fields, values: make([]string, len(fields))}
}

func (f *Form) Focus() int { return f.focus }

// Confirming 是「正在等一次确认」。
func (f *Form) Confirming() bool { return f.confirming }

// AskConfirm 把表单切进确认态。
func (f *Form) AskConfirm(text string) {
	f.confirming = true
	f.ConfirmText = text
}

func (f *Form) CancelConfirm() { f.confirming = false }

// Missing 是还没填的必填项。
//
// 在**提交之前**报出来，而不是让服务端拒一次 ——
// 服务端那句话（「必须填写理由」）是对的，但它到达时
// 人已经按过一次提交，而且他不知道是哪一栏。
func (f *Form) Missing() []string {
	var out []string
	for i, fd := range f.Fields {
		if fd.Required && strings.TrimSpace(f.values[i]) == "" {
			out = append(out, fd.Label)
		}
	}
	return out
}

// Values 是拼给服务端的那个对象。
//
// ─────────────────────────────────────────
// 空的可选字段**不放进去**，而不是放一个空串
// ─────────────────────────────────────────
//
// 放空串的话，服务端收到的是「明确要把这一项设成空」——
// 而用户的意思是「这一项别动」。这个区别在改群配置那种
// 整体保存的动作上是会丢数据的。
func (f *Form) Values() map[string]any {
	out := map[string]any{}
	for i, fd := range f.Fields {
		raw := strings.TrimSpace(f.values[i])
		if raw == "" && !fd.Required {
			continue
		}
		switch fd.Type {
		case "number":
			if n, err := strconv.Atoi(raw); err == nil {
				out[fd.Name] = n
			}
		case "boolean":
			/*
			 * 布尔认「是 / y / true / 1」，其余都是假。
			 *
			 * 认得宽一点是因为这是中文界面而字段是英文的 ——
			 * 一个人在「算不算积分」那一栏里最可能敲的是「是」。
			 */
			lower := strings.ToLower(raw)
			out[fd.Name] = lower == "是" || lower == "y" || lower == "yes" ||
				lower == "true" || lower == "1"
		default:
			out[fd.Name] = raw
		}
	}
	return out
}

// Update 处理一次按键。返回 true 表示这次按键被表单吃掉了。
func (f *Form) Update(msg tea.KeyMsg) bool {
	if f.confirming {
		// 确认态下只认 y/n，别的键一律吞掉 —— 免得人以为自己在编辑
		return true
	}
	switch msg.String() {
	case "tab", "down":
		if len(f.Fields) > 0 {
			f.focus = (f.focus + 1) % len(f.Fields)
		}
		return true
	case "shift+tab", "up":
		if len(f.Fields) > 0 {
			f.focus = (f.focus + len(f.Fields) - 1) % len(f.Fields)
		}
		return true
	case "backspace":
		if f.focus < len(f.values) {
			r := []rune(f.values[f.focus])
			if len(r) > 0 {
				f.values[f.focus] = string(r[:len(r)-1])
			}
		}
		return true
	default:
		if len(msg.Runes) > 0 && f.focus < len(f.values) {
			f.values[f.focus] += string(msg.Runes)
			return true
		}
	}
	return false
}

// View 画出来。
func (f *Form) View(p theme.Palette, width int) string {
	var b strings.Builder

	if f.confirming {
		/*
		 * 确认那一屏**只显示要确认的事**，不显示表单。
		 *
		 * 表单还在旁边的话，人会一边读确认文案一边扫那些输入框，
		 * 而这一步存在的全部意义是让他停下来看清楚一件事。
		 */
		b.WriteString(p.Danger.Render("确认一下：") + "\n\n")
		for _, line := range strings.Split(f.ConfirmText, "\n") {
			b.WriteString(Truncate("  "+line, width, p.Ellipsis()) + "\n")
		}
		b.WriteString("\n" + p.Muted.Render("  y 确认  ·  n 取消"))
		return b.String()
	}

	for i, fd := range f.Fields {
		mark := "  "
		style := p.Muted
		if i == f.focus {
			mark = p.Accent.Render(p.Cursor()) + " "
			style = p.Accent
		}
		label := fd.Label
		if fd.Required {
			label += p.Danger.Render(" *")
		}
		value := f.values[i]
		if i == f.focus {
			value += "▏"
		}
		hint := ""
		switch fd.Type {
		case "number":
			hint = p.Faint.Render("  (数字)")
		case "boolean":
			hint = p.Faint.Render("  (是 / 否)")
		}
		b.WriteString(Truncate(mark+style.Render(label+"： ")+value+hint, width, p.Ellipsis()))
		b.WriteString("\n")
	}
	if len(f.Fields) == 0 {
		b.WriteString(p.Muted.Render("  这个动作不用填任何东西") + "\n")
	}
	return b.String()
}
