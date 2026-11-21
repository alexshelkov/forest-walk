# Working on this tik

Read this before changing anything here. A tik is not a web page with different
CSS: it is a small app that runs inside a phone, offline, in a sandbox, and most
of the rules below exist because something obvious failed in it.

## What a tik is

A self-contained interactive app inside a phone WebView. **Portrait,
full-screen, touch-only, and fully OFFLINE at runtime** (no network, no
`window.open`, no external links) unless the tik has been granted otherwise.

- **Full-bleed.** `margin: 0` and `height: 100%` on html/body, and `height: 100%`
  on the top-level frame. Never `100dvh` / `100svh`: older WebViews drop them and
  the frame collapses to its content height.
- **Touch only.** No mouse, no keyboard, no hover. Tap targets at least 44 CSS
  px. Set `overscroll-behavior: none`, `touch-action: manipulation`,
  `user-select: none`, `-webkit-tap-highlight-color: transparent`.
- **Gestures, not buttons, for movement.** Swipe to steer, drag to aim, tap a
  side to go. No D-pad or arrow cluster; buttons only for start, pause, mute.
- **Controls along the bottom**, where a thumb reaches. Dark backgrounds, punchy
  type, 60fps via CSS transforms and rAF.
- **Do NOT use `env(safe-area-inset-*)`.** It reads 0 on every edge inside a tik:
  the host reserves the notch and the home-indicator area OUTSIDE the WebView, so
  `max(base, env(...))` always collapses to `base`. Use plain padding. A ~15px
  content gutter and ~10-12px on a docked edge read well.
- **All assets local.** Never hot-link a remote URL. Put runtime files in
  `public/assets/` and reference them as `/assets/<name>`.

The reference viewport is 390x844.

## The codetik skill

This file is the short brief. The long one is the `codetik` skill that ships
with the CLI: every command as an agent drives it (`--json`, exit codes, what
to confirm), how a tik is built, and a SpacetimeDB reference with worked
examples. `codetik skill` installs it into the user-level skills folder of
whichever agents you use (Claude Code, Codex, Cursor), asking once and
syncing silently after that; `codetik new` offers the first install. In
Claude Code type `/codetik`, or let it trigger on its own; any other agent
triggers on the same description, or reads the packaged copy directly:

```
codetik skill --path      # the folder; start with SKILL.md, then reference/
```

Not installed on this machine? Run `codetik skill` once.

## Commands

```
codetik dev       # run it locally, in a phone-sized frame with the app chrome
codetik build     # local build check
codetik publish   # a draft on the server; --live releases it
```

`codetik dev` serves the tik in an iframe with the real `window.tik`, so the
accessors below actually work. `--no-iframe` runs it bare with a stub.

## Layout, and what ships

```
index.html          entry (plus index2.html … for `path` slides)
src/                TypeScript, imported and bundled
public/             static assets, served from the URL ROOT (public/a.webp -> /a.webp)
backend/src/        optional SpacetimeDB module (server code, never reaches a device)
tik.yaml            publish metadata, repo-only; `codetik set` edits it, not you
tik.webp            512x512 logo, required to go live, repo-only
tik.config.json     only for multi-slide tiks
package.json        peerDependencies = shared-library opt-in
```

Publishing is an **allowlist**: root `*.html` + `package.json` / `tsconfig.json`
/ `tik.config.json`, `src/**` text, `public/**` assets, `backend/src/**.ts`.
Anything else is dropped, and `codetik publish` prints what it dropped. Read that
list: an asset in an unlisted format silently becoming a 404 is the usual cause.

**Do not add build config.** No vite.config, no postcss config, no dotfiles that
execute. The build harness is supplied by the platform and a tik that ships its
own is rejected.

## `window.tik`

Injected by the host. No import, no opt-in, always present. Types are in
`src/tik.d.ts`.

**`tik.visible()` is the one that matters.** The feed boots tiks and slides
BEFORE the user reaches them, so a tik runs off screen with
`document.hidden === false` and cannot otherwise tell. Read the state AND
subscribe, because events only fire on change:

```ts
if (tik.visible()) start();
tik.on('visible', start);
tik.on('hidden', stop);
```

A tik that ignores this burns battery off screen, and animations are mid-way
through by the time anyone looks at them. On screen, redraw only when
something changed and never put an infinite animation on an element that
also has a `filter` (the skill's `reference/tik.md` explains both).

Other accessors exist ONLY when the tik was granted them, so presence is the
feature test:

```ts
if (tik.profile) {
  const me = await tik.profile();
} // username + avatar
if (tik.token) {
  const t = await tik.token();
} // identity for the backend
if (tik.spacetimedb) {
  const db = await tik.spacetimedb();
}
```

**Locale and time carry nothing.** Use the standard web APIs
(`navigator.language`, `Intl.DateTimeFormat().resolvedOptions()`,
`toLocaleString`); the WebView answers them from the device.

## Grants

`codetik permissions --json` reads them and `codetik backend --status --json`
the backend; never read or edit tik.yaml for either. Four are yours to set:

| command                            | gives the tik                                 |
| ---------------------------------- | --------------------------------------------- |
| `codetik permissions --mic on`     | the microphone, after the app's own prompt    |
| `codetik permissions --profile on` | `tik.profile()`: the viewer's name and avatar |
| `codetik permissions --auth on`    | `tik.token()`: an identity the backend trusts |
| `codetik backend`                  | a backend (`--off` removes it)                |

`codetik permissions --links youtube,github` (or `off`) lets links to exactly
those sites open over the tik, through `<a href target="_blank">` or
`window.open(url)`; YouTube, Vimeo, Spotify and Telegram links open externally, in their
app when it is installed. `--json` lists the site ids.
Any other link does nothing, and links do nothing on the web.

Everything else reaching OUTSIDE the sandbox (`network`, other `links` and
`external`, `tiks`) is granted by Codetik, not declared by you. A publish that
asks for one is refused.

**The combinations are fixed. Four shapes exist and nothing else:**

```
nothing                        no backend, nothing about the viewer
profile                        the viewer's name and avatar, no backend
spacetimedb                    a backend, anonymous users
spacetimedb + auth + profile   a backend with identified users
```

`auth` without a backend is refused: nothing could verify the token. With a
backend, `auth` and `profile` are ONE switch, so asking for either gives both.
`codetik permissions` applies both rules and refuses what a publish would.

## Backend

A tik whose backend is on (`codetik backend`) gets a SpacetimeDB module in
`backend/src/index.ts`, a sibling of `src/`, not a child.

- Server code. It never reaches a device, and it cannot make network calls.
- You author `backend/src/**` only. The `package.json` and `tsconfig.json`
  beside it, and `src/module_bindings/`, are generated and regenerated on
  every publish: never edit them. Only `src/module_bindings/` is gitignored.
- The client imports the generated bindings from `src/module_bindings`.
- `codetik dev` republishes the module on every save and regenerates bindings.
- **One database per tik.** A breaking schema change is REFUSED, published or
  not; `codetik backend --reset-db` clears the rows, only with the user's yes.
  Plan migrations before releasing.

Backends need the Pro plan for everything: `codetik backend`, the dev preview
and every publish.

Writing the module (`spacetimedb@2.13`), the rules that actually bite:

- `schema({...})` holds TABLES only. A `t.object(...)` / `t.row(...)` used as a
  reducer argument or a view's return type is a builder, not an entry.
- A named export is the REGISTRATION surface: reducers, lifecycle hooks and
  views are found by walking them. Keep helpers and constants unexported, and
  export a scheduled reducer like any other or its rows call nothing.
- `public: true` on a table is what lets a client subscribe. Without it the
  client sees no rows and no error.
- The column modifier decides the API: `.primaryKey()` find/update/delete,
  `.unique()` find/delete, `.index()` filter/delete, none of them addressable
  otherwise. `insert` is on the table itself and returns the stored row, which
  is how you read back an `autoInc` id.
- A multi-column index goes in the table's `indexes` (each entry needs
  `columns`); a column listed there must not also carry `.index()`. Range
  filters take a `Range` from `spacetimedb/server`, with tagged bounds.
- `iter()` and `filter()` return iterators, so spread before any array method.
- Timers are a scheduled table plus `{ onSchedule: table }` on the reducer, in
  MICROSECONDS. There is no `setInterval`.
- No `procedure()`, no `httpHandler()`, no `httpRouter()`, no outbound fetch.
  Publish REFUSES a module that declares one, in either direction.

## Providers

Present only when declared, and only after consent:

```ts
if (tik.openrouter && (await tik.openrouter.require('to write your story'))) {
  // model calls through the `ai` + `@openrouter/ai-sdk-provider` shared libraries
}
```

A tik NEVER sees a credential. It asks, the host calls on the viewer's behalf,
and only the result comes back.

Providers are not supported in `codetik dev` yet: calls reject with
`unsupported`, and `@openrouter/ai-sdk-provider` does not resolve locally.

## Shared libraries

Opt in with `codetik add <name>`, which adds the package to `peerDependencies`
in `package.json`. At build time the import is externalized to a URL the host
serves; it is never bundled. An unsupported name fails the build. Do not `npm install` a runtime dependency:
if it is not in the supported set, it cannot ship.

## Assets

`public/` is a budget, not a dumping ground. The target is a portrait phone at
DPR 2-3, so nothing needs 1080p.

| on-screen role        | max width |
| --------------------- | --------- |
| full-bleed background | 720px     |
| hero / character      | 480px     |
| card, panel, button   | 320px     |
| icon, HUD badge       | 160px     |

Images ship as webp (`cwebp -q 80`), audio as **24 kbps / 22.05 kHz mp3** and
never higher, whatever the material. Delete anything unreferenced.

## Comments

Tiks carry MORE comments than ordinary code. Every tik can be forked, and the
next reader arrives cold with no build history.

- A line or two at the top of each `src/` file: what it owns, how it connects.
- A line at every invariant, ordering dependency, physical magic number,
  platform workaround, or constant that mirrors a value elsewhere (a JS number
  matching a CSS width, a count matching a file set).
- Do not restate the code, add section banners, or comment obvious helpers.

One line each, two at most.
