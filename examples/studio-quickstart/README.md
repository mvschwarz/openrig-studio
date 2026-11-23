# Studio quickstart: the Notes app

A complete small Studio: one app, **Notes**, that shows the Markdown files in one folder through its own provider.
It's the smallest example of the parts every real app has: a manifest, a page, a provider, and a folder the Studio
binds to a **root kind** instead of a hardcoded path.

```sh
cd examples/studio-quickstart
node ../../tools/studio.mjs
```

Open http://127.0.0.1:8890/ and choose **NOTES**. Add a `.md` file to `notes/` and press Refresh. An agent reads the
same data from the same origin:

```sh
curl http://127.0.0.1:8890/api/notes
curl "http://127.0.0.1:8890/api/notes/item?name=welcome.md"
```

Check it end to end without a browser (it runs a temporary copy and stops what it starts). From this folder:

```sh
node check.mjs
```

(From the repository root, the same check is `node examples/studio-quickstart/check.mjs`.)

| File | Role |
|---|---|
| `studio.json` | enabled apps, where they are (`appsRoot`), the port (the runtime takes the next one), and the folder for each root kind. Relative paths resolve against this folder. |
| `surfaces.json` | `{"chatSeats": []}`: no agents in this Studio. Remove it and set `"rig"` in `studio.json` to show your OpenRig team. |
| `apps/notes/app.json` | the manifest: page, root kind `notes`, the verbs it calls, the provider it needs |
| `apps/notes/app/notes.html` | the page: one self-contained file, no build step |
| `providers/studio-notes/provider.json` | how the launcher starts the provider and which verbs it answers |
| `providers/studio-notes/notes-server.mjs` | two read-only GET verbs over the bound folder |
| `notes/` | the example data |

Floor also appears on the rail, saying its state is unavailable: the launcher always adds it, and nothing in this
Studio supplies real team state. The full walkthrough, including connecting your team and upgrading, is
[docs/getting-started.md](../../docs/getting-started.md).
