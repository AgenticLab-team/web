import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ARCHIVE_PAGE_SIZE,
  DEFAULT_ORDER,
  displayIndex,
  flipOrder,
  messageAnchor,
  messageLink,
  pageOfIndex,
  pageOfMessage,
  parseMessageId,
  resolveOrder,
  type MessageOrder,
} from "@/lib/messages/archive-rules";

/**
 * 「查看历史消息」这一整块。
 *
 * ─────────────────────────────────────────
 * 站长报的四件事
 * ─────────────────────────────────────────
 *
 * 1. 一条消息被排成三行 —— 一屏看不到几条
 * 2. 应该按时间倒序 —— 打开今天，看到的却是今天最早的那几条
 * 3. 手机上没法快速滑动去引用一条消息
 * 4. 谁 @ 了我，点进去只跳到那一天，还得自己在**几千条**里找
 *
 * 第 4 条是这里的重点，也是最容易做成「看起来做了」的一条：
 * 只要页码差一位，人点开就落到隔壁页，而页面本身一切正常 ——
 * 没有报错、没有空白，只是那条消息不在。所以下面对
 * 「按 id 算页码」的算法做了端到端的一致性验证，而不只是几个例子。
 */

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
/** 正则会匹配到注释里的字眼 —— 先把注释剥掉再断言 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("规则文件保持纯净", () => {
  it("archive-rules 不碰数据库、不碰 React", () => {
    /*
     * 它同时被服务端（算页码）、客户端（MessagePicker 里拼锚点）
     * 和通知生成方引用。沾上 db 之后，客户端那一侧会把整个
     * drizzle 打进包里，或者直接编译不过。
     */
    const rules = src("lib/messages/archive-rules.ts");
    for (const forbidden of ["server-only", "@/lib/db", "drizzle-orm", "react"]) {
      assert.ok(!rules.includes(`from "${forbidden}"`), `archive-rules 引了 ${forbidden}`);
    }
  });
});

// ── 第 2 条：排序 ────────────────────────────────────────────

describe("**默认最新在前**", () => {
  it("不带 order 参数就是倒序 —— 绝大多数访问都不带参数", () => {
    assert.equal(resolveOrder(undefined), "desc");
    assert.equal(DEFAULT_ORDER, "desc");
  });

  it("想按对话顺序读的人明确写 asc", () => {
    assert.equal(resolveOrder("asc"), "asc");
    assert.equal(resolveOrder("desc"), "desc");
  });

  it("认不出来的值回默认，不报错", () => {
    // ?order=ASC、?order=1、?order= 都会有人打出来
    for (const bad of ["ASC", "1", "", "newest", null, 3, {}]) {
      assert.equal(resolveOrder(bad), DEFAULT_ORDER);
    }
  });

  it("同名参数出现两次取第一个 —— ?order=asc&order=desc 不该抛错", () => {
    assert.equal(resolveOrder(["asc", "desc"]), "asc");
  });

  it("flipOrder 是对称的", () => {
    assert.equal(flipOrder("asc"), "desc");
    assert.equal(flipOrder("desc"), "asc");
  });

  it("**「整理成帖子」那条路仍然是正序** —— 倒过来的对话读起来是乱的", () => {
    /*
     * 这一条防的是「站长说倒序」被理解成「全站都倒序」。
     * 回看是检索行为（最新的最要紧），转帖是阅读行为（对话有先后）。
     * 两者都倒过来的话，转出来的帖子会变成一段倒放的对话，
     * 而人多半意识不到是顺序问题，只会觉得整理出来的东西看不懂。
     */
    const page = strip(src("app/(app)/forum/convert/page.tsx"));
    assert.match(page, /order:\s*"asc"/);

    // 库层的默认值也要是正序：调用方不传时不该悄悄变成倒序
    const source = strip(src("lib/forum/convert-source.ts"));
    assert.match(source, /options\.order \?\? "asc"/);
  });

  it("回看页把两种顺序并排放着，不藏进设置", () => {
    const page = strip(src("app/(app)/archive/page.tsx"));
    assert.match(page, /最新在前/);
    assert.match(page, /按对话顺序/);
  });
});

// ── 第 4 条：按 id 算出在第几页 ──────────────────────────────

describe("下标 → 页码", () => {
  it("从 0 数的下标，从 1 数的页码", () => {
    assert.equal(pageOfIndex(0, 100), 1);
    assert.equal(pageOfIndex(99, 100), 1);
    assert.equal(pageOfIndex(100, 100), 2);
    assert.equal(pageOfIndex(101, 100), 2);
  });

  it("perPage 为 0 或负数时不许算出 Infinity 页", () => {
    assert.equal(pageOfIndex(5, 0), 6);
    assert.equal(pageOfIndex(5, -3), 6);
  });

  it("负下标夹回 0 —— 算出第 0 页的话分页控件会指向一个不存在的页", () => {
    assert.equal(pageOfIndex(-4, 50), 1);
  });
});

describe("正序下标 → 显示顺序下标", () => {
  it("正序时原样", () => {
    assert.equal(displayIndex(0, 250, "asc"), 0);
    assert.equal(displayIndex(249, 250, "asc"), 249);
  });

  it("**倒序时第一条变最后一条**", () => {
    /*
     * 这个换算错了的表现很特别：正序看一切正常，
     * 一切到倒序，定位就跳到对称的另一头 ——
     * 早上第一条会把人送到当天最后一页。
     */
    assert.equal(displayIndex(0, 250, "desc"), 249);
    assert.equal(displayIndex(249, 250, "desc"), 0);
    assert.equal(displayIndex(10, 250, "desc"), 239);
  });
});

describe("**页码算出来就必须落在那一页上**", () => {
  /**
   * 端到端验一遍：按当前排序真的把这一天切成页，
   * 然后确认算出来的那一页里**确实**有这条消息。
   *
   * 只测几个例子挡不住 ±1 —— 差一位的错误只在页边界上现形，
   * 而页边界一天只有几十个位置。所以这里把每一条都过一遍。
   */
  const sliceOf = (
    ids: string[],
    order: MessageOrder,
    page: number,
    perPage: number,
  ): string[] => {
    const displayed = order === "desc" ? [...ids].reverse() : ids;
    return displayed.slice((page - 1) * perPage, page * perPage);
  };

  for (const total of [1, 99, 100, 101, 250, 4553]) {
    for (const order of ["asc", "desc"] as const) {
      it(`${total} 条 / ${order}：每一条都落在算出来的那一页里`, () => {
        const perPage = ARCHIVE_PAGE_SIZE;
        // 按时间正序排好的一天，id 就用下标
        const ids = Array.from({ length: total }, (_, i) => `m${i}`);
        for (let i = 0; i < total; i++) {
          const page = pageOfMessage({ indexAsc: i, total, order, perPage });
          assert.ok(page >= 1, `第 ${i} 条算出了第 ${page} 页`);
          assert.ok(
            sliceOf(ids, order, page, perPage).includes(`m${i}`),
            `第 ${i} 条算出第 ${page} 页，但那一页里没有它`,
          );
        }
      });
    }
  }

  it("空的一天不会算出第 0 页", () => {
    assert.equal(pageOfMessage({ indexAsc: 0, total: 0, order: "desc" }), 1);
  });
});

// ── 锚点与永久链接 ──────────────────────────────────────────

describe("锚点", () => {
  it("**加前缀** —— 上游的消息 id 是纯数字串，数字开头的 id 选不中", () => {
    /*
     * `document.getElementById("5811…")` 能拿到，但 `#5811…`
     * 在 CSS 选择器里不合法，`:target` 和 `scrollIntoView` 那条路会静默失效。
     */
    const anchor = messageAnchor("5811344628303360702");
    assert.equal(anchor, "msg-5811344628303360702");
    assert.doesNotMatch(anchor, /^\d/);
  });

  it("永久链接带得住：query 给服务端，hash 给浏览器", () => {
    const link = messageLink("123");
    // m 给服务端算群/日期/页码；# 让浏览器不用一行 JS 就滚过去
    assert.match(link, /^\/archive\?/);
    assert.match(link, /m=123/);
    assert.match(link, /#msg-123$/);
  });

  it("带上 group/date 当兜底 —— 消息被裁剪掉时至少还能落到那一天", () => {
    const link = messageLink("123", { convId: "20000000001@chatroom", date: "2026-08-04" });
    assert.match(link, /group=20000000001%40chatroom/);
    assert.match(link, /date=2026-08-04/);
    assert.match(link, /m=123/);
  });

  it("同一套链接也能指向「整理成帖子」那一页", () => {
    assert.match(messageLink("123", undefined, "/forum/convert"), /^\/forum\/convert\?m=123#/);
  });
});

describe("m 参数是敌对输入", () => {
  it("认得出正常的 id", () => {
    assert.equal(parseMessageId("5811344628303360702"), "5811344628303360702");
    assert.equal(parseMessageId(" 5811344628303360702 "), "5811344628303360702");
  });

  it("**卡形状**：它会被直接写进 DOM id 和 URL 片段", () => {
    for (const bad of [
      "",
      "  ",
      "a b",
      '"><script>alert(1)</script>',
      "../../etc/passwd",
      "#msg-1",
      "x".repeat(129),
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(parseMessageId(bad), null, `${JSON.stringify(bad)} 不该被放行`);
    }
  });

  it("同名参数出现两次取第一个", () => {
    assert.equal(parseMessageId(["abc", "def"]), "abc");
  });
});

// ── 隐私 ────────────────────────────────────────────────────

describe("**按 id 直达也要过群可见性**", () => {
  const locate = strip(src("lib/messages/locate.ts"));

  it("用现成的 assertGroupAccess，不另写一套判断", () => {
    /*
     * 群消息属于隐私：只有群里的人看得见。而消息 id 是上游给的
     * 数字串 —— 一个不校验成员身份的「按 id 取消息」接口
     * 等于把整个群的聊天记录变成可遍历的公开接口。
     */
    assert.match(locate, /assertGroupAccess\(user, target\.convId\)/);
    assert.doesNotMatch(locate, /groupMembers/, "自己写了一套成员判断");
  });

  it("拿不到就 return null，**不区分「不存在」和「没权限」**", () => {
    // 区分开的话，这个接口就成了「某条消息是否存在」的探测器
    assert.match(locate, /if \(!target\) return null;/);
    assert.match(locate, /if \(!assertGroupAccess\([\s\S]*?\)\) return null;/);
  });

  it("回看页把 m 交给 locateMessage，不自己查库", () => {
    const page = strip(src("app/(app)/archive/page.tsx"));
    assert.match(page, /locateMessage\(user, focusId/);
    assert.doesNotMatch(page, /from "drizzle-orm"/, "页面里直接拼查询会绕开收口");
  });

  it("「引用」那一页同样收口", () => {
    const page = strip(src("app/(app)/forum/convert/page.tsx"));
    assert.match(page, /locateMessage\(user, focusId/);
  });

  it("定位不到时静默退回按天回看，不提示「你看不了这条」", () => {
    const page = strip(src("app/(app)/archive/page.tsx"));
    // located 为 null 时一路 ?? 回落到普通参数
    assert.match(page, /located\?\.convId \?\?/);
    assert.match(page, /located\?\.date \?\?/);
  });
});

describe("**切页和算页码必须用同一套过滤条件**", () => {
  const source = strip(src("lib/forum/convert-source.ts"));
  const locate = strip(src("lib/messages/locate.ts"));

  it("过滤条件只有一份（dayScope），两边都用它", () => {
    // 两边各写一份的话，差一个 content != '' 就差一整个下标
    assert.match(source, /export function dayScope/);
    assert.match(locate, /import \{ dayScope \} from "@\/lib\/forum\/convert-source"/);
    assert.match(locate, /dayScope\(target\.convId, date\)/);
  });

  it("**排序带 id 做次级键** —— 同一秒好几条时，只按 ts 排会漏消息", () => {
    /*
     * 只按 ts 排时 SQLite 不保证同值行的相对顺序：
     * 翻页时同一条可能在第 1 页和第 2 页各出现一次，另一条一次都不出现。
     * 而列表看起来一切正常，没人会发现。
     */
    assert.match(source, /desc\(messages\.ts\), desc\(messages\.id\)/);
    assert.match(source, /asc\(messages\.ts\), asc\(messages\.id\)/);
    // 算下标那边用同样的次级键
    assert.match(locate, /lt\(messages\.id, messageId\)/);
  });

  it("页码经过 paginate 夹边界 —— ?page=999 要落到有内容的页上", () => {
    assert.match(source, /paginate\(options\.page, total, perPage\)/);
  });
});

// ── 第 1 条：一条消息一行 ────────────────────────────────────

describe("**一条消息不该占三行**", () => {
  const row = src("components/messages/ArchiveMessage.tsx");
  const stripped = strip(row);

  it("昵称收进正文行首，不再自己占一行", () => {
    /*
     * 原来是「第一行头像+昵称+时间，第二行引用块，第三行正文」——
     * 每条消息里有两行右边全是留白。群聊记录本来的读法就是
     * 「张三：在的」，收进同一行之后一屏从六七条变成二十多条。
     */
    assert.match(
      stripped,
      /<p className="t-subhead[^"]*">[\s\S]*?\{message\.senderName\}[\s\S]*?\{body\}[\s\S]*?<\/p>/,
    );
  });

  it("**一个字段都没删**：头像、昵称、时间、引用块、@ 高亮都还在", () => {
    // 「塞进一行」不等于「把信息扔掉」—— 扔掉的话没人能发现是什么时候没的
    assert.match(stripped, /<Avatar/);
    assert.match(stripped, /\{message\.senderName\}/);
    assert.match(stripped, /timeLabel\(message\.ts\)/);
    assert.match(stripped, /replyTarget/);
    assert.match(stripped, /<MessageText/);
    assert.match(stripped, /message\.type === "quote" && !replyTarget/);
  });

  it("右侧那两条窄栏是**整行高**的，不靠 44px 伪元素撑触摸面积", () => {
    /*
     * 行压到 30px 上下之后，.tap-target 的 44×44 伪元素会盖住
     * 上下相邻行的按钮 —— 点「引用」会引到隔壁那条，
     * 而这种错手没人会来报，只会觉得这个站点不准。
     */
    assert.match(stripped, /items-stretch/);
    assert.doesNotMatch(stripped, /tap-target/);
  });

  it("时间按社区时区渲染 —— 服务端渲染不写 timeZone 用的是服务器时区", () => {
    // 日期边界一直按东八区切，时间却按服务器时区显示的话，
    // 「这一天」的第一条会显示成前一天晚上
    assert.match(stripped, /timeZone: COMMUNITY_TIMEZONE/);
  });
});

describe("**定位过去要看得见**", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const row = strip(src("components/messages/ArchiveMessage.tsx"));

  it("高亮那一条", () => {
    // 只把它滚进视口的话，一屏里还有几十条长得一样的，等于没定位
    assert.match(row, /focused \? "msg-focus" : ""/);
    assert.match(css, /\.msg-focus \{/);
  });

  it("**常驻底色 + 短闪两层**，因为 reduce-motion 会把动画压成 0.01ms", () => {
    const block = css.slice(css.indexOf(".msg-focus {"), css.indexOf(".msg-focus {") + 300);
    assert.match(block, /background: var\(--accent-soft\)/);
    assert.match(block, /animation: msg-flash/);
  });

  it("闪完不留 forwards —— 那会永久持有 to 帧并造一个层叠上下文", () => {
    const block = css.slice(css.indexOf(".msg-focus {"), css.indexOf(".msg-focus {") + 300);
    assert.doesNotMatch(block, /forwards|both/);
  });

  it("锚点留出吸顶 chrome 的余量 —— 否则滚到位之后正好被压在下面", () => {
    assert.match(row, /scroll-mt-28/);
  });

  it("高亮由服务端按 m 参数直接渲染，不依赖 :target", () => {
    // 客户端路由是 pushState，:target 在部分浏览器上不跟着更新
    assert.doesNotMatch(css, /:target/);
  });
});

// ── 第 3 条：手机上引用 ──────────────────────────────────────

describe("**手机上要滑得动、点得中**", () => {
  const picker = src("components/forum/MessagePicker.tsx");
  const stripped = strip(picker);

  it("拖选不再靠 onPointerEnter —— 触摸指针被隐式捕获，它永远不触发", () => {
    /*
     * 这是「手机上拖选从来没生效过」的根因：pointerdown 那一刻
     * 触摸指针就被捕获到起始元素上了，后续事件只发给它，
     * 兄弟元素的 enter 不会来。用鼠标测是好的，所以能一直活着。
     */
    assert.doesNotMatch(stripped, /onPointerEnter/);
    assert.match(stripped, /elementFromPoint/);
    assert.match(stripped, /closest<HTMLElement>\("\[data-msg-id\]"\)/);
  });

  it("**碰一下不算选中** —— 手机上碰一下通常是想滚页面", () => {
    // 选中挂 onClick：浏览器判定成滚动手势时不派发 click
    assert.match(stripped, /onClick=\{\(\) => toggle\(message\.id\)\}/);
    // onPointerDown 只剩把手那一处
    assert.equal((stripped.match(/onPointerDown/g) ?? []).length, 1);
  });

  it("只有把手那一栏禁用触摸滚动，正文区照常滑", () => {
    // 整行禁用的话列表就滑不动了 —— 那比不能拖选更糟
    assert.match(stripped, /touchAction: "none"/);
    assert.match(stripped, /className="flex w-9 shrink-0 cursor-grab/);
  });

  it("圆点一直可见 —— 原来写的 group-hover 在没有 group 的父元素下永远透明", () => {
    assert.doesNotMatch(stripped, /group-hover/);
    assert.doesNotMatch(stripped, /opacity-0/);
  });

  it("按住把手时抓住指针，手指滑出列表也收得回 pointerup", () => {
    assert.match(stripped, /setPointerCapture\(e\.pointerId\)/);
    assert.match(stripped, /onPointerUp=\{\(\) => setDragging\(null\)\}/);
    assert.match(stripped, /onPointerCancel=\{\(\) => setDragging\(null\)\}/);
  });

  it("**引用的路径只有一步**：回看里点一下就到，且那条已经选好", () => {
    const row = strip(src("components/messages/ArchiveMessage.tsx"));
    const archive = strip(src("app/(app)/archive/page.tsx"));
    // 每条消息上一个常驻的小按钮 —— 长按会和文本选择/系统菜单打架，
    // 侧滑在这种密度下看不见也够不着
    assert.match(row, /quoteHref/);
    assert.match(archive, /messageLink\(message\.id, \{ convId, date: day \}, "\/forum\/convert"\)/);
    // 到了那一页，那条是预先选中的
    assert.match(stripped, /focusId \? new Set\(\[focusId\]\) : new Set\(\)/);
  });

  it("论坛功能关掉时不给引用入口 —— 点过去是 404", () => {
    const archive = strip(src("app/(app)/archive/page.tsx"));
    assert.match(archive, /featureEnabled\("forum", user\)/);
  });
});

// ── 链接改造 ────────────────────────────────────────────────

describe("**「谁 @ 了我」要直达那一条**", () => {
  it("@提及通知链到消息 id，不再只链到那一天", () => {
    const interactions = strip(src("lib/messages/interactions.ts"));
    assert.match(interactions, /messageLink\(item\.messageId/);
    assert.doesNotMatch(interactions, /link: `\/archive\?group=/, "还在链到整整一天");
  });

  it("成员主页的「最近被 @」同样直达", () => {
    const page = strip(src("app/(app)/members/[wxId]/page.tsx"));
    assert.match(page, /messageLink\(m\.messageId/);
  });

  it("检索结果能跳回群聊记录里的那一条", () => {
    // 就地展开只有前后 8 条；想看那半小时得回到回看页，
    // 而以前从搜索结果没有任何一条路过去
    const hits = strip(src("components/search/MessageHitList.tsx"));
    assert.match(hits, /messageLink\(hit\.id/);
  });
});

describe("**这一页不再一次渲染一整天**", () => {
  const source = strip(src("lib/forum/convert-source.ts"));
  const archive = strip(src("app/(app)/archive/page.tsx"));

  it("查询带 limit/offset —— 一天最多 4553 条", () => {
    assert.match(source, /\.limit\(slice\.perPage\)/);
    assert.match(source, /\.offset\(slice\.offset\)/);
  });

  it("只查这一页出现过的人，不再把整张 people 表拉进内存", () => {
    assert.match(source, /inArray\(people\.wxId, senderIds\)/);
  });

  it("两页都有分页控件，且翻页时不把筛选丢掉", () => {
    assert.match(archive, /<Pagination/);
    assert.match(strip(src("app/(app)/forum/convert/page.tsx")), /<Pagination/);
  });

  it("翻页时**不带**上 m —— 已经翻走了就不该继续假装在定位", () => {
    // pageHref 只透传传进去的参数，carry 里没有 m
    assert.match(archive, /params=\{carry\}/);
    assert.doesNotMatch(archive, /carry = \{[^}]*\bm\b/);
  });
});
