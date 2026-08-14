package kit

import (
	"strings"
	"sync"

	"github.com/charmbracelet/glamour"

	"github.com/jmr/agenticlab/tui/internal/theme"
)

/*
 * Markdown 渲染。
 *
 * ═════════════════════════════════════════
 * 长文是这个站唯一「非读不可」的内容
 * ═════════════════════════════════════════
 *
 * 论坛里有代码块、有引用、有表格。按纯文本铺出来的话，
 * 一段带缩进的代码和一段正文长得一模一样 ——
 * 而「深潜」那一屏存在的全部理由就是让长文被读完。
 *
 * ─────────────────────────────────────────
 * 渲染器要缓存，而且要按**宽度**缓存
 * ─────────────────────────────────────────
 *
 * `glamour.NewTermRenderer` 每次要解析一遍样式表，几毫秒 ——
 * 而 Bubble Tea 的 View 在每一次按键后都会被调用。
 * 不缓存的话，按住方向键滚动会肉眼可见地卡。
 *
 * 按宽度缓存是因为窗口一改大小就要重新排版：
 * 缓存一个固定宽度的渲染器，结果是分栏之后正文还按老宽度换行，
 * 右边那一栏被撞散。
 */

var (
	rendererMu sync.Mutex
	renderers  = map[rendererKey]*glamour.TermRenderer{}
)

type rendererKey struct {
	width int
	dark  bool
	// 无色终端下 glamour 那套 ANSI 样式一个都不能用
	plain bool
}

// Markdown 把一段 markdown 渲染成终端能看的样子。
//
// 渲染不出来时**原样返回**，而不是报错：一段渲染失败的正文
// 仍然是可读的文字，而一句「渲染失败」什么都不是。
func Markdown(src string, p theme.Palette, width int) string {
	if strings.TrimSpace(src) == "" {
		return ""
	}
	if width < 20 {
		width = 20
	}

	caps := p.Caps()
	key := rendererKey{width: width, dark: caps.Dark, plain: caps.Color == theme.NoColor}

	rendererMu.Lock()
	r, ok := renderers[key]
	if !ok {
		var err error
		opts := []glamour.TermRendererOption{glamour.WithWordWrap(width)}
		if key.plain {
			/*
			 * 无色：用 notty 样式。
			 *
			 * 不是「把颜色去掉」—— notty 会把强调改成用**字符**表达
			 * （标题前加 #、粗体加星号），而那正是无色下唯一
			 * 还能表达层次的东西。
			 */
			opts = append(opts, glamour.WithStandardStyle("notty"))
		} else if key.dark {
			opts = append(opts, glamour.WithStandardStyle("dark"))
		} else {
			opts = append(opts, glamour.WithStandardStyle("light"))
		}
		r, err = glamour.NewTermRenderer(opts...)
		if err != nil {
			rendererMu.Unlock()
			return src
		}
		renderers[key] = r
	}
	rendererMu.Unlock()

	out, err := r.Render(src)
	if err != nil {
		return src
	}
	/*
	 * glamour 会在前后各加一行空白。
	 *
	 * 留着的话，一屏里每一条回复之间就有两行空 ——
	 * 而终端的行数是这个界面最稀缺的东西。
	 */
	return strings.Trim(out, "\n")
}
