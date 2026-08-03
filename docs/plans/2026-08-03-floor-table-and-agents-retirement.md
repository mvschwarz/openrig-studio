# FLOOR Table and AGENTS Retirement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace FLOOR's cards with dense semantic tables, move detached-state coverage to FLOOR, and retire the redundant AGENTS app without removing its shared provider.

**Architecture:** Keep FLOOR as a dependency-free HTML surface and preserve its existing runtime contract, event stream, welcome manifest, and delegated agent launcher. Change only the presentation projection: inline metrics plus two semantic tables. Remove AGENTS from the separate apps repository after FLOOR owns the behavior guard; keep `studio-host` and its live-state tests intact.

**Tech Stack:** Standalone HTML/CSS/JavaScript, Node.js built-in test runner, Git worktrees, browser verification on the deployed Studio box.

---

### Task 1: Pin the FLOOR contract with a failing test

**Files:**
- Create: `test/floor-surface.test.mjs`
- Read: `app/surfaces/floor.html`

**Step 1: Write the failing test**

Add Node tests that read `floor.html` and assert:

```js
assert.equal((surface.match(/<table\b/g) || []).length, 2);
for (const heading of ["Seat", "Pod / member", "State", "Lifecycle", "Age", "Pending"]) {
  assert.match(surface, new RegExp(`<th[^>]*>${heading.replace(" / ", " \\/ \")}<\\/th>`, "i"));
}
assert.doesNotMatch(surface, /<article class="seat\b/);
```

Isolate the `state.attached === false` branch and assert it contains all three
reason keys, their distinct copy, and `setConnection('down', ...)`. Assert the
whole source retains `fetch('/surfaces.json')`, delegated `content.addEventListener`,
`open-agent`, `rig.textContent = state.rig`, `EventSource('/api/events')`, and the
polling fallback.

**Step 2: Run the new test to verify it fails**

Run: `node --test test/floor-surface.test.mjs`

Expected: FAIL because the current surface renders seat and queue `<article>` cards and no tables.

**Step 3: Commit the red test**

```bash
git add test/floor-surface.test.mjs
git commit -m "test: pin the floor table and detached states"
```

### Task 2: Implement the dense FLOOR tables

**Files:**
- Modify: `app/surfaces/floor.html`
- Test: `test/floor-surface.test.mjs`

**Step 1: Replace card CSS with table CSS**

Introduce an inline `.metrics` strip and horizontally scrollable `.table-wrap`
containers. Style real `table`, `thead`, `th`, `td`, and row-state pips with the
compact uppercase-header and quiet-separator rhythm of OpenRig's topology table.
Keep the existing dark palette and visible text status labels.

**Step 2: Replace seat card rendering**

Render one `<tr>` per seat with six cells: seat, pod/member, state, lifecycle,
age, pending. Use both a colored pip and escaped state text. Render a full-width
empty row when no seats are reported.

**Step 3: Replace queue card rendering**

Render queue rows with work, state, source, and destination columns. Render a
full-width clear row when the queue is empty.

**Step 4: Preserve the runtime behavior**

Do not change `welcomeHtml`, the delegated `open-agent` handler, detached-state
mapping, `state.rig` caption, event connection, or polling fallback.

**Step 5: Run focused and full tests**

Run: `node --test test/floor-surface.test.mjs`

Expected: all FLOOR contract tests pass.

Run: `npm test`

Expected: the complete SDK suite passes with no failures (80 existing tests plus the new FLOOR tests).

**Step 6: Commit the implementation**

```bash
git add app/surfaces/floor.html
git commit -m "feat: make the rig floor a dense table"
```

### Task 3: Retire the AGENTS surface cleanly

**Files:**
- Delete: `apps/agents/app.json`
- Delete: `apps/agents/app/agents.html`
- Delete: `test/agents-no-rig.test.mjs`
- Modify: `apps/mini-nle/app/mini-nle.html`
- Modify: `test/mini-nle-contract.test.mjs`
- Modify: `providers/studio-host/package.json`
- Preserve: `providers/studio-host/**`
- Preserve: `test/live-state.test.mjs`

**Step 1: Move the remaining user instruction to the sidebar**

Change the existing MINI-NLE contract test first so its deliberately disabled
review handoff points to the agent sidebar instead of the AGENTS surface. Run
that focused test and observe the expected failure, then replace only the stale
instructional copy in MINI-NLE. Do not enable the ruled-out handoff verbs.

**Step 2: Remove the AGENTS app**

Delete the app directory. Do not remove or rename `studio-host`, its endpoints,
or its live-state implementation.

**Step 3: Remove only the superseded test hook**

Delete `agents-no-rig.test.mjs` only after Task 2 is green. Change the provider
test script to run `../../test/live-state.test.mjs` and keep that state-generator
coverage unchanged.

**Step 4: Run the provider and MINI-NLE tests**

Run: `npm test` from `providers/studio-host`.

Expected: the two live-state tests pass and no test references the deleted app.

Run: `node --test test/mini-nle-contract.test.mjs`

Expected: all MINI-NLE contract tests pass with the sidebar instruction pinned.

**Step 5: Search for stale AGENTS app references**

Run: `rg -n "apps/agents|agents-no-rig|id.*agents" .`

Expected: no product or test reference still installs the retired app. References
to seat/agent capabilities in `studio-host` remain.

**Step 6: Commit the retirement**

```bash
git add -A apps/agents apps/mini-nle test/agents-no-rig.test.mjs test/mini-nle-contract.test.mjs providers/studio-host/package.json
git commit -m "refactor: retire the agents surface after sidebar launch"
```

### Task 4: Browser-verify locally

**Files:**
- Verify: `app/surfaces/floor.html`
- Verify: generated runtime state and consumer manifest fixtures

**Step 1: Start an isolated Studio instance**

Use a verified-free port and a consumer overlay that declares the required
factory-state/event provider plus welcome content. Confirm process ownership and
`location.origin` before inspecting pixels.

**Step 2: Inspect healthy state**

Verify the welcome block appears first, metrics are inline, both semantic tables
are readable, all seat/queue values are present, every rig appears in the
caption, and the welcome agent button emits `open-agent`.

**Step 3: Inspect detached states**

Serve crafted `no-rig`, `no-rig-cli`, and `rig-error` envelopes one at a time.
Verify distinct copy and a down signal for all three; none may show green live.

### Task 5: Publish, deploy, and verify Matti

**Files:**
- Modify on Matti: `/home/ubuntu/studio/studio.json` (remove only the AGENTS app row)
- Preserve on Matti: `studio-host` provider declaration and configuration

**Step 1: Inspect outgoing SDK history**

Run: `git log --oneline origin/main..HEAD`

Expected: only the design, FLOOR test, and FLOOR implementation commits owned by this worktree. Stop and report any additional commit before pushing.

**Step 2: Push both public branches to main**

Push only after the full SDK and provider suites are green. Record the exact SHAs.

**Step 3: Update the Studio box**

Back up `studio.json`, remove only the `agents` app entry, update the public repo
pins, reinstall with each repository's real install path, and restart the user
service. Do not remove `studio-host` or touch either rig.

**Step 4: Verify through the deployed browser origin**

Confirm `/api/contract` is healthy, the rail has six surfaces and no AGENTS,
FLOOR renders dense tables, FILES still loads and lists content, and a live seat
terminal opens and then releases without leaving a `seatview-*` session.

**Step 5: Hand back durably**

Append compact evidence and exact pins to the qitem, close it with
`closure_reason=no-follow-on`, and include any residual limitation plainly.
