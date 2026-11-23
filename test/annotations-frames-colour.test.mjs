// Two annotation behaviours: marks anchor to elements inside a nested frame, and the pen has colours.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = fs.readFileSync(path.join(REPO, "app", "annotations.js"), "utf8");
const CSS = fs.readFileSync(path.join(REPO, "app", "annotations.css"), "utf8");

test("an element from a nested frame (another realm) still gets a selector, so its mark anchors to it", async () => {
  // The shell's realm has its own Element; the frame's element isn't an instance of it.
  globalThis.Element ??= class Element {};
  const { stableSelector } = await import("../app/annotations.js");
  const doc = { body: {} };
  const parent = {
    nodeType: 1,
    tagName: "SECTION",
    ownerDocument: doc,
    parentElement: null,
    children: [],
    getAttribute: () => null,
  };
  const el = {
    nodeType: 1,
    tagName: "BUTTON",
    id: "",
    ownerDocument: doc,
    parentElement: parent,
    getAttribute: (n) => (n === "data-testid" ? "pay" : null),
  };
  parent.children = [el];
  assert.ok(
    !(el instanceof globalThis.Element),
    "the stand-in is foreign to this realm, like a nested frame's element",
  );
  assert.equal(stableSelector(el), '[data-testid="pay"]');
  assert.equal(stableSelector({ nodeType: 1, id: "total", getAttribute: () => null }), "#total");
  assert.equal(stableSelector(null), null);
  assert.equal(stableSelector({ nodeType: 3 }), null, "a text node isn't an element");
});

test("the toolbar has colour swatches; the pen paints new marks and recolours the selected one", () => {
  for (const c of ["#ff6b5a", "#111318", "#ffffff", "#5fd08a"])
    assert.ok(JS.includes(`"${c}"`), `swatch ${c}`);
  assert.match(JS, /data-color="\$\{color\}"/, "each swatch is a button carrying its colour");
  assert.match(JS, /color: pen\(draft\.shape\)/, "a new mark records the pen's colour");
  assert.match(JS, /record\.color = state\.color/, "a swatch recolours the selected mark");
  assert.match(JS, /stroke:\$\{ink\};fill:\$\{ink\}1c/, "a mark is drawn in its colour");
  assert.match(
    JS,
    /\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(shown\.color/,
    "only a plain hex colour reaches the drawing",
  );
  assert.match(
    CSS,
    /\.studio-annotations__tools button\.studio-annotations__swatch \{/,
    "the swatch rule out-ranks the toolbar's button rule",
  );
});
