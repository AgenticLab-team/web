package screens

import (
	"fmt"
	"sort"

	"github.com/jmr/agenticlab/tui/internal/ui/kit"
)

/*
 * 屏幕注册表。
 *
 * ═════════════════════════════════════════
 * 它是对齐守卫的另一半
 * ═════════════════════════════════════════
 *
 * `src/lib/tui/surface.ts` 里每个面声明自己在终端里的屏幕 id，
 * 而 `tests/tui-parity.test.ts` 读**这个文件**，逐条核对：
 *
 *   · 表里声明了、这里没注册 → 红（终端里那一屏其实不存在）
 *   · 这里注册了、表里没有   → 红（一个不受任何守卫覆盖的屏）
 *
 * 那份守卫是靠**搜这个文件里的字符串**做到跨语言核对的，
 * 所以每个 id 必须以 `Register("...")` 的字面量形式出现在这里 ——
 * 用变量拼出来的话，守卫看不见它，而看不见等于没守。
 */

var registry = map[string]Factory{}

// Register 登记一屏。
func Register(id string, f Factory) {
	if _, dup := registry[id]; dup {
		/*
		 * 重复注册直接 panic。
		 *
		 * 后注册的会覆盖先注册的，而那意味着**有一屏永远打不开** ——
		 * 症状是「点进去看到的是另一个东西」，
		 * 而没有任何地方会报错。在启动时炸掉便宜得多。
		 */
		panic("屏幕 id 重复注册：" + id)
	}
	registry[id] = f
}

// New 造一屏。id 认不出的话给一个说得清楚的占位屏，而不是 nil。
func New(id string, ctx Context, params Params) Screen {
	if f, ok := registry[id]; ok {
		return f(ctx, params)
	}
	/*
	 * 认不出的 id 只有一种来源：**这个二进制比服务端旧**。
	 *
	 * （表和注册表的一致性有守卫盯着，所以同一个版本内不可能对不上。）
	 *
	 * 所以这里的提示要指向「去更新」，而不是「出错了」——
	 * 后者会让人去重装、去重新登录，两件都没用。
	 */
	return newMissing(ctx, id)
}

// Registered 是已经注册的全部 id，排过序。
func Registered() []string {
	ids := make([]string, 0, len(registry))
	for id := range registry {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Has 是「这一屏在这个版本里存在吗」。
//
// 外壳用它决定最左那一竖里画不画某一格：一个装了旧版的人
// 不该看到一个点进去说「请更新」的入口。
func Has(id string) bool {
	_, ok := registry[id]
	return ok
}

func init() {
	/*
	 * ── 群聊 ────────────────────────────────────────────
	 */
	Register("chat/live", newChatLive)
	Register("chat/archive", genericFactory(spec{
		title: "按天回看", path: "/api/v1/archive",
		hint: "群消息是每 2 分钟同步一次的镜像 —— 上游没有推送，只能轮询",
	}))
	Register("chat/search", genericFactory(spec{
		title: "检索", path: "/api/v1/search", search: true,
		hint: "可见性在 SQL 层就切掉了 —— 搜不到的是真的搜不到",
	}))
	Register("chat/links", genericFactory(spec{
		title: "资源库", path: "/api/v1/links", search: true,
		actions: []action{
			{key: "v", label: "投一票", method: "POST", path: "/api/v1/links/{id}/vote",
				body: map[string]any{"on": true}, scope: "me:write"},
			{key: "s", label: "收藏", method: "POST", path: "/api/v1/links/{id}/save",
				body: map[string]any{"on": true}, scope: "me:write"},
		},
	}))
	Register("chat/radar", genericFactory(spec{
		title: "关键词雷达", path: "/api/v1/radar",
		hint: "太宽的词会被挡下来 —— 一个「的」会在两分钟内命中几百条",
		actions: []action{
			{key: "n", label: "加一个词", method: "POST", path: "/api/v1/radar",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "keyword", Label: "关键词", Type: "string", Required: true},
					{Name: "force", Label: "太宽也要加（是/否）", Type: "boolean"},
				}},
			{key: "d", label: "删掉这个词", method: "DELETE", path: "/api/v1/radar/{id}",
				scope: "me:write"},
		},
	}))
	Register("chat/stats", genericFactory(spec{
		title: "群统计", path: "/api/v1/groups/{conv_id}/stats",
	}))
	Register("chat/announcement", genericFactory(spec{
		title: "群公告", path: "/api/v1/groups/{conv_id}/announcement",
		hint: "改公告是整条替换，不是追加 —— 会把群里现在那段顶掉",
		actions: []action{
			/*
			 * 危险级 1：它会把一千六百人打开群就看见的那段字**顶掉**，
			 * 而微信里没有历史版本。被覆盖的那段只在我们自己的库里。
			 */
			{key: "e", label: "改公告（整条替换）", method: "POST",
				path: "/api/v1/groups/{conv_id}/announcement", scope: "groups:send", danger: 1,
				fields: []kit.Field{
					{Name: "text", Label: "新的公告全文", Type: "string", Required: true},
				}},
		},
	}))

	/*
	 * ── 论坛 ────────────────────────────────────────────
	 */
	Register("forum/index", genericFactory(spec{
		title: "论坛", path: "/api/v1/forum/boards",
	}))
	Register("forum/board", genericFactory(spec{
		title: "版块", path: "/api/v1/posts", query: []string{"board"},
	}))
	Register("forum/post", newForumPost)
	Register("forum/new", newForumCompose)
	Register("forum/edit", newForumEdit)
	Register("forum/history", genericFactory(spec{
		title: "编辑历史", path: "/api/v1/posts/{id}/history",
	}))
	Register("forum/search", genericFactory(spec{
		title: "论坛搜索", path: "/api/v1/forum/search", search: true,
	}))
	Register("forum/deep", genericFactory(spec{
		title: "深潜", path: "/api/v1/forum/deep",
		hint: "全站长文平均 2.3 次浏览，短帖 8.2 次 —— 这一页是为此存在的",
	}))
	Register("forum/convert", newForumConvert)

	/*
	 * ── 社区 ────────────────────────────────────────────
	 */
	Register("community/home", genericFactory(spec{title: "首页", path: "/api/v1/home"}))
	Register("community/members", genericFactory(spec{
		title: "成员", path: "/api/v1/members", search: true,
		actions: []action{
			{key: "f", label: "关注/取关", method: "POST", path: "/api/v1/me/following",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "target", Label: "user / post / tag / board", Type: "string", Required: true},
					{Name: "id", Label: "对象 id", Type: "string", Required: true},
				}},
		},
	}))
	Register("community/person", newPerson)
	Register("community/leaderboard", genericFactory(spec{
		title: "排行榜", path: "/api/v1/leaderboard",
		hint: "主排序是高质量消息，不是总条数 —— 后者会让复读机上榜",
	}))
	Register("community/projects", genericFactory(spec{
		title: "项目目录", path: "/api/v1/projects",
		actions: []action{
			{key: "n", label: "自荐一个项目", method: "POST", path: "/api/v1/projects",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "repo", Label: "owner/name", Type: "string", Required: true},
					{Name: "pitch", Label: "一句话说清它是干嘛的", Type: "string", Required: true},
				}},
		},
	}))
	Register("community/repo", genericFactory(spec{
		title: "项目详情", path: "/api/v1/projects/{owner}/{repo}",
	}))
	Register("community/activities", genericFactory(spec{
		title: "活动", path: "/api/v1/activities",
		hint: "回车看某个活动的资格判定 —— 它会逐条说你差在哪",
		actions: []action{
			{key: "s", label: "报名/退出", method: "POST",
				path: "/api/v1/activities/{id}/apply", scope: "activities:write",
				fields: []kit.Field{
					{Name: "on", Label: "报名（是）还是退出（否）", Type: "boolean", Required: true},
				}},
		},
	}))
	Register("community/activity", genericFactory(spec{
		title: "活动详情", path: "/api/v1/activities/{id}",
		hint: "资格是逐条给的（差多少积分、差几天打卡）—— 只说「不符合」没法行动",
		actions: []action{
			{key: "s", label: "报名/退出", method: "POST",
				path: "/api/v1/activities/{id}/apply", scope: "activities:write",
				fields: []kit.Field{
					{Name: "on", Label: "报名（是）还是退出（否）", Type: "boolean", Required: true},
				}},
		},
	}))
	Register("community/shop", genericFactory(spec{
		title: "商店", path: "/api/v1/shop",
		actions: []action{
			/*
			 * 危险级 1：扣的是真积分。而 `client_token` 是**必填**的 ——
			 * 它是幂等键，同一个 token 重发拿回的是同一单。
			 * 不填就没法安全重试：网络超时之后你不知道上一次成没成。
			 */
			{key: "b", label: "买一件", method: "POST", path: "/api/v1/shop/{id}/buy",
				scope: "economy:write", danger: 1,
				fields: []kit.Field{
					{Name: "client_token", Label: "随便一个至少 8 位的随机串（防重复扣款）",
						Type: "string", Required: true},
				}},
		},
	}))
	Register("community/welcome", genericFactory(spec{
		title: "新人补课包", path: "/api/v1/welcome",
	}))
	Register("community/onboarding", genericFactory(spec{
		title: "入站设置", path: "/api/v1/welcome",
	}))

	/*
	 * ── 我的 ────────────────────────────────────────────
	 */
	Register("me/home", genericFactory(spec{title: "我的", path: "/api/v1/me"}))
	Register("me/profile", genericFactory(spec{
		title: "编辑资料", path: "/api/v1/me",
		hint: "只改填了的那几项 —— 留空的不动，而不是被清掉",
		actions: []action{
			{key: "e", label: "改简介 / 技能标签", method: "POST", path: "/api/v1/me/profile",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "bio", Label: "一句话简介", Type: "string"},
					{Name: "skills", Label: "技能标签（逗号分隔）", Type: "string"},
				}},
		},
	}))
	Register("me/points", genericFactory(spec{
		title: "积分与打卡", path: "/api/v1/me/points",
		actions: []action{
			{key: "c", label: "打卡", method: "POST", path: "/api/v1/me/checkin",
				scope: "me:write"},
			{key: "m", label: "用补签卡补一天", method: "POST", path: "/api/v1/me/makeup",
				scope: "economy:write", danger: 1,
				fields: []kit.Field{
					{Name: "date", Label: "补哪一天（YYYY-MM-DD）", Type: "string", Required: true},
				}},
		},
	}))
	Register("me/titles", genericFactory(spec{
		title: "称号", path: "/api/v1/me/titles",
		actions: []action{
			{key: "e", label: "换挂着的称号", method: "POST", path: "/api/v1/me/titles/equip",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "title_id", Label: "称号 id（留空 = 摘下来）", Type: "string"},
				}},
		},
	}))
	Register("me/bookmarks", genericFactory(spec{title: "收藏夹", path: "/api/v1/me/bookmarks"}))
	/*
	 * 一次性邮箱拆成两屏，而网页上它是一页。
	 *
	 * 网页上一页能同时铺开「我有哪几个箱子」和「这个箱子收到的信」，
	 * 终端里那是两种翻页节奏：前者是一张短表，后者要能一直往下读。
	 * 挤进一屏的话，信的正文只剩四五行 —— 而人来这儿就是为了读那封信。
	 */
	Register("me/mail", genericFactory(spec{
		title: "一次性邮箱", path: "/api/v1/mail/burners",
		hint: "这里只列**这把令牌自己开的**箱子 —— 你在网页上开的它看不见",
		actions: []action{
			{key: "n", label: "开一个新箱子", method: "POST", path: "/api/v1/mail/burners",
				scope: "mail:burner",
				fields: []kit.Field{
					{Name: "local_part", Label: "自选前缀（留空 = 随机，最常用）", Type: "string"},
				}},
			{key: "d", label: "提前销毁这个箱子", method: "DELETE", path: "/api/v1/mail/burners/{id}",
				scope: "mail:burner", danger: 1},
		},
	}))
	Register("me/mail/box", genericFactory(spec{
		title: "这个箱子收到的信", path: "/api/v1/mail/burners/{id}/messages",
		hint: "`otp_code` 是已经抽好的验证码 —— 抽不出来时是空的，宁可不抽也不猜错",
	}))
	Register("me/drafts", genericFactory(spec{
		title: "草稿箱", path: "/api/v1/me/drafts",
		actions: []action{
			{key: "d", label: "扔掉这份草稿", method: "DELETE", path: "/api/v1/me/drafts/{id}",
				scope: "me:write"},
			{key: "n", label: "存一份草稿", method: "POST", path: "/api/v1/me/drafts",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "board", Label: "版块 key", Type: "string", Required: true},
					{Name: "title", Label: "标题", Type: "string"},
					{Name: "content", Label: "正文", Type: "string", Required: true},
					{Name: "base", Label: "基于哪一版（第一次填 0）", Type: "number", Required: true},
				}},
		},
	}))
	Register("me/following", genericFactory(spec{
		title: "关注", path: "/api/v1/me/following",
		actions: []action{
			{key: "f", label: "关注/取关", method: "POST", path: "/api/v1/me/following",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "target", Label: "user / post / tag / board", Type: "string", Required: true},
					{Name: "id", Label: "对象 id", Type: "string", Required: true},
				}},
		},
	}))
	Register("me/notifications", genericFactory(spec{
		title: "通知", path: "/api/v1/me/notifications",
		actions: []action{
			/*
			 * 不传 ids 就是**全部标已读**。
			 *
			 * 服务端那侧「空数组 = 一条都不标」是刻意的，
			 * 而这里这个键的语义是「清红点」—— 所以它一个字段都不填。
			 */
			{key: "A", label: "全部标为已读", method: "POST",
				path: "/api/v1/me/notifications/read", scope: "notifications:write"},
		},
	}))
	Register("me/notification-prefs", genericFactory(spec{
		title: "通知设置", path: "/api/v1/me/notifications/prefs",
		hint: "标着 always_on 的那几类关不掉 —— 关掉等于让一个人不知道自己被处理了",
		actions: []action{
			{key: "e", label: "改一类通知", method: "POST",
				path: "/api/v1/me/notifications/prefs", scope: "notifications:write",
				fields: []kit.Field{
					{Name: "type", Label: "哪一类（上面那个 key）", Type: "string", Required: true},
					{Name: "site", Label: "站内通知（是/否）", Type: "boolean", Required: true},
					{Name: "push", Label: "锁屏推送（是/否）", Type: "boolean"},
				}},
		},
	}))
	Register("me/privacy", genericFactory(spec{
		title: "隐私", path: "/api/v1/me/privacy",
		hint: "每一项都写着「它不管什么」—— 一个让人以为管得更多的开关比没有更坏",
		actions: []action{
			{key: "e", label: "拨一个开关", method: "POST", path: "/api/v1/me/privacy",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "key", Label: "哪一项（上面那个 key）", Type: "string", Required: true},
					{Name: "on", Label: "开（是）还是关（否）", Type: "boolean", Required: true},
				}},
		},
	}))
	Register("me/moderation", genericFactory(spec{
		title: "我的处罚与申诉", path: "/api/v1/me/moderation",
		actions: []action{
			{key: "p", label: "提一次申诉", method: "POST", path: "/api/v1/me/appeals",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "action_id", Label: "对哪一条处罚（上面那个 id）", Type: "string", Required: true},
					{Name: "reason", Label: "说明情况", Type: "string", Required: true},
				}},
		},
	}))
	Register("me/tokens", genericFactory(spec{
		title: "开放 API", path: "/api/v1/me/tokens",
		hint: "source 是 ssh 的那些，明文在网关那台机器上 —— 可以一键全撤",
		actions: []action{
			{key: "n", label: "建一把新令牌", method: "POST", path: "/api/v1/me/tokens",
				scope: "me:write",
				fields: []kit.Field{
					{Name: "name", Label: "这把是干什么的", Type: "string", Required: true},
					{Name: "scopes", Label: "要哪些权限（逗号分隔）", Type: "string", Required: true},
				}},
			/*
			 * 危险级 1：撤掉之后那把立刻验不过。
			 *
			 * 撤到自己正在用的那一把时，服务端会回 409 让你加 confirm ——
			 * 那一层拦的是「当场掉线」，而它的错误信息说得很清楚。
			 */
			{key: "d", label: "撤销这把令牌", method: "DELETE", path: "/api/v1/me/tokens/{id}",
				scope: "me:write", danger: 1},
		},
	}))
	Register("me/security", genericFactory(spec{
		title: "登录与设备", path: "/api/v1/me/sessions",
		hint: "这里是网页会话；令牌在「开放 API」那一屏。passkey 要浏览器里的认证器，终端里做不了",
		actions: []action{
			{key: "d", label: "把这台设备踢下线", method: "DELETE",
				path: "/api/v1/me/sessions/{id}", scope: "me:write", danger: 1},
		},
	}))
	Register("me/export", genericFactory(spec{
		title: "导出我的数据", path: "/api/v1/me/export",
		hint: "这份文件里会有别人在群里说的话",
	}))
	Register("me/update", newAbout)

	/*
	 * ── 管理 ────────────────────────────────────────────
	 *
	 * 三十屏共用一个实现：它们的形状是同一个（一份数据 + 几个动作），
	 * 而具体读什么、能做什么由服务端的 `/api/v1/admin/sections` 说了算。
	 *
	 * 在这里为三十个分区各写一份的话，后台加一个字段时
	 * 那三十份里没有一份会知道。
	 */
	for _, id := range adminScreenIDs {
		Register(id, newAdmin)
	}
}

// adminScreenIDs 必须和 surface.ts 里那些 `admin/*` 屏幕 id 一一对应。
//
// 写成一张显式的表而不是从 surface 包里循环生成 —— 对齐守卫是靠
// **搜这个文件里的字符串**做跨语言核对的，循环生成的话它一个都看不见。
var adminScreenIDs = []string{
	"admin/dashboard",
	// 这两个是两个功能分支合进来时补的 —— 后台屏全是同一个实现，
	// 具体读什么由服务端 /api/v1/admin/sections 说了算，所以只要多一行 id
	"admin/mail",
	"admin/oauth",
	"admin/health",
	"admin/storage",
	"admin/backup",
	"admin/audit",
	"admin/users",
	"admin/user",
	"admin/binds",
	"admin/roles",
	"admin/invites",
	"admin/reports",
	"admin/appeals",
	"admin/posts",
	"admin/escalation",
	"admin/approvals",
	"admin/words",
	"admin/boards",
	"admin/groups",
	"admin/points",
	"admin/points-ledger",
	"admin/points-levels",
	"admin/shop",
	"admin/activities",
	"admin/broadcast",
	"admin/community",
	"admin/settings",
	"admin/flags",
	"admin/modules",
	"admin/api",
	"admin/llm",
}

// String 让注册表在调试时能被打出来
func String() string {
	return fmt.Sprintf("%d 屏：%v", len(registry), Registered())
}
