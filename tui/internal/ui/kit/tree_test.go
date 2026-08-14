package kit

import (
	"encoding/json"
	"testing"
)

/*
 * `Params()` 是「对当前这一行所在的那个东西做点什么」的基础 ——
 * 投票、收藏、举报、报名全靠它拿 id。
 *
 * 它拿错 id 的后果是**动作成功了，只是作用在错的对象上** ——
 * 而屏幕上会显示「做完了」。所以这几条要钉死。
 */

func parse(t *testing.T, src string) *Tree {
	t.Helper()
	return Parse(json.RawMessage(src))
}

func TestParamsFromLeafFindsItsOwnParent(t *testing.T) {
	// 两条链接，光标停在第二条的一个字段上
	tree := parse(t, `{"items":[
		{"id":"aaa","title":"第一条"},
		{"id":"bbb","title":"第二条"}
	]}`)

	// 展开到叶子：顶层已经展开，把 items 和两个元素都展开
	for i := 0; i < len(tree.rows); i++ {
		tree.cursor = i
		if tree.rows[i].count > 0 {
			tree.Toggle()
		}
	}

	// 找到「第二条」那个 title 叶子
	found := false
	for i, r := range tree.rows {
		if r.value == "第二条" {
			tree.cursor = i
			found = true
			break
		}
	}
	if !found {
		t.Fatal("树里找不到「第二条」那一行 —— 展开逻辑变了？")
	}

	got := tree.Params()
	if got["id"] != "bbb" {
		t.Errorf("拿到的是 %q，该是 bbb —— 往上找的时候串到前一个兄弟身上了", got["id"])
	}
}

func TestParamsOnContainerRowItself(t *testing.T) {
	tree := parse(t, `{"items":[{"id":"aaa","title":"第一条"}]}`)
	for i := range tree.rows {
		tree.cursor = i
		if tree.rows[i].count > 0 {
			tree.Toggle()
		}
	}
	for i, r := range tree.rows {
		if r.linkParams["id"] == "aaa" {
			tree.cursor = i
			break
		}
	}
	if tree.Params()["id"] != "aaa" {
		t.Error("光标就停在那个对象的头上，却没拿到它自己的 id")
	}
}

func TestParamsEmptyWhenNothingHasID(t *testing.T) {
	tree := parse(t, `{"total": 3, "note": "没有 id"}`)
	if len(tree.Params()) != 0 {
		t.Error("这份数据里没有任何 id，不该凭空给一个出来")
	}
}

func TestToggleDoesNotPanicAtBoundary(t *testing.T) {
	/*
	 * 折叠之后行数会变少。游标不夹住的话下一次渲染会越界 ——
	 * 而那是一次崩溃，用户看到的是终端突然回到 shell。
	 */
	tree := parse(t, `{"a":{"b":{"c":1}}}`)
	for i := range tree.rows {
		tree.cursor = i
		tree.Toggle()
	}
	tree.cursor = len(tree.rows) + 10
	tree.Toggle()
	tree.Collapse()
	_ = tree.Params()
	_, _ = tree.Link()
}

func TestScalarRendersIntegersWithoutExponent(t *testing.T) {
	/*
	 * JSON 的数字在 Go 里是 float64。直接 `%v` 的话，
	 * 一个毫秒时间戳会显示成 `1.786646856204e+12` ——
	 * 而人完全看不出那是什么。
	 */
	tree := parse(t, `{"ts": 1786646856204}`)
	for _, r := range tree.rows {
		if r.key == "ts" {
			if r.value != "1786646856204" {
				t.Errorf("大整数显示成了 %q", r.value)
			}
			return
		}
	}
	t.Fatal("没找到 ts 那一行")
}

func TestTruncateCountsDisplayWidth(t *testing.T) {
	/*
	 * 中文一个字占两格。按 rune 数截的话，一行中文会超出去一倍宽 ——
	 * 而超出去的部分会把布局撞散，右边那一栏整个错位。
	 */
	got := Truncate("一二三四五", 6, "…")
	// 6 格装得下两个汉字 + 省略号（省略号自己也占一格）
	if len([]rune(got)) > 3 {
		t.Errorf("按显示宽度截应该只剩两三个字符，实际 %q", got)
	}
}
