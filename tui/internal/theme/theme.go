package theme

import "github.com/charmbracelet/lipgloss"

/*
 * 调色板与边框。
 *
 * ═════════════════════════════════════════
 * 四套颜色，而**无色那一套要单独设计**
 * ═════════════════════════════════════════
 *
 * 前三套（真彩、256、16）是同一个设计的三次量化，做法一样：
 * 给每个语义色一个各档的取值，lipgloss 自己挑。
 *
 * 无色那一套不是「把颜色去掉」——去掉之后所有层次一起消失，
 * 屏幕变成一堵没有结构的字墙。它靠的是另外三样：
 *   · 留白（分区之间空一行，而不是靠底色分开）
 *   * 字符密度（选中那一行前面加 `▎`，而不是反色）
 *   · 粗体与下划线（终端在无色下仍然认这两个属性）
 *
 * 所以下面每个语义色都配了一个 `plain` 字段：无色下该用什么**字符**。
 */

// Palette 是一次探测结果对应的那一套颜色。
type Palette struct {
	caps Caps

	// 主文字
	Ink lipgloss.Style
	// 次要说明
	Muted lipgloss.Style
	// 更淡的一档：时间戳、计数
	Faint lipgloss.Style
	// 强调（选中项、当前分区）
	Accent lipgloss.Style
	// 成功 / 已完成
	Good lipgloss.Style
	// 要注意但不危险
	Warn lipgloss.Style
	// 危险、不可逆
	Danger lipgloss.Style
	// 自己说的话 —— 群聊里要一眼分得出
	Mine lipgloss.Style
	// 代发署名那一行
	Attribution lipgloss.Style
}

// New 按探测结果给出一套样式。
//
// 无色终端下每一个 Style 都是**空的**（不带任何颜色属性），
// 而不是「带着颜色但终端忽略它」——后者会让 lipgloss 仍然
// 往输出里写转义序列，管道和 CI 日志里就全是乱码。
func New(c Caps) Palette {
	p := Palette{caps: c}
	if c.Color == NoColor {
		// 无色：只留粗体和下划线这两个终端普遍认的属性
		p.Ink = lipgloss.NewStyle()
		p.Muted = lipgloss.NewStyle()
		p.Faint = lipgloss.NewStyle().Faint(true)
		p.Accent = lipgloss.NewStyle().Bold(true)
		p.Good = lipgloss.NewStyle().Bold(true)
		p.Warn = lipgloss.NewStyle().Bold(true)
		p.Danger = lipgloss.NewStyle().Bold(true).Underline(true)
		p.Mine = lipgloss.NewStyle().Bold(true)
		p.Attribution = lipgloss.NewStyle().Faint(true)
		return p
	}

	pick := func(trueColor, ansi256, ansi16 string) lipgloss.Color {
		switch c.Color {
		case TrueColor:
			return lipgloss.Color(trueColor)
		case Ansi256:
			return lipgloss.Color(ansi256)
		default:
			return lipgloss.Color(ansi16)
		}
	}

	if c.Dark {
		p.Ink = lipgloss.NewStyle().Foreground(pick("#e6e6e6", "254", "7"))
		p.Muted = lipgloss.NewStyle().Foreground(pick("#9aa0a6", "245", "7"))
		p.Faint = lipgloss.NewStyle().Foreground(pick("#6b7075", "240", "8"))
		p.Accent = lipgloss.NewStyle().Foreground(pick("#7aa2f7", "111", "4")).Bold(true)
		p.Good = lipgloss.NewStyle().Foreground(pick("#9ece6a", "150", "2"))
		p.Warn = lipgloss.NewStyle().Foreground(pick("#e0af68", "179", "3"))
		p.Danger = lipgloss.NewStyle().Foreground(pick("#f7768e", "204", "1"))
		p.Mine = lipgloss.NewStyle().Foreground(pick("#bb9af7", "141", "5"))
	} else {
		/*
		 * 浅色那一套不是把深色反过来。
		 *
		 * 直接反色的结果是一堆在白底上**对比度不够**的字 ——
		 * 尤其 `Faint`：深色下的 #6b7075 在白底上实测只有 3:1，
		 * 而那正是时间戳和计数用的颜色，屏幕上到处都是。
		 */
		p.Ink = lipgloss.NewStyle().Foreground(pick("#1f2328", "234", "0"))
		p.Muted = lipgloss.NewStyle().Foreground(pick("#57606a", "241", "0"))
		p.Faint = lipgloss.NewStyle().Foreground(pick("#6e7781", "243", "8"))
		p.Accent = lipgloss.NewStyle().Foreground(pick("#0969da", "26", "4")).Bold(true)
		p.Good = lipgloss.NewStyle().Foreground(pick("#1a7f37", "28", "2"))
		p.Warn = lipgloss.NewStyle().Foreground(pick("#9a6700", "94", "3"))
		p.Danger = lipgloss.NewStyle().Foreground(pick("#cf222e", "160", "1"))
		p.Mine = lipgloss.NewStyle().Foreground(pick("#8250df", "98", "5"))
	}

	/*
	 * 代发署名那一行永远是最淡的一档。
	 *
	 * 它出现在**每一条**代发消息下面，而它的作用是「需要的时候查得到」，
	 * 不是「一直提醒你」。用正常字重的话，一屏聊天里一半的行是署名。
	 */
	p.Attribution = p.Faint.Italic(true)
	return p
}

func (p Palette) Caps() Caps { return p.caps }

/*
 * ── 边框 ──────────────────────────────────────────────
 *
 * 认不认识 Unicode 决定用哪一套。ASCII 那套不好看，
 * 但它在一个画不出框线的终端上是**唯一读得懂的**东西 ——
 * 那种终端上 Unicode 框线会显示成一串问号或者乱码方块，
 * 而那比 `+---+` 难认得多。
 */

func (p Palette) Border() lipgloss.Border {
	if p.caps.Unicode {
		return lipgloss.RoundedBorder()
	}
	return lipgloss.Border{
		Top: "-", Bottom: "-", Left: "|", Right: "|",
		TopLeft: "+", TopRight: "+", BottomLeft: "+", BottomRight: "+",
	}
}

// VLine 是分栏之间那一竖。
func (p Palette) VLine() string {
	if p.caps.Unicode {
		return "│"
	}
	return "|"
}

// Bullet 是列表项前面那个点。
func (p Palette) Bullet() string {
	if p.caps.Unicode {
		return "·"
	}
	return "*"
}

// Cursor 是「当前选中的这一行」的记号。
//
// 无色终端下它是唯一的选中提示，所以**不能省**：
// 反色在无色下不可靠（一部分终端把它渲染成什么都不做）。
func (p Palette) Cursor() string {
	if p.caps.Unicode {
		return "▎"
	}
	return ">"
}

// Ellipsis 是截断记号。ASCII 下用三个点而不是一个 `…` ——
// 后者在窄字体里会占两格，把本来就紧的一行再挤掉一格。
func (p Palette) Ellipsis() string {
	if p.caps.Unicode {
		return "…"
	}
	return "..."
}
