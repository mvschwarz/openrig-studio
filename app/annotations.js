const NS = "http://www.w3.org/2000/svg";
const SHAPES = new Set(["circle", "rect", "arrow", "text"]);
const KEYS = { c: "circle", b: "rect", a: "arrow", t: "text" };
const clone = (value) => structuredClone(value);
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssEscape = (value) => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
const id = () => globalThis.crypto?.randomUUID?.() ?? `ann-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function stableSelector(element) {
  if (!(element instanceof Element)) return null;
  if (element.id) return `#${cssEscape(element.id)}`;
  for (const name of ["data-annotate-id", "data-testid", "name", "aria-label"]) {
    const value = element.getAttribute(name);
    if (value) return `[${name}="${cssEscape(value)}"]`;
  }
  const parts = [];
  for (let node = element; node && node.nodeType === 1 && node !== node.ownerDocument.body; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const siblings = [...(node.parentElement?.children ?? [])].filter((item) => item.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    if (parts.length >= 5) break;
  }
  return parts.length ? parts.join(" > ") : null;
}

function sheet() {
  const existing = document.querySelector("link[data-studio-annotations]");
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./annotations.css", import.meta.url).href;
  link.dataset.studioAnnotations = "";
  document.head.append(link);
  return link;
}

export function attach(shell, { store } = {}) {
  if (!shell?.overlay || typeof shell.active !== "function" || typeof shell.onMarkup !== "function" || typeof shell.onSurface !== "function") {
    throw new TypeError("annotations need a studioShell with overlay, active(), onMarkup(), and onSurface()");
  }
  if (store && (typeof store?.load !== "function" || typeof store?.save !== "function")) {
    throw new TypeError("annotation store must provide both load(surfaceId) and save(surfaceId, records)");
  }
  const persistent = Boolean(store);
  sheet();
  const memory = new Map();
  const root = document.createElement("section");
  root.className = "studio-annotations";
  root.setAttribute("aria-label", "Shared annotations");
  root.innerHTML = `
    <svg class="studio-annotations__canvas" aria-label="Annotation canvas">
      <defs>
        <marker id="studio-ann-arrow-human" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#ff6b5a"/></marker>
        <marker id="studio-ann-arrow-agent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#8b93ff"/></marker>
      </defs>
      <g data-marks></g><g data-draft></g>
    </svg>
    <div class="studio-annotations__tools" role="toolbar" aria-label="Annotation tools">
      <input class="studio-annotations__note" aria-label="Annotation note" placeholder="What should change?">
      <button data-tool="circle">○ Circle <kbd>C</kbd></button>
      <button data-tool="rect">□ Box <kbd>B</kbd></button>
      <button data-tool="arrow">↗ Arrow <kbd>A</kbd></button>
      <button data-tool="text">T Text <kbd>T</kbd></button>
      <button data-action="undo" title="Undo">↶</button>
      <button data-action="redo" title="Redo">↷</button>
    </div>
    <aside class="studio-annotations__thread">
      <div class="studio-annotations__thread-head"><strong>Annotations</strong><span class="studio-annotations__status"></span></div>
      <div class="studio-annotations__list"></div>
    </aside>`;
  shell.overlay.append(root);

  const canvas = root.querySelector(".studio-annotations__canvas");
  const marks = root.querySelector("[data-marks]");
  const draftLayer = root.querySelector("[data-draft]");
  const list = root.querySelector(".studio-annotations__list");
  const status = root.querySelector(".studio-annotations__status");
  const note = root.querySelector(".studio-annotations__note");
  const state = { surfaceId: null, scope: null, records: [], tool: null, draft: null, drag: null, selected: null, undo: [], redo: [], loading: 0 };
  const cleaners = [];

  const bounds = () => {
    const rect = root.getBoundingClientRect();
    return { rect, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  };
  const active = () => shell.active();
  // THE PERSISTENCE KEY IS THE SHELL'S TO COMPOSE, not this layer's. A surface id
  // is the default; a surface holding several documents behind one id declares a
  // sub-context and the shell folds it in. Composing it here as well would be two
  // places computing one property, which drifts silently.
  //
  // Falling back to the surface id keeps this working against a shell that
  // predates the seam — the layer degrades to one board per surface rather than
  // throwing, which is what it did before sub-contexts existed.
  const scopeOf = () => (typeof shell.scope === "function" ? shell.scope() : active().id);
  // WHERE TO LOOK FOR ELEMENTS, and that document's rect in top-window
  // coordinates. Normally the active surface's frame; a surface that renders its
  // real content in a SAME-ORIGIN NESTED frame may name it, and the shell resolves
  // the chain. Without this an agent naming "#publish" resolves against the host
  // surface's chrome instead of the document the human is looking at — the mark
  // lands as "missing" and the core property (an agent names an element, the human
  // sees a mark on THAT element) is lost.
  //
  // The shell composes it; this layer only consumes it. Falls back to the surface
  // frame against a shell that predates the seam.
  const view = () => {
    if (typeof shell.target === "function") {
      try { const v = shell.target(); if (v?.doc && v?.rect) return v; } catch {}
    }
    const frame = active().frame;
    try { return frame?.contentDocument ? { doc: frame.contentDocument, rect: frame.getBoundingClientRect() } : null; }
    catch { return null; }
  };
  const frameDocument = () => view()?.doc ?? null;
  const point = (event) => {
    const { rect, width, height } = bounds();
    return { x: clamp((event.clientX - rect.left) / width), y: clamp((event.clientY - rect.top) / height) };
  };
  const elementAt = (event) => {
    const v = view();
    if (!v) return null;
    try { return v.doc.elementFromPoint(event.clientX - v.rect.left, event.clientY - v.rect.top); } catch { return null; }
  };
  const elementAnchor = (selector) => {
    const v = view();
    if (!v || !selector) return null;
    let element;
    try { element = v.doc.querySelector(selector); } catch { return null; }
    if (!element) return null;
    const outer = bounds();
    const frameRect = v.rect;
    const rect = element.getBoundingClientRect();
    return {
      x: (frameRect.left - outer.rect.left + rect.left) / outer.width,
      y: (frameRect.top - outer.rect.top + rect.top) / outer.height,
      width: rect.width / outer.width,
      height: rect.height / outer.height,
      text: element.innerText?.trim().replace(/\s+/g, " ").slice(0, 180) || element.getAttribute("aria-label") || "",
    };
  };
  const displayRecord = (record) => {
    const found = elementAnchor(record.selector);
    if (!record.selector || !found) return { ...record, status: record.selector ? "missing" : "spatial" };
    const offset = record.offset ?? { x: 0, y: 0, width: 0, height: 0 };
    return { ...record, status: "anchored", text: found.text || record.text, anchor: {
      x: found.x + (offset.x ?? 0), y: found.y + (offset.y ?? 0),
      width: Math.max(.01, found.width + (offset.width ?? 0)), height: Math.max(.01, found.height + (offset.height ?? 0)),
    } };
  };

  const shapeMarkup = (record, index, classes = "") => {
    const shown = displayRecord(record);
    const { width, height } = bounds();
    const a = shown.anchor ?? { x: .4, y: .4, width: .2, height: .1 };
    const x = a.x * width, y = a.y * height, w = a.width * width, h = a.height * height;
    const source = shown.source === "agent" ? "agent" : "human";
    let shape;
    if (shown.shape === "circle") shape = `<ellipse class="shape" cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.abs(w / 2)}" ry="${Math.abs(h / 2)}"/>`;
    else if (shown.shape === "arrow") shape = `<line class="shape" x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" marker-end="url(#studio-ann-arrow-${source})"/>`;
    else if (shown.shape === "text") shape = `<rect class="shape" x="${x}" y="${y}" width="${Math.abs(w)}" height="${Math.abs(h)}" rx="4"/><text class="studio-annotations__label" x="${x + 9}" y="${y + Math.min(20, Math.abs(h) - 7)}">${esc(shown.note || "Text")}</text>`;
    else shape = `<rect class="shape" x="${Math.min(x, x + w)}" y="${Math.min(y, y + h)}" width="${Math.abs(w)}" height="${Math.abs(h)}" rx="3"/>`;
    const badgeX = Math.min(x, x + w), badgeY = Math.min(y, y + h);
    return `<g class="studio-annotations__mark ${source === "agent" ? "agent" : ""} ${state.selected === shown.id ? "selected" : ""} ${shown.status === "missing" ? "missing" : ""} ${classes}" data-id="${esc(shown.id)}">${shape}<circle class="studio-annotations__badge" cx="${badgeX}" cy="${badgeY}" r="9"/><text class="studio-annotations__badge-text" x="${badgeX}" y="${badgeY}">${shown.status === "missing" ? "?" : (source === "agent" ? "A" : "H")}</text>${index >= 0 ? `<text class="studio-annotations__label" x="${badgeX + 13}" y="${badgeY + 4}">${index + 1}</text>` : ""}</g>`;
  };
  const describe = (record) => {
    const shown = displayRecord(record);
    const target = shown.selector ? `${shown.shape} on ${shown.selector}${shown.text ? ` (\"${shown.text}\")` : ""}` : `${shown.shape} on the surface`;
    return { shown, target };
  };
  function render() {
    const { width, height } = bounds();
    canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
    marks.innerHTML = state.records.map((record, index) => shapeMarkup(record, index)).join("");
    draftLayer.innerHTML = state.draft ? shapeMarkup({ ...state.draft, id: "draft", source: "human" }, -1, "studio-annotations__draft") : "";
    root.classList.toggle("is-browsing", !state.tool);
    root.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("on", button.dataset.tool === state.tool));
    status.textContent = persistent ? `${state.records.length} · persisted` : `${state.records.length} · session only`;
    list.innerHTML = state.records.length ? state.records.map((record, index) => {
      const { shown, target } = describe(record);
      return `<article class="studio-annotations__item ${shown.source === "agent" ? "agent" : ""} ${state.selected === shown.id ? "selected" : ""}" data-item="${esc(shown.id)}"><div class="studio-annotations__item-top"><span>${index + 1}</span><span class="studio-annotations__source">${shown.source === "agent" ? "Agent" : "You"}</span><span>${esc(shown.shape)}</span>${shown.status === "missing" ? '<span class="studio-annotations__missing">anchor missing</span>' : ""}<button class="studio-annotations__delete" data-delete="${esc(shown.id)}" title="Delete annotation">×</button></div><p>${esc(shown.note || "Review this")}</p><small>${esc(target)}</small></article>`;
    }).join("") : '<div class="studio-annotations__empty">No marks yet. Choose a tool, then draw on the surface.</div>';
  }

  const read = async (surfaceId) => {
    const value = store?.load ? await store.load(surfaceId) : memory.get(surfaceId);
    return clone(Array.isArray(value) ? value : value?.records ?? []);
  };
  const write = async () => {
    const records = clone(state.records);
    if (store?.save) await store.save(state.scope, records);
    else memory.set(state.scope, records);
  };
  const checkpoint = () => {
    state.undo.push(clone(state.records));
    if (state.undo.length > 50) state.undo.shift();
    state.redo.length = 0;
  };
  const travel = async (direction) => {
    const source = direction === "undo" ? state.undo : state.redo;
    const target = direction === "undo" ? state.redo : state.undo;
    const snapshot = source.pop();
    if (!snapshot) return false;
    target.push(clone(state.records));
    state.records = snapshot;
    state.selected = null;
    await write(); render(); return true;
  };
  const loadSurface = async () => {
    const token = ++state.loading;
    const surfaceId = active().id;
    const scope = scopeOf();
    state.surfaceId = surfaceId;
    state.scope = scope;
    state.records = scope ? await read(scope) : [];
    if (token !== state.loading) return;
    state.selected = null; state.draft = null; state.drag = null; state.undo = []; state.redo = [];
    render();
  };
  const choose = (shape) => {
    state.tool = SHAPES.has(shape) && state.tool !== shape ? shape : null;
    state.selected = null; state.draft = null; render();
    return state.tool;
  };
  const add = async ({ selector = null, shape = "circle", note: message = "Review this", source = "agent", anchor = null } = {}) => {
    if (!SHAPES.has(shape)) throw new TypeError(`unknown annotation shape: ${shape}`);
    const found = selector ? elementAnchor(selector) : null;
    const placed = anchor ?? (found ? { x: found.x, y: found.y, width: found.width, height: found.height } : { x: .38, y: .38, width: .24, height: .14 });
    checkpoint();
    const record = { id: id(), surfaceId: state.surfaceId, selector, shape, note: message, source: source === "human" ? "human" : "agent", anchor: placed, offset: found ? { x: placed.x - found.x, y: placed.y - found.y, width: placed.width - found.width, height: placed.height - found.height } : null, text: found?.text ?? "", status: selector ? (found ? "anchored" : "missing") : "spatial", createdAt: new Date().toISOString() };
    state.records.push(record); await write(); render(); return clone(record);
  };
  const remove = async (recordId) => {
    const at = state.records.findIndex((record) => record.id === recordId);
    if (at < 0) return false;
    checkpoint(); state.records.splice(at, 1); state.selected = null; await write(); render(); return true;
  };

  const onPointerDown = (event) => {
    if (!shell.markup()) return;
    const mark = event.target.closest?.("[data-id]");
    if (!state.tool && mark) {
      const record = state.records.find((item) => item.id === mark.dataset.id);
      if (!record?.anchor) return;
      state.selected = record.id;
      state.drag = { id: record.id, pointerId: event.pointerId, start: point(event), before: clone(record), moved: false };
      canvas.setPointerCapture?.(event.pointerId); render(); event.preventDefault(); return;
    }
    if (!state.tool) return;
    const start = point(event);
    state.draft = { shape: state.tool, anchor: { x: start.x, y: start.y, width: state.tool === "text" ? .2 : 0, height: state.tool === "text" ? .05 : 0 }, start, selector: stableSelector(elementAt(event)) };
    canvas.setPointerCapture?.(event.pointerId); render(); event.preventDefault();
  };
  const onPointerMove = (event) => {
    if (state.drag?.pointerId === event.pointerId) {
      const record = state.records.find((item) => item.id === state.drag.id);
      if (!record) return;
      const now = point(event), dx = now.x - state.drag.start.x, dy = now.y - state.drag.start.y;
      record.anchor = { ...state.drag.before.anchor, x: state.drag.before.anchor.x + dx, y: state.drag.before.anchor.y + dy };
      if (record.selector) record.offset = { ...(state.drag.before.offset ?? {}), x: (state.drag.before.offset?.x ?? 0) + dx, y: (state.drag.before.offset?.y ?? 0) + dy };
      state.drag.moved ||= Math.abs(dx) + Math.abs(dy) > .002; render(); return;
    }
    if (!state.draft) return;
    const now = point(event), start = state.draft.start;
    if (state.draft.shape !== "text") state.draft.anchor = { x: start.x, y: start.y, width: now.x - start.x, height: now.y - start.y };
    render();
  };
  const onPointerUp = async (event) => {
    if (state.drag?.pointerId === event.pointerId) {
      const drag = state.drag; state.drag = null;
      if (drag.moved) { state.undo.push(state.records.map((item) => item.id === drag.id ? drag.before : clone(item))); state.redo.length = 0; await write(); }
      render(); return;
    }
    if (!state.draft) return;
    const draft = state.draft; state.draft = null;
    const raw = draft.anchor;
    let anchor = draft.shape === "rect" || draft.shape === "circle" ? { x: Math.min(raw.x, raw.x + raw.width), y: Math.min(raw.y, raw.y + raw.height), width: Math.max(.012, Math.abs(raw.width)), height: Math.max(.012, Math.abs(raw.height)) } : raw;
    if (draft.shape === "text") anchor = { ...anchor, width: .22, height: .06 };
    let message = note.value.trim();
    if (draft.shape === "text" && !message) message = window.prompt("Text to place on the surface")?.trim() ?? "";
    if (!message) message = draft.shape === "text" ? "Text" : "Review this";
    const found = draft.selector ? elementAnchor(draft.selector) : null;
    checkpoint();
    state.records.push({ id: id(), surfaceId: state.surfaceId, selector: draft.selector, shape: draft.shape, note: message, source: "human", anchor, offset: found ? { x: anchor.x - found.x, y: anchor.y - found.y, width: anchor.width - found.width, height: anchor.height - found.height } : null, text: found?.text ?? "", status: draft.selector ? (found ? "anchored" : "missing") : "spatial", createdAt: new Date().toISOString() });
    await write(); render();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", (event) => onPointerUp(event).catch(console.error));
  canvas.addEventListener("pointercancel", () => { if (state.drag) { const at = state.records.findIndex((item) => item.id === state.drag.id); if (at >= 0) state.records[at] = state.drag.before; } state.drag = null; state.draft = null; render(); });
  root.querySelectorAll("[data-tool]").forEach((button) => button.addEventListener("click", () => choose(button.dataset.tool)));
  root.querySelector("[data-action='undo']").addEventListener("click", () => travel("undo"));
  root.querySelector("[data-action='redo']").addEventListener("click", () => travel("redo"));
  list.addEventListener("click", (event) => {
    const deleting = event.target.closest("[data-delete]");
    if (deleting) { remove(deleting.dataset.delete); return; }
    const item = event.target.closest("[data-item]");
    if (item) { state.selected = item.dataset.item; render(); }
  });
  const onKey = (event) => {
    if (!shell.markup() || isTypingTarget(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); travel(event.shiftKey ? "redo" : "undo"); return; }
    if (event.key === "Escape") { choose(null); return; }
    if ((event.key === "Delete" || event.key === "Backspace") && state.selected) { event.preventDefault(); remove(state.selected); return; }
    const shape = KEYS[event.key.toLowerCase()];
    if (shape && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); choose(shape); }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", render);
  cleaners.push(shell.onMarkup((on) => { root.classList.toggle("is-marking", Boolean(on)); if (!on) { state.tool = null; state.draft = null; state.drag = null; } render(); }));
  const frameLoad = () => render();
  let observedFrame = null;
  const observeFrame = () => {
    observedFrame?.removeEventListener("load", frameLoad);
    observedFrame = active().frame;
    observedFrame?.addEventListener("load", frameLoad);
  };
  cleaners.push(shell.onSurface(() => { observeFrame(); loadSurface().catch(console.error); }));
  observeFrame();
  root.classList.toggle("is-marking", Boolean(shell.markup()));
  const ready = loadSurface();
  ready.catch(console.error);

  return Object.freeze({
    detach() {
      cleaners.forEach((clean) => clean?.());
      observedFrame?.removeEventListener("load", frameLoad);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", render);
      root.remove();
    },
    ready,
    annotate: add,
    list: () => clone(state.records),
    remove,
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    tool: choose,
    state: () => ({ surfaceId: state.surfaceId, scope: state.scope,
      anchoringIn: (() => { const v = view(); return v ? (v.doc === active().frame?.contentDocument ? "surface" : "nested") : null; })(),
      markup: shell.markup(), tool: state.tool, selected: state.selected, records: clone(state.records), persistence: persistent ? "store" : "session only" }),
  });
}
