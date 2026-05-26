# Heterarchy People

People dataset for the Heterarchy Atlas.

Each person lives in `people/<id>/index.yaml`. Image files in the same directory are copied into the built dataset as source assets.

## Schema

Source files are validated against [`schema/people.json`](schema/people.json) (`additionalProperties: false` — no undocumented fields).

```sh
npm run validate
```

Key fields:

- `avatar` — primary portrait (`avatar.png`, `avatar.jpg`, or `avatar.webp`)
- `avatarsAlt` — optional list of alternative portrait filenames in the person directory
- `refs` — optional links (`twitter`, `github`, `web`, `bsky`, `nostr`, `matrix`)

## Renames

When an item id changes, add the old id to [`redirects.yaml`](redirects.yaml) at the repo root:

```yaml
mario: mario-havel
```

Build emits these into `dist/index.json` as `meta.redirects` for the frontend to honor old URLs.
Use `altNames` for display nicknames — not for slug changes.

Other datasets link here as `[Display Name](people:<id>)` in markdown descriptions (resolved on the frontend). Keep the visible label on the left, e.g. `[Wei Dai](people:wei-dai)`.

