/**
 * 模块登记表。纯数据 + 纯函数。
 *
 * ─────────────────────────────────────────
 * 一个开关必须真的关得掉某样东西
 * ─────────────────────────────────────────
 *
 * 这个项目里已经出现过两次「开关不接线」：
 * `notification_prefs` 建好了表没人读，「立即同步」排了队没人消费。
 * 两次的表现都一样 —— 界面上一切正常，用户以为自己做了什么，
 * 而系统的行为一点没变。
 *
 * 所以这张表里的每一项都必须声明 `enforcedIn`：
 * 那个开关到底在哪几个文件里被判定。
 * `tests/modules.test.ts` 会**读源码**核对这几个文件真的引用了它 ——
 * 声明得再好看，代码里没读就是没关。
 *
 * ─────────────────────────────────────────
 * 关掉一个模块意味着什么
 * ─────────────────────────────────────────
 *
 * 只停**写入侧**，不藏已有数据。
 * 关掉资源库之后，新消息不再抽链接，但已经收录的还看得到 ——
 * 关一个模块是「先别再长了」，不是「把过去删掉」。
 * 后者应该走裁剪或删除，那是另一件事，且不可逆。
 */

export interface ModuleSpec {
  key: string;
  name: string;
  /** 一句话说清它做什么 */
  summary: string;
  /** 关掉之后**具体**会发生什么 —— 不写清楚的话没人敢关 */
  whenOff: string;
  /** 对应的 settings 键 */
  settingKey: string;
  /** 依赖的模块；依赖被关掉时它也等于停了 */
  dependsOn?: string[];
  /**
   * 这个开关在哪几处真的被读。
   * 测试会读源码核对 —— 声明得再好看，代码里没读就是没关。
   */
  enforcedIn: string[];
  /** 有些东西不该能被关掉 */
  lockedOn?: boolean;
  lockReason?: string;
  /**
   * 默认**关着**的理由。
   *
   * ─────────────────────────────────────────
   * 不填就不许默认关
   * ─────────────────────────────────────────
   *
   * 站里的规矩是模块一律默认开（「默认关掉的功能等于没做」），
   * 而这条规矩有一个真实的例外：一个**没有人复核就往一千六百人
   * 的群里发消息**的东西，默认开等于替站长做了一个他没做过的决定。
   *
   * 但例外必须写下理由 —— 否则下一个人只要把 value 改成 "false"
   * 就能绕过那条规矩，而没有任何地方会问他为什么。
   */
  defaultOff?: string;
}

export const MODULES: ModuleSpec[] = [
  {
    key: "sync",
    name: "消息同步",
    summary: "从上游拉群消息进本地库，是几乎所有功能的数据来源",
    whenOff: "停止拉取新消息。排行榜、签到、搜索、资源库、雷达全部停在当前这一刻",
    settingKey: "module.sync.enabled",
    enforcedIn: ["src/lib/sync/messages.ts"],
  },
  {
    key: "links",
    name: "链接资源库",
    summary: "把群聊里的链接抽出来去重归档",
    whenOff: "新消息不再抽链接；已经收录的照常可见可搜",
    settingKey: "module.links.enabled",
    dependsOn: ["sync"],
    enforcedIn: ["src/lib/links/ingest.ts"],
  },
  {
    key: "radar",
    name: "关键词雷达",
    summary: "群里提到订阅的词就通知订阅者",
    whenOff: "不再扫描新消息、不再产生命中与通知；已有的订阅和命中记录都留着",
    settingKey: "module.radar.enabled",
    dependsOn: ["sync"],
    enforcedIn: ["src/lib/radar/engine.ts"],
  },
  {
    key: "directory",
    name: "成员目录",
    summary: "按技能标签找到同群的人",
    whenOff: "/members 显示为已关闭；标签数据保留",
    settingKey: "module.directory.enabled",
    enforcedIn: ["src/lib/members/queries.ts"],
  },
  {
    key: "shop",
    name: "积分商店",
    summary: "用积分兑换东西 —— 积分的回收口",
    whenOff: "不能再下单；已有订单照常处理。积分会变成只进不出",
    settingKey: "module.shop.enabled",
    enforcedIn: ["src/lib/shop/purchase.ts"],
  },
  {
    key: "broadcast",
    name: "群发",
    summary: "把站内内容推回微信群",
    whenOff: "所有群发一律不发送，包括已经排好的",
    settingKey: "module.broadcast.enabled",
    enforcedIn: ["src/lib/broadcast/sender.ts"],
  },
  {
    key: "offsite",
    name: "异地备份",
    summary: "把备份与归档传到对象存储并读回校验",
    whenOff: "不再上传。备份仍然在本机做，但只存在这一块磁盘上",
    settingKey: "module.offsite.enabled",
    enforcedIn: ["src/lib/backup/offsite.ts"],
  },
  {
    key: "prune",
    name: "存储自动裁剪",
    summary: "磁盘水位到线时自动做可逆的分层裁剪",
    whenOff: "不再自动裁剪。磁盘满了要人工处理",
    settingKey: "module.prune.enabled",
    enforcedIn: ["src/lib/storage/auto.ts"],
  },
  {
    key: "digest",
    name: "每周精选",
    summary: "每周一把上一周值得看的帖子挑出来，备成一份群发草稿",
    /*
     * 说清楚它**只备草稿**。
     *
     * 这一条以前有两个开关在管，而且两个各说各话：
     * 配置项叫「启用每周精选回推」，功能开关叫「每周精选回推微信群」——
     * 两个名字都在暗示它会自己发出去，而代码从头到尾只生成草稿，
     * 发送走群发那一整套复核流程。
     */
    whenOff: "定时任务照常跑但不再挑稿，也不再备草稿。已经备好的草稿留着",
    settingKey: "module.digest.enabled",
    dependsOn: ["broadcast"],
    enforcedIn: ["src/lib/digest/build.ts"],
  },
  {
    key: "digest_daily",
    name: "每天晚上的推送",
    summary: "每天 20:00 把最近值得读的挑 3 条，**直接发进所有群**",
    /*
     * ⚠️ 和「每周精选」不一样：**这个会自己发出去**，没有人复核。
     *
     * 名字和 summary 里都把这件事说死了 —— 上一次这块出问题，
     * 正是因为开关的名字在暗示一件代码没做的事（那次是反过来：
     * 名字暗示会发，实际只备草稿）。一个名字骗人的开关，
     * 比没有开关更危险。
     *
     * 它单独成一个开关而不是并进 `digest`：站长要停掉「自动发」时
     * 不该被迫连周报一起停，而周报只备草稿、本来没有停的理由。
     * 一个开关管两件危险程度差一个量级的事，最后一定是没人敢动它。
     */
    whenOff: "定时任务照常跑，但不挑稿也不发。周报不受影响",
    defaultOff:
      "全站唯一一个没有人复核就往所有群发消息的东西 —— 默认开等于替站长" +
      "做了一个他没做过的决定。站长亲手打开一次，本身就是那道闸",
    settingKey: "module.digest_daily.enabled",
    dependsOn: ["broadcast"],
    enforcedIn: ["src/lib/digest/build-daily.ts"],
  },
  {
    key: "alerts",
    name: "告警投递",
    summary: "组件挂了给站长发微信",
    whenOff: "告警仍然落库，但**不再发出去** —— 只能靠人主动看后台",
    settingKey: "module.alerts.enabled",
    enforcedIn: ["src/lib/alerts/dispatch.ts"],
  },
  {
    key: "audit",
    name: "审计日志",
    summary: "记录每一个后台写操作",
    whenOff: "—",
    settingKey: "module.audit.enabled",
    enforcedIn: [],
    lockedOn: true,
    lockReason: "关掉审计等于让后台操作无迹可查 —— 这个开关本身就该是不存在的",
  },
];

export function moduleByKey(key: string): ModuleSpec | undefined {
  return MODULES.find((m) => m.key === key);
}

export type ModuleStatus = "on" | "off" | "blocked" | "locked";

export interface ModuleState {
  key: string;
  enabled: boolean;
  status: ModuleStatus;
  /** 因为依赖被关掉而实际停摆的 —— 自己的开关还开着 */
  blockedBy: string[];
  reason: string;
}

/**
 * 算出每个模块的实际状态。
 *
 * `blocked` 和 `off` 必须分开：
 * 一个开关开着、但依赖被关掉的模块，在界面上如果显示成「开启」，
 * 管理员会以为它在跑。**「开着但不工作」是最容易骗人的状态。**
 */
export function resolveStates(enabled: Record<string, boolean>): ModuleState[] {
  const isOn = (key: string) => {
    const spec = moduleByKey(key);
    if (spec?.lockedOn) return true;
    return enabled[key] ?? true;
  };

  return MODULES.map((spec) => {
    if (spec.lockedOn) {
      return {
        key: spec.key,
        enabled: true,
        status: "locked" as const,
        blockedBy: [],
        reason: spec.lockReason ?? "不可关闭",
      };
    }

    const on = isOn(spec.key);
    if (!on) {
      return {
        key: spec.key,
        enabled: false,
        status: "off" as const,
        blockedBy: [],
        reason: spec.whenOff,
      };
    }

    const blockedBy = (spec.dependsOn ?? []).filter((dep) => !isOn(dep));
    if (blockedBy.length > 0) {
      return {
        key: spec.key,
        enabled: true,
        status: "blocked" as const,
        blockedBy,
        reason: `开关是开着的，但依赖的${blockedBy
          .map((k) => moduleByKey(k)?.name ?? k)
          .join("、")}被关掉了 —— 它实际上没有在工作`,
      };
    }

    return { key: spec.key, enabled: true, status: "on" as const, blockedBy: [], reason: "" };
  });
}

/** 关掉这个模块会连累谁 —— 确认之前要说出来 */
export function dependentsOf(key: string): ModuleSpec[] {
  return MODULES.filter((m) => (m.dependsOn ?? []).includes(key));
}

/**
 * 依赖关系不能成环。
 *
 * 成环的话 resolveStates 会算出一组自洽但没有意义的状态，
 * 而界面上看不出任何异常。
 */
export function findDependencyCycles(): string[][] {
  const cycles: string[][] = [];
  const visit = (key: string, path: string[]) => {
    if (path.includes(key)) {
      cycles.push([...path.slice(path.indexOf(key)), key]);
      return;
    }
    for (const dep of moduleByKey(key)?.dependsOn ?? []) {
      visit(dep, [...path, key]);
    }
  };
  for (const spec of MODULES) visit(spec.key, []);
  return cycles;
}

export const STATUS_LABELS: Record<ModuleStatus, string> = {
  on: "运行中",
  off: "已关闭",
  blocked: "开着但没在工作",
  locked: "不可关闭",
};

export function statusTone(status: ModuleStatus): "success" | "warning" | "muted" {
  if (status === "on") return "success";
  if (status === "blocked") return "warning";
  return "muted";
}
