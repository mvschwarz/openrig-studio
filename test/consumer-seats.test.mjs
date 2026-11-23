// The seat roster is a CONSUMER declaration, and its failure modes are silent
// by nature — a roster that does not arrive looks exactly like a roster nobody
// declared, and the shipped fixture stands in for it without complaint.
//
// Reading the code is what missed this the first time, so these are effect
// tests: boot a runtime against a real overlay directory and ask what it
// actually serves. Each case below FAILS against the previous behaviour, where
// /surfaces.json spread the package document and overrode only surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRuntime } from "./helpers/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "app", "serve-studio.mjs");

function overlay(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-overlay-"));
  fs.copyFileSync(path.join(ROOT, "app", "surfaces", "floor.html"), path.join(dir, "floor.html"));
  fs.writeFileSync(
    path.join(dir, "surfaces.json"),
    JSON.stringify(
      {
        surfaces: [
          { id: "floor", name: "FLOOR", path: "/surfaces/floor.html", glyph: "▦", hint: "the box" },
        ],
        ...doc,
      },
      null,
      2,
    ),
  );
  return dir;
}

// Port 0: the OS picks a free port, so the test never lands on someone else's
// server.
async function boot(dir) {
  const { proc, ready } = startRuntime(RUNTIME, ["--surfaces", dir]);
  const port = await ready;
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
  return { get, stop: () => proc.kill() };
}

test("a consumer's declared roster is what the shell is served", async () => {
  const dir = overlay({
    chatSeats: [
      { seat: "impl@rig-a", name: "impl" },
      { seat: "qa@rig-a", name: "qa" },
    ],
    chatLocalPort: 8797,
  });
  const s = await boot(dir);
  try {
    const doc = await s.get("/surfaces.json");
    assert.deepEqual(
      doc.chatSeats.map((r) => r.seat),
      ["impl@rig-a", "qa@rig-a"],
      "the consumer's own seats must reach the shell",
    );
    assert.equal(doc.chatLocalPort, 8797, "the terminal endpoint must reach the shell too");
    assert.ok(
      !doc.chatSeats.some((r) => String(r.seat).includes("fixture")),
      "the packaged fixture seat must not survive alongside a declared roster",
    );
  } finally {
    s.stop();
  }
});

test("no declared roster leaves the packaged one standing", async () => {
  const s = await boot(overlay({}));
  try {
    const doc = await s.get("/surfaces.json");
    assert.ok(
      Array.isArray(doc.chatSeats) && doc.chatSeats.length,
      "with nothing declared the package roster is the fallback, so this stays additive",
    );
  } finally {
    s.stop();
  }
});

test("a DECLARED but malformed roster warns instead of falling back silently", async () => {
  // The likeliest real mistake: copy the shape of surfaces.json, write an
  // object. Array.isArray rejects it and the fixture stands in — which is
  // correct behaviour and an incorrect silence.
  const s = await boot(overlay({ chatSeats: { impl: "impl@rig-a" } }));
  try {
    const c = await s.get("/api/contract");
    const warned = (c.manifest.warnings || []).some((w) => /chatSeats must be an array/.test(w));
    assert.ok(warned, "a declared-but-unusable roster must be named in manifest.warnings");
  } finally {
    s.stop();
  }
});

test("rows without a usable seat are named rather than quietly dropped", async () => {
  const s = await boot(
    overlay({ chatSeats: [{ name: "impl" }, { seat: "  " }], chatLocalPort: 8797 }),
  );
  try {
    const c = await s.get("/api/contract");
    const warned = (c.manifest.warnings || []).some((w) => /NONE carries a usable "seat"/.test(w));
    assert.ok(warned, "a roster whose rows all lack a seat renders empty and must say so");
  } finally {
    s.stop();
  }
});

test("seats declared with no terminal endpoint are called out as unattachable", async () => {
  const s = await boot(overlay({ chatSeats: [{ seat: "impl@rig-a", name: "impl" }] }));
  try {
    const c = await s.get("/api/contract");
    const warned = (c.manifest.warnings || []).some((w) => /without chatLocalPort/.test(w));
    assert.ok(warned, "listed-but-not-attachable is a configuration gap, not an empty rig");
  } finally {
    s.stop();
  }
});

test("a roster the launcher read from the rig isn't warned as declared, and the shell is told where it came from", async () => {
  const rows = [{ seat: "impl@rig-a", name: "impl", status: "running" }];
  const s = await boot(overlay({ chatSeats: rows, chatSeatsFrom: "rig" }));
  try {
    const c = await s.get("/api/contract");
    const warned = (c.manifest.warnings || []).some((w) => /chatLocalPort/.test(w));
    assert.equal(warned, false, (c.manifest.warnings || []).join("\n"));
    const m = await s.get("/surfaces.json");
    assert.equal(m.chatSeatsFrom, "rig");
    assert.deepEqual(m.chatSeats, rows, "control: the roster itself is served");
  } finally {
    s.stop();
  }
  // Control: the same roster marked declared is warned.
  const d = await boot(overlay({ chatSeats: rows, chatSeatsFrom: "declared" }));
  try {
    const c = await d.get("/api/contract");
    assert.ok((c.manifest.warnings || []).some((w) => /without chatLocalPort/.test(w)));
  } finally {
    d.stop();
  }
});
