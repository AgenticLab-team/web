import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  MAX_PENDING,
  PROMPT_TTL_DAYS,
  expiredPromptIds,
  prCandidates,
  prefillFor,
  repoCandidates,
  selectPrompts,
  subjectKeyForPr,
  subjectKeyForRepo,
  type PromptCandidate,
} from "@/lib/github/prompt-rules";
import {
  MAX_SHOWCASE,
  isStale,
  mayRefresh,
  rankRepos,
  sanitizePinned,
  showcaseRepos,
  type RepoFact,
} from "@/lib/github/repo-rules";
import { stripComments as strip } from "./_source";

/**
 * 「有新项目 / 新 PR，要不要发个帖」。
 *
 * ═════════════════════════════════════════
 * 这个功能只有一种失败方式
 * ═════════════════════════════════════════
 *
 * 它变成一个每天都在那儿、永远消不掉、越看越烦的红点。
 * 一旦变成那样，人学会的不是「去分享」，是**无视这一整块区域** ——
 * 而被无视的区域以后放什么都没用了。
 *
 * 所以下面几乎每一条测的都是**上限**，不是命中率：提示过一次就不再提、
 * 绑定当天的旧东西一条都不提、同时最多三条、挂久了自动消失。
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 9);

const cand = (over: Partial<PromptCandidate> & { subjectKey: string }): PromptCandidate => ({
  kind: "repo",
  title: "some-repo",
  url: "https://github.com/me/some-repo",
  summary: null,
  repoFullName: "me/some-repo",
  subjectAt: NOW - DAY,
  ...over,
});

describe("**提示过一次就不再提示第二次 —— 不管他采纳了没有**", () => {
  /*
   * 这是整个功能的地基。用户点了「不用了」之后那条记录**留在库里**
   * （状态变 dismissed），下一轮检测按 subject_key 跳过它。
   *
   * 如果做成「处理完就删」，下一轮会发现这个仓库没见过，
   * 于是又提示一遍 —— 而那正是用户刚刚明确说不要的东西。
   */
  it("见过的 subjectKey 一条都不会再产生", () => {
    const selected = selectPrompts({
      candidates: [cand({ subjectKey: "repo:1" }), cand({ subjectKey: "repo:2" })],
      known: new Set(["repo:1"]),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.deepEqual(
      selected.map((s) => s.subjectKey),
      ["repo:2"],
    );
  });

  it("「见过」不区分当时的结果 —— 采纳过的、拒绝过的、过期的，一视同仁", () => {
    const selected = selectPrompts({
      candidates: [cand({ subjectKey: "repo:1" })],
      known: new Set(["repo:1"]),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.deepEqual(selected, []);
  });

  it("库里靠唯一索引兜底，代码里的判断只是为了少写一行", () => {
    // 查询和插入之间有窗口；并发进来两个请求时，只有约束挡得住
    const migration = readFileSync(
      new URL("../drizzle/0042_github.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `github_prompts_subject_idx` ON `github_share_prompts` \(`user_id`,`subject_key`\)/,
    );
  });

  it("落库走 onConflictDoNothing —— 撞上就是「提过了」，不是错误", () => {
    const src = readFileSync(new URL("../src/lib/github/prompts.ts", import.meta.url), "utf8");
    assert.match(src.replace(/\/\*[\s\S]*?\*\//g, ""), /onConflictDoNothing\(\)/);
  });
});

describe("**刚绑定的时候一条都不提示**", () => {
  /*
   * 一个写了十年代码的人绑完会有 60 个仓库。全变成提示的话，
   * 这个功能在他眼里第一天就死了 —— 而下一条真正有用的提示
   * 会和这 60 条一起被划掉。
   */
  it("baseline 模式下全部记成 baseline，没有一条 pending", () => {
    const selected = selectPrompts({
      candidates: [
        cand({ subjectKey: "repo:1" }),
        cand({ subjectKey: "repo:2" }),
        cand({ subjectKey: "repo:3" }),
      ],
      known: new Set(),
      pendingCount: 0,
      now: NOW,
      mode: "baseline",
    });
    assert.equal(selected.length, 3, "记录还是要落，不然下次会被当成新的");
    assert.deepEqual(new Set(selected.map((s) => s.status)), new Set(["baseline"]));
  });

  it("baseline 之后的新东西才提示", () => {
    const selected = selectPrompts({
      candidates: [cand({ subjectKey: "repo:1" }), cand({ subjectKey: "repo:new" })],
      known: new Set(["repo:1"]),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.deepEqual(selected, [
      { ...cand({ subjectKey: "repo:new" }), status: "pending" },
    ]);
  });
});

describe("**同时最多三条，多了就不是提示而是收件箱**", () => {
  it("超出名额的仍然落库，但状态是 baseline", () => {
    /*
     * 不落库的话它下次会被当成新的再来一遍，而「下次」永远存在 ——
     * 于是它会一直排在队头堵着，直到用户去处理它。
     */
    const many = Array.from({ length: 6 }, (_, i) =>
      cand({ subjectKey: `repo:${i}`, subjectAt: NOW - i * 1000 }),
    );
    const selected = selectPrompts({
      candidates: many,
      known: new Set(),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.equal(selected.length, 6, "全部都要留下记录");
    assert.equal(selected.filter((s) => s.status === "pending").length, MAX_PENDING);
  });

  it("已经挂着的那些占名额", () => {
    const selected = selectPrompts({
      candidates: [cand({ subjectKey: "a" }), cand({ subjectKey: "b" })],
      known: new Set(),
      pendingCount: MAX_PENDING - 1,
      now: NOW,
      mode: "live",
    });
    assert.equal(selected.filter((s) => s.status === "pending").length, 1);
  });

  it("名额不够时**留新的**，不留老的", () => {
    // 刚建好、正想说点什么的那个项目，才是最可能真的被分享出来的
    const selected = selectPrompts({
      candidates: [
        cand({ subjectKey: "old", subjectAt: NOW - 20 * DAY }),
        cand({ subjectKey: "new", subjectAt: NOW - 1 * DAY }),
      ],
      known: new Set(),
      pendingCount: MAX_PENDING - 1,
      now: NOW,
      mode: "live",
    });
    const pending = selected.filter((s) => s.status === "pending");
    assert.deepEqual(pending.map((p) => p.subjectKey), ["new"]);
  });
});

describe("**太老的不提示 —— 它已经不是「新的」了**", () => {
  it("超过 30 天的记下来但不提示", () => {
    const selected = selectPrompts({
      candidates: [cand({ subjectKey: "ancient", subjectAt: NOW - 60 * DAY })],
      known: new Set(),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.deepEqual(selected.map((s) => s.status), ["baseline"]);
  });

  it("抓取中断一个月再恢复，不会把这一个月攒的全倒出来", () => {
    const backlog = Array.from({ length: 10 }, (_, i) =>
      cand({ subjectKey: `r${i}`, subjectAt: NOW - (40 + i) * DAY }),
    );
    const selected = selectPrompts({
      candidates: backlog,
      known: new Set(),
      pendingCount: 0,
      now: NOW,
      mode: "live",
    });
    assert.equal(selected.filter((s) => s.status === "pending").length, 0);
  });
});

describe("**每一条提示都有确定的消失时间**", () => {
  /*
   * 这一条保证「永远消不掉」在结构上不可能发生。
   * 没有它的话，一条没人理的提示会一直挂着占名额，
   * 最后页面上永远是那三条谁也不想看的旧提示。
   */
  it("挂满 14 天的自动收起来", () => {
    const ids = expiredPromptIds(
      [
        { id: "old", createdAt: NOW - (PROMPT_TTL_DAYS + 1) * DAY },
        { id: "fresh", createdAt: NOW - 2 * DAY },
      ],
      NOW,
    );
    assert.deepEqual(ids, ["old"]);
  });

  it("刚好到期那一刻还留着，多一天才收 —— 边界上不要抖", () => {
    assert.deepEqual(expiredPromptIds([{ id: "x", createdAt: NOW - PROMPT_TTL_DAYS * DAY }], NOW), []);
  });
});

describe("**点过去必须是填好的，不能是一张白纸**", () => {
  /*
   * 如果点「去分享」进的是空白表单，那这条提示做的事就只是
   * 打断你、然后把活儿丢给你。而人在被打断的那一刻最不想写字，
   * 于是它 100% 会被划掉。
   */
  it("新项目：标题是完整一句话，正文里有链接和简介", () => {
    const p = prefillFor({
      kind: "repo",
      title: "tinygrad",
      url: "https://github.com/me/tinygrad",
      summary: "一个很小的深度学习框架",
      repoFullName: "me/tinygrad",
    });
    assert.match(p.title, /tinygrad/);
    assert.ok(p.title.length > 4, "标题不能是个词");
    assert.match(p.content, /https:\/\/github\.com\/me\/tinygrad/);
    assert.match(p.content, /一个很小的深度学习框架/);
    assert.ok(p.content.split("\n").length >= 5, "正文得有结构，不能只有一行链接");
  });

  it("PR：说清楚是给哪个项目提的", () => {
    const p = prefillFor({
      kind: "pr",
      title: "vercel/next.js#123 修一个水合报错",
      url: "https://github.com/vercel/next.js/pull/123",
      summary: null,
      repoFullName: "vercel/next.js",
    });
    assert.match(p.title, /vercel\/next\.js/);
    assert.match(p.content, /pull\/123/);
  });

  it("没有简介也照样填得出来，不会留一个空占位", () => {
    const p = prefillFor({
      kind: "repo",
      title: "x",
      url: "https://github.com/me/x",
      summary: null,
      repoFullName: "me/x",
    });
    assert.doesNotMatch(p.content, /null|undefined/);
  });
});

describe("**标识用不会变的东西**", () => {
  it("仓库用数值 id，不用会变的 full_name", () => {
    /*
     * 改名、转移到组织下都会让 full_name 变。用它当 key 的话，
     * 一个改过名的仓库会被当成新仓库再提示一遍 ——
     * 而那正是「消不掉的提示」最容易复现的一条路。
     */
    assert.equal(subjectKeyForRepo("123456"), "repo:123456");
    const src = readFileSync(
      new URL("../src/lib/github/prompt-rules.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(src, /subjectKeyForRepo\(r\.id\)/, "候选里没有用数值 id 生成 key");
  });

  it("PR 用 owner/repo#number，这个组合永远不会被复用", () => {
    assert.equal(subjectKeyForPr("vercel/next.js", 42), "pr:vercel/next.js#42");
  });
});

describe("**哪些东西配得上占用别人首页的一条**", () => {
  it("fork 来的仓库不提示 —— 点一下 fork 按钮不是「我做了个新项目」", () => {
    const out = repoCandidates([
      { id: "1", name: "a", fullName: "me/a", description: null, htmlUrl: "u", language: null, stars: 0, isFork: true, isPrivate: false, createdAt: NOW },
      { id: "2", name: "b", fullName: "me/b", description: null, htmlUrl: "u", language: null, stars: 0, isFork: false, isPrivate: false, createdAt: NOW },
    ]);
    assert.deepEqual(out.map((c) => c.subjectKey), ["repo:2"]);
  });

  it("私有仓库一条都不提示 —— 分享的目的是让别人看见", () => {
    const out = repoCandidates([
      { id: "3", name: "secret", fullName: "me/secret", description: null, htmlUrl: "u", language: null, stars: 0, isFork: false, isPrivate: true, createdAt: NOW },
    ]);
    assert.deepEqual(out, []);
  });

  it("只有**合并了的** PR 才提示", () => {
    /*
     * 一个刚开、还没人看的 PR 发到站里，讨论会停在「等合并吧」；
     * 而且没有人想被提醒去分享一个被拒的 PR。
     */
    const out = prCandidates([
      { repoFullName: "o/r", number: 1, title: "t", htmlUrl: "u", repoDescription: null, merged: false, createdAt: NOW, isPrivate: false },
      { repoFullName: "o/r", number: 2, title: "t", htmlUrl: "u", repoDescription: null, merged: true, createdAt: NOW, isPrivate: false },
    ]);
    assert.deepEqual(out.map((c) => c.subjectKey), ["pr:o/r#2"]);
  });

  it("私有仓库里的 PR 也不提示", () => {
    const out = prCandidates([
      { repoFullName: "o/r", number: 9, title: "t", htmlUrl: "u", repoDescription: null, merged: true, createdAt: NOW, isPrivate: true },
    ]);
    assert.deepEqual(out, []);
  });
});

// ─────────────────────────────────────────────────────────────

const repo = (over: Partial<RepoFact> & { id: string }): RepoFact => ({
  fullName: `me/${over.id}`,
  name: over.id,
  description: null,
  htmlUrl: `https://github.com/me/${over.id}`,
  language: null,
  stars: 0,
  forks: 0,
  isFork: false,
  archived: false,
  isPrivate: false,
  createdAt: NOW - 30 * DAY,
  pushedAt: NOW - DAY,
  ...over,
});

describe("**主页上展示哪些仓库**", () => {
  it("私有的一律丢掉 —— 三道防线里唯一写在我们自己代码里的那道", () => {
    /*
     * 抓取接口按定义只返回公开仓库，token 又没有任何 scope。
     * 那为什么还要这一层？因为前两道任何一次改动都可能悄悄放开
     * （换个接口、加个 scope 图省事），而这一行不会。
     */
    const out = showcaseRepos([repo({ id: "pub" }), repo({ id: "sec", isPrivate: true })]);
    assert.deepEqual(out.map((r) => r.id), ["pub"]);
  });

  it("本人置顶的排最前，而且按他排的顺序", () => {
    const out = rankRepos(
      [repo({ id: "a", stars: 100 }), repo({ id: "b" }), repo({ id: "c" })],
      ["me/c", "me/b"],
    );
    assert.deepEqual(out.map((r) => r.id), ["c", "b", "a"]);
  });

  it("没置顶时 star 多的在前 —— 但 0 star 的一片里按最近推送排", () => {
    /*
     * 这个社群里大部分人的项目都是 0 star，纯按 star 排的话
     * 主页会是一排 0 按随机顺序摆着，而 star 数在那种情况下
     * 不携带任何信息。
     */
    const out = rankRepos([
      repo({ id: "old", pushedAt: NOW - 300 * DAY }),
      repo({ id: "hot", stars: 30 }),
      repo({ id: "recent", pushedAt: NOW }),
    ]);
    assert.deepEqual(out.map((r) => r.id), ["hot", "recent", "old"]);
  });

  it("顺手 fork 的、没 star 的归档仓库垫底", () => {
    const out = rankRepos([
      repo({ id: "forked", isFork: true }),
      repo({ id: "dead", archived: true }),
      repo({ id: "real" }),
    ]);
    assert.deepEqual(out.map((r) => r.id), ["real", "dead", "forked"]);
  });

  it("最多摆 6 个 —— 再多就成了仓库列表页，而这一页是人的主页", () => {
    const many = Array.from({ length: 20 }, (_, i) => repo({ id: `r${i}`, stars: i }));
    assert.equal(showcaseRepos(many).length, MAX_SHOWCASE);
  });

  it("没有可展示的东西时返回空 —— 页面靠它决定整块区域出不出现", () => {
    assert.deepEqual(showcaseRepos([]), []);
    assert.deepEqual(showcaseRepos([repo({ id: "x", isPrivate: true })]), []);
  });

  it("展示组件在空列表时返回 null，而不是渲染一个空的 GitHub 区块", () => {
    /*
     * 空区块有两个问题：让绝大多数人的主页多一块没内容的地方，
     * 而且把「这个人没绑 GitHub」变成一条对所有同群的人公开的信息。
     */
    const src = readFileSync(
      new URL("../src/components/github/RepoShowcase.tsx", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(src, /if \(repos\.length === 0\) return null;/);
  });
});

describe("**置顶清单要洗过再存**", () => {
  it("只留真的属于这个人的仓库", () => {
    const owned = [repo({ id: "a" }), repo({ id: "b" })];
    assert.deepEqual(sanitizePinned(["me/a", "someone/else", "me/b"], owned), ["me/a", "me/b"]);
  });

  it("去重、限长、非字符串一律丢掉", () => {
    const owned = Array.from({ length: 10 }, (_, i) => repo({ id: `r${i}` }));
    assert.deepEqual(sanitizePinned(["me/r0", "me/r0"], owned), ["me/r0"]);
    assert.equal(sanitizePinned(owned.map((r) => r.fullName), owned).length, MAX_SHOWCASE);
    assert.deepEqual(sanitizePinned([1, null, { a: 1 }], owned), []);
    assert.deepEqual(sanitizePinned("me/r0", owned), [], "不是数组就该当空");
  });

  it("私有仓库不能被置顶 —— 否则它的名字会出现在主页上", () => {
    const owned = [repo({ id: "sec", isPrivate: true })];
    assert.deepEqual(sanitizePinned(["me/sec"], owned), []);
  });
});

describe("**缓存与限流**", () => {
  it("6 小时算旧；从来没抓过（fetchedAt=0）永远算旧", () => {
    assert.equal(isStale(NOW - 3600_000, NOW), false);
    assert.equal(isStale(NOW - 7 * 3600_000, NOW), true);
    assert.equal(isStale(0, NOW), true);
  });

  it("**冷却期内一律不抓，哪怕上一次是失败的**", () => {
    /*
     * GitHub 的限流按服务器出口 IP 算，不是按用户 ——
     * 一个人狂点刷新会把全站的额度耗光，
     * 而症状是别人主页上的项目突然全空了。
     *
     * 失败也计入冷却：不计的话，一个连不上 GitHub 的时段会变成
     * 一个不受限的重试循环。
     */
    assert.equal(mayRefresh(null, NOW), true, "从没抓过时得让它抓一次");
    assert.equal(mayRefresh(NOW - 60_000, NOW), false);
    assert.equal(mayRefresh(NOW - 11 * 60_000, NOW), true);
  });

  it("渲染路径上一个网络请求都没有 —— 页面只读缓存表", () => {
        const memberPage = strip(
      readFileSync(new URL("../src/app/(app)/members/[wxId]/page.tsx", import.meta.url), "utf8"),
    );
    assert.match(memberPage, /showcaseFor\(/);
    assert.doesNotMatch(memberPage, /refreshGithubData|fetchPublicRepos|fetch\(/);
  });
});
