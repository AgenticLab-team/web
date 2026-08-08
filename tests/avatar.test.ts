import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialOf, paletteFor } from "@/components/Avatar";
import { normalizeAvatarUrl } from "@/lib/avatar";

describe("头像占位", () => {
  it("中文取首字", () => {
    assert.equal(initialOf("牛牛酱"), "牛");
  });

  it("英文取首字母并大写", () => {
    assert.equal(initialOf("jmr"), "J");
    assert.equal(initialOf("ShipOwner"), "S");
  });

  it("emoji 昵称取完整 emoji 而不是半个代理对", () => {
    // 直接 slice(0,1) 会切出半个代理对，渲染成方框
    assert.equal(initialOf("🌊ShowMeAI"), "🌊");
    assert.equal(initialOf("👨‍👩‍👧 一家人"), "👨‍👩‍👧");
  });

  it("空昵称有兜底", () => {
    assert.equal(initialOf(""), "?");
    assert.equal(initialOf("   "), "?");
  });

  it("同一个 wxId 永远得到同一个颜色", () => {
    const a = paletteFor("wxid_examplemember01");
    const b = paletteFor("wxid_examplemember01");
    assert.deepEqual(a, b);
  });

  it("不同 wxId 会分散到不同颜色", () => {
    const seen = new Set(
      ["wxid_a", "wxid_b", "wxid_c", "wxid_d", "wxid_e", "wxid_f"].map(
        (id) => paletteFor(id).bg,
      ),
    );
    assert.ok(seen.size >= 3, `6 个 id 只落到 ${seen.size} 种颜色，分散得不够`);
  });
});

describe("头像 URL 归一化", () => {
  it("http 升级为 https", () => {
    // 站点是 HTTPS，http 图片会被浏览器当混合内容拦掉且页面上毫无提示
    assert.equal(
      normalizeAvatarUrl("http://wx.qlogo.cn/mmhead/ver_1/abc/0"),
      "https://wx.qlogo.cn/mmhead/ver_1/abc/0",
    );
  });

  it("https 保持不变", () => {
    assert.equal(
      normalizeAvatarUrl("https://mmhead.hk.wechat.com/mmhead/ver_1/x/0"),
      "https://mmhead.hk.wechat.com/mmhead/ver_1/x/0",
    );
  });

  it("非微信域名一律拒绝", () => {
    // 这个字段来自外部数据，不限制就是任意图片注入点
    assert.equal(normalizeAvatarUrl("https://evil.example.com/x.png"), null);
    assert.equal(normalizeAvatarUrl("javascript:alert(1)"), null);
    assert.equal(normalizeAvatarUrl("data:image/svg+xml,<svg/>"), null);
  });

  it("空值与非法 URL 返回 null", () => {
    assert.equal(normalizeAvatarUrl(null), null);
    assert.equal(normalizeAvatarUrl(""), null);
    assert.equal(normalizeAvatarUrl("   "), null);
    assert.equal(normalizeAvatarUrl("not a url"), null);
  });
});
