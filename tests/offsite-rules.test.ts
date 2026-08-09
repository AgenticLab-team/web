import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRILL_AFTER_MS,
  STALE_AFTER_MS,
  STATUS_LABELS,
  expiredRemotely,
  missingConfigKeys,
  missingRemotely,
  needsDrill,
  offsiteStatus,
  readConfig,
  statusDetail,
  statusTone,
  type OffsiteState,
} from "@/lib/backup/rules";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const DAY = 86_400_000;

const healthy: OffsiteState = {
  configured: true,
  lastUploadAt: NOW - HOUR,
  lastVerifiedAt: NOW - HOUR,
  lastDrillAt: NOW - 3 * DAY,
  lastError: null,
};

describe("状态判定 —— 备份最常见的失败方式是「一直在成功」", () => {
  it("没配置不是「成功 0 个」，是「根本没在做」", () => {
    const state = { ...healthy, configured: false };
    assert.equal(offsiteStatus(state, NOW), "unconfigured");
    assert.equal(statusTone("unconfigured"), "danger", "没有异地备份必须是红的");
    assert.match(statusDetail(state, NOW), /一块磁盘/);
  });

  it("一切正常", () => {
    assert.equal(offsiteStatus(healthy, NOW), "ok");
    assert.equal(statusTone("ok"), "success");
  });

  it("上次失败了就是失败，不看时间", () => {
    const state = { ...healthy, lastError: "403 SignatureDoesNotMatch" };
    assert.equal(offsiteStatus(state, NOW), "failing");
    assert.equal(statusDetail(state, NOW), "403 SignatureDoesNotMatch");
  });

  it("太久没有新副本算过期", () => {
    assert.equal(offsiteStatus({ ...healthy, lastUploadAt: NOW - STALE_AFTER_MS - 1 }, NOW), "stale");
    assert.equal(offsiteStatus({ ...healthy, lastUploadAt: NOW - STALE_AFTER_MS + 1 }, NOW), "ok");
  });

  it("**传上去了但从没读回来对过哈希，不算正常**", () => {
    const state = { ...healthy, lastVerifiedAt: null };
    assert.equal(offsiteStatus(state, NOW), "never_verified");
    assert.match(statusDetail(state, NOW), /只能证明请求没报错/);
  });

  it("配置好了但一次都没传成功过，也是没验证过", () => {
    const state = { ...healthy, lastUploadAt: null, lastVerifiedAt: null };
    assert.equal(offsiteStatus(state, NOW), "never_verified");
    assert.match(statusDetail(state, NOW), /一次都没传成功/);
  });

  it("每个状态都有中文名，不会把状态码直接显示给人", () => {
    for (const key of ["unconfigured", "ok", "stale", "never_verified", "failing"] as const) {
      assert.ok(STATUS_LABELS[key]?.length > 0, `${key} 没有中文名`);
      assert.notEqual(STATUS_LABELS[key], key);
    }
  });

  it("只有 ok 是绿的 —— 其余状态一律不能看起来像没事", () => {
    for (const key of ["unconfigured", "stale", "never_verified", "failing"] as const) {
      assert.notEqual(statusTone(key), "success", `${key} 被显示成了正常`);
    }
  });
});

describe("恢复演练 —— 没演练过的备份只是一堆字节", () => {
  it("传过但从没演练过就该演练", () => {
    assert.equal(needsDrill({ ...healthy, lastDrillAt: null }, NOW), true);
  });

  it("刚演练过就不用", () => {
    assert.equal(needsDrill(healthy, NOW), false);
  });

  it("超过周期就该再演练一次", () => {
    assert.equal(needsDrill({ ...healthy, lastDrillAt: NOW - DRILL_AFTER_MS - 1 }, NOW), true);
  });

  it("没配置时不催演练 —— 那时候的问题不是演练", () => {
    assert.equal(needsDrill({ ...healthy, configured: false, lastDrillAt: null }, NOW), false);
  });

  it("一份都没传成功过时不催演练", () => {
    assert.equal(
      needsDrill({ ...healthy, lastUploadAt: null, lastDrillAt: null }, NOW),
      false,
    );
  });

  it("副本正常但该演练了，详情里要说出来", () => {
    const state = { ...healthy, lastDrillAt: NOW - 60 * DAY };
    assert.equal(offsiteStatus(state, NOW), "ok");
    assert.match(statusDetail(state, NOW), /恢复演练/);
  });
});

describe("哪些还没传上去", () => {
  const prefix = "agenticlab/";

  it("远端没有的要传", () => {
    const missing = missingRemotely(
      [{ name: "backups/a.gz", size: 100 }],
      [],
      prefix,
    );
    assert.deepEqual(missing.map((m) => m.name), ["backups/a.gz"]);
  });

  it("远端有且大小一致的不重传", () => {
    const missing = missingRemotely(
      [{ name: "backups/a.gz", size: 100 }],
      [{ key: "agenticlab/backups/a.gz", size: 100 }],
      prefix,
    );
    assert.deepEqual(missing, []);
  });

  it("**大小对不上要重传** —— 上次传了一半的对象不能算数", () => {
    const missing = missingRemotely(
      [{ name: "backups/a.gz", size: 100 }],
      [{ key: "agenticlab/backups/a.gz", size: 40 }],
      prefix,
    );
    assert.equal(missing.length, 1, "被截断的对象被当成已经传过了");
  });

  it("前缀不一样的对象不算数 —— 别把别人桶里的文件当成自己的", () => {
    const missing = missingRemotely(
      [{ name: "backups/a.gz", size: 100 }],
      [{ key: "someoneelse/backups/a.gz", size: 100 }],
      prefix,
    );
    assert.equal(missing.length, 1);
  });
});

describe("远端保留", () => {
  const prefix = "agenticlab/backups/";
  const daily = (n: number) => ({ key: `${prefix}agenticlab-daily-2026080${n}-0400.db.gz`, size: 1 });

  it("远端永远比本地多留一份", () => {
    const remote = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(daily);
    const doomed = expiredRemotely(remote, { daily: 7, weekly: 4 }, prefix);
    assert.equal(doomed.length, 1, "9 份保留 7+1，只该删最老的那 1 份");
    assert.match(doomed[0].key, /20260801/);
  });

  it("不够数的时候一个都不删", () => {
    assert.deepEqual(expiredRemotely([daily(1), daily(2)], { daily: 7, weekly: 4 }, prefix), []);
  });

  it("daily 和 weekly 分开算，不会互相挤掉", () => {
    const remote = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(daily),
      { key: `${prefix}agenticlab-weekly-20260802-0400.db.gz`, size: 1 },
    ];
    const doomed = expiredRemotely(remote, { daily: 7, weekly: 4 }, prefix);
    assert.ok(doomed.every((d) => d.key.includes("daily")), "周备份被日备份挤掉了");
  });

  it("归档文件永远不删 —— 那是冷层正文的唯一副本", () => {
    const remote = [
      { key: "agenticlab/archive/messages-2025-01.ndjson.gz", size: 1 },
      { key: "agenticlab/archive/messages-2025-02.ndjson.gz", size: 1 },
    ];
    assert.deepEqual(expiredRemotely(remote, { daily: 0, weekly: 0 }, prefix), []);
  });
});

describe("配置读取 —— 半套配置比没配置更糟", () => {
  const full = {
    OFFSITE_S3_ENDPOINT: "https://x.r2.cloudflarestorage.com/",
    OFFSITE_S3_BUCKET: "agenticlab",
    OFFSITE_S3_ACCESS_KEY_ID: "k",
    OFFSITE_S3_SECRET_ACCESS_KEY: "s",
  };

  it("配齐了才认", () => {
    const config = readConfig(full);
    assert.ok(config);
    assert.equal(config.bucket, "agenticlab");
  });

  it("缺一项就整体算没配置，而不是跑起来再失败", () => {
    for (const key of Object.keys(full)) {
      const partial = { ...full, [key]: undefined };
      assert.equal(readConfig(partial), null, `缺 ${key} 时还认为配置好了`);
      assert.deepEqual(missingConfigKeys(partial), [key]);
    }
  });

  it("空字符串等于没填", () => {
    assert.equal(readConfig({ ...full, OFFSITE_S3_BUCKET: "   " }), null);
  });

  it("endpoint 末尾的斜杠去掉，避免拼出双斜杠的路径", () => {
    assert.equal(readConfig(full)!.endpoint, "https://x.r2.cloudflarestorage.com");
  });

  it("前缀自动补斜杠，不然对象名会粘在一起", () => {
    assert.equal(readConfig({ ...full, OFFSITE_S3_PREFIX: "abc" })!.prefix, "abc/");
    assert.equal(readConfig({ ...full, OFFSITE_S3_PREFIX: "abc/" })!.prefix, "abc/");
  });

  it("region 默认 auto —— R2 就是这么要求的", () => {
    assert.equal(readConfig(full)!.region, "auto");
  });

  it("全空时缺的是全部四项", () => {
    assert.equal(missingConfigKeys({}).length, 4);
  });
});
