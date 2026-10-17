// The test Worker's source, in two versions. It is benign: it stores at
// most eight markers of one fixed shape in its D1 database and reads them
// back. It is deployed as written (--no-bundle), so these bytes are the
// bytes whose sha256 the plan carries.
export const workerSource = (version: string) => `// bend-infra test:live Worker, version ${version}
const VERSION = ${JSON.stringify(version)};
const MARKER = /^bend-infra-e2e-marker-[0-9a-f]{32}$/;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/version") return json({ version: VERSION });
    if (url.pathname !== "/marker") return json({ error: "not found" }, 404);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS markers (value TEXT PRIMARY KEY)").run();
    if (request.method === "POST") {
      const value = url.searchParams.get("value") ?? "";
      if (!MARKER.test(value)) return json({ error: "bad marker" }, 400);
      const row = await env.DB.prepare("SELECT count(*) AS n FROM markers").first();
      if (row.n >= 8) return json({ error: "full" }, 409);
      await env.DB.prepare("INSERT OR IGNORE INTO markers (value) VALUES (?1)").bind(value).run();
      return json({ version: VERSION, stored: value });
    }
    if (request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT value FROM markers ORDER BY value").all();
      return json({ version: VERSION, markers: results.map((r) => r.value) });
    }
    return json({ error: "method not allowed" }, 405);
  },
};
`;
