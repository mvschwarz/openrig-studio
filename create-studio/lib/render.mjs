// Rendering — substitution is ALWAYS output-context aware.
//
// The bug this file exists to prevent: a `--hint 'say "hello"'` or a `--glyph '"'`
// interpolated raw into a JSON template produced an INVALID surfaces.row.json
// while the CLI still exited 0, and hint markup landed in the surface as live
// HTML. A generator that emits a broken artifact and reports success is the
// worst failure shape there is — it looks like it worked.
//
// Rules, one per output context:
//   JSON     — never templated as text. Build an object, JSON.stringify it.
//              (See the row construction in index.mjs. Escaping JSON by hand is the bug.)
//   HTML     — escape &<>"' on every interpolated value.
//   JS       — inside <script>, values are JSON-encoded, not HTML-escaped;
//              HTML-escaping there would emit a literal &quot; into code.
//   Markdown — see assertMarkdownSafe below.

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

// A value destined for a JS string literal inside <script>. Returns the quotes
// too, so the template writes `= {{TOKEN_JS}};` with no quotes of its own.
export const toJsLiteral = (value) => JSON.stringify(String(value ?? ""));

// Markdown is deliberately NOT escaped, and that is a decision rather than an
// oversight. The values reaching the emitted README (id, and the label derived
// from it) land inside headings, inline code and fenced blocks. Backslash-
// escaping inside a code span is WRONG — markdown does not interpret specials
// there, so the escape itself would show up as literal backslashes in the
// output the developer reads.
//
// Those values are safe because admission constrains the project name to
// ^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$ — no markdown-active character can survive
// it. That makes markdown safety DEPENDENT on a rule enforced in another file,
// which is exactly the kind of invisible coupling that rots. So assert it here:
// if admission is ever loosened, generation fails loudly instead of quietly
// emitting malformed markdown.
const MARKDOWN_ACTIVE = /[\\`*_{}\[\]()#+!|<>]/;

export function assertMarkdownSafe(values) {
  for (const [key, value] of Object.entries(values)) {
    if (MARKDOWN_ACTIVE.test(String(value ?? ""))) {
      throw new Error(
        `refusing to emit: ${key} contains a markdown-active character (${JSON.stringify(value)}). ` +
        `Values reaching the emitted README must be markdown-inert; admission should have ` +
        `rejected this earlier. If the name rules were loosened, the README template needs ` +
        `context-aware escaping before that change can ship.`
      );
    }
  }
}

// `escape` receives (value, key) so a caller can vary handling per token —
// e.g. leave an already-JSON-encoded *_JS token alone while HTML-escaping the rest.
export function render(template, vars, escape = (value) => value) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    key in vars ? escape(vars[key], key) : whole
  );
}
