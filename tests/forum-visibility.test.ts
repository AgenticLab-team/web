import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canSeePost,
  capVisibility,
  GUEST,
  isIndexable,
  isStricter,
  normalizePostVisibility,
  type PostVisibilityInfo,
  type ViewerContext,
} from "@/lib/forum/visibility";
import { VISIBILITY_LEVELS, type Visibility } from "@/lib/db/schema/forum";

/**
 * 可见性矩阵测试。
 *
 * 6 个可见性级别 × 6 类身份 = 36 种组合逐一断言。
 * 这是论坛里最不能出错的地方，靠人工推理必然漏 ——
 * 写成表格反而一眼能看出哪里不对。
 */

const AUTHOR = "u_author";
const ROLE = "role_vip";
const GROUP = "g1@chatroom";

const viewers: Record<string, ViewerContext> = {
  访客: GUEST,
  外部用户: { userId: "u_ext", kind: "external", groupIds: [], roleIds: [], canModerate: false },
  非本群成员: { userId: "u_other", kind: "member", groupIds: ["g2@chatroom"], roleIds: [], canModerate: false },
  本群成员: { userId: "u_in", kind: "member", groupIds: [GROUP], roleIds: [], canModerate: false },
  持有身份组者: { userId: "u_vip", kind: "member", groupIds: [], roleIds: [ROLE], canModerate: false },
  管理员: { userId: "u_admin", kind: "member", groupIds: [], roleIds: [], canModerate: true },
};

function post(visibility: Visibility, extra: Partial<PostVisibilityInfo> = {}): PostVisibilityInfo {
  return {
    visibility,
    visibilityRoleId: ROLE,
    visibilityGroupId: GROUP,
    authorId: AUTHOR,
    status: "published",
    ...extra,
  };
}

/** 期望表：行=可见性，列=身份。true 表示应当可见 */
const EXPECTED: Record<Visibility, Record<string, boolean>> = {
  public:   { 访客: true,  外部用户: true,  非本群成员: true,  本群成员: true,  持有身份组者: true,  管理员: true },
  unlisted: { 访客: true,  外部用户: true,  非本群成员: true,  本群成员: true,  持有身份组者: true,  管理员: true },
  member:   { 访客: false, 外部用户: true,  非本群成员: true,  本群成员: true,  持有身份组者: true,  管理员: true },
  role:     { 访客: false, 外部用户: false, 非本群成员: false, 本群成员: false, 持有身份组者: true,  管理员: true },
  group:    { 访客: false, 外部用户: false, 非本群成员: false, 本群成员: true,  持有身份组者: false, 管理员: true },
  private:  { 访客: false, 外部用户: false, 非本群成员: false, 本群成员: false, 持有身份组者: false, 管理员: true },
};

describe("可见性矩阵（6 级 × 6 身份）", () => {
  for (const level of VISIBILITY_LEVELS) {
    for (const [viewerName, viewer] of Object.entries(viewers)) {
      const expected = EXPECTED[level][viewerName];
      it(`${level} 对「${viewerName}」${expected ? "可见" : "不可见"}`, () => {
        const verdict = canSeePost(post(level), viewer);
        assert.equal(
          verdict.visible,
          expected,
          verdict.visible ? "不该可见却可见了" : `不该被拒：${(verdict as { reason: string }).reason}`,
        );
      });
    }
  }

  it("作者对自己的帖子在任何级别都可见", () => {
    const author: ViewerContext = {
      userId: AUTHOR,
      kind: "member",
      groupIds: [],
      roleIds: [],
      canModerate: false,
    };
    for (const level of VISIBILITY_LEVELS) {
      assert.equal(canSeePost(post(level), author).visible, true, `${level} 作者看不到自己的帖子`);
    }
  });
});

describe("硬约束", () => {
  it("① 群聊派生内容即使标成 public，访客也看不到", () => {
    // 这一条是兜底：万一某处漏了规范化，读取侧仍然拦得住
    const leaked = post("public", { fromGroupChat: true });
    assert.equal(canSeePost(leaked, GUEST).visible, false);
    assert.equal(canSeePost(leaked, viewers.外部用户).visible, false);
  });

  it("① 群聊派生内容不可被搜索引擎索引", () => {
    assert.equal(isIndexable(post("public", { fromGroupChat: true })), false);
    assert.equal(isIndexable(post("public")), true);
    assert.equal(isIndexable(post("unlisted")), false, "unlisted 明确不进索引");
  });

  it("② 群聊转帖写入时被压到 group 级并锁定", () => {
    const result = normalizePostVisibility({
      requested: "public",
      boardMax: "public",
      fromGroupChat: true,
      sourceGroupId: GROUP,
    });
    assert.equal(result.visibility, "group", "不管请求什么，群聊转帖只能是 group");
    assert.equal(result.visibilityGroupId, GROUP);
    assert.equal(result.locked, true, "必须锁定，否则普通编辑就能改公开");
  });

  it("③ external 用户拿不到任何群级内容", () => {
    // external 的 groupIds 恒为空，所以 group 级天然拒绝
    assert.equal(canSeePost(post("group"), viewers.外部用户).visible, false);
  });
});

describe("版块封顶", () => {
  it("严格程度排序正确", () => {
    assert.equal(isStricter("private", "public"), true);
    assert.equal(isStricter("public", "private"), false);
    assert.equal(isStricter("member", "member"), false);
  });

  it("请求比封顶宽时取封顶", () => {
    assert.equal(capVisibility("public", "member"), "member");
    assert.equal(capVisibility("unlisted", "group"), "group");
  });

  it("请求比封顶严时保留请求", () => {
    // 用户想设得更私密是允许的，封顶只管上限
    assert.equal(capVisibility("private", "member"), "private");
    assert.equal(capVisibility("group", "public"), "group");
  });

  it("普通帖子走封顶且不锁定", () => {
    const result = normalizePostVisibility({ requested: "public", boardMax: "member" });
    assert.equal(result.visibility, "member");
    assert.equal(result.locked, false);
  });
});

describe("内容状态", () => {
  it("草稿只有作者与管理员看得到", () => {
    const draft = post("public", { status: "draft" });
    assert.equal(canSeePost(draft, GUEST).visible, false);
    assert.equal(canSeePost(draft, viewers.非本群成员).visible, false);
    assert.equal(canSeePost(draft, viewers.管理员).visible, true);
  });

  it("已删除的内容只有管理员看得到，作者也不行", () => {
    // 作者能看到自己被删的帖子，就等于删除没生效
    const removed = post("public", { status: "deleted" });
    const author: ViewerContext = { ...GUEST, userId: AUTHOR, kind: "member" };
    assert.equal(canSeePost(removed, author).visible, false);
    assert.equal(canSeePost(removed, viewers.管理员).visible, true);
  });

  it("被隐藏的内容作者仍可见，好让他知道发生了什么", () => {
    const hidden = post("public", { status: "hidden" });
    const author: ViewerContext = { ...GUEST, userId: AUTHOR, kind: "member" };
    assert.equal(canSeePost(hidden, author).visible, true);
    assert.equal(canSeePost(hidden, viewers.非本群成员).visible, false);
  });
});

describe("配置缺失时的兜底", () => {
  it("role 级但没配身份组 → 拒绝而不是放行", () => {
    const broken = post("role", { visibilityRoleId: null });
    assert.equal(canSeePost(broken, viewers.持有身份组者).visible, false);
  });

  it("group 级但没配群 → 拒绝而不是放行", () => {
    const broken = post("group", { visibilityGroupId: null });
    assert.equal(canSeePost(broken, viewers.本群成员).visible, false);
  });
});
