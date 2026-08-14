// Package surface 是「站里有哪些面」这件事在终端侧的形状。
//
// ═════════════════════════════════════════
// 这个包里**没有数据**，数据在 surface.gen.go
// ═════════════════════════════════════════
//
// 真源是 src/lib/tui/surface.ts，由 `npm run tui:gen` 倒过来。
// 在这里手写一份的话就有了两份 —— 而两份必然分叉，
// 分叉之后守卫守的是 TS 那一份，用户用的是这一份。
package surface

// Surface 是一个「面」：网页上的一页、终端里的一屏，
// 以及把两者连起来的那几个端点。
type Surface struct {
	Key   string
	Label string
	// chat / forum / community / me / admin
	Board string
	// 网页路由。空串 = 网页上没有独立页面
	Web string
	// 终端里的屏幕 id。空串 = 终端里不做（Why 里写着为什么）
	Screen string
	Why    string
	API    []string
	// 打开这一屏至少要的 scope
	Scopes []string
	// 某些动作才要的 scope。缺了这一屏照常打开，只是那个动作不可用 ——
	// 群聊就是典型：绝大多数人没有 groups:send，但都要看群聊
	OptionalScopes []string
	// 后台专用：对应 /api/v1/admin/{section} 里的 section
	AdminSection string
}

type Scope struct {
	Key    string
	Label  string
	Detail string
	// >= 2 的默认不勾，而且 SSH 网关上根本不在可申请之列
	Danger int
}

type AdminSection struct {
	Key         string
	Label       string
	Description string
}

// ByKey 取一个面。找不到返回 nil
func ByKey(key string) *Surface {
	for i := range Surfaces {
		if Surfaces[i].Key == key {
			return &Surfaces[i]
		}
	}
	return nil
}

// ByScreen 按屏幕 id 取。路由跳转时用它把 id 解析回一个面
func ByScreen(screen string) *Surface {
	if screen == "" {
		return nil
	}
	for i := range Surfaces {
		if Surfaces[i].Screen == screen {
			return &Surfaces[i]
		}
	}
	return nil
}

// InBoard 是某个分区下、终端里真的存在的那些面，按声明顺序。
//
// 最左那一竖靠它渲染。过滤掉 Screen 为空的那些 ——
// 它们是「想过了但不做」的，不该在导航里占一格。
func InBoard(board string) []Surface {
	var out []Surface
	for _, s := range Surfaces {
		if s.Board == board && s.Screen != "" {
			out = append(out, s)
		}
	}
	return out
}

// Boards 是分区的显示顺序。
//
// 写死在这里而不是从 Surfaces 里推：从数据里推出来的顺序
// 取决于哪个面碰巧排在前面，而那不是一个产品决定。
var Boards = []struct {
	Key   string
	Label string
	// 窄终端下只剩图标时用的那一个字
	Short string
}{
	{"chat", "群聊", "群"},
	{"forum", "论坛", "坛"},
	{"community", "社区", "社"},
	{"me", "我的", "我"},
	{"admin", "管理", "管"},
}

// ScopeByKey 把 scope 翻译成人话。找不到就返回它自己 ——
// 显示一个原始 key 比显示「未知权限」有用：至少还查得到。
func ScopeByKey(key string) Scope {
	for _, s := range Scopes {
		if s.Key == key {
			return s
		}
	}
	return Scope{Key: key, Label: key}
}

// MissingScopes 是「这一屏要的，而这把令牌没有的」。
//
// 只算必需的那些（Scopes），不算 OptionalScopes ——
// 后者缺了不影响进这一屏，只影响某个动作，
// 那句解释在动作旁边说，不在门口说。
func (s Surface) MissingScopes(have []string) []string {
	var missing []string
	for _, want := range s.Scopes {
		found := false
		for _, h := range have {
			if h == want {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, want)
		}
	}
	return missing
}

// HasScope 是「某个可选动作能不能用」。
//
// 界面上靠它决定输入框显示成能打字的样子，还是显示成一句解释 ——
// 而**必须在人动手之前**：让他敲完三百字再拿一句 403，
// 是这套东西里最容易犯也最伤人的错。
func HasScope(have []string, want string) bool {
	for _, h := range have {
		if h == want {
			return true
		}
	}
	return false
}
