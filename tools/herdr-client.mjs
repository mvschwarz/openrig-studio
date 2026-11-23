// Fixed command behind the owner-only /team ttyd. No browser arguments or launch/open operation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function teamClient(env = process.env, uid = process.getuid?.()) {
  const bin = env.STUDIO_HERDR_BIN,
    socket = env.HERDR_SOCKET_PATH,
    session = env.STUDIO_HERDR_SESSION;
  if (
    !bin ||
    !socket ||
    !path.isAbsolute(bin) ||
    !path.isAbsolute(socket) ||
    !path.isAbsolute(env.HOME || "") ||
    path.normalize(bin) !== bin ||
    path.normalize(socket) !== socket ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session || "")
  )
    throw Error("The existing team workspace isn't configured.");
  const b = fs.statSync(bin),
    s = fs.lstatSync(socket);
  if (!b.isFile() || !s.isSocket() || s.uid !== uid || (s.mode & 0o077) !== 0)
    throw Error("The existing team workspace isn't available.");
  fs.accessSync(bin, fs.constants.X_OK);
  const digest = createHash("sha256").update(fs.readFileSync(bin)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(env.STUDIO_HERDR_SHA256 || "") || digest !== env.STUDIO_HERDR_SHA256)
    throw Error("The configured team client doesn't match its pinned version.");
  // 'session attach' attaches an existing persistent session; --session can create one.
  // Keep the existing server's nonsecret HOME/XDG/terminal context. Provider/session
  // credentials from the parent service must not become a client's inherited environment.
  const childEnv = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TERM",
      "COLORTERM",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "TZ",
      "TMPDIR",
      "HERDR_SOCKET_PATH",
      "HERDR_CONFIG_PATH",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "XDG_RUNTIME_DIR",
    ]
      .filter((k) => typeof env[k] === "string")
      .map((k) => [k, env[k]]),
  );
  return { bin, args: ["session", "attach", session], env: childEnv };
}
export function runTeamClient() {
  if (process.argv.length !== 2) {
    process.stdout.write("The team workspace takes no browser arguments.\r\n");
    process.exitCode = 2;
    return;
  }
  let command;
  try {
    command = teamClient();
  } catch {
    process.stdout.write(
      "The existing team workspace isn't available. Your agents and work are kept.\r\n",
    );
    process.exitCode = 1;
    return;
  }
  const child = spawn(command.bin, command.args, { stdio: "inherit", env: command.env });
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => child.kill(sig));
  child.on("error", () => {
    process.stdout.write("The team client couldn't attach.\r\n");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  runTeamClient();
