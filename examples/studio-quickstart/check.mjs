#!/usr/bin/env node
// Self-check for the quickstart: boots this example with the SDK's own launcher from a temporary copy and checks
// what the README promises. Node 18+, nothing to install.
//
//   node examples/studio-quickstart/check.mjs
//
// It never touches the example folder itself (the copy gets the .runtime/ directory), and it stops the Studio it started.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.resolve(here, "../../tools/studio.mjs");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "studio-quickstart-"));
fs.cpSync(here, work, { recursive: true, filter: (p) => !p.includes(`${path.sep}.runtime`) });

const free = (port) =>
  new Promise((resolve) => {
    const s = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
let port = 0;
for (let p = 18890; p < 19890 && !port; p += 10)
  if ((await Promise.all([0, 1, 2, 3].map((i) => free(p + i)))).every(Boolean)) port = p;
if (!port) {
  console.error("no free port block between 18890 and 19890");
  process.exit(1);
}

const origin = `http://127.0.0.1:${port}`;
const studio = spawn(process.execPath, [launcher, "--port", String(port)], {
  cwd: work,
  env: { ...process.env, OPENRIG_STUDIO_DIR: work },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
studio.stdout.on("data", (d) => (log += d));
studio.stderr.on("data", (d) => (log += d));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const get = async (p, init) => {
  const r = await fetch(origin + p, init);
  return { status: r.status, body: await r.text() };
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await get("/")).status === 200;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  check("the Studio starts", up, up ? origin : log.slice(-400));
  if (up) {
    const contract = JSON.parse((await get("/api/contract")).body);
    check(
      "the runtime describes its contract",
      Boolean(contract.contract ?? contract.version ?? contract.capabilities),
      "GET /api/contract",
    );
    const rail = JSON.parse(
      fs.readFileSync(path.join(work, ".runtime/surfaces/surfaces.json"), "utf8"),
    );
    check(
      "Notes is on the rail",
      rail.surfaces.some((s) => s.id === "notes"),
    );
    check("the Notes page is served", (await get("/surfaces/notes.html")).status === 200);
    const first = JSON.parse((await get("/api/notes")).body);
    check(
      "the provider lists the bound folder",
      first.notes.some((n) => n.name === "welcome.md"),
      JSON.stringify(first.notes.map((n) => n.name)),
    );
    fs.writeFileSync(
      path.join(work, "notes", "added.md"),
      "# Added\n\nWritten while the Studio was running.\n",
    );
    const second = JSON.parse((await get("/api/notes")).body);
    check(
      "a note added while running shows on the next read",
      second.notes.some((n) => n.name === "added.md"),
    );
    const item = JSON.parse((await get("/api/notes/item?name=added.md")).body);
    check("one note reads back", item.text?.startsWith("# Added"));
    check(
      "a path outside the folder is refused",
      (await get("/api/notes/item?name=../studio.json")).status === 404,
    );
    check(
      "the provider is read-only",
      (await get("/api/notes", { method: "POST" })).status === 405,
    );
    check(
      "no agent terminal is offered (chatSeats is empty)",
      (await get("/chat/")).status === 404,
    );
  }
} finally {
  studio.kill("SIGTERM");
  await new Promise((r) => studio.once("exit", r));
  fs.rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
