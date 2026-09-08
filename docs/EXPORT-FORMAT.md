# The Mneme journal export format

**Format id:** `mneme-journal-export` · **Version:** 1

This document specifies, completely, what comes out of Mneme's **Preferences → Vault → Export a
journal**. It exists so that somebody who has never seen this codebase can write an importer, a
converter, or an archival tool against a Mneme export — without reverse-engineering anything and
without asking us.

If you only read one paragraph: an export is a **`.zip`** containing a **`mneme-export.json`
manifest**, one **JSON file per entry**, and the **decrypted media files**. Entry content is a
[ProseMirror](https://prosemirror.net/) document; every entry also carries a Markdown rendering of
itself, so a simple importer can ignore ProseMirror entirely.

---

## 1. Ground rules

**The archive is plaintext.** Mneme is end-to-end encrypted, but an export is the deliberate exit
from that: content is decrypted on the device before it is packed. An export is exactly as sensitive
as the journal it came from. Nothing in the archive is encrypted, signed, or authenticated.

**The archive is built on the device.** It never passes through the relay, and the relay could not
read it if it did. Producing one requires an unlocked vault.

**Scope is one journal (notebook).** Each export covers a single journal: its metadata, its live
entries, and the media those entries reference. Deliberately *not* included, because they are
vault-level rather than journal-level: entry templates, interview types, AI settings, the recovery
phrase, device keys, and deleted entries (a tombstone is a deletion, and an export is not a way to
un-delete). Export each journal separately for a complete copy of a vault.

**Compatibility rules** — what a reader may rely on:

- Within a major `formatVersion`, changes are **additive only**. New fields may appear; existing
  fields do not change meaning or type, and are not removed.
- A reader **must ignore fields it does not know**. This is what makes the additive rule useful.
- A reader **must tolerate unknown ProseMirror node and mark types** (see §5.7). Mneme gains node
  types over time; an importer that throws on an unfamiliar one will break on a future export.
- `formatVersion` is bumped only for a change a version-1 reader could not survive. Check it, and
  refuse a version you do not know rather than guessing.

**Character encoding** is UTF-8 throughout. **Timestamps** are ISO 8601 in UTC with milliseconds
(`2026-09-08T12:34:56.789Z`) — every one of them, everywhere in the format.

---

## 2. The container

A ZIP archive (deflate for the JSON members, stored for media — see §7), named

```
mneme-<journal-slug>-<YYYY-MM-DD>.zip
```

with this layout:

```
mneme-export.json          the manifest — the table of contents
README.md                  a short human-readable orientation note
entries/<entryId>.json     one file per entry
media/<mediaId>.<ext>      the decrypted media files
```

`README.md` is for a human opening the archive in five years. It carries no information that is not
in the manifest; do not parse it.

Paths use `/` and are relative to the archive root. Entry and media file names are derived from ids,
which are constrained to `[A-Za-z0-9_-]` — no archive member can escape its directory. **Read files
by the paths the manifest gives you**, not by reconstructing them from ids: the extension of a media
file depends on its type, and future versions may lay out directories differently.

---

## 3. `mneme-export.json` — the manifest

```jsonc
{
  "format": "mneme-journal-export",
  "formatVersion": 1,
  "generator": { "app": "Mneme", "version": "0.5.0+a1b2c3d" },
  "exportedAt": "2026-09-08T12:34:56.789Z",

  "journal": {
    "id": "j-personal",
    "name": "Dream Diary",
    "subtitle": "at night",          // optional
    "color": "terracotta",           // optional — Mneme cover accent
    "cover": "lines",                // optional — lines | dots | grid | plain | photo
    "createdAt": "2026-01-01T00:00:00.000Z",   // optional
    "updatedAt": "2026-09-01T09:00:00.000Z"    // optional
  },

  "counts": { "entries": 42, "media": 17, "missingMedia": 0 },

  "entries": [
    {
      "id": "9f2c…",
      "path": "entries/9f2c….json",
      "title": "A day out",
      "createdAt": "2026-07-04T09:12:00.000Z",
      "updatedAt": "2026-07-04T21:40:11.000Z",
      "labels": ["travel", "summer"],
      "media": ["a81f…", "b0c4…"]
    }
  ],

  "media": [ /* see §4 */ ],
  "missingMedia": [ /* see §4.1 */ ]
}
```

| Field | Type | Notes |
|---|---|---|
| `format` | string | Always `"mneme-journal-export"`. **Check this first.** |
| `formatVersion` | number | `1`. Refuse versions you do not know. |
| `generator` | object | `{app, version}` of the writer. Informational — never branch on it. |
| `exportedAt` | string | When the archive was written. |
| `journal` | object | See below. |
| `counts` | object | `entries`, `media`, `missingMedia`. Convenience; the arrays are authoritative. |
| `entries` | array | The index, **oldest first by `createdAt`**. |
| `media` | array | Every media file present in the archive. |
| `missingMedia` | array | Media that is referenced but **not** in the archive. |

### `journal`

`id` and `name` are always present. `id` is Mneme's internal notebook id and is only meaningful
inside the vault it came from; treat it as an opaque grouping key. `color` and `cover` are Mneme's
presentation choices for the notebook cover — safe to ignore.

### `entries[]`

An index, not the content. Each element repeats the entry's `title`, timestamps, `labels` and media
ids so that a tool can build a listing without opening every entry file. `path` points at the entry
file; the file is authoritative if the two ever disagree.

Entries are ordered **oldest first**. Replaying them in that order rebuilds the original chronology.

---

## 4. Media

Every element of `media[]`:

```jsonc
{
  "id": "a81f…",                     // opaque, unique within the vault
  "path": "media/a81f….mp4",         // where the bytes are in this archive
  "kind": "video",                   // video | audio | image | file
  "mime": "video/mp4",
  "bytes": 4718592,                  // length of the file at `path`
  "name": "clip.mp4",                // optional — original filename, if there was one
  "durationMs": 18400,               // optional — video/audio only
  "width": 1280,                     // optional — video/image only
  "height": 720,                     // optional
  "createdAt": "2026-07-04T09:20:00.000Z",
  "entryId": "9f2c…"                 // the entry these bytes belong to
}
```

- `bytes` is the length of the **decrypted** file in the archive. It is measured at write time, so it
  always matches the file — trust it over any size recorded elsewhere.
- `mime` may carry parameters (`video/webm;codecs=vp8,opus`). The file extension is derived from the
  base type; unknown types get `.bin`. Use `mime`, not the extension.
- A media file referenced by two entries is stored **once**; `entryId` names the first entry that
  referenced it, and both entries list its id.
- `kind: "file"` is a generic attachment (a PDF, a spreadsheet) — anything the app does not render
  itself.

### 4.1 `missingMedia` — an honest gap

Mneme is multi-device and offline-first, so a recording may live only on a phone that is switched
off. Rather than fail the whole export, such a reference is recorded:

```jsonc
{ "id": "c93a…", "entryId": "9f2c…", "reason": "unavailable" }
```

An id in `missingMedia` is **not** in `media[]` and has **no file** in the archive, but the entry's
document still references it (§5.4). An importer should keep the reference and render a placeholder,
the way Mneme itself does. A complete archive has `missingMedia: []`; anything else means: export
again from a device that holds those files, or while online.

`reason` is an open enumeration — treat an unrecognised value as "unavailable".

---

## 5. `entries/<id>.json` — an entry

```jsonc
{
  "id": "9f2c…",
  "journalId": "j-personal",
  "title": "A day out",
  "createdAt": "2026-07-04T09:12:00.000Z",
  "updatedAt": "2026-07-04T21:40:11.000Z",
  "labels": ["travel", "summer"],

  "body":     { "type": "doc", "content": [ /* … */ ] },
  "markdown": "## A day out\n\nWe went to the coast…\n",

  "media": [ /* the §4 objects this entry references, in document order */ ],
  "links": ["7c11…"]
}
```

- **`body` is the content of record.** Everything an entry can hold is in there.
- **`markdown` is derived.** It is provided so a simple importer never has to touch ProseMirror.
  It is a faithful rendering of ordinary prose; Mneme's custom nodes have no Markdown spelling and
  appear as the tokens in §6. If `markdown` and `body` ever disagree, `body` wins.
- `title` is the entry's own title, which is independent of any heading inside `body`.
- `labels` are free-form tags. Interview entries carry the interview type's name as a label.
- `createdAt` is the entry's **journal date** — the date the user assigned it, which is editable and
  need not be when it was typed. Sort and file by this. `updatedAt` is the last edit.
- `links` are ids of other entries this one links to (§5.5). A target may be in another journal, or
  in no export at all.

### 5.1 The document

`body` is a ProseMirror document in [TipTap's JSON shape](https://tiptap.dev/docs/editor/api/schema):

```jsonc
{ "type": "doc", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "hello" } ] } ] }
```

A node is `{ type, attrs?, content?, marks?, text? }`. Text nodes carry `text` and optional `marks`.

### 5.2 Standard nodes

These are stock ProseMirror/TipTap and behave exactly as their specifications say:

| Type | Attrs | Notes |
|---|---|---|
| `doc` | — | The root. |
| `paragraph` | — | |
| `heading` | `level` | Levels **1–3** only. |
| `text` | — | Carries `text` and `marks`. |
| `bulletList`, `orderedList`, `listItem` | `start` on `orderedList` | |
| `taskList`, `taskItem` | `checked: boolean` on `taskItem` | Checklists; may nest. |
| `blockquote` | — | |
| `codeBlock` | `language: string \| null` | `null` = auto-detected on display. |
| `horizontalRule` | — | |
| `hardBreak` | — | |
| `table`, `tableRow`, `tableHeader`, `tableCell` | `colspan`, `rowspan`, `colwidth` on cells | Standard prosemirror-tables. |

Marks: `bold`, `italic`, `strike`, `code`, and `link` (`{ href, target, rel }`). Link hrefs are
restricted to `http`, `https`, `mailto`, `tel` plus relative and fragment URLs — an importer should
re-validate rather than trust this.

### 5.3 Math — `inlineMath`, `blockMath`

```jsonc
{ "type": "inlineMath", "attrs": { "latex": "x^2 + y^2" } }
{ "type": "blockMath",  "attrs": { "latex": "\\int_0^1 f(x)\\,dx" } }
```

`latex` is LaTeX source, rendered with [KaTeX](https://katex.org/). `inlineMath` is an inline node;
`blockMath` is a block. Both are atoms — no `content`.

> KaTeX is rendered with `trust: false`, i.e. `\href`, `\url`, `\includegraphics` and the `\html*`
> family are disabled. If you render this LaTeX yourself, do the same: it is arbitrary stored input.

### 5.4 Media — `mediaAttachment`, `mediaGallery`

A single embedded recording, picture or file:

```jsonc
{
  "type": "mediaAttachment",
  "attrs": {
    "id": "a81f…", "kind": "video", "mime": "video/mp4", "bytes": 4718592,
    "durationMs": 18400, "name": "clip.mp4", "width": 1280, "height": 720,
    "createdAt": 1751620800000,
    "transcript": "So we set off early…"
  }
}
```

Consecutive images group into a gallery, whose `images` array holds the same attribute shape:

```jsonc
{ "type": "mediaGallery", "attrs": { "images": [ { "id": "…", "kind": "image", … } ] } }
```

Both are block atoms. **Resolve `attrs.id` against the manifest's `media[]`** to find the file.

Two traps worth naming:

- **`createdAt` inside node attrs is epoch milliseconds (a number)**, not an ISO string. It is the
  raw stored attribute, preserved verbatim so the document round-trips. Everywhere *outside* a
  document — manifest, entry fields — timestamps are ISO strings. The manifest's `media[]` gives you
  the same value as ISO.
- **`transcript` is content.** It is the text of a transcribed recording, it is editable by hand, and
  it survives deletion of the recording itself. Do not treat it as a cache. It is included in an
  entry's plain text for search.

### 5.5 Cross-entry links — `entryLink`

```jsonc
{ "type": "entryLink", "attrs": { "entryId": "7c11…", "label": "the other one" } }
```

An inline atom. `label` is the target's title as of the last render — Mneme re-resolves it live, so
treat it as a display hint, not the truth. The target may not be in this archive (another journal, or
deleted); render a dead reference rather than failing.

### 5.6 Location cards — `locationMap`

A pinned place or a from→to journey, with a **frozen map image**:

```jsonc
{
  "type": "locationMap",
  "attrs": {
    "from":  { "lat": 51.5072, "lng": -0.1276, "label": "London" },
    "to":    { "lat": 48.8566, "lng": 2.3522, "label": "Paris" },   // or null
    "zoom": 13,
    "map":   { "id": "…", "kind": "image", "mime": "image/png", … },   // the snapshot
    "photo": { "id": "…", "kind": "image", … }                          // or null
  }
}
```

`map` and `photo` are media attachments in the §5.4 shape and are exported like any other media. The
map is a raster image composited once, at insert time, from OpenStreetMap tiles — opening the entry
later makes no network request, and there is no live map to reconstruct. `zoom` is the tile zoom
level the snapshot was drawn at.

### 5.7 Video interviews — `videoInterview`

One recorded interview session: a list of questions, each with the clip that answers it, plus an
optionally rendered "film" stitching them together.

```jsonc
{
  "type": "videoInterview",
  "attrs": {
    "sessionId": "…",
    "typeName": "Daily interview",
    "lang": "de",                      // optional — spoken language of the answers
    "cards": [
      { "q": "How did today go?", "clip": { "id": "…", "kind": "video", … },
        "transcript": "It was long.", "dropped": false },
      { "q": "And tomorrow?", "clip": null }        // skipped, or its source clip deleted
    ],
    "film":  { "id": "…", "kind": "video", … },     // or null
    "renderedAt": 1751620800000                      // epoch ms, or null
  }
}
```

- `cards` pairs each question with its answer. `clip: null` means the question was skipped **or** the
  source clip was deleted after the film was rendered — `dropped: true` distinguishes the second
  case, and a surviving `transcript` is also evidence an answer existed.
- A single node can reference up to **seven** media files (six clips plus the film). Walk `cards[].clip`
  **and** `film`; missing one leaves an orphaned file.
- `renderedAt` is epoch ms, like `createdAt` inside documents.

### 5.8 Unknown nodes

Mneme adds node types over time. An importer that meets an unfamiliar `type`:

1. must not throw;
2. should preserve the node verbatim if it can round-trip, or fall back to the entry's `markdown`;
3. should still scan its attrs for anything shaped like a media reference (`{id, kind, mime, …}`) if
   it wants to be sure it has not dropped a file. The manifest's `media[]` is the authoritative list
   of what the archive contains — an importer that walks *that* cannot miss a file, whatever node
   referenced it.

---

## 6. Markdown rendering

`markdown` is a plain Markdown source for the same document. Standard prose — headings, emphasis,
lists, task lists, quotes, fenced code, GFM tables, rules — is ordinary Markdown. Mneme's own nodes
have no Markdown spelling, so they serialize to lossless tokens instead:

| Node | Markdown |
|---|---|
| `inlineMath` | `$latex$` |
| `blockMath` | `$$` on its own line, the LaTeX, `$$` |
| `entryLink` | `[[entryId\|label]]` |
| `mediaAttachment` | a ` ```mneme:media ` fenced block carrying the node's JSON |
| `mediaGallery` | a ` ```mneme:gallery ` fenced block carrying the node's JSON |
| tables with merged or multi-block cells | a ` ```mneme:table ` fenced block carrying the node's JSON |
| `locationMap`, `videoInterview`, and any block node the serializer does not know | a ` ```mneme:node ` fenced block carrying the node's JSON |

The `mneme:node` fence is the catch-all, and it is why `markdown` never silently drops content: a
node with no Markdown spelling is written out as its own JSON rather than skipped. An importer that
only wants prose can strip every ` ```mneme:* ` block. One that wants everything should read `body`
instead — that is what it is for.

---

## 7. Notes for implementers

**Compression.** JSON members are deflated; media members are **stored** (level 0), because video,
audio and JPEG are already compressed and re-deflating them buys a percent for a full second copy in
memory. Any ZIP reader handles both.

**Size.** An archive is as large as the media in it — a journal with video runs to gigabytes. The
writer streams, but a browser still holds the finished archive in memory to hand it to the download.
Stream on the reading side too; do not assume you can `JSON.parse` your way through a whole archive.

**Ids.** Entry and media ids are **random**, deliberately: Mneme's relay sees record ids in
cleartext, so a timestamped or sequential id would leak the writing chronology. Do not infer order
from an id — use `createdAt`. Ids are unique within a vault and stable across devices.

**Re-importing into Mneme** is not yet built (see [ROADMAP.md](./ROADMAP.md)); this format is the
prerequisite for it, and for anyone else's importer. If you write one, the entry's `body` is what to
carry: it holds everything.

**A minimal reader**, in full:

```js
import { unzipSync, strFromU8 } from 'fflate';

const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
const manifest = JSON.parse(strFromU8(files['mneme-export.json']));
if (manifest.format !== 'mneme-journal-export' || manifest.formatVersion !== 1) {
  throw new Error(`unsupported archive: ${manifest.format} v${manifest.formatVersion}`);
}

for (const ref of manifest.entries) {          // already oldest-first
  const entry = JSON.parse(strFromU8(files[ref.path]));
  console.log(entry.createdAt, entry.title);
  console.log(entry.markdown);                 // or walk entry.body
  for (const m of entry.media) {
    const bytes = files[m.path];               // Uint8Array, decrypted
    console.log('  ', m.path, m.mime, bytes.length);
  }
}

for (const gap of manifest.missingMedia) {
  console.warn('not in this archive:', gap.id, 'from entry', gap.entryId);
}
```

---

## 8. Reference implementation

| Where | What |
|---|---|
| `apps/client/src/export/format.ts` | The types in this document, as TypeScript. |
| `apps/client/src/export/journal.ts` | The writer. |
| `apps/client/src/export/collect.ts` | The document walk that finds an entry's media. |
| `apps/client/src/ui/ExportJournal.tsx` | The UI. |
| `apps/client/scripts/export-journal.ts` | The regression check — and the clearest worked example of reading an archive back. |

Run the check with `pnpm --filter client exec tsx scripts/export-journal.ts`.
