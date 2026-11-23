// A generated app's own listener: the app's static files on an origin of their own, and nothing else.
// No Studio API, proxy, credential, bridge or WebSocket is reachable through it, so a page the app serves
// can't act as the person in their Studio even though they are signed in to both.
//
// It is OFF unless a server-hooks module offers admission for project apps: the module's named export
// `projectApp(ctx)` (contract/server-hooks.md, "Off without admission: project apps"). That admission
// decides every request and every upgrade on this listener. There is no loopback default here: a
// listener meant for an outside origin with nobody deciding who reaches it would serve everyone.
//
// The hook gets only what this listener is: the app id, its origin, the Studio's origin and an explicit
// binding file. It gets no environment and no Studio route, so a sign-in for this origin is configured
// on purpose and never borrowed from the Studio's own.
//
//   node tools/project-app-server.mjs --hooks /abs/hooks.mjs --app <id> --root /abs/app/folder \
//     --origin https://app.example [--studio-origin https://studio.example] \
//     [--auth-binding /abs/binding.json] [--port 8893]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serveProjectApp } from "./project-app-assets.mjs";
import { refuseUpgrade } from "./server-hooks.mjs";

const LOCAL_NAMES = ["127.0.0.1", "localhost", "[::1]"];
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isFn = (f) => typeof f === "function";

// An origin exactly as a browser names it: https, or http on this computer only.
function exactOrigin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const ok =
    u.origin === value &&
    !u.username &&
    !u.password &&
    (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_NAMES.includes(u.hostname)));
  return ok ? u : null;
}

// Checks what `projectApp(ctx)` returned, in the same shape as the Studio's admission. A loopback
// admission (`local`) is refused: this listener has no "this computer only" mode.
export function checkProjectAppHooks(h, where) {
  const bad = (why) => {
    throw new Error(`project app hooks ${where}: ${why}`);
  };
  if (!h || typeof h !== "object") bad("projectApp() must return an object");
  if (!h.admission || !isFn(h.admission.http) || !isFn(h.admission.upgrade))
    bad("admission.http and admission.upgrade are required functions");
  if (h.admission.local) bad("a loopback admission can't guard a project app");
  if (h.close != null && !isFn(h.close)) bad("close must be a function");
  return {
    describe: typeof h.describe === "string" && h.describe ? h.describe.slice(0, 200) : where,
    admission: h.admission,
    close: h.close ?? (() => {}),
  };
}

// Loads the hooks module and asks it for this app's admission. A module that can't load, or that offers
// no `projectApp`, throws: project apps stay off.
export async function loadProjectAppHooks(file, ctx) {
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`project app hooks ${file}: could not load (${e.message})`, { cause: e });
  }
  if (!isFn(mod.projectApp))
    throw new Error(
      `project app hooks ${file}: no projectApp(ctx) export, so project apps are off (contract/server-hooks.md)`,
    );
  return checkProjectAppHooks(await mod.projectApp(ctx), file);
}

// `hooks` is what checkProjectAppHooks returned (or anything with the same admission). Without one, this
// throws: there is no project-app listener without admission.
export function createProjectAppServer({ root, app, origin, studioOrigin = null, hooks }) {
  if (!hooks?.admission || !isFn(hooks.admission.http) || !isFn(hooks.admission.upgrade))
    throw Error("Project apps are off without an admission hook (contract/server-hooks.md).");
  if (hooks.admission.local) throw Error("A loopback admission can't guard a project app.");
  const u = exactOrigin(origin);
  if (!u) throw Error("Set the exact app origin.");
  if (!APP_ID.test(app) || !path.isAbsolute(root))
    throw Error("Set the app id and the app's absolute folder.");
  if (studioOrigin !== null && !exactOrigin(studioOrigin))
    throw Error("Set the exact Studio return origin.");
  root = fs.realpathSync(root);
  if (!fs.statSync(root).isDirectory()) throw Error("The app folder must be a folder.");
  const { admission } = hooks;

  const plain = (res, code, headers = {}) => {
    res.writeHead(code, { "cache-control": "no-store", ...headers });
    res.end();
  };
  // An admission that throws or rejects is a refusal, never a pass.
  const decide = (fn, fail) =>
    Promise.resolve()
      .then(fn)
      .catch(() => fail());

  const server = http.createServer((req, res) => {
    if (req.headers.host !== u.host) return plain(res, 421);
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return plain(res, 400);
    }
    decide(
      () =>
        admission.http(req, res, (principal) => {
          if (!principal || typeof principal !== "object") return plain(res, 403);
          // After the app origin's own sign-in completes at top level, the person goes back to the
          // Studio: only to the configured Studio origin's root, and only with this app selected.
          if (url.pathname === "/_openrig/auth-return" && studioOrigin) {
            if (req.method !== "GET") return plain(res, 405, { allow: "GET" });
            let target;
            try {
              target = new URL(url.searchParams.get("studio"));
            } catch {
              return plain(res, 400);
            }
            if (
              target.origin !== studioOrigin ||
              target.username ||
              target.password ||
              target.pathname !== "/" ||
              target.searchParams.get("s") !== app ||
              [...url.searchParams.keys()].some((k) => k !== "studio") ||
              url.searchParams.getAll("studio").length !== 1
            )
              return plain(res, 400);
            return plain(res, 303, { location: target.href, "referrer-policy": "no-referrer" });
          }
          return serveProjectApp(req, res, url, { app, root });
        }),
      () => {
        if (!res.headersSent) plain(res, 503);
        else res.destroy();
      },
    );
  });

  // Admission is asked about every upgrade too, so its refusal is the answer a refused person gets. An
  // admitted one still gets nothing: this listener has no WebSocket.
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (req.headers.host !== u.host) return refuseUpgrade(socket, "421 Misdirected Request");
    decide(
      () => admission.upgrade(req, socket, head, () => refuseUpgrade(socket, "404 Not Found")),
      () => refuseUpgrade(socket, "503 Service Unavailable"),
    );
  });
  server.on("close", () => hooks.close?.());
  return server;
}

const OPTIONS = ["port", "origin", "app", "root", "auth-binding", "studio-origin", "hooks"];

// The command line. Every input is a flag; the process environment is never read for a setting.
export async function main(argv = process.argv.slice(2), log = console.log) {
  const { values: v } = parseArgs({
    args: argv,
    options: Object.fromEntries(OPTIONS.map((k) => [k, { type: "string" }])),
  });
  if (!v.hooks)
    throw Error(
      "Project apps are off without an admission hook: pass --hooks <module exporting projectApp>.",
    );
  const port = Number(v.port || "8893");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Set the loopback port.");
  for (const k of ["hooks", "auth-binding"])
    if (v[k] !== undefined && !path.isAbsolute(v[k]))
      throw Error(`--${k} must be an absolute path.`);
  let binding = null;
  if (v["auth-binding"] !== undefined) {
    binding = JSON.parse(fs.readFileSync(v["auth-binding"], "utf8"));
    if (!binding || typeof binding !== "object" || Array.isArray(binding))
      throw Error("--auth-binding must hold one JSON object.");
  }
  const studioOrigin = v["studio-origin"] || null;
  const hooks = await loadProjectAppHooks(v.hooks, {
    app: v.app,
    origin: v.origin,
    studioOrigin,
    binding,
    log: (line) => log(`  hooks   : ${String(line).slice(0, 300)}`),
  });
  let server;
  try {
    server = createProjectAppServer({
      root: v.root,
      app: v.app,
      origin: v.origin,
      studioOrigin,
      hooks,
    });
  } catch (e) {
    hooks.close();
    throw e;
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  log(`project app: ${v.origin}/project-apps/${v.app}/ on 127.0.0.1:${port}`);
  log(`  door    : ${hooks.describe}`);
  return server;
}

// Run as a command when this file is the program, however it was named: Node loads the main module from
// its real path, so a symlinked path (a package laid out through links, or a temp folder behind one) is
// compared by its real path too.
const isMain = () => {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};
if (isMain()) {
  main().then(
    (server) => {
      for (const sig of ["SIGINT", "SIGTERM"])
        process.on(sig, () => {
          server.closeAllConnections();
          server.close(() => process.exit(0));
        });
    },
    (e) => {
      console.error(`project app: ${e.message}`);
      process.exit(1);
    },
  );
}
