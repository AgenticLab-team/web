package kit

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/theme"
)

/*
 * 一个能改多行的编辑器。
 *
 * ═════════════════════════════════════════
 * 它刻意**很小**
 * ═════════════════════════════════════════
 *
 * 终端里写长文这件事，一个自己搓的编辑器永远比不上 vim/nano ——
 * 而在这个站里，需要写长文的地方（发帖、编辑）恰好都是
 * 「人会认真坐下来写」的场合。
 *
 * 所以这里只做**够用**的那一档：光标能上下左右、能换行、能删。
 * 真要写长文的人按 Ctrl+E，我们把内容丢给 `$EDITOR`，
 * 他写完存盘退出，内容回来。那条路比任何自搓的编辑器都好。
 *
 * ─────────────────────────────────────────
 * 按 rune 存，不按字节
 * ─────────────────────────────────────────
 *
 * 这个站的内容基本是中文。按字节存的话，一次退格会删掉
 * 一个汉字的三分之一，屏幕上出现一个乱码方块 ——
 * 而人只会觉得这个输入框坏了。
 */

// Editor 是一块多行文本。
type Editor struct {
	lines [][]rune
	// 光标在第几行、第几个字符
	row, col int
	// 视窗从第几行开始
	top int
}

func NewEditor(initial string) *Editor {
	e := &Editor{}
	e.SetText(initial)
	return e
}

// SetText 整个换掉内容，光标回到开头。
func (e *Editor) SetText(s string) {
	e.lines = nil
	for _, l := range strings.Split(s, "\n") {
		e.lines = append(e.lines, []rune(l))
	}
	if len(e.lines) == 0 {
		e.lines = [][]rune{{}}
	}
	e.row, e.col, e.top = 0, 0, 0
}

// Text 是现在的内容。
func (e *Editor) Text() string {
	out := make([]string, len(e.lines))
	for i, l := range e.lines {
		out[i] = string(l)
	}
	return strings.Join(out, "\n")
}

// Empty 是「一个字都没写」。
func (e *Editor) Empty() bool { return strings.TrimSpace(e.Text()) == "" }

// Update 处理一次按键。返回 true 表示这次按键被吃掉了。
//
// **不吃 Ctrl+S 和 Esc** —— 那两个是外层的（提交 / 放弃）。
// 吃掉的话，一个人写到一半按 Esc 想退出，会发现按不动。
func (e *Editor) Update(msg tea.KeyMsg) bool {
	switch msg.String() {
	case "ctrl+s", "esc", "ctrl+c", "ctrl+e":
		return false

	case "enter":
		rest := append([]rune{}, e.lines[e.row][e.col:]...)
		e.lines[e.row] = e.lines[e.row][:e.col]
		e.lines = append(e.lines[:e.row+1], append([][]rune{rest}, e.lines[e.row+1:]...)...)
		e.row++
		e.col = 0

	case "backspace":
		switch {
		case e.col > 0:
			line := e.lines[e.row]
			e.lines[e.row] = append(line[:e.col-1], line[e.col:]...)
			e.col--
		case e.row > 0:
			/*
			 * 在行首退格 = 把这一行接到上一行末尾。
			 *
			 * 不做的话，一个空行删不掉 —— 而人会一直按，
			 * 然后以为这个编辑器卡住了。
			 */
			prev := e.lines[e.row-1]
			e.col = len(prev)
			e.lines[e.row-1] = append(prev, e.lines[e.row]...)
			e.lines = append(e.lines[:e.row], e.lines[e.row+1:]...)
			e.row--
		}

	case "left":
		if e.col > 0 {
			e.col--
		} else if e.row > 0 {
			e.row--
			e.col = len(e.lines[e.row])
		}
	case "right":
		if e.col < len(e.lines[e.row]) {
			e.col++
		} else if e.row < len(e.lines)-1 {
			e.row++
			e.col = 0
		}
	case "up":
		if e.row > 0 {
			e.row--
			e.clampCol()
		}
	case "down":
		if e.row < len(e.lines)-1 {
			e.row++
			e.clampCol()
		}
	case "home":
		e.col = 0
	case "end":
		e.col = len(e.lines[e.row])

	default:
		if len(msg.Runes) == 0 {
			return false
		}
		line := e.lines[e.row]
		next := make([]rune, 0, len(line)+len(msg.Runes))
		next = append(next, line[:e.col]...)
		next = append(next, msg.Runes...)
		next = append(next, line[e.col:]...)
		e.lines[e.row] = next
		e.col += len(msg.Runes)
	}
	return true
}

// clampCol 换行之后光标不能超出新行的长度。
//
// 不夹的话，从一行长的移到一行短的会让 col 落在外面，
// 而下一次插入字符时会 panic —— 那是终端突然回到 shell。
func (e *Editor) clampCol() {
	if e.col > len(e.lines[e.row]) {
		e.col = len(e.lines[e.row])
	}
}

// View 画出来。
func (e *Editor) View(p theme.Palette, width, height int) string {
	if height < 1 {
		height = 1
	}

	// 视窗跟着光标走，但尽量少动 —— 人是靠周围那几行认位置的
	if e.row < e.top {
		e.top = e.row
	}
	if e.row >= e.top+height {
		e.top = e.row - height + 1
	}
	if e.top < 0 {
		e.top = 0
	}

	var b strings.Builder
	for i := e.top; i < len(e.lines) && i < e.top+height; i++ {
		text := string(e.lines[i])
		if i == e.row {
			/*
			 * 光标画成一个字符插进去，而不是用终端的真光标。
			 *
			 * 真光标要算出它在屏幕上的绝对位置，而这一块是被
			 * 嵌在分栏布局里的 —— 算错一格，光标就会出现在别的栏里。
			 */
			r := e.lines[i]
			text = string(r[:e.col]) + "▏" + string(r[e.col:])
		}
		b.WriteString(Truncate(text, width, p.Ellipsis()))
		if i < e.top+height-1 && i < len(e.lines)-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// Status 是「第几行，共几行」。
//
// 长文里没有这个的话，人不知道自己在哪 —— 而这一块的高度
// 通常只有十几行，看不到整体。
func (e *Editor) Status() string {
	return "第 " + itoa(e.row+1) + " 行 / 共 " + itoa(len(e.lines)) + " 行"
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
