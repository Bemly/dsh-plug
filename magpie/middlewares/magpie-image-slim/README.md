# magpie-image-slim

A Magpie gateway middleware that replaces **historical inline images** with a tiny
standard placeholder, so a long conversation keeps its prompt cache instead of
re-sending every image on every turn.

Works with any agent Magpie proxies (tested on DSH + agy-cli/Gemini). One block in,
one block out — the message never changes shape.

---

## Why this exists

Every turn re-sends the whole conversation. Any image still sitting in the history
is re-encoded and re-billed on every request. The obvious fix — swap old images for a
short marker — breaks in a non-obvious way once an agy-cli bridge is in the middle.

`agy-cli` keeps a live provider session and decides whether the client's history still
matches what it last sent. If it does not, the bridge **rebuilds the session**
(`session_new`) and the prompt cache is gone. Its comparison is
`sameHistoryUpToImages()`:

```js
function sameHistoryUpToImages(expected, actual) {
  if (expected.length !== actual.length) return false
  // 1. every message must carry the SAME NUMBER of image slots
  if (expected.some((m, i) => imageSlots(m) !== imageSlots(actual[i]))) return false
  // 2. drop every image slot entirely, then compare what is left
  return historyKey(withoutImages(expected)) === historyKey(withoutImages(actual))
}
```

Two consequences drive this middleware's whole design:

1. **A slot must stay a slot.** `imageSlots()` counts a block as one slot when it is
   either a real `image` block **or** a text block matching the standard pattern
   `[<n> MB image left out here: …]`. Replace an image with `[image]` — or delete it
   outright — and the count drops from 1 to 0. That reads as *the user removed an
   image*, the bridge rebuilds, and the whole prompt is recomputed.
2. **The placeholder body is never compared.** `withoutImages()` deletes the slot
   before comparing, so anything written after the colon is irrelevant. Keep it short.

Measured on the same conversation, same model, image moved from "current turn" to
"history" on the next turn:

| placeholder body | cache_read on the turn after the image | agy session |
|---|---|---|
| `[image]` | **0** (full recompute) | `session_new: history_mismatch` |
| `[0.34 MB image left out here: ）]` | **92.7%** | reused, no rebuild |

That is the entire reason this package emits the long, ugly, standard form.

---

## What it does

For each historical user message that qualifies, every `input_image` block is replaced
by **one** `input_text` block. Historical tool results (`function_call_output` and
`custom_tool_call_output`) are handled the same way, so `read_image` results do not
keep re-sending full images in later turns:

```
[0.34 MB image left out here: ）]
```

— 32 characters, in the standard `image-slim` shape. Block count is unchanged, message
count is unchanged, and the image slot count is unchanged, so the provider session
survives and the prefix cache keeps hitting.

A message qualifies when it contains either:

| Format | Produced by |
|---|---|
| `[<n> MB image left out here: …]` | this middleware (idempotent — already-slimmed text is left alone) |
| `Image "<name>" (sha256:…) … Normalized copy (read-only…): "<path>"` | DSH host (`dsh-llm-pi-ai`'s `requestImageHandleText`) |

The DSH handle text is kept **verbatim** and always precedes the image it describes, so
the model still receives the local `Normalized copy` path every turn and can call
`read_image` on demand. The path is deliberately *not* repeated inside the placeholder.

Images in the current turn are left untouched by default (`keepCurrentTurn`), so the
model sees a freshly sent picture at full fidelity.

---

## Options

Set via Magpie's plugin options (`magpie plugin options magpie-image-slim '<json>'`)
or `ctx.options` in a hook config.

| Option | Default | Meaning |
|---|---|---|
| `agents` | `["dsh"]` | Only touch requests from these agents. Empty array = all. |
| `models` | `[]` | Only touch these models. Empty = all. |
| `keepCurrentTurn` | `true` | Leave the current turn's images intact. Disable to slim everything and get a perfectly stable prefix (the model must then `read_image`). |
| `replaceImages` | `true` | Master switch for the replacement itself. |
| `splitPlaceholders` | `false` | Opt-in: rewrite a text block that *contains* placeholders inline into separate blocks. Off by default because it changes block counts. |
| `log` | `true` | Log one line per request that changed something. |

Default options as shipped:

```json
{
  "agents": ["dsh"],
  "models": [],
  "keepCurrentTurn": true,
  "replaceImages": true,
  "splitPlaceholders": false,
  "log": true
}
```

---

## Install

Through Magpie:

```bash
magpie plugin add magpie-image-slim
```

Through npm (for a local hook or a bundled gateway):

```bash
npm install magpie-image-slim
```

Then reference `image-slim.middleware.js` from your Magpie middleware list, or let
`magpie plugin add` wire it up through the `magpie.middleware` field in `package.json`.

---

## Verifying it works

Each request that changed something logs one line:

```
image-slim v0.1.7: [dsh] replaced 1 image(s), split 0 text block(s)
```

`split 0` is expected — splitting is off by default and would break the block count.

To confirm the cache is actually being reused, look at the provider's usage report for
the turn **after** an image becomes history. `cache_read / context` should be high
(measured 88–93% on Gemini via agy-cli), and the bridge log must **not** show a
`session_new` with `reason=history_mismatch` for that turn.

---

## Design notes

- **One block in, one block out.** Never add, remove, or reorder blocks. A changed block
  count is indistinguishable from a changed conversation.
- **Never invent a shorter marker.** `[image]`, `[IMG]`, `[图片]` all fail
  `isImagePlaceholder()` and will silently cost you a full-context recompute on every
  turn. The regex is strict on purpose; match it exactly.
- **Never edit history.** This middleware only rewrites the outgoing request body. The
  stored session keeps its `image` blocks, which is why the DSH handle text (and the
  path inside it) can be regenerated on every turn.
- **The placeholder is not for the model.** Its only job is to occupy the image slot so
  the session is not rebuilt. What the model actually needs — the local path — comes
  from the DSH handle text sitting immediately before it.

---

## Compatibility

- Magpie gateway, `responses`-shaped requests (`body.input[]`).
- DSH (`dsh-llm-pi-ai` images, `Normalized copy` handle text).
- agy-cli bridge ≥ 0.1.132 (the version whose `isImagePlaceholder()` /
  `sameHistoryUpToImages()` this middleware is built against).
- Any other agent works too, as long as its images arrive as `input_image` blocks and
  the message carries either of the two recognized texts.

## License

MIT
