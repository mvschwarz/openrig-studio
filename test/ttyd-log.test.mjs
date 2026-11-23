// What of ttyd's output reaches a Studio's log (tools/ttyd-log.mjs): errors and ttyd's own lines, never libwebsockets'
// plugin warnings, which some builds print at every start whatever the log level.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { TTYD_QUIET, forwardTtydLog, keepTtydLine } from "../tools/ttyd-log.mjs";

// Lines a real ttyd 1.7.7 (libwebsockets 4.5) printed at start with -d 1, plus one error it printed for a bad socket path.
const WARNINGS = [
  "[t] W: callback_lws_sshd_demo: Can't open /etc/lws-test-sshd-server-key",
  '[t] W: ssh pvo "ops" is mandatory',
  '[t] W: callback_raw_test: Missing pvo "fifo-path", raw file fd testing disabled',
  "[t] W: handler_server_protocol_init: requires 'upload-dir' pvo",
];
const ERROR = '[t] E: [null wsi]: lws_socket_bind: ERROR on binding fd 10 to "/x/c.sock" (errno 2)';

test("ttyd runs with errors only, and the plugin warnings are left out of the log", () => {
  assert.deepEqual(TTYD_QUIET, ["-d", "1"]);
  for (const w of WARNINGS) assert.equal(keepTtydLine(w), false, w);
  assert.equal(keepTtydLine(ERROR), true);
  assert.equal(keepTtydLine("ttyd: invalid option -- 'z'"), true);
  assert.equal(keepTtydLine("a line that mentions W: in passing"), true);
});

test("forwardTtydLog passes whole lines, across chunk boundaries, and a last line with no newline", async () => {
  const from = new PassThrough();
  let out = "";
  forwardTtydLog(from, { write: (s) => (out += s) });
  const text = `${WARNINGS[0]}\n${ERROR}\n${WARNINGS[1]}\nttyd: last`;
  for (let i = 0; i < text.length; i += 7) from.write(text.slice(i, i + 7));
  from.end();
  await new Promise((r) => from.once("end", r));
  assert.equal(out, `${ERROR}\nttyd: last\n`);
  forwardTtydLog(undefined);
});
