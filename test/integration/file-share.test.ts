import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileShareRuntime } from "./file-share-runtime";

test("file-share: real local Wrangler stores binary files in D1/R2 across restart and source update", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-file-share-"));
  const runtime = new FileShareRuntime(dir, 20000 + Math.floor(Math.random() * 30000));
  const { app, persist } = runtime;
  let id = "";
  let token = "";
  const owned = new Map<string, string>();

  // Inspect only the scratch persistence of pinned local Miniflare, never an account database.
  function persistedRows(provider: "d1" | "r2", table: string, query: string) {
    const directory = path.join(persist, "v3", provider);

    for (const file of fs.readdirSync(directory, { recursive: true })) {
      if (!String(file).endsWith(".sqlite")) continue;
      const db = new Database(path.join(directory, String(file)), { readonly: true });

      try {
        if (db.query("SELECT name FROM sqlite_master WHERE name = ?").get(table))
          return db.query(query).all();
      } finally {
        db.close();
      }
    }

    throw new Error(`Wrangler did not persist ${table} in local ${provider}`);
  }

  const databaseRows = () => persistedRows("d1", "files", "SELECT * FROM files ORDER BY id");

  const objectRows = () =>
    persistedRows("r2", "_mf_objects", "SELECT key, size FROM _mf_objects ORDER BY key");

  const request = runtime.request.bind(runtime);
  const start = runtime.start.bind(runtime);
  const stop = runtime.stop.bind(runtime);

  try {
    await start();
    expect((await request("/")).headers.get("x-app-version")).toBe("1");
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 60, 0]);

    const uploaded = await request("/api/files", {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent("résumé 日本.html"),
        "content-type": "text/html",
      },
      body: bytes,
    });

    expect(uploaded.status).toBe(201);
    // SAFETY: the public response shape is asserted below and used only in this integration scenario.
    const file = (await uploaded.json()) as { id: string; deleteToken: string; created: string };
    id = file.id;
    token = file.deleteToken;
    owned.set(id, token);
    expect(databaseRows()).toEqual([
      {
        id,
        name: "résumé 日本.html",
        size: bytes.length,
        mime: "text/html",
        created: file.created,
        delete_hash: createHash("sha256").update(token).digest("hex"),
      },
    ]);
    expect(token.length).toBeGreaterThan(30);
    expect(objectRows()).toEqual([{ key: id, size: bytes.length }]);

    async function verify() {
      const metadata = await request("/api/files/" + id);
      // SAFETY: metadata keys and values are immediately checked against the uploaded file.
      const m = (await metadata.json()) as Record<string, string | number>;
      expect(m).toMatchObject({
        id,
        name: "résumé 日本.html",
        size: bytes.length,
        mime: "text/html",
      });
      expect(JSON.stringify(m)).not.toContain(token);
      expect(Object.keys(m).sort()).toEqual(["created", "id", "mime", "name", "size"]);
      const download = await request("/api/files/" + id + "/download");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
      expect(download.headers.get("content-disposition")).toContain("attachment;");
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    }

    await verify();

    for (const authorization of ["", "Bearer " + "a".repeat(64)]) {
      expect(
        (await request("/api/files/" + id, { method: "DELETE", headers: { authorization } }))
          .status,
      ).toBe(403);
      await verify();
    }

    expect((await request("/api/files", { method: "GET" })).status).toBe(405);
    expect((await request("/api/files/nope")).status).toBe(404);
    expect((await request("/missing")).status).toBe(404);
    expect(
      (
        await request("/api/files", {
          method: "POST",
          headers: { "x-file-name": "%ZZ" },
          body: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/files", { method: "POST", body: new Uint8Array(1048577) })).status,
    ).toBe(413);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1048576));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });

    // Bun supports duplex for streamed requests; use a structural extension of the DOM type.
    const streamedRequest: RequestInit & { duplex: string } = {
      method: "POST",
      body: stream,
      duplex: "half",
    };

    expect((await request("/api/files", streamedRequest)).status).toBe(413);

    const boundary = await request("/api/files", {
      method: "POST",
      headers: {
        "x-file-name": encodeURIComponent('a/\\b"\r\n.html'),
        "content-type": "text/html; charset=utf-8",
      },
      body: new Uint8Array(1048576),
    });

    expect(boundary.status).toBe(201);

    // SAFETY: successful upload contract is checked immediately below; values only drive local HTTP requests.
    const max = (await boundary.json()) as {
      id: string;
      deleteToken: string;
      name: string;
      size: number;
      mime: string;
    };

    owned.set(max.id, max.deleteToken);
    expect(max.name).not.toMatch(/[\r\n/\\]/);
    expect(max.size).toBe(1048576);
    expect(max.mime).toBe("application/octet-stream");
    expect(
      (await request("/api/files/" + max.id + "/download")).headers.get("content-disposition"),
    ).toContain("filename*=UTF-8''");
    expect(
      (
        await request("/api/files/" + max.id, {
          method: "DELETE",
          headers: { authorization: "Bearer " + max.deleteToken },
        })
      ).status,
    ).toBe(204);
    expect((await request("/api/files/" + max.id + "/download")).status).toBe(404);
    owned.delete(max.id);
    expect(databaseRows()).toHaveLength(1);
    await stop();
    await start();
    expect((await request("/")).headers.get("x-app-version")).toBe("1");
    await verify();
    expect(databaseRows()).toHaveLength(1);
    expect(objectRows()).toEqual([{ key: id, size: bytes.length }]);
    await stop();
    const source = path.join(app, "src/worker.js");
    fs.writeFileSync(
      source,
      fs.readFileSync(source, "utf8").replace('APP_VERSION = "1"', 'APP_VERSION = "2"'),
    );
    await start();
    expect((await request("/")).headers.get("x-app-version")).toBe("2");
    await verify();
    expect(databaseRows()).toHaveLength(1);
    expect(objectRows()).toEqual([{ key: id, size: bytes.length }]);
    expect(
      (
        await request("/api/files/" + id, {
          method: "DELETE",
          headers: { authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(204);
    expect((await request("/api/files/" + id)).status).toBe(404);
    expect((await request("/api/files/" + id + "/download")).status).toBe(404);
    owned.delete(id);
    expect(databaseRows()).toEqual([]);
    expect(objectRows()).toEqual([]);
    id = "";
  } finally {
    try {
      for (const [fileId, capability] of owned) {
        const deleted = await request("/api/files/" + fileId, {
          method: "DELETE",
          headers: { authorization: "Bearer " + capability },
        });

        expect([204, 404]).toContain(deleted.status);
        expect((await request("/api/files/" + fileId + "/download")).status).toBe(404);
      }
    } finally {
      await stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}, 240_000);

test("file-share: a real Wrangler port collision never accepts or mutates the foreign runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend-file-share-collision-"));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const foreign = new FileShareRuntime(path.join(dir, "occupied"), port);
  const contender = new FileShareRuntime(path.join(dir, "contender"), port);
  let fileId = "";
  let capability = "";

  // Snapshot actual local provider inventories, including the capability hash.
  function inventory() {
    const rows = [];

    for (const [provider, table] of [
      ["d1", "files"],
      ["r2", "_mf_objects"],
    ]) {
      const directory = path.join(foreign.persist, "v3", provider);

      for (const file of fs.readdirSync(directory, { recursive: true })) {
        // Read provider object databases, not Miniflare's changing alarm metadata database.
        if (!/^[0-9a-f]{64}\.sqlite$/.test(path.basename(String(file)))) continue;
        const db = new Database(path.join(directory, String(file)), { readonly: true });

        try {
          if (db.query("SELECT name FROM sqlite_master WHERE name = ?").get(table))
            rows.push(db.query(`SELECT * FROM ${table}`).all());
        } finally {
          db.close();
        }
      }
    }

    expect(rows).toHaveLength(2);

    return rows;
  }

  try {
    await foreign.start();

    const uploaded = await foreign.request("/api/files", {
      method: "POST",
      headers: { "x-file-name": "occupied.txt" },
      body: "foreign runtime sentinel",
    });

    expect(uploaded.status).toBe(201);
    // SAFETY: the upload response's values are used only against this owned local runtime.
    const file = (await uploaded.json()) as { id: string; deleteToken: string };
    fileId = file.id;
    capability = file.deleteToken;
    const before = inventory();
    const identity = await foreign.request("/");
    expect(identity.headers.get("x-app-version")).toBe("1");
    expect(identity.headers.get("x-test-runtime")).toBe(foreign.marker);
    expect(identity.headers.get("x-test-mutations")).toBe("1");
    expect(contender.marker).not.toBe(foreign.marker);

    // Must fail without sending a POST even while the foreign app returns 200/version 1.
    // Wait for actual Wrangler startup/bind failure rather than killing npm before it starts.
    await expect(contender.start()).rejects.toThrow("foreign listener");
    expect(contender.exitCode).toBe(1);
    expect(contender.log).toMatch(/Address already in use|EADDRINUSE/i);
    await expect(
      contender.request("/api/files", { method: "POST", body: "must not be sent" }),
    ).rejects.toThrow("not ready");
    await contender.stop();

    const remaining = await foreign.request("/");
    expect(remaining.headers.get("x-test-runtime")).toBe(foreign.marker);
    expect(remaining.headers.get("x-app-version")).toBe("1");
    expect(remaining.headers.get("x-test-mutations")).toBe("1");
    expect(inventory()).toEqual(before);
    const download = await foreign.request("/api/files/" + fileId + "/download");
    expect(await download.text()).toBe("foreign runtime sentinel");
    console.info(
      "Collision: pinned Wrangler exited 1 with address-in-use; foreign marker/version, mutation count and D1/R2 inventories unchanged.",
    );
  } finally {
    try {
      if (fileId && capability) {
        expect(
          (
            await foreign.request("/api/files/" + fileId, {
              method: "DELETE",
              headers: { authorization: "Bearer " + capability },
            })
          ).status,
        ).toBe(204);
        expect((await foreign.request("/api/files/" + fileId)).status).toBe(404);
        expect((await foreign.request("/api/files/" + fileId + "/download")).status).toBe(404);
        expect(inventory()).toEqual([[], []]);
      }
    } finally {
      try {
        await contender.stop();
      } finally {
        await foreign.stop();
      }

      const listener = await fetch(foreign.base, { signal: AbortSignal.timeout(3000) }).catch(
        () => null,
      );

      expect(listener?.headers.get("x-test-runtime")).not.toBe(foreign.marker);
      expect(listener?.headers.get("x-test-runtime")).not.toBe(contender.marker);
      console.info(
        "Collision cleanup:",
        listener ? "foreign listener left untouched" : "port closed",
      );
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
