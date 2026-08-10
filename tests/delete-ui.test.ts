import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCode, readSource } from "./_source";

/**
 * 注销的入口与确认。
 *
 * ─────────────────────────────────────────
 * 这一层要防的不是坏人，是手滑
 * ─────────────────────────────────────────
 *
 * 注销不可撤销。而它出现在一个日常设置页上，
 * 旁边就是「改通知偏好」「看登录记录」这类随手点的东西。
 *
 * 所以三道闸：必须是本人（不能在预览别人身份时触发）、
 * 必须手打确认词、删完立刻登出。
 *
 * ─────────────────────────────────────────
 * 告知必须排在确认之前
 * ─────────────────────────────────────────
 *
 * 放在旁边或下面的话，人会先打完确认词再读到 ——
 * 而那时注意力已经在按钮上了。
 *
 * 尤其第一条：他很可能以为注销能删掉自己的微信发言。删不掉。
 * **等他发现时已经没有账号可以登回来问了。**
 */

const action = readCode("lib/users/delete-actions.ts");
const ui = readCode("components/me/DeleteAccount.tsx");
const uiText = readSource("components/me/DeleteAccount.tsx");
const page = readCode("app/(app)/me/security/page.tsx");
const adminAction = readCode("lib/admin/user-actions.ts");

describe("**自助注销的三道闸**", () => {
  it("**预览别人身份时不能触发**", () => {
    /*
     * getCurrentUser 在预览态下返回的是被预览的那个人。
     * 只用它的话，管理员开着预览随手点一下，删掉的是别人的账号 ——
     * 这是这个功能能造成的最坏后果。
     */
    assert.match(action, /const real = await getRealUser\(\)/);
    assert.match(action, /real\.id !== user\.id/);
  });

  it("**必须手打确认词**", () => {
    assert.match(action, /input\.confirm\.trim\(\) !== CONFIRM_WORD/);
    // 界面上按钮在打对之前是禁用的 —— 不可撤销的操作不该只隔一次点击
    assert.match(ui, /disabled=\{!ready \|\| pending\}/);
    assert.match(ui, /confirm\.trim\(\) === CONFIRM_WORD/);
  });

  it("**删完立刻登出**", () => {
    /*
     * 不登出的话，页面上还挂着一个已经不存在的账号，
     * 下一步操作会撞上各种「查不到」，而人会以为是没删掉。
     */
    assert.match(action, /await clearSessionCookie\(\)/);
    assert.match(action, /redirect\(/);
  });

  it("**审计写在删除之前**", () => {
    /*
     * 写在后面的话，一旦删除成功而审计写失败，
     * 就成了一次没有任何记录的账号消失 —— 而 audit_logs 正是注销时
     * 刻意保留的那一档，为的就是这种时候查得到。
     */
    const auditAt = action.indexOf("audit(");
    const deleteAt = action.indexOf("deleteAccount(");
    assert.ok(auditAt > 0 && deleteAt > 0);
    assert.ok(auditAt < deleteAt, "审计写在删除后面了");
  });
});

describe("**告知在确认之前**", () => {
  it("三条都摊开渲染，不折叠", () => {
    // 一个需要点开才看得到的免责说明，等于没有说
    assert.match(ui, /MUST_DISCLOSE\.map/);
  });

  it("**排在输入框上面**", () => {
    const disclose = ui.indexOf("MUST_DISCLOSE.map");
    const input = ui.indexOf("value={confirm}");
    assert.ok(disclose > 0 && input > 0);
    assert.ok(disclose < input, "告知排在确认框后面了 —— 人会先打完再读到");
  });

  it("**入口不藏在二级页面里**", () => {
    /*
     * 「你的数据你能拿走」是这个站信任基建的一部分。
     * 一个找不到的注销入口，和没有注销一样 ——
     * 区别只是前者还显得像有。
     */
    assert.match(page, /<DeleteAccount \/>/);
  });

  it("**先提醒可以导出数据** —— 注销之后就导不了了", () => {
    assert.match(readSource("app/(app)/me/security/page.tsx"), /注销之后就导不了了/);
  });

  it("**默认收起** —— 日常设置页上不该常驻一个红色的不可撤销按钮", () => {
    assert.match(ui, /const \[open, setOpen\] = useState\(false\)/);
  });
});

describe("**后台删号**", () => {
  it("要 user.delete 权限", () => {
    assert.match(adminAction, /requireWritableAdmin\("user\.delete"\)/);
  });

  it("**必须写理由，而且比封禁要求更长**", () => {
    // 不可撤销的操作，「清理」两个字不算理由
    assert.match(adminAction, /reason\.length < 6/);
  });

  it("**不能在后台删自己**", () => {
    /*
     * 删掉自己之后名下的角色也跟着没了 —— 如果他恰好是唯一一个
     * 有 user.delete 的人，这个能力就永远消失了。
     */
    assert.match(adminAction, /input\.userId === admin\.user\.id/);
  });

  it("**审计里留下删的是谁** —— 删完那一行只剩个壳", () => {
    /*
     * 昵称微信号全清空了，不留一份的话日志翻出来是一串查不到人的 id，
     * 而这正是最需要查得清楚的一类操作。
     */
    assert.match(adminAction, /targetLabel: target\.siteNickname/);
    assert.match(adminAction, /before: \{ status: target\.status, wxId: target\.wxId \}/);
  });

  it("已经注销过的不重复删", () => {
    assert.match(adminAction, /target\.status === "deleted"/);
  });
});

describe("文案", () => {
  it("**确认词是中文且明确**", () => {
    assert.match(readCode("lib/users/deletion-plan.ts"), /CONFIRM_WORD = "注销我的账号"/);
  });

  it("**确认词不放在 use server 文件里** —— 那样整个构建会失败", () => {
    /*
     * 「use server」文件**只允许导出 async 函数**。导出一个常量会让
     * 构建挂掉，而且报的是「该模块没有任何导出」——
     * 第一眼完全看不出是这个原因。这一条被真实的构建失败催出来。
     */
    assert.equal(action.includes('CONFIRM_WORD = '), false, 'CONFIRM_WORD 又被放回 use server 文件里了');
    assert.match(action, /^"use server";/);
  });

  it("**界面上不写「删除数据」这种会让人误解的话**", () => {
    /*
     * 群聊记录删不掉。界面上任何一句「删除你的全部数据」
     * 都会让人以为微信发言也一起没了 —— 而那是这个功能最坏的误解。
     */
    for (const bad of ["删除你的全部数据", "清除所有数据", "彻底删除全部"]) {
      assert.equal(uiText.includes(bad), false, `文案里出现了「${bad}」`);
    }
  });
});
