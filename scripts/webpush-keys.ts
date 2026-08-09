import { createECDH } from "node:crypto";

/**
 * 生成一对 VAPID 密钥。
 *
 * 故意不 import 项目里的任何模块：这条命令要在**还没配好环境**的
 * 机器上能跑（它就是用来配环境的），不能因为缺 NEKOBOT_API_KEY 而挂。
 *
 * 私钥换了等于所有已有订阅作废（推送服务按公钥认应用）——
 * 所以生成一次之后就别再跑第二次，除非你确实想让全部用户重新订阅。
 */
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();

console.log("把下面三行加进 .env.local（VAPID_SUBJECT 换成真实联系方式）：\n");
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString("base64url")}`);
console.log(`VAPID_SUBJECT=mailto:admin@example.com`);
