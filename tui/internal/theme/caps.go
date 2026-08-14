// Package theme 回答四个互相独立的问题：这个终端有多少颜色、
// 背景是深是浅、认不认识宽字符、有多宽。
//
// ═════════════════════════════════════════
// 四件事分开探，分开降级
// ═════════════════════════════════════════
//
// 把它们合成一个「终端好不好」的等级是很自然的做法，也是错的：
// tmux 里常见的是「颜色只有 256、但 Unicode 完全没问题」，
// 而 Windows 的一部分终端恰好相反。合成一个等级的话，
// 其中一半人会白白拿到一个降级过头的界面。
package theme

import (
	"os"
	"strings"
)

// ColorDepth 是这个终端能表达多少颜色。
type ColorDepth int

const (
	// NoColor 是**要认真做的一档**，不是应付了事的兜底。
	//
	// 管道、`script` 录制、CI 日志、以及一部分 Windows 终端会落到这里。
	// 在无色下唯一还能表达层次的只有留白和字符密度 ——
	// 所以布局本身要在没有颜色时依然读得懂，
	// 不能靠「反正没人用」蒙过去。
	NoColor ColorDepth = iota
	Ansi16
	Ansi256
	TrueColor
)

// Caps 是一次探测的结果。它在启动时算一次，之后跟着 SIGWINCH 更新尺寸。
type Caps struct {
	Color ColorDepth
	// 背景是不是深色。探不到就当**深色** —— 终端的多数派
	Dark bool
	// 画不画得了 ─ │ ┌ 这一类框线和 emoji
	Unicode bool
	Width   int
	Height  int
}

// 三档宽度断点。判据是**列数**，不是「是不是手机」——
// 一个分屏到 60 列的 iTerm 和一个 60 列的手机 SSH 客户端
// 需要的是同一套布局。
const (
	// 三栏：服务器条 + 频道栏 + 主区 + 成员/详情栏
	WideAt = 120
	// 两栏：频道栏 + 主区
	MediumAt = 80
)

func (c Caps) ThreeColumn() bool { return c.Width >= WideAt }
func (c Caps) TwoColumn() bool   { return c.Width >= MediumAt && c.Width < WideAt }
func (c Caps) OneColumn() bool   { return c.Width < MediumAt }

// Detect 从环境变量里读出能读的那些。
//
// ─────────────────────────────────────────
// 为什么不做 OSC 查询
// ─────────────────────────────────────────
//
// 问终端「你背景是什么颜色」（OSC 11）要往 stdin 上等一个回答，
// 而那件事在两种常见情况下会**挂住**：
//
//	· SSH 会话里，终端在对面，而中间可能有一层不透传的东西
//	· stdin 不是 tty（管道、CI）
//
// 挂住的表现是「敲了 ash 之后黑屏几秒」，而那是人对一个工具的
// 第一印象。所以这里只读环境变量 —— 读不到就用多数派的默认值，
// 并且让 `--light` / `ASH_THEME` 能手动覆盖。
func Detect(env func(string) string, width, height int) Caps {
	if env == nil {
		env = os.Getenv
	}
	c := Caps{
		Color:   detectColor(env),
		Dark:    detectDark(env),
		Unicode: detectUnicode(env),
		Width:   width,
		Height:  height,
	}
	// 尺寸探不到时按 80x24 排版 —— 那是 VT100 以来的公约数
	if c.Width <= 0 {
		c.Width = 80
	}
	if c.Height <= 0 {
		c.Height = 24
	}
	return c
}

func detectColor(env func(string) string) ColorDepth {
	// 这两个是「明确要求不要颜色」的公约，优先级最高
	if env("NO_COLOR") != "" {
		return NoColor
	}
	if strings.EqualFold(env("ASH_COLOR"), "none") {
		return NoColor
	}

	term := strings.ToLower(env("TERM"))
	if term == "dumb" || term == "" {
		/*
		 * `TERM` 为空通常意味着不是交互终端（cron、管道）。
		 * 当成无色而不是当成 16 色：往管道里写 ANSI 转义，
		 * 会让日志文件里全是 `ESC[38;5;` 这种东西，
		 * 而那比没有颜色难读得多。
		 */
		return NoColor
	}

	ct := strings.ToLower(env("COLORTERM"))
	if ct == "truecolor" || ct == "24bit" {
		return TrueColor
	}
	if strings.Contains(term, "256color") {
		return Ansi256
	}
	return Ansi16
}

func detectDark(env func(string) string) bool {
	switch strings.ToLower(env("ASH_THEME")) {
	case "light":
		return false
	case "dark":
		return true
	}
	/*
	 * `COLORFGBG` 是一部分终端（rxvt、konsole、以及 iTerm2 的一个选项）
	 * 会设的：`前景;背景`，背景是 0-6 或 8 就是深色。
	 *
	 * 它不普及，但读它是免费的。读不到就当深色 ——
	 * 猜错的代价是不对称的：深色主题在浅背景上是「颜色偏淡」，
	 * 浅色主题在深背景上是**几乎看不见**。
	 */
	if fgbg := env("COLORFGBG"); fgbg != "" {
		parts := strings.Split(fgbg, ";")
		bg := parts[len(parts)-1]
		switch bg {
		case "7", "9", "10", "11", "12", "13", "14", "15":
			return false
		}
	}
	return true
}

func detectUnicode(env func(string) string) bool {
	if strings.EqualFold(env("ASH_ASCII"), "1") {
		return false
	}
	/*
	 * 判据是 locale 里有没有 UTF-8。
	 *
	 * 更准的做法是画一个已知宽度的字符再测光标位移 ——
	 * 但那和 OSC 查询一样要往 stdin 上等回答，
	 * 会在 SSH 和管道里挂住（见 Detect 上面那段）。
	 *
	 * locale 判错的方向是安全的：一个设了 UTF-8 却画不出框线的终端
	 * 很少见，而反过来（能画却退到 ASCII）只是难看一点。
	 */
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		v := strings.ToUpper(env(k))
		if v == "" {
			continue
		}
		return strings.Contains(v, "UTF-8") || strings.Contains(v, "UTF8")
	}
	/*
	 * 三个变量都没设。
	 *
	 * 这在 Docker 和一部分 SSH 登录里很常见，而那些环境里
	 * 终端本身多半是支持 UTF-8 的 —— 只是没人设过 locale。
	 * 所以当成支持，让「难看」而不是「一律退成 ASCII」成为默认。
	 */
	return true
}
