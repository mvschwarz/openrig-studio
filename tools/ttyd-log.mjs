// What of ttyd's own output reaches the log of whatever started it.
//
// ttyd runs with -d 1 (errors only), which drops its start-up notices and the line it prints for every page load. Some
// libwebsockets builds also load plugins that print warnings about their own missing settings (an sshd demo key, a raw
// test fifo, an upload folder) whatever the log level, every time ttyd starts. Those lines are libwebsockets warnings,
// "[<time>] W: ...", and say nothing about the terminal, so they are dropped. Errors ("E:") and anything that isn't a
// libwebsockets line, such as ttyd's own complaint about its arguments, still pass.
export const TTYD_QUIET = ["-d", "1"];

const LWS_WARNING = /^\[[^\]]*\] W: /;
export const keepTtydLine = (line) => !LWS_WARNING.test(line);

// Copies `from` to `to` a line at a time, leaving out what keepTtydLine drops. A last line with no newline is passed
// on when the stream ends.
export function forwardTtydLog(from, to = process.stderr) {
  if (!from) return;
  let rest = "";
  from.setEncoding?.("utf8");
  from.on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const l of lines) if (keepTtydLine(l)) to.write(l + "\n");
  });
  from.on("end", () => {
    if (rest && keepTtydLine(rest)) to.write(rest + "\n");
    rest = "";
  });
  from.on("error", () => {});
}
