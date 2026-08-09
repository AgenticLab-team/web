import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EDIT_WINDOW_MS,
  MAX_REPLY_CHARS,
  canEditReply,
  checkReplyContent,
  collapsedView,
  shouldMarkEdited,
} from "@/lib/forum/reply-rules";
import { stripComments as strip } from "./_source";

/**
 * 编辑与折叠回复。
 *
 * ─────────────────────────────────────────
 * 三个字段一直在库里，一个都没接上
 * ─────────────────────────────────────────
 *
 * · `replies.edit_count` —— 列在、查询也读它，但没有任何地方写它
 * · `replies.collapsed` / `collapse_reason` —— 查询取出来了，
 *   而**界面上一处都没渲染**：折叠和不折叠长得一模一样
 * · `moderateReply` —— 支持四种动作，全站没有一个组件调它
 *
 * 第二条最糟：数据写进去了、看起来生效了，而实际什么都没发生。
 * 版主会以为自己折叠成功了。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

const NOW = 1_700_000_000_000;
const base = { isAuthor: true, status: "published", createdAt: NOW - 60_000, now: NOW };

describe("能不能改", () => {
  it("自己的、刚发的、正常状态 —— 可以", () => {
    assert.equal(canEditReply(base).ok, true);
  });

  it("别人的不行", () => {
    const r = canEditReply({ ...base, isAuthor: false });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /自己的/);
  });

  it("**被折叠或删除的改不了** —— 改了等于绕过处置", () => {
    for (const status of ["hidden", "deleted"]) {
      assert.equal(canEditReply({ ...base, status }).ok, false, `${status} 竟然能改`);
    }
  });

  it("**超过时间窗就不给改** —— 那时候对话已经往下走了", () => {
    /*
     * 回复是对话的一部分，底下可能已经有人引用它、回应它。
     * 悄悄改掉一条被引用过的回复，会让后面那串回应看起来莫名其妙。
     */
    const r = canEditReply({ ...base, createdAt: NOW - EDIT_WINDOW_MS - 1 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /有人在回应/);
  });

  it("刚好在窗口边界上还能改", () => {
    assert.equal(canEditReply({ ...base, createdAt: NOW - EDIT_WINDOW_MS }).ok, true);
  });

  it("时间窗不长不短 —— 太长等于没有，太短改不了错字", () => {
    assert.ok(EDIT_WINDOW_MS >= 5 * 60_000 && EDIT_WINDOW_MS <= 2 * 3600_000);
  });
});

describe("内容校验", () => {
  it("**不能改成空** —— 那等于删除，但不留删除记录", () => {
    /*
     * 引用它的那几条会指向一个空气泡，
     * 而没有任何地方说明发生过什么。
     */
    for (const raw of ["", "   ", "\n\n"]) {
      const r = checkReplyContent(raw);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.match(r.reason, /直接删/);
    }
  });

  it("太长要拒", () => {
    assert.equal(checkReplyContent("长".repeat(MAX_REPLY_CHARS + 1)).ok, false);
  });

  it("首尾空白去掉", () => {
    const r = checkReplyContent("  改好了  ");
    assert.equal(r.ok && r.content, "改好了");
  });
});

describe("**改过就标，没有「小改不算」**", () => {
  it("永远返回 true", () => {
    /*
     * 给出「改动很小就不标记」的口子之后，它会被用来
     * 悄悄改掉一句话的意思 —— 而那正是最需要标出来的那种改动。
     */
    assert.equal(shouldMarkEdited(), true);
  });

  it("action 里确实 +1 了 edit_count", () => {
    const code = strip(src("lib/forum/actions.ts"));
    const fn = code.slice(code.indexOf("function editReply"));
    assert.match(fn, /editCount: sql`\$\{replies\.editCount\} \+ 1`/);
  });

  it("界面上显示「编辑过 N 次」", () => {
    assert.match(src("app/(app)/forum/p/[id]/page.tsx"), /编辑过 \{reply\.editCount\} 次/);
  });
});

describe("**编辑不能变成绕过审核的后门**", () => {
  it("走和发表时一样的敏感词闸", () => {
    /*
     * 省掉的话：发一条干净的，然后编辑成任何内容 ——
     * 而审核只看发表那一刻。
     */
    const code = strip(src("lib/forum/actions.ts"));
    const fn = code.slice(code.indexOf("function editReply"));
    assert.match(fn, /checkContent\(/);
  });

  it("走同一个 markdown 渲染（净化 + @解析）", () => {
    const code = strip(src("lib/forum/actions.ts"));
    const fn = code.slice(code.indexOf("function editReply"));
    assert.match(fn, /renderMarkdown\(/);
    assert.match(fn, /mentionResolver\(\)/);
  });

  it("预览态下不能改", () => {
    const code = strip(src("lib/forum/actions.ts"));
    const fn = code.slice(code.indexOf("function editReply"));
    assert.match(fn.slice(0, 400), /assertNotPreviewing\(\)/);
  });

  it("**服务端再判一次时间窗** —— 页面开着不动半小时，按钮还在", () => {
    const code = strip(src("lib/forum/actions.ts"));
    const fn = code.slice(code.indexOf("function editReply"));
    assert.match(fn, /canEditReply\(/);
  });
});

describe("**折叠现在真的看得出来了**", () => {
  it("折叠后仍然显示是谁、第几楼、为什么", () => {
    /*
     * 折叠不是删除。藏得一干二净的话，
     * 引用过它的那几条就变成了自言自语。
     */
    const v = collapsedView({ authorName: "张三", floor: 7, reason: "跑题了" });
    assert.match(v.summary, /7 楼/);
    assert.match(v.summary, /张三/);
    assert.match(v.summary, /跑题了/);
    assert.equal(v.expandable, true);
  });

  it("没填理由时也不炸，但那不该发生 —— action 里必填", () => {
    const v = collapsedView({ authorName: "张三", floor: 7, reason: null });
    assert.ok(v.summary.length > 0);

    const mod = strip(src("lib/forum/moderation.ts"));
    const fn = mod.slice(mod.indexOf("function moderateReply"));
    assert.match(fn.slice(0, 400), /if \(!reason\) return fail/);
  });

  it("**界面真的渲染 collapsed 了** —— 之前一处都没有", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /<CollapsedWrap/);
    assert.match(page, /collapsed=\{reply\.collapsed\}/);
    assert.match(page, /reason=\{reply\.collapseReason\}/);
  });

  it("展开之后照常显示原文 —— 折叠表达的是「不值得占版面」，不是「不能看」", () => {
    const c = src("components/forum/CollapsedReply.tsx");
    assert.match(c, /\{open && <div/);
    assert.doesNotMatch(strip(c), /blur|打码|redact/);
  });
});

describe("**moderateReply 终于有调用点了**", () => {
  it("回复行里能折叠", () => {
    const row = src("components/forum/ReplyRow.tsx");
    assert.match(row, /moderateReply\(\{ replyId, action: "collapse"/);
  });

  it("**折叠要填理由才能提交** —— 没理由的折叠和随手删人没区别", () => {
    const row = src("components/forum/ReplyRow.tsx");
    assert.match(row, /disabled=\{busy \|\| !collapsing\.trim\(\)\}/);
  });

  it("不给自己的回复显示折叠 —— 自己的走删除", () => {
    const row = src("components/forum/ReplyRow.tsx");
    assert.match(row, /canModerate && !isMine/);
  });

  it("**界面的判据和服务端一致** —— 不一致会出现点了必然失败的按钮", () => {
    /*
     * moderateReply 服务端判的是「楼主，或者有 forum.post.delete.any」。
     */
    const manage = strip(src("lib/forum/manage.ts"));
    assert.match(manage, /moderateReplies: isAuthor \|\| canDeleteAny/);

    const mod = strip(src("lib/forum/moderation.ts"));
    const fn = mod.slice(mod.indexOf("function moderateReply"));
    assert.match(fn, /isOwner \|\|\s*\n?\s*can\(user, "forum\.post\.delete\.any"/);
  });
});

describe("接线", () => {
  it("能不能改在查询层算 —— 页面组件里读时钟既不纯，早晚两条还会用上不同的「现在」", () => {
    const q = strip(src("lib/forum/queries.ts"));
    const fn = q.slice(q.indexOf("function listReplies"));
    assert.match(fn, /const now = Date\.now\(\);/);
    assert.match(fn, /canEdit: canEditReply\(/);

    const page = strip(src("app/(app)/forum/p/[id]/page.tsx"));
    const loop = page.slice(page.indexOf("replies.map"));
    assert.doesNotMatch(loop.slice(0, 2000), /Date\.now\(\)/, "页面里又读了一次时钟");
  });

  it("原文传下去了 —— 渲染后的 HTML 回不去 markdown", () => {
    assert.match(src("lib/forum/queries.ts"), /content: r\.content,/);
    assert.match(src("app/(app)/forum/p/\\[id\\]/page.tsx".replace("\\[", "[").replace("\\]", "]")), /content=\{reply\.content\}/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/reply-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });

  it("用 SVG 图标不用 emoji", () => {
    for (const f of ["components/forum/CollapsedReply.tsx", "components/forum/ReplyRow.tsx"]) {
      assert.match(src(f), /lucide-react/);
      assert.doesNotMatch(strip(src(f)), /[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
