import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_LOCK_REASON,
  canLock,
  canUnlock,
  checkLockReason,
  isLocked,
  lockKind,
  lockNotice,
} from "@/lib/forum/lock-rules";

/**
 * 楼主锁自己的帖子 + 阅读进度。
 *
 * ─────────────────────────────────────────
 * 锁帖原来只有版主做得了
 * ─────────────────────────────────────────
 *
 * 而 FORUM.md 4.3 一直写着楼主可以锁自己的 ——
 * 「这个问题解决了，不用再讨论了」是楼主该有的动作，
 * 和「这串已经吵起来了，版主叫停」完全是两件事。
 *
 * ─────────────────────────────────────────
 * 难的不是加锁，是解锁
 * ─────────────────────────────────────────
 *
 * 楼主一旦能解锁，他就能解掉**版主**加的那把锁 ——
 * 版主叫停、楼主解开、再吵起来，处罚形同虚设。
 *
 * 删除那边早就是这么办的（`deletedBy`：作者自删的自己能恢复，
 * 管理员删的必须走申诉）。这里照抄同一条线。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const AUTHOR = "u_author";
const MOD = "u_mod";
const STRANGER = "u_other";

const author = { userId: AUTHOR, canModerate: false };
const moderator = { userId: MOD, canModerate: true };
const stranger = { userId: STRANGER, canModerate: false };

const open = { authorId: AUTHOR, status: "published", lockedBy: null };
const lockedByAuthor = { authorId: AUTHOR, status: "locked", lockedBy: AUTHOR };
const lockedByMod = { authorId: AUTHOR, status: "locked", lockedBy: MOD };

describe("谁能锁", () => {
  it("**楼主锁得了自己的**", () => {
    assert.equal(canLock(author, open), true);
  });

  it("版主锁得了任何一个", () => {
    assert.equal(canLock(moderator, open), true);
  });

  it("路人锁不了", () => {
    assert.equal(canLock(stranger, open), false);
  });

  it("没登录锁不了", () => {
    assert.equal(canLock(null, open), false);
  });

  it("已经锁上的不能再锁 —— 那个按钮不该出现", () => {
    assert.equal(canLock(author, lockedByAuthor), false);
    assert.equal(canLock(moderator, lockedByMod), false);
  });
});

describe("**谁能解锁 —— 这里是真正的分界线**", () => {
  it("楼主解得开自己加的那把", () => {
    assert.equal(canUnlock(author, lockedByAuthor), true);
  });

  it("**楼主解不开版主加的那把** —— 否则处罚形同虚设", () => {
    /*
     * 版主叫停、楼主解开、再吵起来 —— 这条路必须是死的。
     */
    assert.equal(canUnlock(author, lockedByMod), false);
  });

  it("版主两把都解得开", () => {
    assert.equal(canUnlock(moderator, lockedByAuthor), true);
    assert.equal(canUnlock(moderator, lockedByMod), true);
  });

  it("路人解不开", () => {
    assert.equal(canUnlock(stranger, lockedByAuthor), false);
  });

  it("没锁的时候没有解锁这回事", () => {
    assert.equal(canUnlock(author, open), false);
    assert.equal(canUnlock(moderator, open), false);
  });

  it("**历史数据（lockedBy 为 null）当成版主锁的**", () => {
    /*
     * 这两列加进来之前只有版主能锁 —— 所以这个默认值是事实，
     * 不是保守猜测。当成楼主锁的话，这次改动会顺手把
     * 所有历史处罚交到被处罚的人手上。
     */
    const legacy = { authorId: AUTHOR, status: "locked", lockedBy: null };
    assert.equal(canUnlock(author, legacy), false);
    assert.equal(canUnlock(moderator, legacy), true);
  });
});

describe("**两种锁在读者眼里不是一回事**", () => {
  it("分得出来是谁锁的", () => {
    assert.equal(lockKind(open), "none");
    assert.equal(lockKind(lockedByAuthor), "author");
    assert.equal(lockKind(lockedByMod), "moderator");
  });

  it("楼主收尾说「楼主结束了这个讨论」", () => {
    /*
     * 「该帖已锁定」只说了发生什么，没说为什么。
     * 楼主收尾的帖子仍然值得读（多半还有个结论），
     * 被版主叫停的那种则是在说「这里出过问题」。
     */
    assert.match(lockNotice(lockedByAuthor, "已经解决了"), /楼主结束了这个讨论：已经解决了/);
  });

  it("版主叫停说「版主锁定了这个帖子」", () => {
    assert.match(lockNotice(lockedByMod, "吵起来了"), /版主锁定了这个帖子：吵起来了/);
  });

  it("没理由时也成句", () => {
    assert.ok(lockNotice(lockedByAuthor, null).length > 0);
    assert.ok(lockNotice(lockedByMod, "   ").length > 0);
  });

  it("isLocked 只认 locked 这一个状态", () => {
    assert.equal(isLocked("locked"), true);
    for (const s of ["published", "draft", "hidden", "deleted"]) {
      assert.equal(isLocked(s), false);
    }
  });
});

describe("理由必填", () => {
  it("空的拒，并说清楚这句话会被谁看到", () => {
    const r = checkLockReason("   ");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /显示给看帖的人/);
  });

  it("太长拒", () => {
    assert.equal(checkLockReason("长".repeat(MAX_LOCK_REASON + 1)).ok, false);
  });

  it("压平空白 —— 它会被当成一行显示", () => {
    const r = checkLockReason("已经  解决\n了");
    assert.equal(r.ok && r.reason, "已经 解决 了");
  });
});

describe("**界面和服务端用同一组函数**", () => {
  it("PostCaps 的 lock / unlock 走 lock-rules", () => {
    /*
     * 两处各判一遍的话，早晚会出现一个点了必然失败的按钮 ——
     * 或者更糟：一个不该出现却生效的按钮。
     */
    const manage = strip(src("lib/forum/manage.ts"));
    assert.match(manage, /lock: canLock\(lockActor, post\)/);
    assert.match(manage, /unlock: canUnlock\(lockActor, post\)/);
  });

  it("moderatePostCore 里 lock/unlock 也走它，不再只看权限", () => {
    const manage = strip(src("lib/forum/manage.ts"));
    const fn = manage.slice(manage.indexOf("function moderatePostCore"));
    assert.match(fn, /input\.action === "lock" \? canLock\(lockActor, post\) : canUnlock\(lockActor, post\)/);
  });

  it("**lock / unlock 是两个能力，不是一个** —— 合成一个楼主就能解版主的锁", () => {
    const manage = src("lib/forum/manage.ts");
    assert.match(manage, /unlock: boolean;/);
    const menu = src("components/forum/PostManageMenu.tsx");
    assert.match(menu, /caps\.unlock &&/);
  });

  it("锁上时记下是谁锁的、为什么", () => {
    const manage = strip(src("lib/forum/manage.ts"));
    assert.match(manage, /patch\.lockedBy = actor\.id;/);
    assert.match(manage, /patch\.lockReason = shaped\.reason;/);
  });

  it("解开时把痕迹清掉 —— 留着的话下次谁锁的就说不清了", () => {
    const manage = strip(src("lib/forum/manage.ts"));
    const fn = manage.slice(manage.indexOf('case "unlock"'), manage.indexOf('case "pin"'));
    assert.match(fn, /patch\.lockedBy = null;/);
    assert.match(fn, /patch\.lockReason = null;/);
  });

  it("楼主看到的是「结束讨论」，不是「锁定回复」", () => {
    /*
     * 「锁定回复」是处置动作的说法，而楼主做的是给自己的帖子收尾 ——
     * 同一个词会让人以为自己在处罚别人，于是不敢点。
     */
    assert.match(src("components/forum/PostManageMenu.tsx"), /isMine \? "结束讨论" : "锁定回复"/);
  });

  it("帖子页把锁定原因显示出来", () => {
    const page = src("app/(app)/forum/p/[id]/page.tsx");
    assert.match(page, /lockNotice\(/);
    assert.match(src("components/forum/ReplyForm.tsx"), /lockNotice \?\? "该帖已锁定"/);
  });

  it("规则层不碰数据库", () => {
    const code = src("lib/forum/lock-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm"]) {
      assert.equal(code.includes(forbidden), false, `规则层引了 ${forbidden}`);
    }
  });
});

describe("阅读进度", () => {
  const c = src("components/forum/ReadingProgress.tsx");

  it("**短帖里一个字都不出现**", () => {
    /*
     * 一屏半就能看完的帖子挂一条进度条，是在给一个不存在的问题
     * 提供答案 —— 而它会一直占着视线最上面那一行。
     */
    assert.match(c, /scrollHeight > window\.innerHeight \* 1\.5/);
    assert.match(c, /if \(!enabled\) return null;/);
  });

  it("**页面变长了要重新量** —— 图多的帖子在图片加载完之前量出来是短的", () => {
    assert.match(c, /new ResizeObserver\(onChange\)/);
  });

  it("滚动监听是 passive + rAF 节流 —— 一秒几十次，每次算布局会掉帧", () => {
    assert.match(c, /addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    assert.match(c, /requestAnimationFrame\(update\)/);
  });

  it("**楼层号只在滚的时候露出来**", () => {
    /*
     * 常驻的话，读一段静止的文字时眼角一直挂着一个数字。
     */
    assert.match(c, /setScrolling\(false\), 1000/);
    assert.match(c, /scrolling && floor > 0 \? "opacity-100" : "opacity-0"/);
  });

  it("给的是楼层号，不只是百分比 —— 楼层才是能拿去引用的坐标", () => {
    assert.match(c, /\{floor\} \/ \{maxFloor\}/);
  });

  it("**对读屏隐藏** —— 每次滚动都变的百分比只是噪音", () => {
    assert.equal((c.match(/aria-hidden/g) ?? []).length >= 2, true);
  });

  it("**不跟着登录状态走** —— 「我读到哪了」对访客一样成立", () => {
    const page = strip(src("app/(app)/forum/p/[id]/page.tsx"));
    const at = page.indexOf("<ReadingProgress");
    const gate = page.indexOf("{user && !onlyAuthor && (");
    assert.ok(at > 0 && gate > 0 && at < gate, "被塞进登录判断里了");
  });

  it("用 useSyncExternalStore 而不是 effect 里 setState", () => {
    assert.match(c, /useSyncExternalStore\(subscribeResize, isLongEnough, \(\) => false\)/);
  });
});
