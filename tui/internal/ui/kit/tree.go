// Package kit 是画面上那几样共用的东西：可折叠的数据树、截断、换行。
package kit

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/mattn/go-runewidth"

	"github.com/jmr/agenticlab/tui/internal/theme"
)

/*
 * 把服务端返回的 JSON 铺成一棵能上下走、能折叠的树。
 *
 * ═════════════════════════════════════════
 * 为什么是「渲染 JSON」而不是「渲染结构体」
 * ═════════════════════════════════════════
 *
 * 因为这套东西要解决的问题是**时间上的**：网页那边加一个字段，
 * 终端要跟得上，而不是等下一次发版。
 *
 * 按结构体渲染的话，服务端多返回的字段在终端里**根本不存在** ——
 * 而这件事没有任何症状：屏幕看起来一切正常。
 *
 * 按 JSON 渲染的代价是它比手写的丑。那是值得的代价：
 * 「丑一点」看得见，「少一块」看不见。
 */

// Tree 是一份 JSON 加上「现在选中哪一行、哪些展开着」。
type Tree struct {
	/*
	 * 解析出来的那份数据要留着。
	 *
	 * ─────────────────────────────────────────
	 * 不留的话，展开和折叠**什么都不会发生**
	 * ─────────────────────────────────────────
	 *
	 * `rows` 是按当前的展开状态拍平出来的。改了展开状态之后
	 * 必须重新拍一遍 —— 而重新拍需要原始数据。
	 *
	 * 第一版只把 `open[path]` 翻了一下就完事，于是按回车
	 * 屏幕上一动不动。那种 bug 没有任何报错，看起来就是
	 * 「这个键没用」，而人会以为自己按错了。
	 */
	value any
	rows  []row
	// 展开的路径
	open   map[string]bool
	cursor int
}

type row struct {
	depth int
	// 完整路径，折叠状态按它记
	path string
	key  string
	// 叶子的值；容器为空
	value string
	// 容器才有：里面有几项
	count int
	// 这一行指向站里另一个东西吗
	linkTo     string
	linkParams map[string]string
}

// Parse 把一份 JSON 变成树。
func Parse(raw json.RawMessage) *Tree {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return &Tree{rows: []row{{key: "解析失败", value: err.Error()}}}
	}
	t := &Tree{open: map[string]bool{}, value: v}
	t.build("", "", v, 0)
	/*
	 * 顶层默认展开。
	 *
	 * 全部折叠的话，第一屏是一行 `{...}` —— 人要按好几次才看到内容，
	 * 而他刚进这一屏时并不知道该按什么。
	 */
	for _, r := range t.rows {
		if r.depth == 0 {
			t.open[r.path] = true
		}
	}
	t.rebuild()
	return t
}

func (t *Tree) build(path, key string, v any, depth int) {
	switch val := v.(type) {
	case map[string]any:
		t.rows = append(t.rows, row{
			depth: depth, path: path, key: key, count: len(val),
			linkTo: linkFor(val), linkParams: linkParamsFor(val),
		})
		if !t.open[path] && path != "" {
			return
		}
		for _, k := range sortedKeys(val) {
			t.build(path+"/"+k, k, val[k], depth+1)
		}
	case []any:
		t.rows = append(t.rows, row{depth: depth, path: path, key: key, count: len(val)})
		if !t.open[path] && path != "" {
			return
		}
		for i, item := range val {
			t.build(fmt.Sprintf("%s/%d", path, i), fmt.Sprintf("[%d]", i), item, depth+1)
		}
	default:
		t.rows = append(t.rows, row{depth: depth, path: path, key: key, value: scalar(v)})
	}
}

// rebuild 按当前的展开状态重新拍平。
func (t *Tree) rebuild() {
	t.rows = nil
	t.build("", "", t.value, 0)
	/*
	 * 行数变了，游标可能落在外面。不夹住的话下一次渲染会越界 ——
	 * 而那是一次崩溃，用户看到的是终端突然回到 shell。
	 */
	if t.cursor >= len(t.rows) {
		t.cursor = len(t.rows) - 1
	}
	if t.cursor < 0 {
		t.cursor = 0
	}
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	/*
	 * 排序而不是保持 JSON 里的顺序。
	 *
	 * Go 的 map 遍历顺序是随机的，不排的话**同一份数据每次
	 * 渲染出来的行序都不一样** —— 而人正靠位置记住某一行在哪。
	 */
	sort.Strings(keys)
	return keys
}

func scalar(v any) string {
	switch x := v.(type) {
	case nil:
		return "—"
	case bool:
		if x {
			return "是"
		}
		return "否"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	case string:
		return x
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

/*
 * ── 跨屏跳转 ────────────────────────────────────────────
 *
 * 「聊着聊着想看这个人的主页，从主页进他的帖子」——
 * 这条路径靠的是**数据里带着 id**，而不是每一屏各写一遍跳转。
 *
 * 所以这里认几个约定的字段名。认不出就不给跳转，
 * 而不是猜一个 —— 跳错地方比不能跳糟得多。
 */
func linkFor(m map[string]any) string {
	switch {
	case has(m, "wx_id"):
		return "community/person"
	case has(m, "post_id"):
		return "forum/post"
	case has(m, "conv_id") && has(m, "name"):
		return "chat/live"
	case has(m, "owner") && has(m, "repo"):
		return "community/repo"
	}
	/*
	 * 帖子列表里的元素通常是 `{id, title, board, …}`。
	 * 光有 `id` 不够（什么都有 id），要 `title` 一起在才算。
	 */
	if has(m, "id") && has(m, "title") && has(m, "board") {
		return "forum/post"
	}
	return ""
}

func linkParamsFor(m map[string]any) map[string]string {
	out := map[string]string{}
	for _, k := range []string{"wx_id", "post_id", "conv_id", "owner", "repo", "id"} {
		if s, ok := m[k].(string); ok && s != "" {
			out[k] = s
		}
	}
	return out
}

func has(m map[string]any, k string) bool {
	v, ok := m[k]
	if !ok {
		return false
	}
	s, isStr := v.(string)
	return !isStr || s != ""
}

// Up / Down / Toggle / Collapse 是键盘操作。
func (t *Tree) Up() {
	if t.cursor > 0 {
		t.cursor--
	}
}

func (t *Tree) Down() {
	if t.cursor < len(t.rows)-1 {
		t.cursor++
	}
}

// Toggle 展开或折叠当前行。
func (t *Tree) Toggle() {
	if t.cursor >= len(t.rows) {
		return
	}
	r := t.rows[t.cursor]
	if r.count == 0 {
		return
	}
	t.open[r.path] = !t.open[r.path]
	t.rebuild()
}

// Collapse 折叠当前行。已经是叶子/已折叠时返回 false ——
// 外层据此把「左」当成「返回上一屏」，这是 Discord 那种
// 「一路往回退」的手感。
func (t *Tree) Collapse() bool {
	if t.cursor >= len(t.rows) {
		return false
	}
	r := t.rows[t.cursor]
	if r.count > 0 && t.open[r.path] {
		t.open[r.path] = false
		t.rebuild()
		return true
	}
	return false
}

// Link 是「当前这一行指向哪」。
func (t *Tree) Link() (string, map[string]string) {
	if t.cursor >= len(t.rows) {
		return "", nil
	}
	r := t.rows[t.cursor]
	return r.linkTo, r.linkParams
}

// Params 是当前这一行所在的那个对象上的 id 们。
//
// ═════════════════════════════════════════
// 它往上找，而不是只看当前这一行
// ═════════════════════════════════════════
//
// 光标停在 `title: 某某链接` 这一行上时，人的意思是
// 「对这条链接做点什么」—— 而 id 在它的**父对象**上，
// 不在这一行上。
//
// 只看当前行的话，一个人必须先把光标移到那个折叠标题上
// 才能操作，而屏幕上没有任何东西提示他这一点。
func (t *Tree) Params() map[string]string {
	if t.cursor >= len(t.rows) {
		return nil
	}
	cur := t.rows[t.cursor]
	if len(cur.linkParams) > 0 {
		return cur.linkParams
	}

	/*
	 * ─────────────────────────────────────────
	 * 只认**祖先**，不认前面那个兄弟
	 * ─────────────────────────────────────────
	 *
	 * 行是拍平的，孩子紧跟在父亲后面。所以从一片叶子往上走，
	 * 第一个 `depth` 比它小的行就是它的父亲。
	 *
	 * 而如果不看 depth、只要「往上第一个带 id 的行」，
	 * 就会走到**前一个兄弟对象的头**上 —— 比如资源库里
	 * 光标停在第二条链接的某个字段上，拿到的是第一条链接的 id。
	 *
	 * 那种错最坏：动作成功了，只是作用在错的对象上。
	 */
	depth := cur.depth
	for i := t.cursor - 1; i >= 0; i-- {
		r := t.rows[i]
		if r.depth >= depth {
			continue // 同级或更深 —— 是兄弟或兄弟的孩子，跳过
		}
		depth = r.depth
		if len(r.linkParams) > 0 {
			return r.linkParams
		}
	}
	return nil
}

// View 画出来。
func (t *Tree) View(p theme.Palette, width, height int) string {
	if len(t.rows) == 0 {
		return p.Muted.Render("空的")
	}
	if height < 1 {
		height = 1
	}

	/*
	 * 视窗跟着游标走，但**尽量少动**。
	 *
	 * 每次都把游标居中的话，按一下方向键整屏都在滚 ——
	 * 而人是靠周围那几行认位置的。
	 */
	start := t.cursor - height/2
	if start < 0 {
		start = 0
	}
	if start+height > len(t.rows) {
		start = len(t.rows) - height
		if start < 0 {
			start = 0
		}
	}

	var b strings.Builder
	for i := start; i < len(t.rows) && i < start+height; i++ {
		r := t.rows[i]
		selected := i == t.cursor

		prefix := "  "
		if selected {
			prefix = p.Accent.Render(p.Cursor()) + " "
		}

		indent := strings.Repeat("  ", r.depth)
		var label string
		switch {
		case r.count > 0:
			mark := "+"
			if t.open[r.path] {
				mark = "-"
			}
			name := r.key
			if name == "" {
				name = "结果"
			}
			label = p.Accent.Render(mark+" "+name) + p.Faint.Render(fmt.Sprintf(" (%d)", r.count))
			if r.linkTo != "" {
				// 能跳的行标出来 —— 不标的话没有人会去按回车
				label += p.Faint.Render(" ↵")
			}
		case r.key == "":
			label = p.Ink.Render(r.value)
		default:
			label = p.Muted.Render(r.key+": ") + p.Ink.Render(r.value)
		}

		line := prefix + indent + label
		b.WriteString(Truncate(line, width, p.Ellipsis()))
		if i < start+height-1 && i < len(t.rows)-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// Truncate 按**显示宽度**截断，不是按字节也不是按 rune 数。
//
// 中文一个字占两格。按 rune 数截的话，一行中文会超出去一倍宽 ——
// 而超出去的部分会把布局撞散，右边那一栏整个错位。
func Truncate(s string, width int, ellipsis string) string {
	if width <= 0 {
		return ""
	}
	// 先剥掉 ANSI 转义再量宽度，否则颜色码会被算进去
	if runewidth.StringWidth(stripANSI(s)) <= width {
		return s
	}
	return runewidth.Truncate(s, width, ellipsis)
}

func stripANSI(s string) string {
	var b strings.Builder
	inEscape := false
	for _, r := range s {
		switch {
		case r == 0x1b:
			inEscape = true
		case inEscape:
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				inEscape = false
			}
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
