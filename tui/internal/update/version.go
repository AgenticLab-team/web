// Package update 是自更新：比版本、下载、校验、原子替换。
package update

import (
	"strconv"
	"strings"
)

/*
 * 版本比较。
 *
 * ═════════════════════════════════════════
 * 只有这一份实现，服务端那侧**没有**
 * ═════════════════════════════════════════
 *
 * 「有没有新版」是终端自己要回答的问题：它知道自己是哪一版，
 * 而服务端只知道最新是哪一版。
 *
 * 两边各写一份的话，判得不一样时的症状是「客户端说没更新，
 * 而站长在后台看到大家都在老版本上」—— 而没有人能立刻说出
 * 是哪一边错了。所以 `src/lib/tui/release-rules.ts` 里那一段
 * 是刻意留白的，上面写着为什么。
 */

// Compare 比两个版本。a 比 b 新返回正数。
func Compare(a, b string) int {
	pa := parse(a)
	pb := parse(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var x, y part
		if i < len(pa) {
			x = pa[i]
		} else {
			/*
			 * 一边比另一边短。
			 *
			 * `1.2` vs `1.2.0` 相等；`1.2` vs `1.2-beta` 里
			 * **短的那个更新** —— 因为预发布标签排在正式版之前。
			 * 判反的话，一个装了正式版的人会被一直提示「有更新」，
			 * 而那个更新是回退。
			 */
			if pb[i].isNum {
				x = part{isNum: true, num: 0}
			} else {
				return 1
			}
		}
		if i < len(pb) {
			y = pb[i]
		} else {
			if pa[i].isNum {
				y = part{isNum: true, num: 0}
			} else {
				return -1
			}
		}

		switch {
		case x.isNum && y.isNum:
			if x.num != y.num {
				return x.num - y.num
			}
		case x.isNum:
			// 数字段 > 标签段：1.2.0 比 1.2.0-beta 新
			return 1
		case y.isNum:
			return -1
		default:
			if x.text != y.text {
				if x.text < y.text {
					return -1
				}
				return 1
			}
		}
	}
	return 0
}

// Available 是「该更新了吗」。
func Available(current, latest string) bool {
	return Compare(latest, current) > 0
}

// Required 是「老到必须更新才能用」。
//
// 只在老版本会**做错事**时才该被服务端填上 —— 比如它把令牌写进了
// 世界可读的文件。平时留空：填上它等于把所有人赶下线一次，
// 而那个动作用多了就没人再当回事。
func Required(current, minSupported string) bool {
	if minSupported == "" {
		return false
	}
	return Compare(current, minSupported) < 0
}

type part struct {
	isNum bool
	num   int
	text  string
}

func parse(v string) []part {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	fields := strings.FieldsFunc(v, func(r rune) bool {
		return r == '.' || r == '-' || r == '+'
	})
	out := make([]part, 0, len(fields))
	for _, f := range fields {
		if n, err := strconv.Atoi(f); err == nil {
			out = append(out, part{isNum: true, num: n})
		} else {
			out = append(out, part{text: f})
		}
	}
	return out
}
