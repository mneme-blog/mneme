# Brand assets

The Mneme mark is a ring with a dot at its centre, in the terracotta accent — the
same shape the app ships as its favicon (`apps/client/public/favicon.svg`) and
draws in `apps/client/src/ui/Wordmark.tsx`. Those stay the source of truth for
the mark itself; this directory only holds the places it has to exist as a
standalone file, outside the client bundle.

## Files

| File | Where it is used |
|---|---|
| `mneme-avatar.svg` | Source for the GitHub organisation avatar |
| `mneme-avatar-512.png` | The rendered 512×512 upload |

## The avatar has a background on purpose

The favicon is transparent, which is right for a browser tab. An avatar is not:
GitHub renders it against light *and* dark chrome, and a bare terracotta mark
floats on both. So the avatar sits on the warm-paper ground instead, giving the
same two colours the app's light theme uses:

- ground `#f4eee2` — `--paper`
- mark `#b0563a` — `--accent`

Both come from `apps/client/src/styles/tokens.css`. If the palette moves there,
move it here too — this file is a copy, not a reference.

## Re-rendering

```bash
rsvg-convert -w 512 -h 512 -o brand/mneme-avatar-512.png brand/mneme-avatar.svg
```

GitHub takes the PNG at
**Settings → Profile** (`https://github.com/organizations/mneme-blog/settings/profile`).
There is no REST endpoint for organisation avatars, so this upload is manual.
