/**
 * 版块清单 —— **纯数据，不碰库**。
 *
 * ─────────────────────────────────────────
 * 为什么和 seedBoards 分开
 * ─────────────────────────────────────────
 *
 * 原来它们在一个文件里，而那个文件 `import "server-only"` 并且
 * 连着 `@/lib/db` —— 于是想读一眼「一共有哪些版块」就得先有一个
 * 数据库连接和一整套环境变量。测试里第一次撞上这件事：
 * 断言「预留的 key 别和已建的撞」需要开一个真库，荒唐。
 *
 * 清单是事实，建版块是动作。分开之后，任何地方都能便宜地读到事实。
 */

import type { Visibility } from "@/lib/db/schema/forum";

/**
 * 默认版块。
 *
 * 每个版块的 maxVisibility 都是**封顶**，不是默认值 ——
 * 「群聊沉淀」版封顶就是 group，从结构上杜绝群聊内容被公开，
 * 而不是靠每次发帖时记得选对。
 */
interface BoardSeed {
  key: string;
  name: string;
  description: string;
  icon: string;
  sort: number;
  visibleTo: Visibility;
  defaultVisibility: Visibility;
  maxVisibility: Visibility;
  postMinLevel?: number;
  viewMode?: "flat" | "threaded";
}

export const DEFAULT_BOARDS: BoardSeed[] = [
  {
    key: "general",
    name: "综合讨论",
    /*
     * 描述改了。
     *
     * 原来写的是「什么都能聊」—— 于是 93 篇里 77 篇进了这里，
     * 包括八篇本该去「反馈与报错」的建议。一个说「什么都行」的版块
     * 会**吞掉所有别的版块**，因为选它永远不会错。
     *
     * 现在它明说自己是兜底的，并且点名旁边那几个更合适的地方。
     */
    description: "闲聊、随笔、不知道该发哪儿的。有更合适的版块就发那边",
    icon: "messages-square",
    sort: 10,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    /*
     * 深度好文。
     *
     * ─────────────────────────────────────────
     * 这个版块是数出来的，不是想出来的
     * ─────────────────────────────────────────
     *
     * 上线头一批 93 篇帖子里，43 篇正文超过两千字，其中 33 篇
     * 出自同一个人。而它们的处境是：
     *
     *   长文（≥2000 字）  平均 2.3 次浏览、0.21 条回复
     *   短帖（<300 字）   平均 8.2 次浏览、1.28 条回复
     *
     * 一条四个字的水帖拿到的注意力是一篇一万字文章的三倍半。
     * 原因不是大家不爱看，是它们全都混在「综合讨论」的时间线里 ——
     * 一小时就被冲走，而写它要花一整天。
     *
     * 那位写了 33 篇的人，每篇拿到 2.3 次浏览。他会停的。
     * 所以这里要的不是「多一个分类」，是**给长文一个不按时间冲刷的地方**。
     */
    key: "articles",
    name: "深度好文",
    description: "值得坐下来读完的长文：技术解析、系统梳理、实战复盘",
    icon: "book-open",
    sort: 15,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    /*
     * 资讯。
     *
     * 快讯和长文抢的是同一条时间线，而它们的节奏差一个数量级：
     * 「苹果发布会定档 9 月 9 日」两天后就没人关心，
     * 一篇讲 MoE 通信墙的文章半年后还成立。
     *
     * 混在一起的结果是快讯把长文冲走 —— 分开之后两边都好过。
     */
    key: "news",
    name: "资讯",
    description: "新模型、新发布、行业动态。图个快",
    icon: "newspaper",
    sort: 25,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    /*
     * 折腾与教程。
     *
     * 数出来的第三簇：刷机、部署、踩坑记录、报错解析。
     * 它们和「深度好文」的区别是**目的**不是**长度** ——
     * 这里的帖子是给正卡在同一个坑里的人看的，
     * 而好文是给想弄明白一件事的人看的。
     */
    key: "howto",
    name: "折腾与教程",
    description: "刷机、部署、配置、踩坑记录 —— 让下一个人少走两小时弯路",
    icon: "wrench",
    sort: 28,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "qa",
    name: "问答",
    description: "有问题就问，可以悬赏积分",
    icon: "help-circle",
    sort: 20,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "showcase",
    name: "项目展示",
    description: "把你在做的东西亮出来",
    icon: "sparkles",
    sort: 30,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    /*
     * 反馈与报错。
     *
     * 站长的原话：「就是引导用户遇到 bug 来到某一个板块发言」——
     * 明确不要工单系统。
     *
     * 版块比工单好的地方恰恰在于**公开**：
     * 别人报过的问题你看得见，于是不会再报一遍；
     * 而工单系统里每个人都在自己的隔间里，同一个 bug 会被报二十次，
     * 处理的人也没法一次回答所有人。
     *
     * 所以 visibleTo 是 public：没登录的人也能看到已知问题。
     * 但发帖仍然要登录 —— 一个公开可写的板块两天就会被灌满。
     */
    key: "feedback",
    name: "反馈与报错",
    description: "站点坏了、用着别扭、想要什么功能，都发这里。先翻一下有没有人报过",
    icon: "bug",
    sort: 35,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
  },
  {
    key: "inside",
    name: "内部事务",
    description: "社群运营与内部讨论，登录成员可见",
    icon: "lock",
    sort: 40,
    visibleTo: "member",
    defaultVisibility: "member",
    maxVisibility: "member",
  },
  {
    key: "archive",
    name: "群聊沉淀",
    description: "从群聊转存的讨论。只有原群成员看得到",
    icon: "archive",
    sort: 50,
    visibleTo: "member",
    defaultVisibility: "group",
    // 封顶就是 group：从结构上杜绝这个版块的内容被公开
    maxVisibility: "group",
  },
];

/**
 * 预留的版块。
 *
 * ═════════════════════════════════════════
 * 写下来，但**不建**
 * ═════════════════════════════════════════
 *
 * 一个空版块比没有这个版块更糟：它挂在首页上写着「0」，
 * 第一个想发的人看见没人发过，于是也不发 —— 空着就一直空着。
 * 而九个版块里已经有三个是个位数了。
 *
 * 所以「预留」在这里的意思是**把位置和理由记下来**，不是先建出来占坑：
 * 每一条都写清了「等到什么时候再开」，那个条件是可以数的，
 * 不是「以后看情况」。到时候把它挪进 DEFAULT_BOARDS 就行，一行的事。
 *
 * 有测试盯着它们的 key 不和现有版块撞 —— 撞了的话 seedBoards
 * 会安静地跳过，而那是最难查的一种「怎么没建上」。
 */
export const RESERVED_BOARDS: (BoardSeed & { openWhen: string })[] = [
  {
    key: "jobs",
    name: "招聘与找活",
    description: "招人、找活、接项目",
    icon: "briefcase",
    sort: 60,
    visibleTo: "member",
    defaultVisibility: "member",
    maxVisibility: "member",
    // 这类内容对人数很敏感：人少的时候一条招聘挂三个月没人回，很难看
    openWhen: "站里活跃成员过 300，或者「综合讨论」里出现过 5 条招聘帖",
  },
  {
    key: "reading",
    name: "共读",
    description: "一起读一篇论文或一本书，按进度开帖",
    icon: "book-marked",
    sort: 18,
    visibleTo: "public",
    defaultVisibility: "public",
    maxVisibility: "public",
    // 共读要有人领读，没人领读的共读版就是个空壳
    openWhen: "有人愿意当领读人，并且「深度好文」里的论文解读稳定到每周一篇",
  },
  {
    key: "showoff",
    name: "作品与手艺",
    description: "跟 AI 无关的那些：摄影、木工、做饭、写字",
    icon: "palette",
    sort: 32,
    visibleTo: "member",
    defaultVisibility: "member",
    maxVisibility: "member",
    /*
     * 这一条是留给「这个站会长成什么样」的。
     * 现在的帖子九成跟 AI 有关，但一个只能聊 AI 的群会累 ——
     * 真到了大家开始发别的东西的时候，得有地方放。
     */
    openWhen: "「综合讨论」里出现过 10 条跟技术无关的分享帖",
  },
];
