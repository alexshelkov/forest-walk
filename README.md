# Forest

A [tik](https://codetik.dev): a small interactive app that runs inside a phone,
offline, in the Codetik feed.

```bash
codetik dev                        # run it locally in a phone frame
codetik set --description "..."    # title, description, tags, category (never edit tik.yaml by hand)
codetik check --fix                # types, formatting, assets
codetik publish                    # a draft on the server; --live releases it
```

`AGENTS.md` is the working brief: what a tik may do, the `window.tik` API,
grants, backends, and the asset budget. Read it before changing anything, and
point your coding agent at it.

For the long version, give your agent the `codetik` skill: `codetik skill`
asks which agents you use (Claude Code, Codex, Cursor) and installs it where
each of them loads it from for every project. In Claude Code, `/codetik` runs
it (`/codetik ideas` to pick a starting point, `/codetik backend` to add a
realtime database, `/codetik publish` when it is ready).

## Layout

| path         |                                               |
| ------------ | --------------------------------------------- |
| `index.html` | entry                                         |
| `src/`       | TypeScript, bundled                           |
| `public/`    | assets, served from `/`                       |
| `tik.yaml`   | title, category, tags, grants (never shipped) |
| `tik.webp`   | 512x512 logo, required to go live             |
