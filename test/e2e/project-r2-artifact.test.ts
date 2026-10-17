// Authored ledger/artifact inputs, not provider responses or lifecycle evidence.
// Every public CLI invocation has scratch HOME and no npx in PATH.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonData } from "../../src/json";
import { BIN, ROOT } from "./helpers";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CREATED = "2026-06-01T00:00:00Z";
const UUID = "11111111-1111-4111-8111-111111111111";
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bend-r2-artifact-")));
const tools = path.join(scratch, "tools");
const home = path.join(scratch, "home");

fs.mkdirSync(tools);

fs.mkdirSync(home);

fs.symlinkSync(process.execPath, path.join(tools, "bun"));

fs.symlinkSync("/bin/bash", path.join(tools, "bash"));

fs.symlinkSync("/usr/bin/dirname", path.join(tools, "dirname"));

process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const write = (file: string, value: JsonData) => fs.writeFileSync(file, JSON.stringify(value));
const copy = (value: JsonData) => JSON.parse(JSON.stringify(value));

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(BIN, args, { cwd, encoding: "utf8", env: { HOME: home, PATH: tools } });

  if (r.error) throw r.error;

  return { code: r.status, out: r.stdout, err: r.stderr };
}

type Mode =
  | "create"
  | "delete"
  | "protected-delete"
  | "mixed-protected-delete"
  | "protect"
  | "worker"
  | "worker-existing-db"
  | "consumer-delete"
  | "consumer-update"
  | "unbound-delete";

function scenario(mode: Mode = "create") {
  const dir = path.join(scratch, `p${sequence++}`);

  const init = cli(
    scratch,
    "init",
    dir,
    "--project",
    "hello",
    "--env",
    "dev",
    "--account",
    ACCOUNT,
  );

  expect(init.code).toBe(0);
  const state = path.join(dir, ".bend-iac/dev");
  const ledgerFile = path.join(state, "ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.version = 2;

  const name = (id: string) => `hello-dev-${id}-${ledger.run.slice(0, 8)}`;
  const sourcePath = path.join(dir, "src/worker.js");
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const digest = sha(sourceText);

  const bucket = {
    type: "r2_bucket",
    id: "files",
    environment: "dev",
    protected: mode === "protected-delete" || mode === "mixed-protected-delete",
  };

  const database = {
    type: "d1_database",
    id: "db",
    environment: "dev",
    protected: mode === "mixed-protected-delete",
    location: "weur",
    readReplication: "disabled",
  };

  const worker = {
    type: "worker",
    id: "api",
    environment: "dev",
    main: `sha256:${digest}`,
    compatibilityDate: "2026-06-01",
    bindings: [{ name: "FILES", bucket: "files" }],
  };

  const desired = copy({
    version: 1,
    kind: "bend-infra/desired",
    environments: ["dev"],
    resources: [bucket],
  });

  const observed = copy({
    version: 1,
    kind: "bend-infra/observed",
    source: "fixture",
    resources: [],
  });

  const present = !["create", "worker", "worker-existing-db"].includes(mode);

  ledger.resources = {
    files: {
      type: "r2_bucket",
      logicalId: "files",
      name: name("files"),
      status: present ? "created" : "new",
      physicalId: null,
      protected: bucket.protected,
      bucketCreated: present ? CREATED : null,
      history: [],
    },
  };

  const evidence = copy([
    {
      id: "files",
      type: "r2_bucket",
      name: name("files"),
      present,
      bucketCreated: present ? CREATED : null,
    },
  ]);

  if (present) observed.resources = [bucket];

  if (mode === "protect") desired.resources = [{ ...bucket, protected: true }];

  if (mode.includes("delete")) desired.resources = [];

  if (mode === "mixed-protected-delete") {
    observed.resources.unshift(database);
    ledger.resources.db = {
      type: "d1_database",
      logicalId: "db",
      name: name("db"),
      status: "created",
      physicalId: UUID,
      location: "weur",
      readReplication: "disabled",
      protected: true,
      history: [],
    };
    evidence.push({
      id: "db",
      type: "d1_database",
      name: name("db"),
      present: true,
      uuid: UUID,
      readReplication: "disabled",
    });
  }

  if (mode === "worker" || mode === "worker-existing-db") {
    desired.resources = [
      database,
      bucket,
      { ...worker, bindings: [{ name: "DB", database: "db" }, ...worker.bindings] },
    ];
    ledger.resources.db = {
      type: "d1_database",
      logicalId: "db",
      name: name("db"),
      status: "new",
      physicalId: null,
      history: [],
    };
    ledger.resources.api = {
      type: "worker",
      logicalId: "api",
      name: name("api"),
      status: "new",
      physicalId: null,
      history: [],
    };
    evidence.push(
      { id: "db", type: "d1_database", name: name("db"), present: false },
      { id: "api", type: "worker", name: name("api"), present: false },
    );

    if (mode === "worker-existing-db") {
      Object.assign(ledger.resources.db, {
        status: "created",
        physicalId: UUID,
        location: "weur",
        readReplication: "disabled",
        protected: false,
      });
      Object.assign(evidence[1], { present: true, uuid: UUID, readReplication: "disabled" });
      observed.resources.push(database);
    }
  }

  if (["consumer-delete", "consumer-update", "unbound-delete"].includes(mode)) {
    const unbound = { ...worker, bindings: [] };
    const bound = mode !== "unbound-delete";
    observed.resources.push(bound ? worker : unbound);
    ledger.resources.api = {
      type: "worker",
      logicalId: "api",
      name: name("api"),
      status: "created",
      physicalId: null,
      versionId: "owned-version",
      etag: "owned-etag",
      sourceSha256: digest,
      history: [],
    };
    evidence.push({
      id: "api",
      type: "worker",
      name: name("api"),
      present: true,
      versionId: "owned-version",
      etag: "owned-etag",
      message: `bend-infra sha256:${digest}`,
      tag: `run-${ledger.run}`,
      compatibilityDate: worker.compatibilityDate,
      compatibilityFlags: [],
      bindings: bound
        ? [
            {
              type: "r2_bucket",
              name: "FILES",
              id: null,
              r2: { bucketName: name("files"), jurisdiction: null },
            },
          ]
        : [],
    });

    if (mode !== "consumer-delete") desired.resources = [unbound];
  }

  write(ledgerFile, ledger);
  const inputs = path.join(dir, "inputs");
  fs.mkdirSync(inputs);

  const grant = {
    version: 1,
    kind: "bend-infra/grant",
    environment: "dev",
    allow: ["create", "update", "delete"],
  };

  write(path.join(inputs, "desired.json"), desired);
  write(path.join(inputs, "observed.json"), observed);
  write(path.join(inputs, "grant.json"), grant);

  const approvals = {
    version: 1,
    kind: "bend-infra/approvals",
    approvals: (mode === "mixed-protected-delete"
      ? ["files", "db"]
      : mode === "protected-delete"
        ? ["files"]
        : []
    ).map((resource) => ({
      action: "delete",
      resource,
      environment: "dev",
      approvedBy: "reviewer@example.com",
      reason: "recorded local boundary",
    })),
  };

  write(path.join(inputs, "approvals.json"), approvals);
  const planned = cli(dir, "plan", inputs, "--json");
  expect(planned.code).toBe(0);
  const rep = JSON.parse(planned.out);
  expect(rep.outcome).toBe("approved");

  const payload = rep.operations.map(
    (op: { action: string; type: string; id: string }, i: number) => {
      const head = { step: i + 1, action: op.action, type: op.type, id: op.id, name: name(op.id) };

      if (op.type === "r2_bucket") {
        if (op.action === "update")
          return { ...head, purpose: "protect-bucket", bucketCreated: CREATED, protected: true };

        return {
          ...head,
          purpose: `r2-${op.action}`,
          args: [
            "r2",
            "bucket",
            op.action,
            name(op.id),
            ...(op.action === "create" ? ["--update-config=false"] : []),
          ],
          config: { account_id: ACCOUNT, send_metrics: false },
        };
      }

      if (op.type === "d1_database" && op.action === "delete")
        return {
          ...head,
          purpose: "d1-delete",
          args: ["d1", "delete", name("db"), "--skip-confirmation"],
          config: {
            account_id: ACCOUNT,
            send_metrics: false,
            d1_databases: [{ binding: "DB", database_name: name("db"), database_id: UUID }],
          },
        };

      if (op.type === "d1_database")
        return {
          ...head,
          purpose: "d1-create",
          args: ["d1", "create", name("db"), "--location", "weur", "--update-config=false"],
          config: { account_id: ACCOUNT, send_metrics: false },
        };

      if (op.action === "delete")
        return {
          ...head,
          purpose: "delete-worker",
          args: ["delete", "--name", name("api")],
          config: { account_id: ACCOUNT, send_metrics: false, name: name("api") },
        };

      const config = copy({
        name: name("api"),
        main: "worker.js",
        compatibility_date: "2026-06-01",
        account_id: ACCOUNT,
        workers_dev: true,
        preview_urls: false,
        no_bundle: true,
        upload_source_maps: false,
        send_metrics: false,
        d1_databases: [],
      });

      if (mode === "worker" || mode === "worker-existing-db") {
        config.d1_databases = [
          {
            binding: "DB",
            database_name: name("db"),
            database_id:
              mode === "worker" ? '{uuid of d1_database "db" created by an earlier step}' : UUID,
          },
        ];
        config.r2_buckets = [{ binding: "FILES", bucket_name: name("files") }];
      }

      return {
        ...head,
        purpose: "deploy",
        args: [
          "deploy",
          "--no-bundle",
          "--autoconfig=false",
          "--strict",
          "--message",
          `bend-infra sha256:${digest}`,
          "--tag",
          `run-${ledger.run}`,
        ],
        config,
        sourceSha256: digest,
      };
    },
  );

  const needsSource =
    mode === "worker" || mode === "worker-existing-db" || mode === "consumer-update";

  if (needsSource) {
    fs.mkdirSync(path.join(state, "sources"));
    fs.writeFileSync(path.join(state, "sources", `${digest}.js`), sourceText);
  }

  const artifact = copy({
    version: 2,
    kind: "bend-iac/project-artifact",
    project: "hello",
    purpose: "plan",
    run: ledger.run,
    account: ACCOUNT,
    environment: "dev",
    wrangler: ["npx", "--yes", "wrangler@4.151.1"],
    engine: JSON.parse(fs.readFileSync(path.join(ROOT, ".build/stamp.json"), "utf8")),
    outcome: rep.outcome,
    operations: rep.operations,
    problems: rep.problems,
    inputs: { desired, observed: { ...observed, source: "wrangler" }, grant, approvals },
    observation: evidence,
    source: needsSource
      ? {
          file: "src/worker.js",
          path: sourcePath,
          sha256: digest,
          bytes: Buffer.byteLength(sourceText),
          stored: `sources/${digest}.js`,
        }
      : null,
    payload,
  });

  return { dir, state, ledgerFile, ledger, inputs, artifact, sourcePath };
}

function apply(p: ReturnType<typeof scenario>, artifact = p.artifact, digest?: string) {
  write(p.ledgerFile, p.ledger);

  const before = fs.readFileSync(p.ledgerFile, "utf8");
  const files = fs.readdirSync(p.state);
  const source = artifact.source?.stored;
  const original = fs.readFileSync(p.sourcePath, "utf8");

  const stored =
    source && fs.existsSync(path.join(p.state, source))
      ? fs.readFileSync(path.join(p.state, source), "utf8")
      : null;

  const file = path.join(p.inputs, "artifact.json");
  const text = JSON.stringify(artifact);
  fs.writeFileSync(file, text);

  const r = cli(
    p.dir,
    "apply",
    "--env",
    "dev",
    "--account",
    ACCOUNT,
    "--artifact",
    file,
    "--digest",
    digest ?? `sha256:${sha(text)}`,
  );

  expect(fs.readFileSync(p.ledgerFile, "utf8")).toBe(before);
  expect(fs.readFileSync(p.sourcePath, "utf8")).toBe(original);

  if (r.code === 69) {
    expect(fs.readdirSync(p.state).sort()).toEqual([...files, "journal.jsonl", "work"].sort());

    const journal = fs
      .readFileSync(path.join(p.state, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));

    expect(journal.filter((e) => e.phase === "start").map((e) => [e.purpose, e.mutating])).toEqual([
      ["version", false],
    ]);
    expect(journal.every((e) => e.purpose === "version")).toBe(true);
    expect(journal.filter((e) => e.phase === "spawned").every((e) => e.pid === null)).toBe(true);
    expect(fs.readdirSync(path.join(p.state, "work"))).toEqual(["001-version"]);
  } else expect(fs.readdirSync(p.state).sort()).toEqual(files.sort());

  if (stored !== null) expect(fs.readFileSync(path.join(p.state, source), "utf8")).toBe(stored);

  return r;
}

type Scenario = ReturnType<typeof scenario>;

const controls: {
  label: string;
  mode: Mode;
  change: (p: Scenario) => void;
  code: number;
  diagnostic: string;
}[] = [
  {
    label: "persisted D1 UUID drift",
    mode: "worker-existing-db",
    change: (p) => {
      p.artifact.observation[1].uuid = "22222222-2222-4222-8222-222222222222";
    },
    code: 4,
    diagnostic: "D1 uuid differs",
  },
  {
    label: "placeholder without earlier D1 create",
    mode: "worker-existing-db",
    change: (p) => {
      p.artifact.payload[1].config.d1_databases[0].database_id =
        '{uuid of d1_database "db" created by an earlier step}';
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "foreign account",
    mode: "create",
    change: (p) => {
      p.artifact.account = "fedcba9876543210fedcba9876543210";
    },
    code: 5,
    diagnostic: "another account",
  },
  {
    label: "old artifact version",
    mode: "create",
    change: (p) => {
      p.artifact.version = 1;
    },
    code: 5,
    diagnostic: "not a bend-infra live plan artifact",
  },
  {
    label: "unknown artifact identity field",
    mode: "create",
    change: (p) => {
      p.artifact.bucketCreated = CREATED;
    },
    code: 5,
    diagnostic: "unknown field",
  },
  {
    label: "foreign evidence name",
    mode: "create",
    change: (p) => {
      p.artifact.observation[0].name = "other-dev-files-01234567";
    },
    code: 4,
    diagnostic: "foreign type/name/ownership",
  },
  {
    label: "cross-kind evidence",
    mode: "create",
    change: (p) => {
      p.artifact.observation[0].type = "worker";
      delete p.artifact.observation[0].bucketCreated;
    },
    code: 4,
    diagnostic: "foreign type/name/ownership",
  },
  {
    label: "missing absence evidence",
    mode: "create",
    change: (p) => {
      p.artifact.observation = [];
    },
    code: 4,
    diagnostic: "existence is undetermined",
  },
  {
    label: "duplicate evidence",
    mode: "create",
    change: (p) => {
      p.artifact.observation.push(p.artifact.observation[0]);
    },
    code: 4,
    diagnostic: "duplicate resource evidence",
  },
  {
    label: "unknown presence",
    mode: "create",
    change: (p) => {
      p.artifact.observation[0].present = null;
    },
    code: 5,
    diagnostic: "present",
  },
  {
    label: "existing-name create",
    mode: "create",
    change: (p) => {
      p.ledger.resources.files.status = "created";
      p.ledger.resources.files.bucketCreated = CREATED;
      p.artifact.observation[0].present = true;
      p.artifact.observation[0].bucketCreated = CREATED;
    },
    code: 4,
    diagnostic: "explicit exact-name absence",
  },
  {
    label: "missing generation",
    mode: "delete",
    change: (p) => {
      delete p.artifact.observation[0].bucketCreated;
    },
    code: 5,
    diagnostic: "bucketCreated",
  },
  {
    label: "malformed generation",
    mode: "delete",
    change: (p) => {
      p.artifact.observation[0].bucketCreated = "yesterday";
    },
    code: 5,
    diagnostic: "valid generation",
  },
  {
    label: "changed generation",
    mode: "delete",
    change: (p) => {
      p.artifact.observation[0].bucketCreated = "2026-06-02T00:00:00Z";
    },
    code: 4,
    diagnostic: "generation differs",
  },
  {
    label: "foreign R2 evidence fields",
    mode: "delete",
    change: (p) => {
      p.artifact.observation[0].uuid = "11111111-1111-4111-8111-111111111111";
    },
    code: 5,
    diagnostic: "unknown field",
  },
  {
    label: "false snapshot absence",
    mode: "delete",
    change: (p) => {
      p.artifact.observation[0].present = false;
      p.artifact.observation[0].bucketCreated = null;
    },
    code: 4,
    diagnostic: "snapshot presence",
  },
  {
    label: "snapshot protection tamper",
    mode: "protect",
    change: (p) => {
      p.artifact.inputs.observed.resources[0].protected = true;
    },
    code: 5,
    diagnostic: "planner does not return",
  },
  {
    label: "missing protected deletion approval",
    mode: "protected-delete",
    change: (p) => {
      p.artifact.inputs.approvals.approvals = [];
    },
    code: 5,
    diagnostic: "planner does not return",
  },
  {
    label: "wrong protected deletion approval",
    mode: "protected-delete",
    change: (p) => {
      p.artifact.inputs.approvals.approvals[0].resource = "other";
    },
    code: 5,
    diagnostic: "planner does not return",
  },
  {
    label: "mutating object-purge argv",
    mode: "delete",
    change: (p) => {
      p.artifact.payload[0].args.push("--force-empty");
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "foreign payload account",
    mode: "create",
    change: (p) => {
      p.artifact.payload[0].config.account_id = "fedcba9876543210fedcba9876543210";
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "protection generation redirect",
    mode: "protect",
    change: (p) => {
      p.artifact.payload[0].bucketCreated = "2026-06-02T00:00:00Z";
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "fake protection command",
    mode: "protect",
    change: (p) => {
      p.artifact.payload[0].args = ["r2", "protect"];
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "foreign Worker R2 payload target",
    mode: "worker",
    change: (p) => {
      p.artifact.payload[2].config.r2_buckets[0].bucket_name = "other-dev-files-01234567";
    },
    code: 5,
    diagnostic: "payload is not the one",
  },
  {
    label: "source byte count",
    mode: "worker",
    change: (p) => {
      p.artifact.source.bytes++;
    },
    code: 5,
    diagnostic: "byte count",
  },
  {
    label: "source copy redirect",
    mode: "worker",
    change: (p) => {
      p.artifact.source.stored = "../worker.js";
    },
    code: 5,
    diagnostic: "source identity/copy path",
  },
  {
    label: "source path redirect",
    mode: "worker",
    change: (p) => {
      p.artifact.source.path = path.join(p.dir, "other.js");
    },
    code: 5,
    diagnostic: "source identity/copy path",
  },
  {
    label: "changed source bytes",
    mode: "worker",
    change: (p) => {
      fs.appendFileSync(p.sourcePath, "\n// changed\n");
    },
    code: 5,
    diagnostic: "changed since prepare",
  },
  {
    label: "changed stored bytes",
    mode: "worker",
    change: (p) => {
      fs.appendFileSync(path.join(p.state, p.artifact.source.stored), "x");
    },
    code: 5,
    diagnostic: "byte count",
  },
  {
    label: "foreign binding evidence",
    mode: "consumer-delete",
    change: (p) => {
      p.artifact.observation[1].bindings[0].r2.bucketName = "other-dev-files-01234567";
    },
    code: 4,
    diagnostic: "foreign provider target",
  },
  {
    label: "nondefault binding jurisdiction",
    mode: "consumer-delete",
    change: (p) => {
      p.artifact.observation[1].bindings[0].r2.jurisdiction = "eu";
    },
    code: 5,
    diagnostic: "default jurisdiction",
  },
  {
    label: "cross-kind binding target",
    mode: "consumer-delete",
    change: (p) => {
      p.artifact.observation[1].bindings[0].id = "11111111-1111-4111-8111-111111111111";
    },
    code: 5,
    diagnostic: "no D1 uuid",
  },
  {
    label: "unknown binding",
    mode: "consumer-delete",
    change: (p) => {
      p.artifact.observation[1].bindings[0].type = "secret_text";
    },
    code: 5,
    diagnostic: "type",
  },
  {
    label: "Worker flags",
    mode: "consumer-delete",
    change: (p) => {
      p.artifact.observation[1].compatibilityFlags = ["nodejs_compat"];
    },
    code: 4,
    diagnostic: "undetermined or drifted",
  },
  {
    label: "unknown Worker existence",
    mode: "unbound-delete",
    change: (p) => {
      p.artifact.observation.pop();
    },
    code: 4,
    diagnostic: "positively permit bucket deletion",
  },
  {
    label: "consumer still binding bucket",
    mode: "unbound-delete",
    change: (p) => {
      p.artifact.observation[1].bindings = [
        {
          type: "r2_bucket",
          name: "FILES",
          id: null,
          r2: { bucketName: p.ledger.resources.files.name, jurisdiction: null },
        },
      ];
    },
    code: 4,
    diagnostic: "positively permit bucket deletion",
  },
];

for (const control of controls)
  test(`project R2 artifact: refuses ${control.label} before provider access`, () => {
    const p = scenario(control.mode);
    control.change(p);
    const r = apply(p);
    expect(r.err).toContain(control.diagnostic);
    expect(r.err).not.toContain("local artifact checks passed");
    expect(r.code).toBe(control.code);
  });

test.each(["unknown", "creating", "deleting", "conflict"])(
  "project R2 artifact: %s is not safe absence for create",
  (status) => {
    const p = scenario();
    p.ledger.resources.files.status = status;

    if (status === "deleting") p.ledger.resources.files.bucketCreated = CREATED;
    const r = apply(p);
    expect(r.code).toBe(4);
    expect(r.err).toContain(`ledger status is ${status}`);
    expect(r.err).not.toContain("local artifact checks passed");
  },
);

test("project R2 artifact: confirmed deletion permits same-ID create after recorded absence", () => {
  const p = scenario();
  p.ledger.resources.files.status = "deleted";
  p.ledger.resources.files.bucketCreated = CREATED;
  const r = apply(p);
  expect(r.code).toBe(69);
  expect(r.err).toContain("npx");
});

test.each(["db", "files"])(
  "project R2 artifact: each protected provider needs its own approval (%s)",
  (id) => {
    const p = scenario("mixed-protected-delete");
    p.artifact.inputs.approvals.approvals = p.artifact.inputs.approvals.approvals.filter(
      (a: { resource: string }) => a.resource !== id,
    );
    const r = apply(p);
    expect(r.code).toBe(5);
    expect(r.err).toContain("planner does not return");
  },
);

test.each(["hello/dev", "hello/other"])(
  "project R2 destroy: exact confirmation gate %s stays guarded",
  (confirm) => {
    const p = scenario("mixed-protected-delete");
    const file = path.join(p.inputs, "destroy-approvals.json");
    write(file, p.artifact.inputs.approvals);

    const before = fs.readFileSync(p.ledgerFile, "utf8");

    const r = cli(
      p.dir,
      "destroy",
      "--env",
      "dev",
      "--account",
      ACCOUNT,
      "--confirm",
      confirm,
      "--approvals",
      file,
    );

    expect(fs.readFileSync(p.ledgerFile, "utf8")).toBe(before);

    if (confirm !== "hello/dev") {
      expect(r.code).toBe(5);
      expect(r.err).toContain("--confirm must be exactly hello/dev");
      expect(fs.readdirSync(p.state)).toEqual(["ledger.json"]);
    } else {
      expect(r.code).toBe(69);
      expect(r.err).toContain("npx");

      const journal = fs
        .readFileSync(path.join(p.state, "journal.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));

      expect(journal.every((e) => e.purpose === "version")).toBe(true);
      expect(
        journal.filter((e) => e.phase === "start").map((e) => [e.purpose, e.mutating]),
      ).toEqual([["version", false]]);
      expect(journal.filter((e) => e.phase === "spawned").every((e) => e.pid === null)).toBe(true);
      expect(fs.readdirSync(path.join(p.state, "work"))).toEqual(["001-version"]);
      expect(fs.readdirSync(p.state).sort()).toEqual(["journal.jsonl", "ledger.json", "work"]);
    }
  },
);

test("project R2 artifact: caller digest is checked before local payload validation", () => {
  const p = scenario();
  const r = apply(p, p.artifact, `sha256:${"0".repeat(64)}`);
  expect(r.code).toBe(5);
  expect(r.err).toContain("artifact digest");
});

test.each([
  "create",
  "delete",
  "protected-delete",
  "mixed-protected-delete",
  "protect",
  "worker",
  "worker-existing-db",
  "consumer-delete",
  "consumer-update",
  "unbound-delete",
] as const)(
  "project R2 artifact: exact %s payload reaches only the guarded version child",
  (mode) => {
    const p = scenario(mode);
    const r = apply(p);
    expect(r.err).toContain("npx");
    expect(r.code).toBe(69);

    if (mode === "worker")
      expect(p.artifact.operations.map((o: { id: string }) => o.id)).toEqual([
        "db",
        "files",
        "api",
      ]);

    if (mode === "consumer-delete")
      expect(p.artifact.operations.map((o: { id: string }) => o.id)).toEqual(["api", "files"]);
  },
);
