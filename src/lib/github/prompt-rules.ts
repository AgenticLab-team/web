/**
 * 「你有个新项目 / 新 PR，要不要发个帖」的纯规则。不碰数据库、不碰网络。
 *
 * ─────────────────────────────────────────
 * 这个功能的失败方式只有一种
 * ─────────────────────────────────────────
 *
 * 它会变成一个每天都在那儿、永远消不掉、越看越烦的红点。
 * 一旦变成那样，人学会的不是「去分享」，是**无视这一块区域**——
 * 而被无视的区域以后放什么都没用了。
 *
 * 所以下面每一条规则都是在给它设上限，而不是在提高命中率：
 *
 *   ① 提示过一次就不再提示第二次。**不管用户采纳了没有。**
 *      「提示过了」不靠一个可以被漏改的状态位，靠
 *      (user_id, subject_key) 这一行的**存在本身**（见 schema/github.ts）。
 *   ② 绑定当天已经有的东西一律不提示（baseline）——
 *      不然一个写了十年代码的人绑完会收到 60 条提示。
 *   ③ 同时最多摆 MAX_PENDING 条。多了就不是提示，是收件箱。
 *   ④ 太老的东西不提示：抓取中断一个月再恢复，不该把这一个月
 *      攒的全倒出来。
 *   ⑤ 摆够 TTL 还没人理的自动收起来 —— **这一条最重要**，
 *      它保证任何一条提示都有一个确定的消失时间，
 *      于是「永远消不掉」在结构上不可能发生。
 */

/** 同时最多摆几条 */
export const MAX_PENDING = 3;

/** 一条提示摆多久没人理就自动收起来 */
export const PROMPT_TTL_DAYS = 14;

/** 比这个还老的项目 / PR 不再提示 —— 它已经不是「新的」了 */
export const PROMPT_MAX_AGE_DAYS = 30;

export type PromptKind = "repo" | "pr";

/** 一条候选提示。repo 和 pr 走同一个结构，因为它们在页面上长得一样 */
export interface PromptCandidate {
  kind: PromptKind;
  subjectKey: string;
  title: string;
  url: string;
  summary: string | null;
  repoFullName: string | null;
  /** 这个仓库建好 / 这个 PR 提交的时间 */
  subjectAt: number;
}

/**
 * 仓库的标识用 GitHub 的**数值 id**，不用 full_name。
 *
 * full_name 会变：改名、转移到组织下都会变。用它当 key 的话，
 * 一个改过名的仓库会被当成新仓库再提示一遍 —— 而那正是
 * 「消不掉的提示」最容易复现的一条路。
 */
export function subjectKeyForRepo(repoId: string): string {
  return `repo:${repoId}`;
}

/** PR 用 `owner/repo#number` —— 这个组合在 GitHub 上永远不会被复用 */
export function subjectKeyForPr(repoFullName: string, number: number): string {
  return `pr:${repoFullName}#${number}`;
}

export interface RepoCandidateFact {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stars: number;
  isFork: boolean;
  isPrivate: boolean;
  createdAt: number;
}

export interface PrCandidateFact {
  repoFullName: string;
  number: number;
  title: string;
  htmlUrl: string;
  /** PR 落到的仓库的简介，用来填帖子正文 */
  repoDescription: string | null;
  merged: boolean;
  createdAt: number;
  isPrivate: boolean;
}

/**
 * 仓库 → 候选。
 *
 * **fork 来的仓库不提示。** 点一下 fork 按钮不是「我做了个新项目」，
 * 而这个站上「我做了个新项目」才值得占用别人首页的一条。
 * 一个人 fork 十个仓库就收到十条提示的话，第十一条真项目的提示
 * 也会被顺手划掉。
 */
export function repoCandidates(repos: RepoCandidateFact[]): PromptCandidate[] {
  return repos
    .filter((r) => !r.isPrivate && !r.isFork)
    .map((r) => ({
      kind: "repo" as const,
      subjectKey: subjectKeyForRepo(r.id),
      title: r.name,
      url: r.htmlUrl,
      summary: r.description,
      repoFullName: r.fullName,
      subjectAt: r.createdAt,
    }));
}

/**
 * PR → 候选。
 *
 * **只要合并了的。** 一个刚开、还没人看的 PR 发到站里，
 * 讨论会停在「等合并吧」；而合并了的 PR 是一件已经完成的事，
 * 有结果可讲。这也顺带把「开了又关掉」的那些排除在外 ——
 * 没有人想被提醒去分享一个被拒的 PR。
 */
export function prCandidates(prs: PrCandidateFact[]): PromptCandidate[] {
  return prs
    .filter((p) => !p.isPrivate && p.merged)
    .map((p) => ({
      kind: "pr" as const,
      subjectKey: subjectKeyForPr(p.repoFullName, p.number),
      title: `${p.repoFullName}#${p.number} ${p.title}`,
      url: p.htmlUrl,
      summary: p.repoDescription,
      repoFullName: p.repoFullName,
      subjectAt: p.createdAt,
    }));
}

export interface SelectInput {
  candidates: PromptCandidate[];
  /** 已经进过表的 subjectKey —— 无论当时的结果是什么 */
  known: Set<string>;
  /** 现在还挂着几条 pending */
  pendingCount: number;
  now: number;
  /**
   * baseline：这是绑定后的第一次扫描，**一条都不提示**，
   * 只把当下已经存在的东西记下来，作为「以后什么算新的」的起点。
   */
  mode: "baseline" | "live";
  maxPending?: number;
  maxAgeDays?: number;
}

export interface SelectedPrompt extends PromptCandidate {
  status: "baseline" | "pending";
}

/**
 * 这一轮要往表里写哪些行、各自什么状态。
 *
 * 返回的每一行都要以 INSERT OR IGNORE 落库 —— 唯一索引挡住重复，
 * 而**被挡住这件事本身就是「已经提示过了」**。
 */
export function selectPrompts(input: SelectInput): SelectedPrompt[] {
  const maxPending = input.maxPending ?? MAX_PENDING;
  const maxAgeMs = (input.maxAgeDays ?? PROMPT_MAX_AGE_DAYS) * 86_400_000;

  // 没见过的才考虑。见过的连看都不看 —— 这是规则 ①
  const fresh = input.candidates.filter((c) => !input.known.has(c.subjectKey));

  if (input.mode === "baseline") {
    return fresh.map((c) => ({ ...c, status: "baseline" as const }));
  }

  /*
   * 新的先来。
   *
   * 一次扫到五个新仓库、只能摆三条的时候，摆哪三条？摆最新的。
   * 摆最老的会让「刚建好、正想说点什么」的那个项目排在队尾，
   * 而它是最可能真的被分享出来的那个。
   */
  const ordered = [...fresh].sort((a, b) => b.subjectAt - a.subjectAt);

  const out: SelectedPrompt[] = [];
  let room = Math.max(0, maxPending - input.pendingCount);

  for (const c of ordered) {
    const tooOld = input.now - c.subjectAt > maxAgeMs;
    /*
     * 名额满了或者太老 —— 仍然写一行，但状态是 baseline。
     *
     * **不写的话它下次会被当成新的再来一遍**，而「下次」永远存在，
     * 于是它会一直排在队头堵着，直到用户去处理它。
     * 写成 baseline 等于说「这个我们见过了，跳过」。
     */
    if (tooOld || room === 0) {
      out.push({ ...c, status: "baseline" });
      continue;
    }
    out.push({ ...c, status: "pending" });
    room--;
  }

  return out;
}

/** 挂了太久没人理的那些 —— 自动收起来，不再占位置 */
export function expiredPromptIds(
  pending: { id: string; createdAt: number }[],
  now: number,
  ttlDays = PROMPT_TTL_DAYS,
): string[] {
  const cutoff = now - ttlDays * 86_400_000;
  return pending.filter((p) => p.createdAt < cutoff).map((p) => p.id);
}

export interface Prefill {
  title: string;
  content: string;
}

/**
 * 一键跳到发帖页时预填的东西。
 *
 * ─────────────────────────────────────────
 * 这一段是整个功能的成败所在
 * ─────────────────────────────────────────
 *
 * 如果点过去是一张空白的发帖表单，那这条提示做的事就只是
 * **打断你，然后把活儿丢给你**。而人在被打断的那一刻是最不想写字的，
 * 于是它 100% 会被划掉。
 *
 * 所以预填到「不改也能发」的程度：标题是完整的一句话，
 * 正文有链接、有简介、有一个具体的问题当引子。
 * 留白的地方也说清楚该填什么，而不是留一片空。
 */
export function prefillFor(prompt: {
  kind: PromptKind;
  title: string;
  url: string;
  summary: string | null;
  repoFullName: string | null;
}): Prefill {
  if (prompt.kind === "pr") {
    const lines = [
      `给 ${prompt.repoFullName ?? "一个开源项目"} 提的 PR 合并了。`,
      "",
      `- 链接：${prompt.url}`,
    ];
    if (prompt.summary) lines.push(`- 这个项目：${prompt.summary}`);
    lines.push(
      "",
      "改的是什么、为什么这么改：",
      "",
      "（顺手补两句，比只贴个链接有用得多）",
    );
    return { title: `我给 ${prompt.repoFullName ?? "一个开源项目"} 提了个 PR`, content: lines.join("\n") };
  }

  const lines = [`最近开了个新项目：${prompt.repoFullName ?? prompt.title}`, "", `- 链接：${prompt.url}`];
  if (prompt.summary) lines.push(`- 一句话：${prompt.summary}`);
  lines.push(
    "",
    "它解决什么问题：",
    "",
    "现在能跑到什么程度：",
    "",
    "（想找人一起做 / 想要点意见的话，在这里说一声）",
  );
  return { title: `新项目：${prompt.title}`, content: lines.join("\n") };
}

/** 发帖页的地址，带上预填参数 */
export function composeHref(promptId: string): string {
  return `/forum/new?from=github&prompt=${encodeURIComponent(promptId)}`;
}
