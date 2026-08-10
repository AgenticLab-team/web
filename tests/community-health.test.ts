import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

/**
 * 社群健康度。
 *
 * ─────────────────────────────────────────
 * 一个会说谎的仪表比没有仪表糟
 * ─────────────────────────────────────────
 *
 * 这一页的每个数字都会被拿去做判断：哪个群要干预、要不要找人聊聊、
 * 要不要合群。算错了没有人会发现 —— 因为**没有别的东西可以对照**，
 * 群主本来就是靠感觉，仪表说什么就是什么。
 *
 * 所以下面测的重点是**算法本身**，而不是「有没有渲染出来」：
 * 基尼和教科书定义逐位对齐，判定的每一档都用最小反例卡住。
 */

const TMP = mkdtempSync(join(tmpdir(), "al-health-"));
process.env.DB_PATH = join(TMP, "test.db");
process.env.NEKOBOT_API_KEY = "nk_test";
process.env.SITE_URL = "https://example.test";

/** 教科书定义：相对平均绝对差的一半。O(n²)，只在测试里用 */
function giniByDefinition(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  let sum = 0;
  for (const a of xs) for (const b of xs) sum += Math.abs(a - b);
  return sum / (2 * n * n * mean);
}

describe("发言集中度", async () => {
  const { gini, topShare } = await import("@/lib/admin/community-health");

  it("**和教科书定义逐位对齐** —— 用的是它的线性等价形式", () => {
    /*
     * 实现用的是排序后的线性公式（O(n log n)），
     * 教科书写的是两两绝对差（O(n²)）。两者数学上等价 ——
     * 但「我推导得没错」不是证据，跑一遍才是。
     */
    let worst = 0;
    for (let t = 0; t < 500; t++) {
      const n = 2 + (t % 25);
      // 固定的伪随机，跑出来每次一样 —— 偶发失败的测试等于没有测试
      const xs = Array.from({ length: n }, (_, i) => 1 + ((t * 7 + i * 13) % 97));
      worst = Math.max(worst, Math.abs(gini(xs) - giniByDefinition(xs)));
    }
    assert.ok(worst < 1e-12, `和教科书定义偏差 ${worst}`);
  });

  it("人人相同 = 0", () => {
    assert.equal(gini([5, 5, 5, 5]), 0);
    assert.equal(gini([1, 1]), 0);
  });

  it("**一个人几乎包圆 → 趋近 (n-1)/n**", () => {
    // 4 个人里 1 个人几乎包圆，理论上限 0.75
    assert.ok(gini([1000, 1, 1, 1]) > 0.7);
    assert.ok(gini([1000, 1, 1, 1]) <= 0.75);
  });

  it("两人 1:3 = 0.25", () => {
    assert.equal(gini([1, 3]), 0.25);
  });

  it("**只有一个人说话时是 0，不是 1**", () => {
    /*
     * 一个人的时候「不平等」没有意义。
     * 返回 1 的话，所有单人群都会被判成「集中」——
     * 而它们真正的问题是冷清，那是另一档，对应的动作完全不同。
     */
    assert.equal(gini([50]), 0);
    assert.equal(gini([]), 0);
  });

  it("**从没说过话的人不进分布**", () => {
    /*
     * 把 300 个没开口的成员按 0 算进去的话，每个群的基尼都会顶到
     * 0.95 上下 —— 数字还在，但它不再区分任何东西。
     * 沉默那部分由 silentRatio 单独讲。
     */
    assert.equal(gini([3, 3, 3, 0, 0, 0, 0]), 0, "0 被算进分布了");
  });

  it("**永远落在 0 和 1 之间**", () => {
    for (const xs of [[1e9, 1], [1, 1e9], [0.1, 0.2, 0.3], [7, 7, 7, 1]]) {
      const g = gini(xs);
      assert.ok(g >= 0 && g <= 1, `基尼跑出界了：${g}`);
    }
  });

  it("前三名占比", () => {
    assert.equal(topShare([10, 10, 10, 10, 10], 3), 0.6);
    assert.equal(topShare([100, 1, 1, 1], 3), 102 / 103);
    assert.equal(topShare([], 3), 0);
  });

  it("**前三名占比不看顺序** —— 传进来的顺序不该影响结果", () => {
    assert.equal(topShare([1, 50, 3, 2], 3), topShare([50, 3, 2, 1], 3));
  });
});

describe("判定", async () => {
  const { judge } = await import("@/lib/admin/community-health");

  const base = {
    messages7: 200,
    speakers7: 20,
    momentum: 0,
    gini: 0.3,
    top3Share: 0.3,
    everSpoke: 50,
  };

  it("一切正常 = 活跃", () => {
    assert.equal(judge(base).verdict, "healthy");
  });

  it("**一条都没有 = 停摆**", () => {
    assert.equal(judge({ ...base, messages7: 0 }).verdict, "idle");
  });

  it("**先判停摆再判退潮** —— 已经不说话的群不该只说它「退潮」", () => {
    /*
     * 顺序反过来的话，一个彻底安静的群会被判成「退潮」——
     * 那还留着余地，而它需要的是最强的那个词。
     */
    assert.equal(judge({ ...base, messages7: 0, momentum: -1 }).verdict, "idle");
  });

  it("**跌一半以上 = 退潮**", () => {
    assert.equal(judge({ ...base, momentum: -0.5 }).verdict, "fading");
    assert.equal(judge({ ...base, momentum: -0.9 }).verdict, "fading");
  });

  it("**跌得不够多的不报警** —— 报警多了就会被忽略", () => {
    assert.equal(judge({ ...base, momentum: -0.49 }).verdict, "healthy");
  });

  it("人少或量少 = 冷清", () => {
    assert.equal(judge({ ...base, speakers7: 3 }).verdict, "quiet");
    assert.equal(judge({ ...base, messages7: 9 }).verdict, "quiet");
  });

  it("**集中要两个条件同时成立**", () => {
    // 基尼高但前三没占住 —— 说明是长尾不均，不是几个人把着
    assert.equal(judge({ ...base, gini: 0.7, top3Share: 0.3 }).verdict, "healthy");
    // 前三占住但基尼不高 —— 人本来就少
    assert.equal(judge({ ...base, gini: 0.3, top3Share: 0.8 }).verdict, "healthy");
    assert.equal(judge({ ...base, gini: 0.7, top3Share: 0.8 }).verdict, "concentrated");
  });

  it("**每个判定都说得出依据** —— 只给结论的仪表没人会信", () => {
    for (const over of [
      { messages7: 0 },
      { momentum: -0.8 },
      { speakers7: 2 },
      { gini: 0.7, top3Share: 0.8 },
      {},
    ]) {
      const r = judge({ ...base, ...over });
      assert.ok(r.reasons.length > 0, `${r.verdict} 没有给依据`);
      assert.ok(r.reasons[0].length > 4);
    }
  });

  it("**基线为 0 时不判退潮** —— 新接入的群不是在退潮", () => {
    /*
     * 一个刚接入的群，之前两周的基线是 0。
     * 拿 0 做分母的话结果是 Infinity 或 NaN，
     * 而任何一个和 NaN 的比较都是 false —— 判定会静默走到别的分支。
     * 所以基线为 0 时 momentum 是 null，这里确认它不被当成暴跌。
     */
    assert.notEqual(judge({ ...base, momentum: null }).verdict, "fading");
  });
});

describe("真库", async () => {
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbm.db, { migrationsFolder: "./drizzle" });
  const { communityHealth } = await import("@/lib/admin/community-health");
  const { shiftDateKey } = await import("@/lib/time");

  after(() => rmSync(TMP, { recursive: true, force: true }));

  const TODAY = "2026-08-10";
  const G = "g@chatroom";

  function reset(syncEnabled = true) {
    for (const t of [schema.dailyStats, schema.groupMembers, schema.groups]) {
      dbm.db.delete(t).run();
    }
    dbm.db
      .insert(schema.groups)
      .values({ convId: G, name: "测试群", isGroup: true, memberCount: 10, syncEnabled })
      .run();
  }

  const member = (wxId: string) =>
    dbm.db.insert(schema.groupMembers).values({ convId: G, wxId }).run();

  const stat = (wxId: string, daysAgo: number, messages: number, quality = 0) =>
    dbm.db
      .insert(schema.dailyStats)
      .values({
        convId: G,
        wxId,
        date: shiftDateKey(TODAY, -daysAgo),
        messages,
        qualityMessages: quality,
        charsTotal: messages * 20,
      })
      .run();

  it("**没接入的群不出现**", () => {
    reset(false);
    stat("wx_a", 1, 100);
    assert.deepEqual(communityHealth(TODAY), []);
  });

  it("沉默比例 = 没说过话的人 / 群成员", () => {
    reset();
    for (let i = 0; i < 10; i++) member(`wx_${i}`);
    stat("wx_0", 1, 50);
    stat("wx_1", 1, 50);
    const [g] = communityHealth(TODAY);
    assert.equal(g.members, 10);
    assert.equal(g.everSpoke, 2);
    assert.equal(g.silentRatio, 0.8);
  });

  it("**成员表没同步全时不返回负数**", () => {
    /*
     * 说过话的人比成员表里的人还多是真实会发生的：
     * 成员是一次性快照，而消息是历史累计 —— 退群的人还在消息里。
     * 不夹的话页面上会出现「沉默 -34%」。
     */
    reset();
    member("wx_0");
    for (let i = 0; i < 5; i++) stat(`wx_${i}`, 1, 10);
    const [g] = communityHealth(TODAY);
    assert.equal(g.silentRatio, 0);
  });

  it("**势头按日均比，不按总量**", () => {
    /*
     * 两段窗口不一样长（最近 7 天 vs 之前 14 天）。
     * 直接比总量的话，一个**完全没有变化**的群会显示「少了 50%」——
     * 而那会让每一个正常的群都挂上退潮的红牌。
     */
    reset();
    member("wx_a");
    // 每天都是 10 条，一共三周 —— 势头应该是 0
    for (let d = 1; d <= 21; d++) stat("wx_a", d, 10);
    const [g] = communityHealth(TODAY);
    assert.ok(g.momentum !== null);
    assert.ok(Math.abs(g.momentum!) < 1e-9, `完全平稳却算出了 ${g.momentum}`);
    assert.notEqual(g.verdict, "fading");
  });

  it("**今天只过了一半，不能因此判退潮** —— 这一条是被真 bug 催出来的", () => {
    /*
     * 第一版把今天算进了最近那一段窗口。
     *
     * 于是一个每天 10 条、三周纹丝不动的群算出来是 **−14.3%**：
     * 窗口有 7 个格子，而今天那格还没攒满。
     *
     * 线上的表现会更难看 —— 早上九点打开这一页，今天只有三小时的
     * 消息，**每个群都会挂上退潮的红牌**，到晚上又自己好了。
     * 一个每天早上都误报的预警，一周内就会被彻底忽略，
     * 那时它连真的退潮也叫不醒人。
     *
     * 所以两段窗口都只取已经过完的整天。这里连「今天有一点点数据」
     * 的情况一起测 —— 那正是线上每天上午的样子。
     */
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (let d = 1; d <= 21; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);
    // 今天才刚开始，只有平时的十分之一
    for (let i = 0; i < 8; i++) stat(`wx_${i}`, 0, 1);

    const [g] = communityHealth(TODAY);
    assert.ok(
      Math.abs(g.momentum!) < 1e-9,
      `今天那半天把势头拉成了 ${g.momentum} —— 每天上午都会误报`,
    );
    assert.notEqual(g.verdict, "fading");
  });

  it("**归档缺的那些天不算进分母** —— 未知不是零", () => {
    /*
     * ─────────────────────────────────────────
     * 这一条是线上数据逼出来的
     * ─────────────────────────────────────────
     *
     * 归档有洞：2026-07-15 到 07-29 整整 15 天一条记录都没有，
     * 回填还没补到那儿。而基线窗口正好压在那一段上 ——
     * 4 天的数据除以 14 天，基线被压到真实值的三分之一，
     * 于是势头算出来是 **+1257%、+9950%**。
     *
     * 那种数字比错更糟：它一眼就假，而一个一眼就假的仪表，
     * 人会连同它旁边**真**的那些数字一起不信。
     *
     * 这里造一个同样的洞：基线段里只有 5 天有记录，另外 9 天是空的。
     * 每天的量前后完全一样，所以正确答案是 0%。
     */
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    // 基线段（8~21 天前）只有 5 天有记录
    for (const d of [8, 9, 10, 11, 12]) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);
    // 最近 7 天每天都有
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);

    const [g] = communityHealth(TODAY);
    assert.equal(g.baselineDays, 5, "基线天数该按有记录的天算");
    assert.ok(
      Math.abs(g.momentum!) < 1e-9,
      `前后每天一样多，却算出了 ${g.momentum} —— 洞被当成了零活跃`,
    );
    assert.notEqual(g.verdict, "fading");
  });

  it("**基线太薄就不下结论**，而不是给一个不靠谱的数", () => {
    /*
     * 剩下三四天的时候，一次群聊爆发就能把比值拉到几倍 ——
     * 那不是趋势，是噪声。宁可这一格显示「—」。
     */
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (const d of [8, 9, 10]) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 1);
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 500);

    const [g] = communityHealth(TODAY);
    assert.equal(g.baselineDays, 3);
    assert.equal(g.momentum, null, "基线只有 3 天却给了结论");
  });

  it("**基线天数摆出来了** —— 薄样本要看得见，不能藏", () => {
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (let d = 1; d <= 21; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);
    const [g] = communityHealth(TODAY);
    assert.equal(g.baselineDays, 14, "整段都有记录时该是满 14 天");
  });

  it("**真的腰斩会被认出来**", () => {
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (let d = 8; d <= 21; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 2);
    const [g] = communityHealth(TODAY);
    assert.ok(g.momentum! <= -0.5, `势头只算出 ${g.momentum}`);
    assert.equal(g.verdict, "fading");
  });

  it("**新接入的群没有基线，不判退潮**", () => {
    reset();
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (let i = 0; i < 8; i++) stat(`wx_${i}`, 1, 20);
    const [g] = communityHealth(TODAY);
    assert.equal(g.momentum, null);
    assert.notEqual(g.verdict, "fading");
  });

  it("趋势是 14 格，左旧右新，缺的天补 0", () => {
    reset();
    member("wx_a");
    stat("wx_a", 0, 7);
    stat("wx_a", 13, 3);
    const [g] = communityHealth(TODAY);
    assert.equal(g.trend.length, 14);
    assert.equal(g.trend[0], 3, "最左边应该是 13 天前");
    assert.equal(g.trend[13], 7, "最右边应该是今天");
    assert.equal(g.trend[5], 0);
  });

  it("**集中度只看最近 30 天**", () => {
    /*
     * 按全部历史算的话，早就不说话的老成员会一直摊薄分母 ——
     * 一个正在收缩成三个人的群看起来仍然很均匀，
     * 而那恰恰是这个指标要抓的情况。
     */
    reset();
    // 60 天前：20 个人平均说话
    for (let i = 0; i < 20; i++) stat(`old_${i}`, 60, 100);
    // 最近：只剩 1 个人在说
    stat("wx_solo", 1, 300);
    const [g] = communityHealth(TODAY);
    assert.equal(g.top3Share, 1, "把 60 天前的人算进集中度了");
  });

  it("高质量占比按近 30 天", () => {
    reset();
    member("wx_a");
    stat("wx_a", 1, 100, 25);
    const [g] = communityHealth(TODAY);
    assert.equal(g.qualityRatio, 0.25);
  });

  it("**一条消息都没有时不除以零**", () => {
    reset();
    member("wx_a");
    const [g] = communityHealth(TODAY);
    assert.equal(g.qualityRatio, 0);
    assert.equal(g.top3Share, 0);
    assert.equal(g.gini, 0);
    assert.equal(g.verdict, "idle");
    for (const v of [g.qualityRatio, g.top3Share, g.gini, g.silentRatio]) {
      assert.equal(Number.isFinite(v), true);
    }
  });

  it("**最需要干预的排在最前面**，不是最大的群", () => {
    reset();
    dbm.db
      .insert(schema.groups)
      .values({ convId: "big@chatroom", name: "大群", isGroup: true, syncEnabled: true })
      .run();
    // 大群健康且量大
    for (let d = 1; d <= 21; d++)
      for (let i = 0; i < 10; i++)
        dbm.db
          .insert(schema.dailyStats)
          .values({
            convId: "big@chatroom",
            wxId: `b_${i}`,
            date: shiftDateKey(TODAY, -d),
            messages: 50,
            qualityMessages: 10,
            charsTotal: 1000,
          })
          .run();
    // 小群在退潮
    for (let i = 0; i < 8; i++) member(`wx_${i}`);
    for (let d = 8; d <= 21; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 10);
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 8; i++) stat(`wx_${i}`, d, 1);

    const list = communityHealth(TODAY);
    assert.equal(list[0].name, "测试群", "健康的大群排到了退潮的小群前面");
    assert.equal(list[0].verdict, "fading");
  });
});

describe("归档缺口", async () => {
  /*
   * ─────────────────────────────────────────
   * 线上真有一个 15 天的洞，而没有任何地方在报
   * ─────────────────────────────────────────
   *
   * 2026-07-15 到 07-29，12 个群加起来一条消息都没有，
   * 07-14 有、07-30 又有了。12 个群同时安静半个月不是一种可能。
   *
   * 它的后果是安静的：按天回看翻到那半个月是空的，而页面只会说
   * 「这天没有消息」—— 和真的没人说话长得一模一样。
   * 同步健康那一页也不会红，因为同步本身是好的，缺的是历史。
   */
  const dbm = await import("@/lib/db");
  const schema = await import("@/lib/db/schema");
  const { archiveGaps } = await import("@/lib/admin/community-health");

  const put = (date: string) =>
    dbm.db
      .insert(schema.dailyStats)
      .values({ convId: "gap@chatroom", wxId: "wx_x", date, messages: 5, charsTotal: 100 })
      .run();

  const clear = () => dbm.db.delete(schema.dailyStats).run();

  it("**连续缺 2 天以上才算缺口**", () => {
    clear();
    put("2026-07-01");
    // 只缺 1 天 —— 不报
    put("2026-07-03");
    assert.deepEqual(archiveGaps(), []);
  });

  it("找得出缺口，边界是缺的那几天本身", () => {
    clear();
    put("2026-07-14");
    put("2026-07-30");
    const [gap] = archiveGaps();
    assert.equal(gap.from, "2026-07-15");
    assert.equal(gap.to, "2026-07-29");
    assert.equal(gap.days, 15);
  });

  it("**只在归档自己的范围里找** —— 不报「1970 年到现在都缺」", () => {
    clear();
    put("2026-07-14");
    put("2026-07-15");
    assert.deepEqual(archiveGaps(), []);
  });

  it("多个缺口按大小排，最大的在前", () => {
    clear();
    put("2026-07-01");
    put("2026-07-05"); // 缺 3 天
    put("2026-07-20"); // 缺 14 天
    const gaps = archiveGaps();
    assert.equal(gaps[0].days, 14);
    assert.equal(gaps[1].days, 3);
  });

  it("一天记录都没有时不报错", () => {
    clear();
    assert.deepEqual(archiveGaps(), []);
    put("2026-07-01");
    assert.deepEqual(archiveGaps(), []);
  });
});

describe("接线", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/admin/community/page.tsx", import.meta.url),
    "utf8",
  );

  it("**只读权限点也进得来** —— 否则那个勾等于不存在", () => {
    assert.match(page, /requireAdmin\(\["group\.manage", "group\.stats\.read"\]\)/);
  });

  it("**导航里有它** —— 后台页面到不了等于没做", () => {
    const nav = readFileSync(new URL("../src/lib/admin/nav.ts", import.meta.url), "utf8");
    assert.match(nav, /href: "\/admin\/community"/);
    assert.match(nav, /alsoAllows: \["group\.stats\.read"\]/);
  });

  it("**页面写明了哪两个指标做不了**", () => {
    /*
     * 少两块而不说的话，看的人会以为这就是全部 ——
     * 而「留存率」恰恰是群主最想要的那个数。
     * 说清楚它为什么不在，比悄悄不做要紧。
     */
    assert.match(page, /留存/);
    assert.match(page, /话题/);
  });

  it("**判定的依据要渲染出来**", () => {
    assert.match(page, /g\.reasons/);
  });

  it("**归档缺口排在最前面** —— 它决定这一页的数字能不能信", () => {
    /*
     * 缺口不是「某个群的问题」，是所有趋势的可信度问题。
     * 放在下面的话，人会先看完一堆数字，
     * 最后才知道那些数字不能全信。
     */
    const gapAt = page.indexOf("归档里有缺口");
    const groupsAt = page.indexOf("groups.map");
    assert.ok(gapAt > 0, "页面上没有渲染归档缺口");
    assert.ok(gapAt < groupsAt, "缺口提示排在群卡片后面了");
  });

  it("**势头旁边写着基于几天** —— 薄样本不能藏", () => {
    assert.match(page, /基于 \$\{g\.baselineDays\} 天/);
  });
});
