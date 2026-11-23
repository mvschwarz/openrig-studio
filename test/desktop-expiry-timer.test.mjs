// The Desktop handshake timer decides by the deadline it was scheduled for, not by re-reading the clock when it fires: a timer
// can fire a millisecond before the wall clock reaches the sign-in's exp, and re-reading would answer 504 "the desktop didn't
// answer" where 403 "sign-in expired" is due. A frozen clock makes that moment exact: at the timer, the clock still says time
// is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { upgradeDesktop } from "../tools/desktop.mjs";

const ORIGIN = "http://box.example.invalid";

async function run(t, { exp, now }) {
  const peers = [];
  const upstream = http.createServer();
  // Never answers.
  upstream.on("upgrade", (req, s) => {
    peers.push(s);
    s.on("error", () => {});
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = http.createServer();
  proxy.on("upgrade", (req, s, head) =>
    upgradeDesktop(req, s, head, {
      target: { host: "127.0.0.1", port: upstream.address().port, path: "/" },
      origins: new Set([ORIGIN]),
      exp,
      now,
    }),
  );
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const p of peers) p.destroy();
    proxy.close();
    upstream.close();
  });
  return new Promise((resolve) => {
    const c = net.connect(proxy.address().port, "127.0.0.1", () =>
      c.write(
        `GET /desktop/ws HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\norigin: ${ORIGIN}\r\n\r\n`,
      ),
    );
    let buf = "";
    c.on("data", (d) => {
      buf += d;
    });
    c.on("error", () => {});
    c.on("close", () => resolve(buf.split("\r\n")[0]));
  });
}

test("a handshake timer set for the sign-in's exp answers 403 'sign-in expired', even when the clock still shows time left", async (t) => {
  // exp is 1 s after a clock frozen at 0: the timer is the expiry one (1 s < 10 s), and when it fires the clock still says 1 s left.
  const status = await run(t, { exp: 1, now: () => 0 });
  assert.match(status, /^HTTP\/1\.1 403 /, status);
});

test("one clock reading decides both the timer's kind and its delay (a delay under 10 s is the expiry: 403; 10 s is the limit: 504)", () => {
  // If the kind and the delay each read the clock, a clock that moves between the two readings (0, 0, then 2 ms) makes a
  // 9,998 ms timer that still answers 504. Timers are captured here, so the check is instant and exact.
  const clocks = [0, 0, 2];
  let i = 0;
  const now = () => clocks[Math.min(i++, clocks.length - 1)];
  const timers = [],
    real = globalThis.setTimeout;
  let out = "";
  const socket = {
    end: (t) => {
      out += t;
    },
    destroy() {},
    on() {},
    write() {},
    destroyed: false,
    writable: true,
  };
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return { unref() {} };
  };
  try {
    upgradeDesktop(
      {
        headers: {
          origin: ORIGIN,
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      },
      socket,
      null,
      {
        target: { host: "127.0.0.1", port: 9, path: "/" },
        origins: new Set([ORIGIN]),
        exp: 10.001,
        now,
      },
    );
  } finally {
    globalThis.setTimeout = real;
  }
  const t = timers[0];
  assert.ok(t, "the handshake timer was set");
  t.fn();
  assert.match(
    out,
    t.ms < 10000 ? /^HTTP\/1\.1 403 / : /^HTTP\/1\.1 504 /,
    `a ${t.ms} ms timer answered: ${out.split("\r\n")[0]}`,
  );
});
