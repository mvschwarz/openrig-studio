// "Open a surface at a place" in the shell (app/shell.html): an app frame asks with postMessage({ t: "open-surface", id, hash }),
// or the address carries /?s=<id>&h=<fragment>, and the shell opens that surface's frame at the fragment.
//
// This SDK has no browser dependency (see test/shell-boot.test.mjs), so this checks what can be checked without one: the
// fragment filter itself, run on the real pattern taken from the page, and that every way in goes through it, with the
// message path also requiring one of this Studio's own app frames. Checked live too: /?s=floor&h=%23i%3Dx opened the Floor
// frame at #i=x, and an open-surface posted by the page itself (not an app frame) was ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
const pattern = () => {
  const m = SHELL.match(/const PLACE = (\/\^#\[.*?\]\{0,(\d+)\}\$\/);/);
  assert.ok(m, "the shell declares its fragment filter (const PLACE = /^#[...]{0,N}$/)");
  return new Function(`return ${m[1]};`)();
};

test("the fragment filter takes the apps' real places and nothing that could be a URL, a query or markup", () => {
  const PLACE = pattern();
  const ok = [
    "#i=build-ask%3Arow-1",
    "#open=" + encodeURIComponent("/home/me/work/pricing/pricing-v2.md"),
    "#open=" + encodeURIComponent("/home/me/" + "deep/".repeat(60) + "file.md"),
    "#",
    "#a=1&b=2",
    "#x(1)*!~._-'",
  ];
  for (const h of ok)
    assert.ok(PLACE.test(h), `refused a real place: ${h.slice(0, 80)} (${h.length} chars)`);
  assert.ok(PLACE.test("#" + "a".repeat(1023)), "1024 characters including the '#'");
  const bad = [
    "i=x",
    "",
    "https://evil.example/#x",
    "javascript:alert(1)",
    "#a b",
    "#a\nb",
    "#<script>",
    '#a"b',
    "#a`b",
    "#a?b=1",
    "#a/b",
    "#a#b",
    "#a\\b",
    "#a>b",
    "#" + "a".repeat(1024),
    "#é",
    "#a;b",
  ];
  for (const h of bad)
    assert.ok(!PLACE.test(h), `took a fragment it must refuse: ${JSON.stringify(h.slice(0, 60))}`);
});

test("open-surface, with a place or without, is honoured only from one of this Studio's own app frames", () => {
  const start = SHELL.indexOf("// --- the shell protocol: the ONLY surface->shell API");
  const handler = SHELL.slice(
    SHELL.indexOf('if (e.data.t === "open-surface") {', start),
    SHELL.indexOf('if (e.data.t === "open-agent")', start),
  );
  assert.ok(handler.includes("e.data.hash"), "the open-surface handler reads a hash");
  assert.match(
    SHELL.slice(start, start + 400),
    /if \(e\.origin !== location\.origin\) return;/,
    "another origin is never heard",
  );
  const source = handler.indexOf("f.contentWindow === e.source");
  const filter = handler.indexOf("placeOf(e.data.hash)");
  const act = handler.lastIndexOf("activate(e.data.id, false, e.data.hash)");
  const plain = handler.indexOf("activate(e.data.id);");
  assert.ok(
    source > 0 && filter > source && act > filter,
    "the frame and the place are checked before the surface is opened at the place",
  );
  assert.ok(
    plain > source,
    "a plain open-surface (no place) is also honoured only from this Studio's own app frames",
  );
  assert.match(
    handler,
    /if \(!byId\(e\.data\.id\)\) ignore\(/,
    "an unknown surface is ignored (and said once)",
  );
});

test("the address's h= goes through the same filter, and so does going back or forward", () => {
  assert.match(SHELL, /params\.get\("h"\)/, "the deep link reads h=");
  assert.match(
    SHELL,
    /activate\(qs, true, placeOf\(qh\)\)/,
    "the deep link opens only a filtered place",
  );
  assert.match(
    SHELL,
    /activate\(id, true, placeOf\(h\), true\)/,
    "back/forward reopen only a filtered place, as a restore",
  );
  assert.match(
    SHELL,
    /ignore\("the address's h= isn't a safe fragment"\)/,
    "a bad h= is ignored and said once",
  );
});
