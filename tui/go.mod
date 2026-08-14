// 终端客户端。设计与取舍见仓库根目录的 TUI.md。
//
// 为什么这个目录是 Go 而不是 TypeScript（站里其余全是 TS）：
//
//   ① 分发。`curl | bash` 要在一台什么都不知道的机器上跑起来，
//      而静态二进制没有运行时依赖 —— 不用探测 Node、不用装 Node。
//
//   ② 同一个程序既是本地二进制、又能被 ssh 进来。Charm 的 Wish
//      让一个 Bubble Tea 的 Model 直接当 SSH 服务端的会话处理器，
//      于是 cmd/ash 和 cmd/ash-sshd 共用 internal/ui 里那一个 model。
//      别的语言都要为 SSH 那侧另写一套伪终端服务端 ——
//      而「另写一套」在这个仓库里的下场已经反复见过。
module github.com/jmr/agenticlab/tui

go 1.24.2

require (
	github.com/charmbracelet/bubbletea v1.3.10
	github.com/charmbracelet/lipgloss v1.1.1-0.20250404203927-76690c660834
	github.com/charmbracelet/ssh v0.0.0-20250128164007-98fd5ae11894
	github.com/charmbracelet/wish v1.4.7
	github.com/mattn/go-runewidth v0.0.19
	github.com/mdp/qrterminal/v3 v3.2.1
	github.com/zalando/go-keyring v0.2.8
	golang.org/x/crypto v0.36.0
)

require (
	github.com/alecthomas/chroma/v2 v2.20.0 // indirect
	github.com/anmitsu/go-shlex v0.0.0-20200514113438-38f4b401e2be // indirect
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/aymerick/douceur v0.2.0 // indirect
	github.com/charmbracelet/colorprofile v0.4.1 // indirect
	github.com/charmbracelet/glamour v1.0.0 // indirect
	github.com/charmbracelet/keygen v0.5.3 // indirect
	github.com/charmbracelet/log v0.4.1 // indirect
	github.com/charmbracelet/x/ansi v0.11.6 // indirect
	github.com/charmbracelet/x/cellbuf v0.0.15 // indirect
	github.com/charmbracelet/x/conpty v0.1.0 // indirect
	github.com/charmbracelet/x/errors v0.0.0-20240508181413-e8d8b6e2de86 // indirect
	github.com/charmbracelet/x/exp/slice v0.0.0-20250327172914-2fdc97757edf // indirect
	github.com/charmbracelet/x/input v0.3.4 // indirect
	github.com/charmbracelet/x/term v0.2.2 // indirect
	github.com/charmbracelet/x/termios v0.1.0 // indirect
	github.com/charmbracelet/x/windows v0.2.0 // indirect
	github.com/clipperhouse/displaywidth v0.9.0 // indirect
	github.com/clipperhouse/stringish v0.1.1 // indirect
	github.com/clipperhouse/uax29/v2 v2.5.0 // indirect
	github.com/creack/pty v1.1.21 // indirect
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/dlclark/regexp2 v1.11.5 // indirect
	github.com/erikgeiser/coninput v0.0.0-20211004153227-1c3628e74d0f // indirect
	github.com/go-logfmt/logfmt v0.6.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/gorilla/css v1.0.1 // indirect
	github.com/lucasb-eyer/go-colorful v1.3.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mattn/go-localereader v0.0.1 // indirect
	github.com/microcosm-cc/bluemonday v1.0.27 // indirect
	github.com/muesli/ansi v0.0.0-20230316100256-276c6243b2f6 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/muesli/reflow v0.3.0 // indirect
	github.com/muesli/termenv v0.16.0 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	github.com/yuin/goldmark v1.7.13 // indirect
	github.com/yuin/goldmark-emoji v1.0.6 // indirect
	golang.org/x/exp v0.0.0-20240719175910-8a7402abbf56 // indirect
	golang.org/x/net v0.38.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
	golang.org/x/term v0.36.0 // indirect
	golang.org/x/text v0.30.0 // indirect
	rsc.io/qr v0.2.0 // indirect
)
