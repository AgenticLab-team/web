import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { NOTIFICATION_TYPES } from "@/lib/db/schema";
import {
  ALWAYS_ON,
  FILTER_LABELS,
  SECTION_HINTS,
  SECTION_LABELS,
  TYPE_FILTERS,
  TYPE_META,
  canUseEmail,
  defaultPrefs,
  filterTypes,
  isAlwaysOn,
  isEnabled,
  normalizePrefs,
  parseFilter,
  sanitizeSubmission,
  type NotificationFilter,
} from "@/lib/notifications/prefs";

describe("默认值", () => {
  it("默认全开 —— 默认关掉的通知等于没有通知", () => {
    const prefs = defaultPrefs();
    for (const type of NOTIFICATION_TYPES) {
      assert.equal(prefs[type].site, true, `${type} 默认是关的`);
    }
  });

  it("每个通知类型都有默认值，加类型时不会漏", () => {
    assert.deepEqual(Object.keys(defaultPrefs()).sort(), [...NOTIFICATION_TYPES].sort());
  });

  it("邮件默认关 —— 通道还没接", () => {
    assert.equal(canUseEmail(), false);
    for (const type of NOTIFICATION_TYPES) {
      assert.equal(defaultPrefs()[type].email, false);
    }
  });
});

describe("关不掉的那几类 —— 对当事人不利的消息不该能被静音", () => {
  it("处罚和系统公告关不掉", () => {
    assert.deepEqual([...ALWAYS_ON].sort(), ["moderation", "system"]);
    assert.equal(isAlwaysOn("moderation"), true);
    assert.equal(isAlwaysOn("system"), true);
    assert.equal(isAlwaysOn("reaction"), false);
  });

  it("**存了 false 也强制发出去** —— 前端能被绕过，规则要在这里再判一次", () => {
    const tampered = normalizePrefs({
      moderation: { site: false, email: false },
      system: { site: false, email: false },
    });
    assert.equal(tampered.moderation.site, true);
    assert.equal(tampered.system.site, true);
    assert.equal(isEnabled(tampered, "moderation"), true);
  });

  it("提交路径上也拦得住 —— 改一行请求体绕不过去", () => {
    const submitted = sanitizeSubmission({ moderation: { site: false, email: true } });
    assert.equal(submitted.moderation.site, true);
    assert.equal(isEnabled(submitted, "moderation"), true);
  });

  it("能关的那几类是真的能关", () => {
    const prefs = normalizePrefs({ reaction: { site: false, email: false } });
    assert.equal(isEnabled(prefs, "reaction"), false);
    assert.equal(isEnabled(prefs, "mention"), true);
  });
});

describe("归一化 —— 存量数据不会是完整形状", () => {
  it("空的、null、字符串都退回默认", () => {
    for (const raw of [null, undefined, "x", 42, []]) {
      const prefs = normalizePrefs(raw);
      assert.equal(prefs.mention.site, true, `${JSON.stringify(raw)} 没退回默认`);
    }
  });

  it("**缺的字段按「发」补齐** —— 加新类型时老用户不该静默失去它", () => {
    const prefs = normalizePrefs({ reaction: { site: false, email: false } });
    for (const type of NOTIFICATION_TYPES) {
      if (type === "reaction") continue;
      assert.equal(prefs[type].site, true, `${type} 被当成了关`);
    }
  });

  it("不认识的类型丢掉，不让面板长出鬼条目", () => {
    const prefs = normalizePrefs({ some_old_type: { site: false, email: false } });
    assert.equal("some_old_type" in prefs, false);
    assert.deepEqual(Object.keys(prefs).sort(), [...NOTIFICATION_TYPES].sort());
  });

  it("字段类型不对时按默认处理，而不是当成 falsy", () => {
    const prefs = normalizePrefs({ mention: { site: "no", email: 1 } });
    assert.equal(prefs.mention.site, true);
    assert.equal(prefs.mention.email, false);
  });

  it("归一化是幂等的", () => {
    const once = normalizePrefs({ reaction: { site: false, email: false } });
    assert.deepEqual(normalizePrefs(once), once);
  });
});

describe("是否该发", () => {
  it("没见过的类型默认发 —— 漏发比多发糟", () => {
    assert.equal(isEnabled({}, "brand_new_type"), true);
  });

  it("邮件通道没接上时一律不发，不管开关是什么", () => {
    const prefs = normalizePrefs({ mention: { site: true, email: true } });
    assert.equal(isEnabled(prefs, "mention", "email"), false);
  });
});

describe("面板呈现", () => {
  it("**每个通知类型都要在面板上出现** —— 不然那一类永远关不掉", () => {
    const listed = new Set(TYPE_META.map((m) => m.type));
    for (const type of NOTIFICATION_TYPES) {
      assert.ok(listed.has(type), `${type} 没出现在通知设置面板里`);
    }
    assert.equal(TYPE_META.length, NOTIFICATION_TYPES.length, "面板上有多余的条目");
  });

  it("每一类都有一句「什么时候会收到」", () => {
    for (const meta of TYPE_META) {
      assert.ok(meta.label.length > 0, `${meta.type} 没有标题`);
      assert.ok(meta.hint.length > 4, `${meta.type} 没有说明 —— 用户只能靠猜`);
      assert.notEqual(meta.label, meta.type, `${meta.type} 直接把类型名显示给了用户`);
    }
  });

  it("关不掉的那几类都归在「与你的账号有关」里", () => {
    for (const meta of TYPE_META) {
      if (isAlwaysOn(meta.type)) {
        assert.equal(meta.section, "account", `${meta.type} 分组不对`);
      }
    }
  });

  it("每个分组都有名字和说明", () => {
    for (const section of new Set(TYPE_META.map((m) => m.section))) {
      assert.ok(SECTION_LABELS[section]?.length > 0);
      assert.ok(SECTION_HINTS[section]?.length > 0);
    }
  });

  it("account 分组的说明要讲清楚为什么关不掉", () => {
    assert.match(SECTION_HINTS.account, /关不掉|静音/);
  });
});

describe("列表筛选", () => {
  it("认识的筛选值原样返回，不认识的退回全部", () => {
    assert.equal(parseFilter("mention"), "mention");
    assert.equal(parseFilter("unread"), "unread");
    assert.equal(parseFilter("../../etc/passwd"), "all");
    assert.equal(parseFilter(undefined), "all");
  });

  it("**每个筛选项引用的类型都真实存在** —— 打错一个字那页就永远空着", () => {
    for (const key of Object.keys(FILTER_LABELS) as NotificationFilter[]) {
      for (const type of filterTypes(key) ?? []) {
        assert.ok(
          (NOTIFICATION_TYPES as readonly string[]).includes(type),
          `筛选 ${key} 引用了不存在的类型 ${type}`,
        );
      }
    }
  });

  it("除了「未读」，每一类通知都至少能被一个页签筛出来", () => {
    const covered = new Set(
      (["mention", "reply", "following", "radar", "account"] as const).flatMap((k) => [
        ...(filterTypes(k) ?? []),
      ]),
    );
    const uncovered = NOTIFICATION_TYPES.filter((t) => !covered.has(t));
    /*
     * reaction / featured / accepted / title 只在「全部」里，这是有意的：
     * 它们量大且不紧急，单开一个页签只会占位置。
     *
     * `title`（解锁称号）是后来从 `system` 里拆出来的 ——
     * 它以前混在「与你的账号有关」那一档里，而那一档是**关不掉**的，
     * 于是不关心徽章的人被迫收一串静不了音的消息。
     */
    assert.deepEqual([...uncovered].sort(), ["accepted", "featured", "reaction", "title"]);
  });

  /* matchesFilter 已删：页面按 filterTypes() 拼 SQL，不在内存里过滤 */
  it("回复页签盖住三种回复，不含 @", () => {
    const types = filterTypes("reply") ?? [];
    assert.deepEqual([...types].sort(), ["reply_to_post", "reply_to_reply", "subscribed_reply"]);
    // @提及不在回复页签里 —— 上面那条 deepEqual 已经把它排除掉了
  });

  it("每个页签都有中文名", () => {
    for (const key of Object.keys(FILTER_LABELS) as NotificationFilter[]) {
      assert.ok(FILTER_LABELS[key].length > 0);
      assert.notEqual(FILTER_LABELS[key], key);
    }
  });
});

describe("**页签清单只有一份**", () => {
  it("TYPE_FILTERS 是从 FILTER_TYPES 推出来的，不是手写的第二份", () => {
    /*
     * 加「关注」页签时，计数那边还手写着 ["mention","reply","radar","account"]——
     * 漏掉一个的表现是那一格永远显示 0：页签看起来空的，点进去却有东西。
     * 而这种 bug 只有真的关注了人的用户才会遇到。
     */
    assert.deepEqual(
      [...TYPE_FILTERS].sort(),
      (Object.keys(FILTER_LABELS) as NotificationFilter[])
        .filter((k) => filterTypes(k) !== null)
        .sort(),
    );
    assert.equal(TYPE_FILTERS.includes("all"), false);
    assert.equal(TYPE_FILTERS.includes("unread"), false);
  });

  it("计数那边不再手写页签清单", () => {
    const code = readFileSync(new URL("../src/lib/forum/notify.ts", import.meta.url), "utf8");
    const fn = code.slice(code.indexOf("function notificationCounts"));
    assert.match(fn.slice(0, 900), /TYPE_FILTERS/);
    assert.doesNotMatch(fn.slice(0, 900), /"mention", "reply"/);
  });
});

/* ───────────────────────────────────────────────────────────────
 * 称号解锁不该关不掉
 *
 * 线上 27 条 `system` 通知里 **26 条是「解锁称号」**，
 * 而 `system` 在 ALWAYS_ON 里 —— 关不掉。
 *
 * 于是不关心徽章的人被迫收一串静不了音的消息。
 * 而 ALWAYS_ON 存在的理由恰恰是相反的：
 * 「一旦有一类消息可能被关掉，所有没收到的消息都不能再说明什么」——
 * 反过来，**关不掉的噪音会让人忽略整个通道**，
 * 连带把真正要紧的那一条一起淹掉。
 * ─────────────────────────────────────────────────────────────── */

describe("**称号解锁是可以关掉的**", () => {
  it("它有自己的类型", () => {
    assert.ok((NOTIFICATION_TYPES as readonly string[]).includes("title"));
  });

  it("**不在 ALWAYS_ON 里**", () => {
    assert.equal(isAlwaysOn("title"), false);
  });

  it("而「系统公告」仍然关不掉 —— 它装的是你的发言被整理成帖子这类事", () => {
    assert.equal(isAlwaysOn("system"), true);
    assert.equal(isAlwaysOn("moderation"), true);
  });

  it("偏好面板里能找到它", () => {
    const meta = TYPE_META.find((m) => m.type === "title");
    assert.ok(meta, "偏好面板里没有这一项，等于关不掉");
    assert.equal(meta.section, "recognition");
  });

  it("**发称号的地方真的改了类型**", () => {
    const settle = readFileSync(new URL("../src/lib/titles/settle.ts", import.meta.url), "utf8");
    assert.equal(settle.includes('type: "system"'), false, "还在发 system");
    assert.match(settle, /type: "title"/);
  });

  it("**历史通知会被改签** —— 不改的话它们永远躺在「系统公告」下面", () => {
    /*
     * 用户按类型筛选、按类型静音时看到的都是错的。
     * 幂等：改完一次之后那条 UPDATE 再也匹配不到行。
     *
     * 改签和别的一次性数据修复放在一起（lib/db/repairs.ts）——
     * 它们有一批共同的要求：幂等、说得出为什么、报得出修了几行。
     */
    const repairs = readFileSync(new URL("../src/lib/db/repairs.ts", import.meta.url), "utf8");
    assert.match(repairs, /LIKE '解锁称号%'/);
    assert.match(repairs, /SET type = 'title'/);
  });
});

describe("**类型清单只有一份**", () => {
  it("notify.ts 不再自己抄一份", () => {
    /*
     * 它原来手写了同样的十一个类型。两份手写的清单迟早有一份落后 ——
     * 而真的落后了：加 `title` 时 schema 那份加上了、这一份没有，
     * 于是调用点过不了类型检查，**而报错指向的是调用点，不是抄件**。
     *
     * 运气好在它是编译期错误。换成运行时的分支判断
     * （比如「这一类要不要推送」），表现就会是
     * 「某一类通知静悄悄地不生效」。
     */
    const notify = readFileSync(new URL("../src/lib/forum/notify.ts", import.meta.url), "utf8");
    assert.equal(
      /export type NotificationType =\s*\n?\s*\|/.test(notify),
      false,
      "notify.ts 又自己列了一份类型清单",
    );
    assert.match(notify, /export type \{ NotificationType \}/);
  });
});
