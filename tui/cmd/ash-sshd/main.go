// 命令 ash-sshd 是 SSH 网关：让一个什么都装不了的人也能用这个站。
//
// ═════════════════════════════════════════
// 它服务的是 Windows 工作机、公司电脑、iPad、网吧
// ═════════════════════════════════════════
//
// 这不是「顺手也做一下」。群里相当一部分人只有一台装不了东西的
// Windows 工作机 —— 对他们来说没有 SSH 入口就等于没有终端客户端。
// 而 Windows 10 起自带 OpenSSH 客户端，所以 `ssh` 恰好是那台机器上
// 唯一不需要管理员权限的路。
//
// ═════════════════════════════════════════
// 这台机器**不知道**源站在哪
// ═════════════════════════════════════════
//
// 它只需要一个公网 SITE_URL，调 API 走 HTTPS，和任何一个第三方
// 客户端没有区别。这台盒子上没有数据库、没有 .env.local、
// 没有上游隧道、没有 .deploy-host。
//
// 被打穿的后果是「一台跑着开源 TUI 的空盒子丢了」，不是「站没了」。
// 这一条不是建议，是这个网关能存在的前提。
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"
	"github.com/charmbracelet/wish/activeterm"
	bm "github.com/charmbracelet/wish/bubbletea"
	"github.com/charmbracelet/wish/logging"
	gossh "golang.org/x/crypto/ssh"

	"github.com/jmr/agenticlab/tui/internal/api"
	"github.com/jmr/agenticlab/tui/internal/auth"
	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/theme"
	"github.com/jmr/agenticlab/tui/internal/ui"
	"github.com/jmr/agenticlab/tui/internal/ui/screens"
)

var version = "dev"

func main() {
	addr := flag.String("addr", envOr("ASH_SSHD_ADDR", ":22"), "监听地址")
	site := flag.String("site", envOr("ASH_SITE", "https://agenticlab.sh"), "站点地址（**唯一**要配的东西）")
	hostKey := flag.String("host-key", envOr("ASH_SSHD_HOST_KEY", ".ssh/ash_ed25519"), "主机密钥路径")
	stateDir := flag.String("state", envOr("ASH_SSHD_STATE", "./state"), "令牌存放目录")
	flag.Parse()

	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		log.Fatalf("建不了状态目录：%v", err)
	}

	srv, err := wish.NewServer(
		wish.WithAddress(*addr),
		wish.WithHostKeyPath(*hostKey),

		/*
		 * ─────────────────────────────────────────
		 * 任何用户名都放行，而且**不做任何鉴权**
		 * ─────────────────────────────────────────
		 *
		 * 广告语是 `ssh anyuser@agenticlab.sh` —— 用户名不参与
		 * 任何判定，它只是 ssh 命令行的语法要求。
		 *
		 * 真正的身份来自两样东西：
		 *   ① SSH 公钥指纹（这台机器上「你是谁」的唯一真源）
		 *   ② 之后在浏览器里完成的设备码确认
		 *
		 * 在这一层做账号密码是错的：这个站没有可以在这儿验的密码，
		 * 而做一个就等于在微信群那扇门旁边开了第二个入口。
		 */
		wish.WithPublicKeyAuth(func(ctx ssh.Context, key ssh.PublicKey) bool { return true }),
		/*
		 * 键盘交互也放行 —— 一部分人的 ssh 客户端没有配公钥。
		 *
		 * 那种连接拿不到稳定的指纹，所以它们**每次都要重新登录**
		 * （见 fingerprintOf）。这不理想，但比让他们连不进来好。
		 */
		wish.WithKeyboardInteractiveAuth(func(ctx ssh.Context, c gossh.KeyboardInteractiveChallenge) bool {
			return true
		}),

		wish.WithMiddleware(
			bm.Middleware(handler(*site, *stateDir)),
			/*
			 * 没有 pty 的连接直接拒绝，并说清楚为什么。
			 *
			 * `ssh host command` 这种非交互连接进来之后，
			 * Bubble Tea 会往一个不存在的终端上画东西 ——
			 * 表现是「连上了但什么都没有」，而人会以为服务挂了。
			 */
			activeterm.Middleware(),
			logging.Middleware(),
		),
	)
	if err != nil {
		log.Fatalf("起不来：%v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("SSH 网关在 %s 上听着，站点 %s", *addr, *site)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
			log.Fatalf("挂了：%v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

// handler 是每一条连接进来之后做的事。
func handler(site, stateDir string) func(ssh.Session) (tea.Model, []tea.ProgramOption) {
	return func(s ssh.Session) (tea.Model, []tea.ProgramOption) {
		pty, _, _ := s.Pty()

		/*
		 * 终端能力从 **SSH 会话报上来的** 那份读，不是从网关自己的
		 * 环境变量读 —— 网关跑在 systemd 底下，它的 TERM 是空的，
		 * 而对面可能是一个 truecolor 的 iTerm2。
		 *
		 * 读错的后果是所有人都拿到无色界面，而没有人说得出为什么。
		 */
		env := sessionEnv(s, pty)
		caps := theme.Detect(env, pty.Window.Width, pty.Window.Height)

		fp := fingerprintOf(s)
		store := auth.Store{
			Path: filepath.Join(stateDir, "tokens", fp+".json"),
			/*
			 * **一定要关掉钥匙串。**
			 *
			 * 这台机器上没有属于任何一个人的钥匙串 ——
			 * 用系统钥匙串的话，所有人的令牌会挤进同一个条目，
			 * 于是后一个登录的人会拿到前一个人的身份。
			 */
			FileOnly: true,
		}

		creds, err := store.Load()
		if err == nil && (creds.Site != site || creds.Expired(time.Now())) {
			creds = auth.Credentials{}
		}

		sctx := screens.Context{
			API:    api.New(site, creds.Token, version),
			Scopes: creds.Scopes,
			Theme:  theme.New(caps),
			Ctx:    s.Context(),
			Site:   site,
		}

		if creds.Token == "" {
			// 还没登录：先进登录那一屏，它拿到令牌之后再进主界面
			return newLoginModel(sctx, caps, store, site, fp), []tea.ProgramOption{tea.WithAltScreen()}
		}
		return ui.New(sctx, caps, true), []tea.ProgramOption{tea.WithAltScreen()}
	}
}

// fingerprintOf 是这台机器上「你是谁」的唯一真源。
//
// ═════════════════════════════════════════
// 用户名一个字都不参与
// ═════════════════════════════════════════
//
// 谁都能 `ssh 任何名字@…`，所以用户名在这里没有任何证明力。
// 公钥不一样：能用某把私钥连进来，本身就是一次证明。
//
// 换一把钥匙进来就是一次**新的登录** —— 这是对的：
// 那确实是另一台机器（或者另一个人）。
func fingerprintOf(s ssh.Session) string {
	if key := s.PublicKey(); key != nil {
		/*
		 * `gossh.FingerprintSHA256` 出来的是 `SHA256:xxx`。
		 * 冒号和斜杠不能进文件名，换掉 —— 而换掉之后仍然是单射的，
		 * base64 的字母表里没有下划线。
		 */
		raw := gossh.FingerprintSHA256(key)
		return strings.NewReplacer(":", "_", "/", "_", "+", "-").Replace(raw)
	}
	/*
	 * 没有公钥（键盘交互进来的）。
	 *
	 * 这种连接没有稳定的身份可以绑，所以给一个**一次性**的指纹：
	 * 他这次登录的令牌会存在一个下次找不到的文件名下，
	 * 也就是说他每次都要重新登录。
	 *
	 * 用会话 id 而不是 IP：同一个网吧后面所有人的 IP 一样，
	 * 按 IP 存等于让他们共用一把令牌。
	 */
	return "session-" + s.Context().SessionID()
}

func sessionEnv(s ssh.Session, pty ssh.Pty) func(string) string {
	vals := map[string]string{}
	for _, kv := range s.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			vals[kv[:i]] = kv[i+1:]
		}
	}
	if pty.Term != "" {
		vals["TERM"] = pty.Term
	}
	return func(k string) string { return vals[k] }
}

/* ── 登录那一屏 ──────────────────────────────────────── */

type loginModel struct {
	ctx   screens.Context
	caps  theme.Caps
	store auth.Store
	site  string
	fp    string

	start *auth.StartResponse
	err   string
	done  bool
	inner tea.Model
}

func newLoginModel(ctx screens.Context, caps theme.Caps, store auth.Store, site, fp string) tea.Model {
	return &loginModel{ctx: ctx, caps: caps, store: store, site: site, fp: fp}
}

func (m *loginModel) Init() tea.Cmd {
	return func() tea.Msg {
		anon := api.New(m.site, "", version)

		/*
		 * ═════════════════════════════════════════
		 * SSH 这条路上**不申请高危 scope**
		 * ═════════════════════════════════════════
		 *
		 * 服务端那侧也挡着（`offerableScopes("ssh")` 里根本没有它们），
		 * 这里再挡一次不是重复 —— 是让**申请列表本身**就是干净的：
		 * 确认页上不会出现一个「你想要但拿不到」的勾选框。
		 *
		 * 理由见 TUI.md 第三节：这台机器公开可连，而且持有他人令牌。
		 */
		var want []string
		for _, s := range surface.Scopes {
			if s.Danger < 2 {
				want = append(want, s.Key)
			}
		}

		start, err := auth.Start(m.ctx.Ctx, anon, auth.SourceSSH,
			auth.Fingerprint{Host: "SSH 网关", OS: "gateway", Term: "ssh", Version: version},
			want, m.fp)
		if err != nil {
			return loginErrMsg{err}
		}
		return loginStartedMsg{start}
	}
}

type loginStartedMsg struct{ start *auth.StartResponse }
type loginErrMsg struct{ err error }
type loginDoneMsg struct {
	creds auth.Credentials
	err   error
}

func (m *loginModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch v := msg.(type) {
	case loginStartedMsg:
		m.start = v.start
		return m, func() tea.Msg {
			creds, err := auth.Poll(m.ctx.Ctx, api.New(m.site, "", version), v.start, nil)
			return loginDoneMsg{creds, err}
		}

	case loginErrMsg:
		m.err = v.err.Error()
		return m, nil

	case loginDoneMsg:
		if v.err != nil {
			m.err = v.err.Error()
			return m, nil
		}
		_ = m.store.Save(v.creds)
		m.done = true
		m.ctx.API = api.New(m.site, v.creds.Token, version)
		m.ctx.Scopes = v.creds.Scopes
		inner := ui.New(m.ctx, m.caps, true)
		m.inner = inner
		return m, inner.Init()

	case tea.WindowSizeMsg:
		m.caps.Width = v.Width
		m.caps.Height = v.Height

	case tea.KeyMsg:
		if v.String() == "ctrl+c" {
			return m, tea.Quit
		}
	}

	if m.done && m.inner != nil {
		next, cmd := m.inner.Update(msg)
		m.inner = next
		return m, cmd
	}
	return m, nil
}

func (m *loginModel) View() string {
	if m.done && m.inner != nil {
		return m.inner.View()
	}
	p := m.ctx.Theme
	var b strings.Builder
	b.WriteString(p.Accent.Render("Agentic Lab · 通过 SSH 网关") + "\n\n")

	if m.err != "" {
		b.WriteString(p.Danger.Render(m.err) + "\n\n")
		b.WriteString(p.Muted.Render("断开重连可以再试一次（Ctrl+C）"))
		return b.String()
	}
	if m.start == nil {
		b.WriteString(p.Muted.Render("正在要验证码…"))
		return b.String()
	}

	for _, line := range auth.Instructions(m.start) {
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")
	/*
	 * 这一段是这一屏**必须说清楚**的东西。
	 *
	 * 从 SSH 进来和用本地客户端唯一的实质差别就是：令牌存在
	 * 这台机器上。不说的话，人会以为两者一样 ——
	 * 而那个差别恰恰是他有权知道、并据此决定要不要继续的。
	 */
	b.WriteString(p.Warn.Render("你要知道的一件事：") + "\n")
	b.WriteString(p.Muted.Render("你的令牌会存在这台网关上（本地客户端不会）。") + "\n")
	b.WriteString(p.Muted.Render("它绑在你这次用的 SSH 公钥上、7 天到期，") + "\n")
	b.WriteString(p.Muted.Render("在网站的「我的 → 开放 API」里可以随时一键撤掉。") + "\n\n")
	b.WriteString(p.Faint.Render("另外：「往群里发消息」和「后台」这两项在这条路上不给 ——") + "\n")
	b.WriteString(p.Faint.Render("要用它们的话，装本地客户端：curl -Ls agenticlab.sh | bash"))
	return b.String()
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
