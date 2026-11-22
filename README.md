# Forest walk

<table>
  <tr>
    <td><img src="screenshots/1.webp" width="200" alt="Light through the trees at the footbridge"></td>
    <td><img src="screenshots/2.webp" width="200" alt="A forest path in the morning sun"></td>
    <td><img src="screenshots/3.webp" width="200" alt="The creek's falls under a maple"></td>
    <td><img src="screenshots/4.webp" width="200" alt="A path in the rain"></td>
  </tr>
  <tr>
    <td align="center">Footbridge</td>
    <td align="center">Morning sun</td>
    <td align="center">The falls</td>
    <td align="center">Rain</td>
  </tr>
</table>

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

The `summary` in `tik.yaml` maps this tik's code and lists the rules that keep
it running on phones (tiers, load-time bakes, the version label, the testing
menu). Read it next.

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
