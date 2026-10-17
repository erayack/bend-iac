import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, Wrangler } from "../../src/live/wrangler";

// Genuine pinned CLI, no account operations. Keep credentials outside HOME.
test("pinned Wrangler emits D1-only and D1+R2 dry-run uploads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bend-r2-dry-run-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const old = process.env.HOME;
  process.env.HOME = home;
  const evidence = process.env.BEND_R2_LOCAL_EVIDENCE;

  try {
    const account = "0".repeat(32);
    const name = "bend-infra-e2e-0123456789abcdef-worker";
    const bucket = "bend-infra-e2e-0123456789abcdef-bucket";

    const source = Buffer.from(
      "export default { async fetch(request, env) { const row = await env.DB.prepare('SELECT 1').first(); const object = await env.BUCKET.get('local'); return Response.json({ row, found: object !== null }); } };\n",
    );

    const args = build.deployArgs(
      "0123456789abcdef",
      createHash("sha256").update(source).digest("hex"),
    );

    for (const r2 of [false, true]) {
      const dir = path.join(root, r2 ? "r2" : "d1");
      fs.mkdirSync(dir);

      const config = build.deployConfig(
        account,
        name,
        "2026-06-01",
        [
          {
            binding: "DB",
            database_name: "bend-infra-e2e-0123456789abcdef-db",
            database_id: "00000000-0000-0000-0000-000000000001",
          },
        ],
        r2 ? [{ binding: "BUCKET", bucket_name: bucket }] : [],
      );

      expect(Object.hasOwn(config, "r2_buckets")).toBe(r2);
      const adapter = new Wrangler(dir, account);
      await adapter.deployDryRun(config, source, args);

      const savedConfig = fs.readFileSync(
        path.join(dir, "work/001-deploy-dry-run/wrangler.json"),
        "utf8",
      );

      if (!r2)
        expect(savedConfig).toBe(
          JSON.stringify(
            {
              name,
              main: "worker.js",
              compatibility_date: "2026-06-01",
              account_id: account,
              workers_dev: true,
              preview_urls: false,
              no_bundle: true,
              upload_source_maps: false,
              send_metrics: false,
              d1_databases: [
                {
                  binding: "DB",
                  database_name: "bend-infra-e2e-0123456789abcdef-db",
                  database_id: "00000000-0000-0000-0000-000000000001",
                },
              ],
            },
            null,
            2,
          ) + "\n",
        );

      const upload = fs.readFileSync(
        path.join(dir, "work/001-deploy-dry-run/dry-run-out/worker.js"),
        "utf8",
      );

      expect(upload).toContain("export default");
      const log = fs.readFileSync(path.join(dir, "work/001-deploy-dry-run/stdout.txt"), "utf8");
      expect(log).toContain("DB");

      if (r2) expect(log).toContain(bucket);

      const metadata = fs.readFileSync(
        path.join(dir, "work/001-deploy-dry-run/dry-run-upload.multipart"),
        "utf8",
      );

      expect(metadata).toContain("d1");
      expect(metadata.includes("r2_bucket")).toBe(r2);

      if (r2) {
        expect(metadata).toContain(bucket);

        for (const invalid of [
          { ...config, r2_buckets: [{ binding: "DB", bucket_name: bucket }] },
          { ...config, r2_buckets: [{ binding: "bad", bucket_name: bucket }] },
          { ...config, r2_buckets: [{ binding: "BUCKET", bucket_name: "foreign-bucket" }] },
          {
            ...config,
            r2_buckets: [{ binding: "BUCKET", bucket_name: bucket, jurisdiction: "eu" }],
          },
          {
            ...config,
            r2_buckets: [
              { binding: "BUCKET", bucket_name: bucket },
              { binding: "OTHER", bucket_name: bucket },
            ],
          },
          { ...config, name: "foreign-worker" },
          { ...config, account_id: "1".repeat(32) },
        ])
          await expect(adapter.deployDryRun(invalid, source, args)).rejects.toThrow();
        // Invalid adapter inputs never reach the real CLI; this is a guard
        // assertion in the genuine dry-run scenario, not provider coverage.
        expect(fs.readdirSync(path.join(dir, "work"))).toEqual(["001-deploy-dry-run"]);
        expect(
          fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").match(/"phase":"start"/g),
        ).toHaveLength(1);
      }

      if (evidence) fs.cpSync(dir, path.join(evidence, r2 ? "r2" : "d1"), { recursive: true });
    }
  } finally {
    if (old === undefined) delete process.env.HOME;
    else process.env.HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
