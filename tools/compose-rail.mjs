#!/usr/bin/env node
// Compose the rail from INSTALLED APPS rather than a hand-maintained manifest.
//
// This is the piece that makes "install an app, get a tab" real instead of
// simulated. Each app in the apps repo carries an app.json declaring its
// surface, its provider and the roots it needs; the box declares which apps are
// on and which external doors to hang beside them. Nothing is hardcoded here
// about any particular app — adding one is a directory plus a config line.
//
// WHY A COMPOSER AND NOT JUST POINTING AT THE APPS REPO: the SDK's consumer
// seam serves pages from ONE overlay directory, flat. Apps live in separate
// directories with their own vendor trees. So the composition step gathers
// them. It writes only into .runtime/ — per instance, gitignored, rebuilt every
// boot, never inside the package and never back into a source repo.
//
// It also answers a question the old hand-written manifest silently answered
// wrong: WHICH PROVIDERS DOES THIS RAIL ACTUALLY NEED. That now falls out of
// the enabled apps rather than being a fact someone has to remember.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


let STUDIO_ROOT = process.cwd();
export const setStudioRoot = (p) => { STUDIO_ROOT = p; };

// Writes only inside the studio directory it was given.
const insideRepo = (p) => {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(STUDIO_ROOT) + path.sep)) {
    throw new Error(`compose-rail: refusing to write outside the studio (${p})`);
  }
  return r;
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// A PROVIDER declares how to start itself and which verbs it answers, in its own
// provider.json. That is contract (contract/app-manifest.md): a fact belongs to
// the thing that knows it, and the package containing live-state.mjs is what
// knows live-state.mjs must run.
//
// It used to live in app.json, which meant one backend's start command was
// hand-copied into every app that used it. Two copies drifted — AGENTS carried a
// companion FILES did not — so retiring AGENTS deleted the generator for real
// observe-state and a box with 11 real seats served an invented rig under a
// green live signal. Nobody authored that bug; the format placed the fact where
// a deletion could take it.
const providerDir = (appsRoot, pkg) => path.join(appsRoot, "providers", path.basename(pkg));
function readProviderDeclaration(appsRoot, pkg) {
  const p = path.join(providerDir(appsRoot, pkg), "provider.json");
  if (!fs.existsSync(p)) return null;
  try { return readJson(p); }
  catch (e) { return { __error: `provider.json for ${pkg} is not valid JSON: ${e.message}` }; }
}

// Every provider PRESENT on the box, whether or not an enabled app references
// one. This is what lets an unmatched call be answered with "studio-video
// declares it" rather than only "nothing serves it" — derived from the
// declarations, so it cannot go stale when a verb moves between providers.
function availableProviders(appsRoot) {
  const root = path.join(appsRoot, "providers");
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    const p = path.join(root, name, "provider.json");
    if (!fs.existsSync(p)) continue;
    try {
      const d = readJson(p);
      if (d.package) out.set(d.package, d);
    } catch { /* a malformed declaration is reported where it is used */ }
  }
  return out;
}

// A verb ending in "/" is a PREFIX, the same rule byte routes already use, so
// /api/export-status/ matches its children and /api/health matches only itself.
export const verbMatches = (declared, wanted) =>
  declared === wanted || (declared.endsWith("/") && wanted.startsWith(declared));

export function composeRail({ appsRoot, enabled, doors = [], runtimeDir, studioRoot, log = () => {} }) {
  if (studioRoot) STUDIO_ROOT = studioRoot;
  const surfacesOut = insideRepo(path.join(runtimeDir, "surfaces"));
  const vendorOut = insideRepo(path.join(runtimeDir, "vendor"));

  // Written against the resolved names directly rather than through a loop
  // variable. A loop hides the provenance from the containment check, and the
  // checker is right to refuse to guess — the fix is to make the code say the
  // thing, not to relax the check.
  fs.rmSync(surfacesOut, { recursive: true, force: true });
  fs.mkdirSync(surfacesOut, { recursive: true });
  fs.rmSync(vendorOut, { recursive: true, force: true });
  fs.mkdirSync(vendorOut, { recursive: true });

  const rows = [];
  const providers = new Set();
  const providerRuns = new Map();
  const missing = [];
  const warnings = [];
  const refusals = [];
  // verb -> { required, by: [appId] }. Provider-agnostic by design: an app says
  // WHAT it needs, the box works out WHO answers it.
  const calls = new Map();
  const ownSurfaceIds = [];
  const available = availableProviders(appsRoot);

  for (const id of enabled) {
    const appDir = path.join(appsRoot, "apps", id);
    const manifestPath = path.join(appDir, "app.json");
    if (!fs.existsSync(manifestPath)) { missing.push(`${id}: no app.json at ${appDir}`); continue; }

    const m = readJson(manifestPath);
    const entry = path.join(appDir, m.surface.entry);
    if (!fs.existsSync(entry)) { missing.push(`${id}: surface entry missing (${m.surface.entry})`); continue; }

    // The seam resolves /surfaces/<file> to <overlay>/<file>, flat.
    fs.copyFileSync(entry, path.join(surfacesOut, path.basename(m.surface.path)));

    // An app's vendored assets travel with it. canvas ships 3.4MB of tldraw
    // deliberately so the box never calls a CDN.
    const appVendor = path.join(appDir, "vendor");
    if (fs.existsSync(appVendor)) {
      for (const entryName of fs.readdirSync(appVendor)) {
        fs.cpSync(path.join(appVendor, entryName), path.join(vendorOut, entryName), { recursive: true });
      }
    }

    rows.push({
      id: m.id,
      name: m.name,
      glyph: m.surface.glyph,
      path: m.surface.path,
      hint: m.surface.hint,
    });
    // Carry the provider's RUN SPEC, not just its name. The box used to know
    // each provider by name and hardcode how to start it, which meant a sixth
    // app could not run without editing box code — the opposite of installable.
    // Several apps share one provider; first declaration wins and the rest are
    // checked against it, because two apps disagreeing about how to start the
    // same backend is a real conflict and not something to resolve silently.
    // `calls` is what this app USES. Collected from every app first; resolved
    // against provider declarations once, after the loop.
    for (const [verb, spec] of Object.entries(m.calls ?? {})) {
      const prior = calls.get(verb);
      // required is a UNION: if any app cannot work without the verb, the box
      // cannot come up without it, regardless of who else treats it as optional.
      calls.set(verb, {
        required: Boolean(prior?.required) || Boolean(spec?.required),
        by: [...(prior?.by ?? []), m.id],
      });
    }
    if (m.verbs?.length && !readProviderDeclaration(appsRoot, m.provider?.package ?? "")) {
      warnings.push(
        `${m.id}: declares verbs[] — LEGACY, superseded by calls{}. Honoured while ` +
        `${m.provider?.package ?? "its provider"} ships no provider.json; see contract/app-manifest.md`
      );
    }

    if (m.provider?.package) {
      const pkg = m.provider.package;
      providers.add(pkg);
      if (!providerRuns.has(pkg)) {
        // Copy the run spec rather than aliasing the manifest's own object:
        // companions merge across apps below, and merging into the first app's
        // parsed manifest would edit one app's declaration on behalf of another.
        const run = { ...m.provider.run, companions: [...(m.provider.run?.companions ?? [])] };
        providerRuns.set(pkg, { package: pkg, run, serves: m.provider.serves ?? [], verbs: [...(m.verbs ?? [])], declaredBy: m.id });
      } else {
        const first = providerRuns.get(pkg);
        if (m.provider.run?.entry && first.run?.entry !== m.provider.run.entry) {
          missing.push(`${m.id}: declares ${pkg} entry "${m.provider.run.entry}" but ${first.declaredBy} declared "${first.run?.entry}"`);
        }
        for (const s of m.provider.serves ?? []) if (!first.serves.includes(s)) first.serves.push(s);
        for (const v of m.verbs ?? []) if (!first.verbs.includes(v)) first.verbs.push(v);
        // Companions merge like serves and verbs, and for the same reason:
        // first-declaration-wins on the whole run spec would DROP a companion
        // only the second app declared, which is the accepted-but-unperformed
        // failure reintroduced by the composer instead of the launcher. Same
        // entry declared twice with different args is a real disagreement about
        // how to start one process, so it is reported rather than resolved.
        for (const c of m.provider.run?.companions ?? []) {
          const seen = first.run.companions.find((x) => x.entry === c.entry);
          if (!seen) { first.run.companions.push(c); continue; }
          if (JSON.stringify(seen.args ?? []) !== JSON.stringify(c.args ?? [])) {
            missing.push(`${m.id}: declares ${pkg} companion "${c.entry}" with different args than ${first.declaredBy} declared`);
          }
        }
      }
    }
    log(`${m.id} — ${m.provider?.package ?? "ultralight, no provider"}`);
  }

  // ---- the provider's own declaration WINS -----------------------------------
  // Converge rather than fork: an app-declared run spec is honoured only while
  // its provider ships no provider.json. Once the provider declares, the
  // provider is authoritative and any app copy is ignored WITH BOTH NAMED —
  // there is never a moment when two things claim to say how one process starts.
  for (const [pkg, spec] of providerRuns) {
    const decl = available.get(pkg) ?? readProviderDeclaration(appsRoot, pkg);
    if (!decl) continue;
    if (decl.__error) { refusals.push(decl.__error); continue; }
    if (spec.run?.entry && decl.run?.entry) {
      warnings.push(
        `${pkg}: run spec declared BOTH by its provider.json and by app "${spec.declaredBy}" — ` +
        `the provider wins and the app's copy is ignored. Remove run/serves/verbs from that app.json`
      );
    }
    spec.run = { ...decl.run, companions: [...(decl.run?.companions ?? [])] };
    spec.serves = decl.serves ?? [];
    spec.verbs = [...(decl.verbs ?? [])];
    // seeds and supplies are TOP-LEVEL provider fields, and they were being
    // dropped here — copied nowhere, so a declaration the contract documents
    // could not reach the code that reads it. Every field the contract gives a
    // provider is carried explicitly rather than by spreading `decl`, so adding
    // one to the contract without carrying it fails visibly here instead of
    // silently one layer down.
    spec.seeds = decl.seeds ?? null;
    spec.supplies = decl.supplies ?? [];
    // Which verbs answer ?since=, and whether this provider mints a process
    // identity (contract/change-signal.md). Carried explicitly like every other
    // provider-owned field, so adding one to the contract without carrying it
    // here fails the composer's field-by-field test rather than going quiet.
    spec.signals = decl.signals ?? null;
    spec.declaredBy = `${pkg} (provider.json)`;

    // A signal verb this provider does not actually answer is a declaration that
    // does nothing: a consumer would poll ?since= against a route this backend
    // never serves. Warned rather than refused, because the provider still works
    // and the rest of the studio should not be held up by it.
    for (const v of decl.signals?.verbs ?? []) {
      if (!(spec.verbs ?? []).some((d) => verbMatches(d, v))) {
        warnings.push(
          `${pkg}: signals.verbs names ${v}, which this provider does not declare in verbs[] — ` +
          `a consumer polling it would be polling a route this backend does not answer`
        );
      }
    }
  }

  // ---- the unmatched-call ladder ---------------------------------------------
  // 1. a started provider declares it            -> routed, nothing to do
  // 2. a provider PRESENT but not started does   -> required STARTS it; optional warns
  // 3. nothing present declares it               -> required refuses; optional warns
  //
  // Rung 2 is the authority that makes a cross-provider dependency SATISFIABLE
  // rather than merely sayable: files calls /api/focus, studio-video implements
  // it, and files' own provider is studio-host — so without this, a required
  // call could be declared and never fulfilled.
  //
  // Which provider answers is DERIVED here from the declarations, never carried
  // in the app manifest, so it cannot go stale when a verb moves packages.
  //
  // An OPTIONAL call never starts anything. Only `required: true` grants the
  // authority, so this cannot quietly inflate what a box runs.
  //
  // Rung 3 names the app and the verb, NOT a package to install: the box cannot
  // name something it does not have, and promising that refusal would need a
  // registry that does not exist. See contract/app-manifest.md.
  const servedBy = (verb) => {
    for (const [pkg, spec] of providerRuns) {
      if ((spec.verbs ?? []).some((d) => verbMatches(d, verb))) return pkg;
    }
    return null;
  };
  for (const [verb, want] of calls) {
    if (servedBy(verb)) continue;
    const elsewhere = [...available.entries()]
      .find(([pkg, d]) => !providerRuns.has(pkg) && (d.verbs ?? []).some((x) => verbMatches(x, verb)));
    const who = want.by.join(", ");
    if (elsewhere && want.required) {
      const [pkg, decl] = elsewhere;
      providerRuns.set(pkg, {
        package: pkg,
        run: { ...decl.run, companions: [...(decl.run?.companions ?? [])] },
        serves: decl.serves ?? [],
        verbs: [...(decl.verbs ?? [])],
        declaredBy: `${pkg} (required by ${who})`,
      });
      providers.add(pkg);
      log(`${pkg} — started for ${verb}, required by ${who}`);
    } else if (elsewhere) {
      warnings.push(`${who}: calls ${verb} (optional); ${elsewhere[0]} declares it but is not started`);
    } else if (want.required) {
      refusals.push(
        `${who}: calls ${verb} and it is REQUIRED, but no installed provider declares it. ` +
        `Nothing on this box answers that verb`
      );
    } else {
      warnings.push(`${who}: calls ${verb} (optional) and nothing installed declares it`);
    }
  }

  // ---- the studio's OWN surfaces ---------------------------------------------
  // A studio is allowed to have surfaces of its own, declared in its own
  // surfaces.json beside its pages, without packaging them as installable apps.
  // That is what `create-studio` scaffolds and what a developer writes first.
  //
  // Without this the composer built the rail from installed apps alone, so a
  // freshly scaffolded studio booted through this path served an empty rail and
  // 404'd the page it had just been given — while the same studio served it
  // correctly when pointed at the runtime directly. Two documented paths, two
  // different answers, and the one the scaffolder recommends for a fuller
  // studio was the broken one.
  const ownManifest = path.join(STUDIO_ROOT, "surfaces.json");
  if (fs.existsSync(ownManifest)) {
    let own = [];
    try { own = readJson(ownManifest).surfaces ?? []; }
    catch (e) { refusals.push(`studio surfaces.json is not valid JSON: ${e.message}`); }
    for (const row of own) {
      if (!row?.path) { rows.push({ ...row }); continue; }   // a url row needs no page
      const file = path.basename(row.path);
      const src = path.join(STUDIO_ROOT, file);
      if (!fs.existsSync(src)) {
        missing.push(`studio surface "${row.id}": page missing (${file} not in the studio directory)`);
        continue;
      }
      fs.copyFileSync(src, path.join(surfacesOut, file));
      rows.push({ ...row });
      ownSurfaceIds.push(row.id);
      log(`${row.id} — this studio's own surface`);
    }
  }

  // External doors are BOX composition, not apps: services the box does not own
  // and does not install, hung on the rail by absolute URL. Vault-shaped.
  for (const d of doors) rows.push({ ...d });

  return { rows, providers, providerRuns, missing, warnings, refusals, calls, ownSurfaceIds, surfacesOut, vendorOut };
}

// Write the overlay manifest the SDK reads. chatSeats is RUNTIME state — a live
// rig roster must never be written back into a source-controlled file — so it
// only ever lands here, in the composed copy.
export function writeOverlayManifest({ surfacesOut, rows, chatSeats, chatLocalPort, welcome, primaryRig }) {
  const dir = insideRepo(surfacesOut);
  const doc = {
    _note: "COMPOSED AT BOOT from installed apps + box doors. Do not edit — edit the app's app.json or studio.config.json.",
    surfaces: rows,
  };
  // Array.isArray, not `.length`: an EMPTY roster is a declaration — "this studio
  // has no seats" — and omitting the key made the runtime fall through to the
  // PACKAGE document, which is how the SDK's invented fixture seat reached real
  // boxes. Writing [] is what makes an honest empty sidebar possible.
  if (Array.isArray(chatSeats)) doc.chatSeats = chatSeats;
  // The endpoint travels WITH the roster or the tiles are decorative. Omitted
  // deliberately when no terminal can be served, so the shell reports
  // listed-but-not-attachable instead of failing on click.
  if (chatLocalPort != null) doc.chatLocalPort = chatLocalPort;
  // Which rig the launcher opens on, when a box has more than one and one of
  // them is the point. Declared by the box; the shell hardcodes no rig name.
  if (primaryRig) doc.primaryRig = primaryRig;
  // A box may introduce itself. Declared, never hardcoded into a surface: the
  // shell ships to every box and knows none of their seat names, so a welcome
  // written into FLOOR would be exactly the bespoke lineage we keep removing.
  if (welcome && typeof welcome === "object") doc.welcome = welcome;
  fs.writeFileSync(path.join(dir, "surfaces.json"), JSON.stringify(doc, null, 2) + "\n");
}
