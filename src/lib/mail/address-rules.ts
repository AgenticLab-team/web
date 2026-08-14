/**
 * 邮箱地址的形状与占用判定。纯函数，不碰数据库、不碰网络。
 *
 * 这一层要能一秒跑几百次 —— 它是「这个前缀能不能给你」这句话的全部依据，
 * 而那句话的边界情况（长度、保留词、和已有地址撞车、大小写、punycode）
 * 才是它真正的内容。引了数据库之后没人会为一个边界情况多写一条测试。
 */

/**
 * 禁用词的四种匹配方式。
 *
 * 定义在这里而不是 schema 里，是因为**判定发生在这一层** ——
 * 而这一层不许 import `@/lib/db`（那会把 drizzle 拖进测试，
 * 于是没人再为一个边界情况多写一条断言）。schema 反过来引它。
 */
export const MAIL_BANWORD_KINDS = ["exact", "prefix", "contains", "regex"] as const;

/**
 * 前缀的合法形状。
 *
 * RFC 5321 允许的字符比这宽得多（引号串里几乎什么都能塞），
 * 但**我们不是在实现 RFC，是在发地址**。放宽的每一个字符都要回答
 * 「哪个网站的注册框会拒收它」，而带点的、带加号的地址被拒是家常便饭。
 *
 * 所以只允许：小写字母、数字、`.` `-` `_`，且首尾必须是字母或数字。
 */
const SHAPE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** 连续两个分隔符（`..` `.-` `--` …）—— 打字打错的形态，不该发出去 */
const DOUBLE_SEP = /[._-]{2}/;

/**
 * 一次性箱自选前缀的默认最短长度。
 *
 * ─────────────────────────────────────────
 * 它防的不是滥用，是**抢地址**
 * ─────────────────────────────────────────
 *
 * 一次性池现在既跑一次性箱、又能被申领，两者共用一个命名空间。
 * 不设下限的话，有人可以用一次性箱反复占着 `hi@某域名` ——
 * 每次 24 小时、续着占，而正经申领那条路上他一分钱都不用花。
 *
 * 划一条长度线之后两条路各归各的：
 * **短前缀只能靠申领拿到，长前缀随便你在一次性箱上编。**
 */
export const BURNER_CUSTOM_MIN_LENGTH = 10;

/** 申领（临时箱 / 长期箱）的最短长度。短地址是这套东西里最稀缺的资源 */
export const CLAIM_MIN_LENGTH = 3;

/**
 * 前缀上限。
 *
 * RFC 5321 给 local part 的上限是 64，整个地址是 254。
 * 卡在 64 是因为**超出的部分不是我们说了算** —— 有的服务器会直接拒，
 * 而拒信会退回到发件人那里，我们这边看不到任何东西。
 */
export const MAX_LOCAL_LENGTH = 64;
export const MAX_ADDRESS_LENGTH = 254;

export interface BanwordRule {
  word: string;
  kind: (typeof MAIL_BANWORD_KINDS)[number];
  enabled?: boolean;
  reason?: string | null;
}

/**
 * 永远保留给系统的两个前缀。
 *
 * ═════════════════════════════════════════
 * 这两条是代码里的一句话，不是配置项
 * ═════════════════════════════════════════
 *
 * RFC 5321 要求一个域名能收 `postmaster`；`abuse` 是收
 * 「你们家域名在发垃圾邮件」这种投诉的事实标准通道。
 *
 * 把它们发给用户的话，投诉会寄到那个用户的收件箱里 ——
 * 也就是说**我们会在完全不知情的情况下被投诉、被拉黑**，
 * 而唯一能告诉我们这件事的那封信，正躺在一个不认识它的人手里。
 *
 * 做成可配的话，它迟早会在某次「这个词太严了吧」里被删掉。
 */
export const SYSTEM_RESERVED = ["postmaster", "abuse"] as const;

export type LocalPartPurpose = "burner" | "claim";

export interface LocalPartVerdict {
  ok: boolean;
  /** 归一化之后的前缀。ok 为假时是空串 */
  local: string;
  error: string | null;
}

/**
 * 归一化用户填的前缀。
 *
 * 只做**明显不改变意图**的处理：去首尾空白、转小写。
 *
 * ⚠️ **不去掉中间的空格、不替换成连字符。** 把 `hello world`
 * 变成 `hello-world` 看似贴心，实际上是替用户改了他要的东西 ——
 * 而地址一旦发出去、被他填进某个网站的注册框，就改不回来了。
 * 这种情况要报错让他自己改，不能猜。（和域名申请那一处同一个道理。）
 */
export function normalizeLocalPart(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 这个前缀能不能用。
 *
 * `purpose` 决定最短长度：一次性箱和申领共用一个命名空间，
 * 但**受的约束正好相反** —— 见 BURNER_CUSTOM_MIN_LENGTH。
 */
export function checkLocalPart(
  raw: string,
  options: {
    purpose: LocalPartPurpose;
    banwords?: readonly BanwordRule[];
    /** 覆盖最短长度（后台可配）。站长绕过时传 0 */
    minLength?: number;
  },
): LocalPartVerdict {
  const local = normalizeLocalPart(raw);
  const fail = (error: string): LocalPartVerdict => ({ ok: false, local: "", error });

  if (!local) return fail("前缀不能为空");

  const min =
    options.minLength ??
    (options.purpose === "burner" ? BURNER_CUSTOM_MIN_LENGTH : CLAIM_MIN_LENGTH);

  if (local.length < min) {
    return fail(
      options.purpose === "burner"
        ? `自选前缀至少 ${min} 个字符 —— 更短的留给正式申领，见 MAIL.md`
        : `至少 ${min} 个字符`,
    );
  }
  if (local.length > MAX_LOCAL_LENGTH) {
    return fail(`最多 ${MAX_LOCAL_LENGTH} 个字符`);
  }

  if (!SHAPE.test(local)) {
    // 空格是最常见的一种，单独报 —— 一句「格式不对」帮不上填了空格的人
    if (/\s/.test(local)) return fail("不能有空格 —— 想分隔的话用连字符");
    return fail("只能用小写字母、数字和 . - _，且首尾必须是字母或数字");
  }

  if (DOUBLE_SEP.test(local)) {
    return fail("不能连着出现两个 . - _");
  }

  if ((SYSTEM_RESERVED as readonly string[]).includes(local)) {
    return fail(`${local} 是系统保留的地址（收投诉用），换一个`);
  }

  const hit = matchBanword(local, options.banwords ?? []);
  if (hit) {
    return fail(hit.reason ? `这个前缀不能用：${hit.reason}` : "这个前缀不能用，换一个");
  }

  return { ok: true, local, error: null };
}

/**
 * 禁用词命中判定。四种匹配沿用 `sensitive_words` 那一套。
 *
 * 正则那一档**编译失败就当没命中**，不抛错：一条写坏的规则
 * 不应该让所有人都开不了箱。写坏的那条会在后台校验时被挡下来，
 * 这里是最后一道，宁可漏也不能把整条路堵死。
 */
export function matchBanword(
  local: string,
  rules: readonly BanwordRule[],
): BanwordRule | null {
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const word = rule.word.toLowerCase();
    switch (rule.kind) {
      case "exact":
        if (local === word) return rule;
        break;
      case "prefix":
        if (local.startsWith(word)) return rule;
        break;
      case "contains":
        if (local.includes(word)) return rule;
        break;
      case "regex":
        try {
          if (new RegExp(rule.word, "i").test(local)) return rule;
        } catch {
          /* 写坏的规则不该让所有人开不了箱 */
        }
        break;
    }
  }
  return null;
}

/**
 * 拼出信封地址。
 *
 * **一定要用 punycode 那一半**：中文域名不转 A 标签的话，
 * 网关那一侧收到的信封地址和我们库里存的对不上，
 * 表现是「这个地址收不到信」而没有任何报错。
 */
export function buildAddress(local: string, punycode: string): string {
  return `${local.toLowerCase()}@${punycode.toLowerCase()}`;
}

/** 地址总长能不能塞得下。超了就是发出去也收不回来的那种坏 */
export function addressFits(local: string, punycode: string): boolean {
  return buildAddress(local, punycode).length <= MAX_ADDRESS_LENGTH;
}

/**
 * 把信封收件人拆成前缀和域名。
 *
 * ⚠️ **按最后一个 `@` 拆**，不是第一个：RFC 允许引号串里带 `@`，
 * 而按第一个拆会把 `"a@b"@example.com` 的域名解析成 `b"@example.com`。
 * 我们自己不发这种地址，但**别人可以往我们这里发**。
 */
export function splitAddress(address: string): { local: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return {
    local: address.slice(0, at).toLowerCase(),
    domain: address.slice(at + 1).toLowerCase(),
  };
}

/**
 * 随机前缀。
 *
 * ─────────────────────────────────────────
 * 字符集刻意去掉了形近字
 * ─────────────────────────────────────────
 *
 * 没有 `0/o` `1/l/i`。这串东西的头号用途是**被人念给另一个人**、
 * 或者从手机屏幕抄到电脑上 —— 而 `l` 和 `1` 在很多字体里
 * 根本分不出来。少四个字符换来的熵损失，12 位下完全无所谓
 * （32^12 ≈ 1.2×10^18）。
 *
 * 长度 12 也是照这个用途定的：短到能抄，长到不可能被撞。
 */
const RANDOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RANDOM_LOCAL_LENGTH = 12;

export function randomLocalPart(
  randomBytes: (n: number) => Uint8Array,
  length = RANDOM_LOCAL_LENGTH,
): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length];
  }
  return out;
}
