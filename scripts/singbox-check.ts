// Generate the sample configs (test/samples.ts) and run `sing-box check` on each one.
// Usage: SING_BOX=/path/to/sing-box npm run check:singbox
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateConfig } from "../src/generate";
import { sampleProfiles } from "../test/samples";

const binary = process.env.SING_BOX;
if (!binary) {
  console.error("set SING_BOX to a sing-box 1.14+ binary");
  process.exit(2);
}

const skip: Record<string, string> = {
  // The default profile keeps template placeholders empty on purpose; the schema test covers it.
  default: "template placeholders",
  // auto_redirect is Linux-only; sing-box refuses it elsewhere.
  ...(process.platform === "linux" ? {} : { "full-linux": "needs Linux" }),
};

const dir = mkdtempSync(join(tmpdir(), "singbox-check-"));
let failed = 0;
try {
  for (const { name, profile } of sampleProfiles()) {
    if (skip[name]) {
      console.log(`SKIP  ${name} (${skip[name]})`);
      continue;
    }
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(generateConfig(profile), null, 2));
    const r = spawnSync(binary, ["check", "-c", file, "-D", dir], { cwd: dir, encoding: "utf8" });
    if (r.status === 0) {
      console.log(`OK    ${name}`);
    } else {
      failed++;
      const last = `${r.stderr}${r.stdout}`.trim().split("\n").pop() ?? String(r.error ?? r.status);
      console.log(`FAIL  ${name}: ${last.replace(/\x1b\[[0-9;]*m/g, "")}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
