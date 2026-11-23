// Start the runtime on an OS-assigned port. `ready` resolves to the port once
// the runtime is listening (its first line names the port it bound), and
// rejects if the process exits first.
import { spawn } from "node:child_process";

export function startRuntime(script, args = [], options = {}) {
  const proc = spawn(process.execPath, [script, "--port", "0", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let stdout = "",
    stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => {
      stdout += d;
      const m = stdout.match(/runtime: http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    });
    proc.once("exit", (code) =>
      reject(new Error(`runtime exited (${code}) before listening:\n${stderr}`)),
    );
  });
  return { proc, ready, stderr: () => stderr };
}
