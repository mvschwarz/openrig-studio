import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../tools/install-app.mjs", import.meta.url));
for (const changedRoot of [false, true])
  test(`existing app installer fresh-merges settings under the adoption lock (rootChanged=${changedRoot})`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-settings-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, "studio.json"),
      source = path.join(root, "source"),
      initial = { appsRoot: path.join(root, "app-home"), apps: [], custom: "original" };
    fs.writeFileSync(config, JSON.stringify(initial), { mode: 0o600 });
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "app.json"),
      JSON.stringify({
        id: "counter",
        name: "Counter",
        surface: { path: "/counter", entry: "index.html" },
      }),
    );
    fs.writeFileSync(path.join(source, "index.html"), "<!doctype html><title>Counter</title>");
    const holder = spawn("python3", [
      "-c",
      `import fcntl,json,os,sys
p=sys.argv[1];f=open(p+'.lock','a');os.chmod(p+'.lock',0o600);fcntl.flock(f,fcntl.LOCK_EX);print('locked',flush=True);sys.stdin.readline()
d=json.load(open(p));d['custom']='concurrent customer edit';d['apps']=['another']
if sys.argv[2]=='yes':d['appsRoot']=d['appsRoot']+'-changed'
t=p+'.temp';open(t,'w').write(json.dumps(d));os.chmod(t,0o600);os.replace(t,p)
`,
      config,
      changedRoot ? "yes" : "no",
    ]);
    t.after(() => {
      if (holder.exitCode === null) holder.kill("SIGTERM");
    });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const inode = fs.statSync(config + ".lock").ino;
    const child = spawn(process.execPath, [installer, source, "--enable"], {
      env: { ...process.env, OPENRIG_STUDIO_DIR: root },
    });
    let log = "";
    child.stdout.on("data", (b) => (log += b));
    child.stderr.on("data", (b) => (log += b));
    const ended = new Promise((resolve) => child.once("exit", resolve));
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    const until = Date.now() + 5000;
    while (!fs.existsSync(path.join(initial.appsRoot, "apps/counter/index.html"))) {
      assert.ok(Date.now() < until, log);
      await new Promise((r) => setTimeout(r, 10));
    }
    holder.stdin.end("release\n");
    const code = await ended;
    assert.equal(code, changedRoot ? 1 : 0, log);
    const actual = JSON.parse(fs.readFileSync(config));
    assert.equal(actual.custom, "concurrent customer edit");
    assert.deepEqual(actual.apps, changedRoot ? ["another"] : ["another", "counter"]);
    assert.equal(actual.appsRoot, initial.appsRoot + (changedRoot ? "-changed" : ""));
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config + ".lock").ino, inode);
  });
