# Failure modes

Every entry below actually happened while building or migrating the first five apps on this
SDK. They are ordered by how much time they cost. **The symptom is listed first, because the
symptom is what you will have.**

The unifying shape: **a result whose form looks like an answer while its content is not one.**
Almost every one of these produced HTTP 200, a clean exit, or a green check.

---

## 1. The pane is empty and every verb returns 200

**Cause:** the response shape does not match what the surface reads. A field renamed, a
wrapper added, a vocabulary the UI does not know.

Three real instances, all in one afternoon, all from hand-rewriting working code:
- returned `{dir, entries}` where the surface reads `{roots}` or `{path, dirs, files}`
- read every file as `utf8`, corrupting video, and hung the pane
- returned a `kind` vocabulary (`"file"`) the icon map had no entry for

**Fix:** treat the response shape as a **contract with the surface**, not an implementation
detail. When porting, port — do not retype. Assert on the shape in a test, including the
"no argument" case, because that is usually the one the UI actually calls first.

**Why it hides:** the verb genuinely works. Real data, correct status, sensible JSON.

---

## 2. The tab loads but sits on a spinner forever

**Cause:** a vendored dependency did not load. The surface's own verbs are all fine.

Real instance: an import scan that matched `./` missed `../../vendor/tldraw`, so the app was
installed without its renderer.

**Fix:** declare the vendor closure in `app.json`. Do not discover it by scanning.

---

## 3. The app shows an empty state on a project that is not empty

**Cause:** your page is **not served from inside your project.** A relative
`fetch("timeline.json")` resolves against the surfaces overlay, not your data directory.

Real instance: an app fetched a bare relative filename, which had always worked because its
previous host served the page *out of the project bundle*. Under the SDK studio the shell
serves surfaces from an overlay and only `/api/*` reaches the backend — so it 404'd on **every
project**, fell back to an embedded sample, and reported success.

**Fix:** ask the backend for the document over `/api/…`. Never assume you are inside the data.

---

## 4. A load failure that looks exactly like a new project

**Cause:** a fallback that renders as a plausible empty state.

This is #3's second half and it is worse than #3. The fallback was sample data, so a failure rendered as a different project with broken media — which reads as
"my project loaded wrong." Emptying the fallback fixed the lie and created a subtler one: a
total failure to load became a clean empty board, indistinguishable from a fresh project.

**Fix:** **an empty state and a failed load must not share an appearance.** Name the failure,
say what was tried, and withdraw any affordance that would write into data you are not showing.

---

## 5. A dependency answers, but it is the wrong one

**Cause:** a hardcoded default port, plus a degradation path that cannot tell "absent" from
"answered wrong."

Real instance: a proxy read an env var or fell back to a hardcoded `127.0.0.1:<port>`. On a
busy host something else was there. It returned `ok: true` with a **stranger's data** while the
real service held the correct data.

**Fix:** bind dependencies explicitly. **A degradation path must distinguish "dependency
absent" from "dependency answered wrong"** — otherwise graceful degradation is
indistinguishable from misconfiguration, because both return 200.

---

## 6. The button says it worked and nothing happens

**Cause:** the write is real — data changes on disk — but the process that performs the effect
is not running or not in scope.

Real instance: a verb appended a job for a render watcher, returned `ok: true`, and nothing
ever rendered. **This defeats both obvious checks**: verbs-answer passes, and real-data-changed
passes, because the job file genuinely gains a line.

**Fix:** the bar is **"the verb's real-world effect is observably performed,"** not "data
changed." Observe the render, not the enqueue. If the performer is genuinely out of scope, make
the control **visibly unavailable** — never a button returning success that silently does
nothing.

---

## 7. Works on the author's machine, silently no-ops elsewhere

**Cause:** platform-specific shell behaviour inside a guard.

Real instance: a watcher script used `stat -c %Y` (GNU). On macOS (BSD `stat`) the call failed,
the guard fell through, and **the lane never ran at all** — silently, for an unknown length of
time.

**Fix:** no shell-outs for things a runtime does natively. If you must, test on both platforms
or fail loud when the tool is not the one you expect.

---

## 8. A fresh-looking install serving another instance's content

**Cause:** state written into the installed package directory, then copied.

If a boot step writes into `node_modules`, then `node_modules` is **state**, not just
dependencies. Copying it to skip a slow install carries another instance's registrations.

**Fix:** keep consumer state outside the package (the SDK's `--surfaces` seam exists for this).
And: **an instance's rail is not proof of its commit** — healthy and correct are two claims.

---

## 9. The app is schema-invalid the moment it is created

**Cause:** a required field the creation path does not set — masked by a bigger failure
upstream.

Real instance: every beat created from the UI lacked a required `template` field. Completely
invisible, because the board never loaded a real project (see #3), so validation never ran
against a UI-created record.

**Fix:** when you fix a load path, **re-run everything downstream of it.** Bugs hide behind
bugs, and the second one only becomes reachable when the first is fixed.

---

## 10. Evidence collected from the wrong server

**Cause:** a port collision on a busy host.

A studio that lands on a stranger's port produces screenshots and API responses that are
evidence for something you did not build.

**Fix:** fail loud on an occupied port; never attach to whatever is listening. Confirm with
`lsof -nP -iTCP:<port> -sTCP:LISTEN`, the process args, and in-browser `location.origin`.

---

## 11. [producer] Your file is right there in the overlay and the URL 404s

**Cause:** no valid row registers it. Serving follows **registration**, not the filesystem —
putting a file in your surfaces directory does not publish it.

The same rule catches the case you want caught: a stray `secret.txt` beside your manifest is not
reachable either. The overlay is a registration seam, not a static web root.

**Fix:** check `/api/contract` → `manifest.errors[]`. If your row was rejected it is named there,
row by row. A row that fails validation is excluded from the rail *and* its path stops resolving,
which is why the symptom is a 404 rather than a missing tab.

**Related, and it surprises people:** a registered row whose page is missing returns a 404 naming
the problem — the package's page is **not** substituted underneath your row. That is deliberate.
Serving someone else's bytes under your row would make the rail and the page disagree about whose
surface you are looking at.

---

## 12. [producer] The package is contaminated and your check says it is clean

**Cause:** you checked for **errors**. Contamination is reported as a **warning**.

With an overlay configured, the runtime serves exactly the SDK's own declared surfaces plus your
overlay-declared ones. An undeclared row or file in the installed package — from a copied tree, a
stale materialisation, a dependency writing into `node_modules` — is ignored for serving and
named in `manifest.warnings`. It is deliberately *not* an error: it is not the consumer's fault
and it must not stop the runtime serving.

So `manifest.ok === true` and `errors: []` on a **dirty** package is the correct, healthy-looking
output. A monitor watching for errors sees nothing wrong.

**Fix:** **no-errors is not the clean signal — the warning's absence is.** Assert on
`manifest.warnings` being empty, not just `manifest.errors`. This is the same shape as everything
else on this page: the check's failure output is indistinguishable from its success output unless
you look at the field that actually carries the answer.

---

## The checklist this reduces to

- Open the app in a browser and use it. Do not infer working from responding.
- Ask of every check: **what does this look like when it fails?** If that resembles success,
  the check proves nothing — run a negative control that makes it fail on purpose.
- Assert that the **legitimate** operation still works, not only that the bad one is rejected.
  A boundary that rejects everything passes every attack test and ships a dead feature.
- Install your manifest somewhere that has nothing.
- Never let a failure borrow an empty state's appearance.
