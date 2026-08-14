/**
 * 核对域名的 MX / SPF / DMARC 配对了没有。
 *
 *   npm run mail-dns                    # 全部 100 个
 *   npm run mail-dns -- tsuki.icu 华立.icu  # 只核几个
 *
 * ⚠️ **不要用 `dig` 代替它。** 很多网络对 53 端口做透明劫持，
 * 不存在的域名会返回一个假地址，而且 `dig @1.1.1.1` 也一样 ——
 * 查询根本没出去。这个脚本走 DoH（HTTPS 上的 DNS），劫不了。
 *
 * DNS 体检任务（写进 mail_domains 那三个灯）是 P1，还没做。
 * 在那之前这个脚本是唯一的核对手段。
 */
import { CATALOG } from "@/lib/mail/domain-catalog";
import { DEFAULT_RESOLVERS, checkDomainDns, type DnsVerdict } from "@/lib/mail/dns-check";
import { getSetting } from "@/lib/settings/store";

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const domains = args.length > 0 ? args : CATALOG.map((e) => e.domain);

/*
 * MX 主机名从设置里读，不写死。
 *
 * 写死的话这个脚本和 DNS 体检会拿两个不同的值去比 ——
 * 而分叉的方向是「脚本说全绿、后台说全红」。
 */
const mxHost = getSetting("mail.mx_host", "publicmx.agenticlab.sh");

const kindOf = new Map(CATALOG.map((e) => [e.domain, e.kind]));

async function main() {
  console.log(`核 ${domains.length} 个域名，MX 该指向 ${mxHost}\n`);

  const verdicts: DnsVerdict[] = [];
  // 并发 12 —— 再高会撞上 DoH 的限流，而限流返回的是「没查成」，看起来像没配
  for (let i = 0; i < domains.length; i += 12) {
    const batch = domains.slice(i, i + 12);
    verdicts.push(
      ...(await Promise.all(batch.map((d) => checkDomainDns(d, mxHost, DEFAULT_RESOLVERS)))),
    );
    // 只在真终端里刷同一行；重定向到文件时 \r 会糊成一串，那时候干脆不打
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  已查 ${Math.min(i + 12, domains.length)}/${domains.length}`);
    }
  }
  if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(40) + "\r");

  const bad = verdicts.filter((v) => v.mxOk !== true || v.spfOk !== true || v.dmarcOk !== true);
  const unknown = verdicts.filter((v) => v.mxOk === null || v.spfOk === null || v.dmarcOk === null);

  if (bad.length === 0) {
    console.log(`✅ ${verdicts.length} 个全部正确`);
    return;
  }

  console.log(`${verdicts.length - bad.length} 个正确，${bad.length} 个有问题：\n`);
  for (const v of bad) {
    const miss = [
      v.mxOk === false && "MX 缺",
      v.spfOk === false && "SPF 缺",
      v.dmarcOk === false && "DMARC 缺",
      (v.mxOk === null || v.spfOk === null || v.dmarcOk === null) && "查询失败",
    ].filter(Boolean);
    console.log(`  ${v.domain.padEnd(48)} ${miss.join(" · ")}   [${kindOf.get(v.domain) ?? "?"}]`);
    if (v.detail.mx.length > 0 && v.mxOk === false) console.log(`      MX 现在是：${v.detail.mx.join(" | ")}`);
  }

  if (unknown.length > 0) {
    console.log(
      `\n⚠ 其中 ${unknown.length} 个是**没查成**（不是没配）—— DoH 限流或者刚加记录还没同步，隔几分钟再跑一次`,
    );
  }
  /*
   * 有问题时**不退非零**：这个脚本是给人看的，不是给 CI 用的。
   * 退非零会让它在 `npm run` 后面吐一屏 npm 的错误堆栈，把真正的输出顶掉。
   */
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
