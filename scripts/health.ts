/** 跑一轮健康探测并落库。 npm run health */
import { runHealthChecks, takeStorageSnapshot } from "@/lib/health";

runHealthChecks()
  .then((reports) => {
    for (const r of reports) {
      const icon = r.status === "ok" ? "✓" : r.status === "degraded" ? "!" : "✗";
      console.log(`  ${icon} ${r.component.padEnd(13)} ${r.status.padEnd(9)} ${r.detail ?? ""}`);
    }
    const s = takeStorageSnapshot();
    console.log(`\n库 ${(s.dbBytes / 1048576).toFixed(1)}MB（FTS ${(s.ftsBytes / 1048576).toFixed(1)}MB）· 磁盘 ${s.diskPct}%`);
    for (const t of s.byTable.slice(0, 6)) {
      console.log(`    ${t.name.padEnd(22)} ${(t.bytes / 1048576).toFixed(2)} MB`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
