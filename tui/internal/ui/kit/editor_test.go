package kit

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func key(s string) tea.KeyMsg {
	switch s {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

func TestTypeAndSplitLines(t *testing.T) {
	e := NewEditor("")
	for _, s := range []string{"a", "b"} {
		e.Update(key(s))
	}
	e.Update(key("enter"))
	e.Update(key("c"))
	if got := e.Text(); got != "ab\nc" {
		t.Errorf("打出来的是 %q", got)
	}
}

func TestBackspaceDeletesWholeRune(t *testing.T) {
	/*
	 * 这个站的内容基本是中文。按字节删的话，一次退格会删掉
	 * 一个汉字的三分之一，屏幕上出现一个乱码方块 ——
	 * 而人只会觉得这个输入框坏了。
	 */
	e := NewEditor("")
	e.Update(key("中"))
	e.Update(key("文"))
	e.Update(key("backspace"))
	if got := e.Text(); got != "中" {
		t.Errorf("退一格之后是 %q，该是「中」", got)
	}
}

func TestBackspaceAtLineStartJoinsPreviousLine(t *testing.T) {
	/*
	 * 在行首退格 = 把这一行接到上一行末尾。
	 *
	 * 不做的话，一个空行删不掉 —— 人会一直按，
	 * 然后以为这个编辑器卡住了。
	 */
	e := NewEditor("第一行\n第二行")
	e.row, e.col = 1, 0
	e.Update(key("backspace"))
	if got := e.Text(); got != "第一行第二行" {
		t.Errorf("接起来之后是 %q", got)
	}
	if e.row != 0 || e.col != 3 {
		t.Errorf("光标落在 (%d,%d)，该落在第一行末尾 (0,3)", e.row, e.col)
	}
}

func TestMovingToShorterLineClampsColumn(t *testing.T) {
	/*
	 * 从一行长的移到一行短的，光标不夹住的话 col 会落在外面，
	 * 而下一次插入字符时会 panic —— 那是终端突然回到 shell。
	 */
	e := NewEditor("很长的一行\n短")
	e.row, e.col = 0, 5
	e.Update(key("down"))
	if e.col > 1 {
		t.Fatalf("光标 col=%d，超出了这一行的长度", e.col)
	}
	// 夹住之后打字不该崩
	e.Update(key("x"))
	if got := e.Text(); got != "很长的一行\n短x" {
		t.Errorf("打出来的是 %q", got)
	}
}

func TestDoesNotSwallowSubmitOrCancel(t *testing.T) {
	/*
	 * Ctrl+S 和 Esc 是外层的（提交 / 放弃）。编辑器吃掉的话，
	 * 一个人写到一半按 Esc 想退出，会发现按不动。
	 */
	e := NewEditor("x")
	if e.Update(tea.KeyMsg{Type: tea.KeyCtrlS}) {
		t.Error("Ctrl+S 被编辑器吃掉了 —— 那样就提交不了")
	}
	if e.Update(key("esc")) {
		t.Error("Esc 被编辑器吃掉了 —— 那样就退不出去")
	}
}

func TestEmptyEditorHasOneLine(t *testing.T) {
	// 零行的话，第一次打字会索引越界
	e := NewEditor("")
	if len(e.lines) != 1 {
		t.Fatalf("空编辑器有 %d 行，该有 1 行", len(e.lines))
	}
	e.Update(key("a"))
	if e.Text() != "a" {
		t.Error("空编辑器里打不进字")
	}
}
