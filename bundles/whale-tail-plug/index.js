// whale-tail-plug — host half: serves the three artwork files to the browser.
// Ported from dsh-moe-lite (KurosawaGeeker, lib/index.js); route renamed.
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-whale-tail-plug";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "assets");

const MIME = {
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

const ALLOWED = new Set([
  "whale-tail-wiggle.gif",
  "whale-tail-first.webp",
  "deepseek-harness-maid-stacked.svg",
]);

export async function apply(ctx) {
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    const dispose = webServer.register({
      kind: "exact",
      path: "/api/whale-tail-plug/assets",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          const rel = (url.searchParams.get("f") ?? "").split("?")[0];
          if (!ALLOWED.has(rel)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          const file = path.normalize(path.join(ASSETS_DIR, rel));
          if (!file.startsWith(ASSETS_DIR + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
          }
          res.writeHead(200, {
            "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=86400",
          });
          createReadStream(file).pipe(res);
        } catch (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => dispose, "whale-tail-plug: asset route");
  });
}
