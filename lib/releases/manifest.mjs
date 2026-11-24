import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";

export const SCHEMA = "openrig.release/v0";
export const LOCAL = ["studioSdk", "studioApps"];
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
export const relative = (x) =>
  typeof x === "string" &&
  !!x &&
  !path.isAbsolute(x) &&
  !x.split(/[\\/]/).some((p) => p === ".." || p === "." || !p) &&
  !x.includes("\\") &&
  // eslint-disable-next-line no-control-regex -- refuses paths containing control characters
  !/[\x00-\x1f\x7f]/.test(x);
export function validateRelease(d) {
  const errors = [],
    bad = (yes, why) => {
      if (yes) errors.push(why);
    };
  bad(!object(d) || d.schema !== SCHEMA, "schema must be openrig.release/v0");
  if (!object(d)) return { ok: false, errors };
  bad(
    !semver.valid(d.release) || !/^[A-Za-z0-9.+-]+$/.test(d.release),
    "release needs an exact version/id",
  );
  bad(
    !object(d.compatibility) || !Array.isArray(d.compatibility.upgradeFrom),
    "compatibility.upgradeFrom is required",
  );
  bad(
    !Array.isArray(d.customerOwned) ||
      d.customerOwned.some((p) => typeof p !== "string" || !relative(p.replace(/\/$/, ""))),
    "customerOwned must list relative roots",
  );
  bad(!Array.isArray(d.migrations), "migrations must be explicit (empty when none)");
  bad(!object(d.components) || !Object.keys(d.components).length, "components are required");
  if (!object(d.components)) return { ok: false, errors };
  const advertised = new Map();
  for (const [id, c] of Object.entries(d.components)) {
    if (!relative(id) || id.includes("/") || !object(c)) {
      errors.push(`invalid component ${id}`);
      continue;
    }
    bad(!semver.valid(c.version), `${id}.version must be exact SemVer`);
    bad(
      !c.name || !object(c.source) || !/^[0-9a-f]{7,40}$/.test(c.source.rev),
      `${id} needs name/source provenance`,
    );
    bad(
      !object(c.artifact) ||
        !relative(c.artifact.file) ||
        !/^[0-9a-f]{64}$/.test(c.artifact.sha256) ||
        !Number.isSafeInteger(c.artifact.bytes) ||
        c.artifact.bytes < 1,
      `${id} needs a locked artifact`,
    );
    if (LOCAL.includes(id))
      bad(
        !object(c.vendorBaseline) ||
          !relative(c.vendorBaseline.file) ||
          !/^[0-9a-f]{64}$/.test(c.vendorBaseline.sha256),
        `${id} needs a locked vendorBaseline`,
      );
    for (const [k, v] of Object.entries(c.interfaces || {})) {
      if (advertised.has(k) && advertised.get(k) !== v) errors.push(`conflicting interface ${k}`);
      advertised.set(k, v);
    }
    if (c.patchStack)
      bad(
        !/^[0-9a-f]{64}$/.test(c.patchStack.sha256) ||
          !Number.isInteger(c.patchStack.count) ||
          c.patchStack.count < 0 ||
          !/^[0-9a-f]{7,40}$/.test(c.patchStack.sourceRev),
        `${id}.patchStack must be pinned`,
      );
  }
  for (const [id, c] of Object.entries(d.components))
    for (const [key, want] of Object.entries(c?.requires || {})) {
      const target = d.components[key];
      if (target)
        bad(
          !semver.validRange(want) || !semver.satisfies(target.version, want),
          `${id} requires ${key} ${want}`,
        );
      else bad(advertised.get(key) !== want, `${id} requires interface ${key} ${want}`);
    }
  // runtime: what a component needs from the host runtime (openrigCore: a semver range). Reported by plan, never enforced here:
  // the runtime is a host operation, so a release without that component must still plan and apply.
  for (const [id, c] of Object.entries(d.components)) {
    if (c?.runtime === undefined) continue;
    if (!object(c.runtime)) {
      errors.push(`${id}.runtime must be an object of runtime name to semver range`);
      continue;
    }
    for (const [name, want] of Object.entries(c.runtime))
      bad(
        typeof want !== "string" || !semver.validRange(want),
        `${id}.runtime.${name} must be a semver range`,
      );
  }
  // initialConfig (optional): the settings a FRESH workspace's studio.json starts with, under the creator's own --config (the creator wins
  // key by key). Never applied on adoption or upgrade, where studio.json belongs to the customer; inspect reports a key that differs.
  if (d.initialConfig !== undefined) {
    if (!object(d.initialConfig)) errors.push("initialConfig must be an object");
    else {
      bad(
        Object.hasOwn(d.initialConfig, "appsRoot"),
        "initialConfig cannot set appsRoot (the installer writes it)",
      );
      bad(
        d.initialConfig.serverHooks !== undefined && !relative(d.initialConfig.serverHooks),
        "initialConfig.serverHooks must be a path relative to the studio folder",
      );
    }
  }
  return { ok: !errors.length, errors };
}
export function readRelease(file) {
  const resolved = fs.realpathSync(file),
    bytes = fs.readFileSync(resolved),
    descriptor = JSON.parse(bytes);
  const v = validateRelease(descriptor);
  if (!v.ok) throw Error(v.errors.join("; "));
  return { descriptor, file: resolved, dir: path.dirname(resolved), sha256: sha256(bytes) };
}
export function lockedFile(release, ref) {
  if (!relative(ref.file)) throw Error("Artifact paths must stay in the release folder.");
  const file = fs.realpathSync(path.join(release.dir, ref.file));
  if (!file.startsWith(release.dir + path.sep))
    throw Error("Artifact resolves outside the release folder.");
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== ref.sha256 || (ref.bytes !== undefined && ref.bytes !== bytes.length))
    throw Error(`Digest/length mismatch: ${ref.file}`);
  return { file, bytes };
}
export function readBaseline(release, component) {
  const { bytes } = lockedFile(release, component.vendorBaseline),
    files = {};
  for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match || !relative(match[2]) || Object.hasOwn(files, match[2]))
      throw Error("Invalid/duplicate vendor baseline entry.");
    files[match[2]] = match[1];
  }
  return files;
}
