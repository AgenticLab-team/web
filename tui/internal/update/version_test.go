package update

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int // -1 / 0 / 1，只看符号
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.1.0", "1.0.9", 1},
		{"2.0.0", "1.99.99", 1},
		{"1.0.0", "1.0.1", -1},

		// 前缀 v 不算数
		{"v1.2.3", "1.2.3", 0},

		// 短的补零：1.2 == 1.2.0
		{"1.2", "1.2.0", 0},

		/*
		 * 预发布排在正式版**之前**。
		 *
		 * 判反的话，一个装了 1.2.0 的人会被一直提示「有更新」，
		 * 而那个更新是 1.2.0-beta —— 一次回退。
		 */
		{"1.2.0", "1.2.0-beta", 1},
		{"1.2.0-beta", "1.2.0", -1},
		{"1.2.0-beta.2", "1.2.0-beta.1", 1},
	}
	for _, c := range cases {
		got := Compare(c.a, c.b)
		sign := 0
		if got > 0 {
			sign = 1
		} else if got < 0 {
			sign = -1
		}
		if sign != c.want {
			t.Errorf("Compare(%q, %q) = %d，想要符号 %d", c.a, c.b, got, c.want)
		}
	}
}

func TestAvailable(t *testing.T) {
	if !Available("1.0.0", "1.0.1") {
		t.Error("有新版却说没有")
	}
	if Available("1.0.1", "1.0.0") {
		t.Error("服务端版本更旧，不该提示更新 —— 那是一次回退")
	}
	if Available("1.0.0", "1.0.0") {
		t.Error("同一版不该提示更新")
	}
}

func TestRequired(t *testing.T) {
	// 平时留空 —— 留空时永远不强制
	if Required("0.0.1", "") {
		t.Error("没填 minSupported 时不该强制更新")
	}
	if !Required("1.0.0", "1.1.0") {
		t.Error("低于下限却没要求更新")
	}
	if Required("1.1.0", "1.1.0") {
		t.Error("等于下限就不该被赶下线")
	}
}

func TestParseGarbage(t *testing.T) {
	// 服务端配错了不该让客户端 panic —— 它只是不更新
	if Compare("", "") != 0 {
		t.Error("空串之间应该相等")
	}
	_ = Compare("不是版本号", "1.0.0")
}
