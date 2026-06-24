// specrcheckr — local review server. Regenerates the packet, serves the page,
// and saves per-feature decisions/comments to .spec-review/approval.json.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generate } from "./generate.mjs";

export function serve({ config, root }, { port = Number(process.env.SPECRCHECKR_PORT || 4179), host = "127.0.0.1" } = {}) {
  const { outputDir } = generate({ config, root });
  const indexPath = resolve(outputDir, "index.html");
  const latestPath = resolve(outputDir, "latest.json");
  const approvalPath = resolve(outputDir, "approval.json");

  function send(res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((res, rej) => {
      let b = "";
      req.setEncoding("utf8");
      req.on("data", (c) => {
        b += c;
        if (b.length > 1024 * 1024) rej(new Error("body too large"));
      });
      req.on("end", () => res(b));
      req.on("error", rej);
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", `http://${host}:${port}`).pathname;
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        return send(res, 200, readFileSync(indexPath), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/latest.json") {
        return send(res, 200, readFileSync(latestPath), "application/json; charset=utf-8");
      }
      if (req.method === "POST" && pathname === "/approval") {
        const body = JSON.parse(await readBody(req));
        if (!["approved", "revise"].includes(body.decision)) return send(res, 400, "decision must be approved or revise");
        const latest = JSON.parse(readFileSync(latestPath, "utf8"));
        if (body.base !== latest.base || body.head !== latest.head) return send(res, 409, "packet is stale; reload the page");
        const approval = {
          base: latest.base,
          head: latest.head,
          decision: body.decision,
          comments: String(body.comments || ""),
          node_reviews: body.node_reviews && typeof body.node_reviews === "object" ? body.node_reviews : {},
          saved_at: new Date().toISOString(),
        };
        writeFileSync(approvalPath, `${JSON.stringify(approval, null, 2)}\n`);
        return send(res, 200, JSON.stringify(approval), "application/json; charset=utf-8");
      }
      send(res, 404, "not found");
    } catch (err) {
      send(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  server.listen(port, host, () => {
    console.log(`specrcheckr review server: http://${host}:${port}/`);
    console.log("Open it, decide each feature, then stop with Ctrl+C.");
  });
  return server;
}
