// Package ui 是外壳：最左那一竖、频道栏、主区，以及把它们连起来的导航栈。
package ui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/theme"
	"github.com/jmr/agenticlab/tui/internal/ui/kit"
	"github.com/jmr/agenticlab/tui/internal/ui/screens"
)

/*
 * Discord 式三栏，窄终端逐级折叠。
 *
 * ═════════════════════════════════════════
 * 断点按**列数**，不按「是不是手机」
 * ═════════════════════════════════════════
 *
 *   ≥ 120 列                    80–119 列              < 80 列
 *   ┌──┬────┬──────────┬────┐  ┌────┬──────────┐      ┌──────────┐
 *   │服│频道│   主区    │详情│  │频道│   主区    │      │   主区    │
 *   └──┴────┴──────────┴────┘  └────┴──────────┘      └──────────┘
 *                               详情进 Tab             频道栏进 Ctrl+K
 *
 * 一个分屏到 60 列的 iTerm 和一个 60 列的手机 SSH 客户端
 * 需要的是同一套布局 —— 所以判据只有宽度。
 */

const (
	railWidth    = 6
	channelWidth = 18
	detailWidth  = 28
)

// Model 是整个终端。
type Model struct {
	ctx   screens.Context
	caps  theme.Caps
	theme theme.Palette

	// 当前在哪个分区（最左那一竖）
	board int
	// 分区里选中第几屏
	channel int

	// 导航栈。跳转压栈，Esc 弹栈 ——
	// 「人 → 主页 → 帖子 → GitHub」那条路径靠它一路退回来
	stack []frame

	status    string
	statusErr bool
	// 命令面板（Ctrl+K）
	palette     bool
	paletteText string

	// SSH 会话里有些键不该有效（比如「用浏览器打开」）——
	// 网关那台机器上没有浏览器，按下去只会静默失败
	overSSH bool

	/*
	 * 未读数。它常驻在最左那一竖的「我的」那一格上。
	 *
	 * -1 表示「还不知道」—— 和 0 分开：显示一个 0 意味着
	 * 「确实没有未读」，而实际可能只是流还没连上。
	 */
	unread int

	quitting bool
}

type frame struct {
	id     string
	params screens.Params
	screen screens.Screen
}

// New 建一个外壳，落在群聊那一屏上。
func New(ctx screens.Context, caps theme.Caps, overSSH bool) Model {
	m := Model{
		ctx:     ctx,
		caps:    caps,
		theme:   ctx.Theme,
		overSSH: overSSH,
		unread:  -1,
	}
	m.push("chat/live", nil)
	return m
}

func (m *Model) push(id string, params screens.Params) tea.Cmd {
	s := screens.New(id, m.ctx, params)
	m.stack = append(m.stack, frame{id: id, params: params, screen: s})
	m.syncNav(id)
	return s.Init()
}

// syncNav 让最左那一竖跟着当前屏走。
//
// 不同步的话，从群聊里点进一个人的主页之后，左边还高亮着「群聊」——
// 而人是靠那一竖判断自己在哪的。
func (m *Model) syncNav(id string) {
	s := surface.ByScreen(id)
	if s == nil {
		return
	}
	for bi, b := range surface.Boards {
		if b.Key != s.Board {
			continue
		}
		m.board = bi
		for ci, item := range surface.InBoard(b.Key) {
			if item.Screen == id {
				m.channel = ci
			}
		}
		return
	}
}

func (m *Model) top() *frame {
	if len(m.stack) == 0 {
		return nil
	}
	return &m.stack[len(m.stack)-1]
}

func (m Model) Init() tea.Cmd {
	/*
	 * 通知流从启动就连着，一直到退出 —— 不管人在哪一屏。
	 *
	 * 挂在「通知」那一屏上的话，人只有站在那一屏时才收得到，
	 * 而那正好是他最不需要提醒的时候。
	 */
	cmds := []tea.Cmd{screens.SubscribeLive(m.ctx)}
	if f := m.top(); f != nil {
		cmds = append(cmds, f.screen.Init())
	}
	return tea.Batch(cmds...)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.caps.Width = msg.Width
		m.caps.Height = msg.Height
		return m, nil

	case screens.NavigateMsg:
		cmd := m.push(msg.Screen, msg.Params)
		return m, cmd

	case screens.BackMsg:
		if len(m.stack) > 1 {
			m.stack = m.stack[:len(m.stack)-1]
			m.syncNav(m.top().id)
		}
		return m, nil

	case screens.StatusMsg:
		m.status = msg.Text
		m.statusErr = msg.Err
		return m, nil

	case screens.LiveBatch:
		/*
		 * 一条 SSE 事件加上「接着听下一条」。
		 *
		 * 不把 next 排回去的话，流只收得到第一条 —— 而那种 bug
		 * 看起来像是「实时通知偶尔不工作」，最难查的一类。
		 */
		msgs, next := msg.Unwrap()
		var cmds []tea.Cmd
		for _, inner := range msgs {
			var cmd tea.Cmd
			var updated tea.Model
			updated, cmd = m.Update(inner)
			m = updated.(Model)
			cmds = append(cmds, cmd)
		}
		cmds = append(cmds, next)
		return m, tea.Batch(cmds...)

	case screens.UnreadMsg:
		m.unread = msg.Count
		return m, nil

	case screens.LiveNotificationMsg:
		/*
		 * 补漏回放出来的那些**不逐条弹**。
		 *
		 * 断线一小时之后回来，服务端会把这期间的都送过来 ——
		 * 一条一条弹是刷屏，不是提醒。角标已经变了，
		 * 人想看的时候去那一屏就好。
		 */
		if msg.Replay {
			return m, nil
		}
		m.status = "🔔 " + msg.Title
		m.statusErr = false
		return m, nil

	case tea.KeyMsg:
		if m.palette {
			return m.updatePalette(msg)
		}
		if cmd, handled := m.globalKey(msg); handled {
			return m, cmd
		}
	}

	if f := m.top(); f != nil {
		s, cmd := f.screen.Update(msg)
		f.screen = s
		return m, cmd
	}
	return m, nil
}

// globalKey 是不管在哪一屏都生效的那几个键。
//
// ─────────────────────────────────────────
// 它必须**让位给正在输入的屏**
// ─────────────────────────────────────────
//
// 群聊那一屏里，每一个可打印字符都是在打字。
// 把 `k` 抢来当「上一屏」的话，一个人打不出「ok」——
// 而他不会怀疑是快捷键，只会觉得键盘坏了。
//
// 所以这里只留**带修饰键的**和 Esc/Tab 这类明确不是字符的。
func (m *Model) globalKey(k tea.KeyMsg) (tea.Cmd, bool) {
	switch k.String() {
	case "ctrl+c":
		m.quitting = true
		return tea.Quit, true
	case "ctrl+k":
		m.palette = true
		m.paletteText = ""
		return nil, true
	case "esc":
		if len(m.stack) > 1 {
			m.stack = m.stack[:len(m.stack)-1]
			m.syncNav(m.top().id)
			return nil, true
		}
		return nil, false
	case "ctrl+n":
		m.cycleBoard(1)
		return m.openCurrent(), true
	case "ctrl+p":
		m.cycleBoard(-1)
		return m.openCurrent(), true
	}
	return nil, false
}

func (m *Model) cycleBoard(delta int) {
	m.board = (m.board + delta + len(surface.Boards)) % len(surface.Boards)
	m.channel = 0
}

func (m *Model) openCurrent() tea.Cmd {
	items := surface.InBoard(surface.Boards[m.board].Key)
	if len(items) == 0 {
		return nil
	}
	if m.channel >= len(items) {
		m.channel = 0
	}
	return m.push(items[m.channel].Screen, nil)
}

/*
 * ── 命令面板 ────────────────────────────────────────────
 *
 * Ctrl+K。它是窄终端下**唯一完整的导航**（那时候频道栏没地方画），
 * 也是宽终端下最快的那条 —— 六十来屏，用方向键找是找不动的。
 */

func (m Model) updatePalette(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "esc", "ctrl+k":
		m.palette = false
		return m, nil
	case "enter":
		hits := m.paletteHits()
		if len(hits) > 0 {
			m.palette = false
			cmd := m.push(hits[0].Screen, nil)
			return m, cmd
		}
		return m, nil
	case "backspace":
		r := []rune(m.paletteText)
		if len(r) > 0 {
			m.paletteText = string(r[:len(r)-1])
		}
	default:
		if len(k.Runes) > 0 {
			m.paletteText += string(k.Runes)
		}
	}
	return m, nil
}

func (m Model) paletteHits() []surface.Surface {
	q := strings.ToLower(strings.TrimSpace(m.paletteText))
	var out []surface.Surface
	for _, s := range surface.Surfaces {
		if s.Screen == "" || !screens.Has(s.Screen) {
			continue
		}
		if q == "" || strings.Contains(strings.ToLower(s.Label), q) ||
			strings.Contains(strings.ToLower(s.Screen), q) {
			out = append(out, s)
		}
	}
	return out
}

func (m Model) View() string {
	if m.quitting {
		return ""
	}
	p := m.theme
	w, h := m.caps.Width, m.caps.Height

	if m.palette {
		return m.paletteView(w, h)
	}

	// 底部两行：面包屑 + 状态
	bodyHeight := h - 2
	if bodyHeight < 3 {
		bodyHeight = 3
	}

	var cols []string
	mainWidth := w

	if m.caps.ThreeColumn() {
		cols = append(cols, m.railView(bodyHeight))
		cols = append(cols, m.channelView(bodyHeight))
		mainWidth = w - railWidth - channelWidth - detailWidth - 3
	} else if m.caps.TwoColumn() {
		cols = append(cols, m.channelView(bodyHeight))
		mainWidth = w - channelWidth - 1
	}
	if mainWidth < 20 {
		mainWidth = 20
	}

	main := ""
	if f := m.top(); f != nil {
		main = f.screen.View(mainWidth, bodyHeight)
	}
	cols = append(cols, padBlock(main, mainWidth, bodyHeight))

	if m.caps.ThreeColumn() {
		cols = append(cols, m.detailView(bodyHeight))
	}

	var b strings.Builder
	b.WriteString(joinColumns(p, cols, bodyHeight))
	b.WriteString("\n")
	b.WriteString(kit.Truncate(m.breadcrumb(), w, p.Ellipsis()))
	b.WriteString("\n")
	b.WriteString(kit.Truncate(m.statusLine(w), w, p.Ellipsis()))
	return b.String()
}

// railView 是最左那一竖：分区。
func (m Model) railView(height int) string {
	p := m.theme
	lines := make([]string, 0, height)
	for i, b := range surface.Boards {
		label := b.Label
		/*
		 * 未读数挂在「我的」那一格上 —— 通知屏在那个分区底下。
		 *
		 * 挂在通知那一行上的话，人要先切到那个分区才看得见 ——
		 * 而角标存在的意义正是「不用切过去也知道有事」。
		 */
		if b.Key == "me" && m.unread > 0 {
			label += p.Danger.Render(" " + itoa(m.unread))
		}
		if i == m.board {
			lines = append(lines, p.Accent.Render(p.Cursor()+label))
		} else {
			lines = append(lines, " "+p.Muted.Render(label))
		}
	}
	return padBlock(strings.Join(lines, "\n"), railWidth, height)
}

// channelView 是当前分区下的那几屏。
func (m Model) channelView(height int) string {
	p := m.theme
	items := surface.InBoard(surface.Boards[m.board].Key)
	lines := make([]string, 0, len(items))
	for i, s := range items {
		mark := "  "
		style := p.Muted
		if i == m.channel {
			mark = p.Accent.Render(p.Cursor()) + " "
			style = p.Ink
		}
		lines = append(lines, kit.Truncate(mark+style.Render(s.Label), channelWidth, p.Ellipsis()))
	}
	return padBlock(strings.Join(lines, "\n"), channelWidth, height)
}

// detailView 是最右那一栏。
//
// 它现在放的是「这一屏要什么权限、你有没有」——
// 因为那是终端里最容易让人卡住、而又最难自己查清楚的一件事。
func (m Model) detailView(height int) string {
	p := m.theme
	f := m.top()
	if f == nil {
		return padBlock("", detailWidth, height)
	}
	s := surface.ByScreen(f.id)
	if s == nil {
		return padBlock("", detailWidth, height)
	}

	var lines []string
	lines = append(lines, p.Muted.Render("这一屏要"))
	for _, sc := range s.Scopes {
		spec := surface.ScopeByKey(sc)
		if surface.HasScope(m.ctx.Scopes, sc) {
			lines = append(lines, p.Good.Render("✓ ")+p.Faint.Render(spec.Label))
		} else {
			lines = append(lines, p.Danger.Render("✗ ")+p.Faint.Render(spec.Label))
		}
	}
	if len(s.OptionalScopes) > 0 {
		lines = append(lines, "", p.Muted.Render("某些动作还要"))
		for _, sc := range s.OptionalScopes {
			spec := surface.ScopeByKey(sc)
			if surface.HasScope(m.ctx.Scopes, sc) {
				lines = append(lines, p.Good.Render("✓ ")+p.Faint.Render(spec.Label))
			} else {
				lines = append(lines, p.Faint.Render("· "+spec.Label))
			}
		}
	}
	for i := range lines {
		lines[i] = kit.Truncate(lines[i], detailWidth, p.Ellipsis())
	}
	return padBlock(strings.Join(lines, "\n"), detailWidth, height)
}

// breadcrumb 是导航栈那一行。
//
// 它存在的理由是**让人知道 Esc 会退到哪**：
// 「群聊 › 张三 › 那篇帖子」比一个孤零零的标题说得多得多。
func (m Model) breadcrumb() string {
	p := m.theme
	parts := make([]string, 0, len(m.stack))
	for i, f := range m.stack {
		title := f.screen.Title()
		if i == len(m.stack)-1 {
			parts = append(parts, p.Accent.Render(title))
		} else {
			parts = append(parts, p.Faint.Render(title))
		}
	}
	sep := p.Faint.Render(" › ")
	crumb := strings.Join(parts, sep)
	if len(m.stack) > 1 {
		crumb += p.Faint.Render("   Esc 退回")
	}
	return crumb
}

func (m Model) statusLine(width int) string {
	p := m.theme
	if m.status != "" {
		if m.statusErr {
			return p.Danger.Render(m.status)
		}
		return p.Muted.Render(m.status)
	}
	keys := "Ctrl+K 找东西 · Ctrl+N/P 换分区 · Esc 退回 · Ctrl+C 退出"
	if m.caps.OneColumn() {
		// 窄屏放不下全部，留最要紧的那个
		keys = "Ctrl+K 找东西 · Esc 退回"
	}
	return p.Faint.Render(keys)
}

func (m Model) paletteView(width, height int) string {
	p := m.theme
	var b strings.Builder
	b.WriteString(p.Accent.Render("跳到： ") + m.paletteText + "▏\n\n")
	hits := m.paletteHits()
	for i, s := range hits {
		if i >= height-4 {
			break
		}
		mark := "  "
		if i == 0 {
			mark = p.Accent.Render(p.Cursor()) + " "
		}
		board := ""
		for _, bd := range surface.Boards {
			if bd.Key == s.Board {
				board = bd.Label
			}
		}
		line := mark + s.Label + p.Faint.Render("  "+board)
		b.WriteString(kit.Truncate(line, width, p.Ellipsis()) + "\n")
	}
	if len(hits) == 0 {
		b.WriteString(p.Muted.Render("没有匹配的"))
	}
	return b.String()
}

/* ── 排版小工具 ──────────────────────────────────────── */

// padBlock 把一块内容补成固定的宽高。
//
// 不补的话，右边那一栏会跟着左边内容的行数上下跳 ——
// 而人正靠位置记住某一行在哪。
func padBlock(s string, width, height int) string {
	lines := strings.Split(s, "\n")
	for len(lines) < height {
		lines = append(lines, "")
	}
	if len(lines) > height {
		lines = lines[:height]
	}
	return strings.Join(lines, "\n")
}

func joinColumns(p theme.Palette, cols []string, height int) string {
	if len(cols) == 1 {
		return cols[0]
	}
	split := make([][]string, len(cols))
	for i, c := range cols {
		split[i] = strings.Split(c, "\n")
	}
	var b strings.Builder
	for row := 0; row < height; row++ {
		for i := range cols {
			if i > 0 {
				b.WriteString(p.Faint.Render(p.VLine()))
			}
			if row < len(split[i]) {
				b.WriteString(split[i][row])
			}
		}
		if row < height-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// itoa 不用 strconv：这里只会是一个小整数，而
// 未读数上千时显示成 `999+` 比一个五位数有用得多。
func itoa(n int) string {
	if n > 999 {
		return "999+"
	}
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
