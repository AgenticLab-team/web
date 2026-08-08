/**
 * 内置称号的定义。
 *
 * 纯数据，不碰数据库 —— seed 和测试都引这一份。
 * 放在 seed-titles.ts 里的话，测试要读这张表就得先连库。
 *
 * 数量刻意少。称号一多就变成徽章墙，每一个都不值钱了 ——
 * 「我有 27 个称号」和「我有 0 个」给人的感觉是一样的。
 */

export interface TitleSeed {
  key: string;
  name: string;
  description: string;
  icon: string;
  rarity: "common" | "rare" | "epic" | "legendary";
  source: "grant" | "achievement" | "purchase" | "seasonal";
  price?: number;
  rentDays?: number;
  conditionKind?: string;
  conditionValue?: number;
  limitCount?: number;
  sort: number;
}

export const BUILTIN_TITLES: TitleSeed[] = [
  {
    key: "seed_user",
    name: "种子用户",
    description: "参与内测的人。站点最早的样子他们见过。",
    icon: "🌱",
    rarity: "legendary",
    source: "grant",
    // 内测就这么些人，名额上限就是它的意义所在 ——
    // 后面再发就不叫种子用户了
    limitCount: 100,
    sort: 100,
  },
  {
    key: "first_post",
    name: "开了个头",
    description: "在论坛发出第一篇帖子。",
    icon: "✍️",
    rarity: "common",
    source: "achievement",
    conditionKind: "posts",
    conditionValue: 1,
    sort: 10,
  },
  {
    key: "streak_30",
    name: "月度常客",
    description: "连续打卡 30 天。",
    icon: "🔥",
    rarity: "rare",
    source: "achievement",
    conditionKind: "streakBest",
    conditionValue: 30,
    sort: 30,
  },
  {
    key: "streak_100",
    name: "百日不辍",
    description: "连续打卡 100 天。",
    icon: "💎",
    rarity: "epic",
    source: "achievement",
    conditionKind: "streakBest",
    conditionValue: 100,
    sort: 40,
  },
  {
    key: "quality_500",
    name: "话都说在点上",
    description: "累计 500 条高质量发言。",
    icon: "🎯",
    rarity: "epic",
    source: "achievement",
    conditionKind: "qualityMessages",
    conditionValue: 500,
    sort: 45,
  },
  {
    key: "answerer",
    name: "有问必答",
    description: "累计回复 200 次。",
    icon: "💬",
    rarity: "rare",
    source: "achievement",
    conditionKind: "replies",
    conditionValue: 200,
    sort: 20,
  },
  {
    /*
     * 自定义称号是主要的积分回收口：按月租用，到期续费。
     * 一次性买断的话，回收只发生一次，之后积分照样越攒越多。
     */
    key: "custom_monthly",
    name: "自定义称号",
    description: "自己起一个名字，按月续费。",
    icon: "🏷️",
    rarity: "rare",
    source: "purchase",
    price: 300,
    rentDays: 30,
    sort: 50,
  },
];
