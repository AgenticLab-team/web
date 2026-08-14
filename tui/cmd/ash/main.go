// 命令 ash 是本地终端客户端。
//
// 装法：curl -Ls agenticlab.sh | bash
// 它同时注册 `ash` 和 `agenticlab.sh` 两个名字 —— 后者是别人在群里
// 贴出来的那个，一个人看到安装命令之后最可能敲的就是它。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mdp/qrterminal/v3"

	"github.com/jmr/agenticlab/tui/internal/api"
	"github.com/jmr/agenticlab/tui/internal/auth"
	"github.com/jmr/agenticlab/tui/internal/surface"
	"github.com/jmr/agenticlab/tui/internal/theme"
	"github.com/jmr/agenticlab/tui/internal/ui"
	"github.com/jmr/agenticlab/tui/internal/ui/screens"
	"github.com/jmr/agenticlab/tui/internal/update"
)

// version 由构建时注入：go build -ldflags "-X main.version=1.2.3"
var version = "dev"

const defaultSite = "https://agenticlab.sh"

func main() {
	site := flag.String("site", envOr("ASH_SITE", defaultSite), "站点地址")
	logout := flag.Bool("logout", false, "退出登录并清掉本地令牌")
	showVersion := flag.Bool("version", false, "打印版本")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	store := auth.Store{}
	if *logout {
		store.Clear()
		fmt.Println("已经退出登录，本地令牌清掉了。")
		return
	}

	/*
	 * Ctrl+C 之外也要能被好好地杀掉。
	 *
	 * 终端程序被 SIGTERM 打断时如果不收拾，会把终端留在
	 * 「隐藏了光标、开着 alt screen」的状态 —— 人回到 shell 之后
	 * 看到的是一个坏掉的终端，而他多半会关掉整个窗口。
	 */
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	creds, err := ensureLogin(ctx, store, *site)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	client := api.New(*site, creds.Token, version)
	caps := theme.Detect(os.Getenv, 0, 0)
	sctx := screens.Context{
		API:    client,
		Scopes: creds.Scopes,
		Theme:  theme.New(caps),
		Ctx:    ctx,
		Site:   *site,
	}

	/*
	 * 自更新在**后台**跑，不挡启动。
	 *
	 * 挡着的话，一次网络卡顿换来的是「这个工具启动要五秒」——
	 * 而那是人放弃它最常见的理由。
	 */
	go checkUpdate(ctx, client)

	m := ui.New(sctx, caps, false)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithContext(ctx))
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "跑不起来：", err)
		os.Exit(1)
	}
}

// ensureLogin 拿一把能用的令牌，没有就走设备码登录。
func ensureLogin(ctx context.Context, store auth.Store, site string) (auth.Credentials, error) {
	creds, err := store.Load()
	switch {
	case err == nil && creds.Site != site:
		/*
		 * 换站了就当没登录。
		 *
		 * 一把 A 站的令牌拿去调 B 站会拿到 401，而那句话
		 * （「令牌无效」）指向的是「令牌坏了」——
		 * 人会去重新登录，然后拿到一把 A 站的新令牌，再失败一次。
		 */
		creds = auth.Credentials{}
	case err == nil && creds.Expired(time.Now()):
		creds = auth.Credentials{}
	case err != nil && err != auth.ErrNoCredentials:
		return creds, err
	}

	if creds.Token != "" {
		return creds, nil
	}
	return login(ctx, store, site)
}

// login 走一遍设备码。
func login(ctx context.Context, store auth.Store, site string) (auth.Credentials, error) {
	anon := api.New(site, "", version)

	/*
	 * 默认申请**除高危之外的全部**。
	 *
	 * 少申请的话，人会在几天后用到某个功能时撞一次墙，
	 * 而那时候他早忘了登录时勾过什么。
	 *
	 * 高危那两个（往群里发消息、后台）不在默认里 ——
	 * 它们要人在确认页上单独勾。默认勾上等于没有问过。
	 */
	var want []string
	for _, s := range surface.Scopes {
		if s.Danger < 2 {
			want = append(want, s.Key)
		}
	}

	start, err := auth.Start(ctx, anon, auth.SourceCLI, auth.DetectFingerprint(version), want, "")
	if err != nil {
		return auth.Credentials{}, fmt.Errorf("要不到验证码：%w", err)
	}

	for _, line := range auth.Instructions(start) {
		fmt.Println(line)
	}

	/*
	 * 二维码。
	 *
	 * 手机在手上的时候，扫一下比「打开浏览器、敲一个网址、
	 * 再敲八位字符」快一个数量级 —— 而这一步是整个安装流程里
	 * 唯一需要离开终端的动作，也就是最容易在这儿放弃的一步。
	 *
	 * 画在窄的那一档（`qrterminal.L`）：默认那档在 80 列的终端里
	 * 会换行，换行之后的二维码扫不出来。
	 */
	if start.VerificationURIComplete != "" {
		fmt.Println()
		qrterminal.GenerateHalfBlock(start.VerificationURIComplete, qrterminal.L, os.Stdout)
	}

	fmt.Println()
	fmt.Print("等着你在浏览器里确认… ")

	creds, err := auth.Poll(ctx, anon, start, nil)
	if err != nil {
		fmt.Println()
		return auth.Credentials{}, err
	}
	fmt.Println("好了。")

	if err := store.Save(creds); err != nil {
		/*
		 * 存不下不算失败 —— 这一次照样能用，只是下次要重新登录。
		 *
		 * 直接退出的话，一个只读文件系统上的用户永远进不来，
		 * 而他其实只是需要每次登录一下。
		 */
		fmt.Fprintf(os.Stderr, "提醒：令牌没存下来（%v），下次还要再登录一次\n", err)
	} else {
		fmt.Println("令牌存在：", store.Describe())
	}
	return creds, nil
}

// checkUpdate 在后台查、下、换。**换的是磁盘上那个文件**，
// 当前这个进程照常跑完 —— 下次启动才是新版。
//
// ─────────────────────────────────────────
// 它整段都不许打扰人
// ─────────────────────────────────────────
//
// 查不到、下不动、没写权限 —— 每一种都只是「这次没更新成」，
// 而不是一个要人处理的问题。往屏幕上写一句的话，
// 一个装在只读目录里的人每次启动都会看到同一句他解决不了的话。
//
// 唯一会说话的是校验和对不上：那有两种可能，
// 一次半截下载（无害）或者有人在中间换了文件（很严重），
// 而客户端分不出是哪一种 —— 所以它值得被看到。
func checkUpdate(ctx context.Context, client *api.Client) {
	defer func() { _ = recover() }()

	var m update.Manifest
	if err := client.Get(ctx, "/api/v1/release", nil, &m); err != nil {
		return
	}
	if !update.Available(version, m.Version) {
		return
	}
	asset := m.AssetFor(update.Platform())
	if asset == nil {
		return // 这个平台本来就该自己 go build
	}
	if err := update.Apply(ctx, *asset, nil); err != nil {
		if errors.Is(err, update.ErrChecksum) {
			fmt.Fprintln(os.Stderr, "\n⚠ 自动更新被中止：", err)
		}
		return
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
