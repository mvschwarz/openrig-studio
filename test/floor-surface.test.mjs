import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = path.join(REPO, "app", "surfaces", "floor.html");
const surface = fs.readFileSync(SURFACE, "utf8");

test("FLOOR renders seats and queue as semantic tables instead of cards", () => {
  assert.match(surface, /<title>Rig Floor<\/title>/, "positive control: loaded the FLOOR surface");
  assert.equal((surface.match(/<table\b/g) || []).length, 2);

  for (const heading of ["Seat", "Pod / member", "State", "Lifecycle", "Age", "Pending"]) {
    assert.match(surface, new RegExp(`<th[^>]*>${heading.replace(" / ", " \\/ ")}<\\/th>`, "i"));
  }

  for (const heading of ["Work", "State", "Source", "Destination"]) {
    assert.match(surface, new RegExp(`<th[^>]*>${heading}<\\/th>`, "i"));
  }

  assert.doesNotMatch(surface, /<article class="seat\b/);
  assert.doesNotMatch(surface, /<article class="queue-item\b/);
});

test("FLOOR keeps detached states distinct and always marks them down", () => {
  const start = surface.indexOf("if (state.attached === false)");
  const end = surface.indexOf("rig.textContent = state.rig", start);
  assert.notEqual(start, -1, "detached-state branch exists");
  assert.notEqual(end, -1, "attached-state branch follows detached handling");

  const detached = surface.slice(start, end);
  assert.match(detached, /'no-rig': 'No rig is running on this box\.'/);
  assert.match(detached, /'no-rig-cli': 'The rig CLI is not installed on this box\.'/);
  assert.match(detached, /'rig-error': 'The rig is installed but could not be read\.'/);
  assert.match(detached, /setConnection\('down'/);
  assert.doesNotMatch(detached, /setConnection\('live'/);
});

test("FLOOR keeps its declared welcome and delegated agent launcher", () => {
  assert.match(surface, /fetch\('\/surfaces\.json'/);
  assert.match(surface, /welcome = d && typeof d\.welcome === 'object'/);
  assert.match(surface, /content\.addEventListener\('click'/);
  assert.match(surface, /parent\.postMessage\(\{ t: 'open-agent', seat: b\.dataset\.seat \}/);
});

test("FLOOR keeps the all-rig caption and live-to-polling refresh path", () => {
  assert.match(surface, /rig\.textContent = state\.rig/);
  assert.match(surface, /new EventSource\('\/api\/events'\)/);
  assert.match(surface, /setConnection\('polling', 'polling fallback'\)/);
  assert.match(surface, /setInterval\(refresh, 15000\)/);
});
