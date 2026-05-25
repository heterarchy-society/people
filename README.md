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
