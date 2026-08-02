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
    if (m.provider?.package) {
      const pkg = m.provider.package;
      providers.add(pkg);
      if (!providerRuns.has(pkg)) {
        providerRuns.set(pkg, { package: pkg, run: m.provider.run, serves: m.provider.serves ?? [], declaredBy: m.id });
      } else {
        const first = providerRuns.get(pkg);
        if (m.provider.run?.entry && first.run?.entry !== m.provider.run.entry) {
          missing.push(`${m.id}: declares ${pkg} entry "${m.provider.run.entry}" but ${first.declaredBy} declared "${first.run?.entry}"`);
        }
        for (const s of m.provider.serves ?? []) if (!first.serves.includes(s)) first.serves.push(s);
      }
    }
    log(`${m.id} — ${m.provider?.package ?? "ultralight, no provider"}`);
  }

  // External doors are BOX composition, not apps: services the box does not own
  // and does not install, hung on the rail by absolute URL. Vault-shaped.
  for (const d of doors) rows.push({ ...d });

  return { rows, providers, providerRuns, missing, surfacesOut, vendorOut };
}

// Write the overlay manifest the SDK reads. chatSeats is RUNTIME state — a live
// rig roster must never be written back into a source-controlled file — so it
// only ever lands here, in the composed copy.
export function writeOverlayManifest({ surfacesOut, rows, chatSeats }) {
  const dir = insideRepo(surfacesOut);
  const doc = {
    _note: "COMPOSED AT BOOT from installed apps + box doors. Do not edit — edit the app's app.json or studio.config.json.",
    surfaces: rows,
  };
  if (chatSeats?.length) doc.chatSeats = chatSeats;
  fs.writeFileSync(path.join(dir, "surfaces.json"), JSON.stringify(doc, null, 2) + "\n");
}
