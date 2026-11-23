# Workspace surfaces

A composed app can use the full Studio canvas for its own navigation and conversation layout. Other surfaces keep the normal shell. The shell retains frames and unsaved app state across navigation as before.

From an active same-origin surface, send `parent.postMessage(message, location.origin)`:

- `{t:'surface-layout', layout:'workspace'}` uses the canvas; `layout:'default'` restores the usual shell. Workspace mode closes the existing agent/chat panels using their normal close controls and preserves their drafts.
- `{t:'workspace-context'}` requests declared app navigation and the current opaque route.
- `{t:'surface-route', value:'opaque value', replace:false}` records up to 512 characters in the shell URL's `view` parameter. `replace:true` replaces the current entry. Browser Back returns the active surface and route without replacing its frame.
- `{t:'open-surface-view', id:'requests', value:'opaque value'}` opens a declared workspace at that view using the normal surface switch. Cached frames and unsaved edits remain; app-specific route meaning stays with the target app. Use ordinary `open-surface` when you want its existing selection.
- `{t:'reload-workspace'}` performs an explicit top-level reload, for example after saving a draft before re-authentication. It sends no message or retry.

The shell replies with `{t:'workspace-context', id, route, surfaces:[{id,name,glyph}], links:[{label,href}]}` and sends `{t:'surface-active', active}` as surfaces change. Check `event.source === parent` and `event.origin === location.origin`. Route state belongs to the app; the shell does not interpret a request ID or persist an app's drafts. Apps should preserve their own drafts before navigation and should poll only while active.

Use the existing `{t:'open-surface', id}` message to open another declared app. Workspace mode is opt-in and carries no special backend authority, credentials or private service dependency. It does not change popout or unmount-on-blur behavior.
