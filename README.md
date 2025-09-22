# ASR ↔ LLM ↔ TTS Playground (HTTP or NKN Relay)

<p align="center">
  <a target="_blank" href="https://github.com/robit-man/piper-tts-service">
    <img alt="piper-tts-service" src="https://img.shields.io/badge/piper--tts--service-OPEN%20ON%20GITHUB-000?style=for-the-badge&logo=github">
  </a>
  <a target="_blank" href="https://github.com/robit-man/ollama-nkn-relay">
    <img alt="ollama-nkn-relay" src="https://img.shields.io/badge/ollama--nkn--relay-OPEN%20ON%20GITHUB-000?style=for-the-badge&logo=github">
  </a>
  <a target="_blank" href="https://github.com/robit-man/whisper-asr-service">
    <img alt="whisper-asr-service" src="https://img.shields.io/badge/whisper--asr--service-OPEN%20ON%20GITHUB-000?style=for-the-badge&logo=github">
  </a>
</p>

<img width="1754" height="1267" alt="image" src="https://github.com/user-attachments/assets/321f08fc-5fe9-4f26-9a62-cf3fb3e4ea77" />

A lightweight, browser-first visual editor for wiring realtime speech + language + speech pipelines. Drag nodes, connect ports with SVG splines, stream delta tokens sentence-by-sentence to TTS, and persist your graph to LocalStorage. Works with direct HTTP backends or NKN relays.

---

## ✨ Features

- **Visual graph editor**
  - Drag nodes on a snap grid, draw cubic-bezier wires between ports.
  - Click-click linking *and* drag-to-connect with **retarget** support.
  - One incoming link per input (exclusive); outputs can **fan-out** to many inputs.
  - Alt/Ctrl/Meta-click on ports or wires to **disconnect**, or double-click a wire to delete.
  - Import/Export your entire workspace as JSON.

- **Three built-in node types**
  - **ASR** (Speech-to-Text) → outputs: `partial`, `phrase`, `final`
  - **LLM** (Chat/Reasoning) → inputs: `prompt`, `system`; outputs: `delta`, `final`, `memory`
  - **TTS** (Text-to-Speech) → input: `text`; modes: `stream` (raw PCM) or `file` (OGG)

- **Streaming you can hear**
  - **LLM delta streaming is sentence-aware.** Partial tokens are buffered and flushed at end-of-sentence delimiters (`.?!` / newlines), so **TTS speaks coherent sentences**, not choppy word-by-word.
  - Robust **frame ordering** over NKN: chunks carry sequence numbers and are reassembled in order.

- **Per-node dynamic settings**
  - Compact modal builds form fields from each node type’s schema.
  - Values persist in `LocalStorage` (via `NodeStore`) and export cleanly.

- **Transport flexibility**
  - Direct `fetch()` over HTTP(S), or **NKN relay** streaming (`CFG.transport==='nkn'`).
  - NDJSON chat streaming for LLM, raw 16-bit PCM streaming for TTS.

- **Audio pipeline**
  - Low-latency `ScriptProcessorNode` queue with underrun protection, preroll/spacer frames, and **linear resampling** to the AudioContext rate.

---

## 🧭 Quick Start

1. **Serve the app** with any static server (e.g. `vite`, `webpack dev server`, `python -m http.server`).  
   If you serve over **https**, make sure your backends are also **https** (or use a same-origin proxy).

2. **Configure backends** in the node settings:
   - **LLM** must expose `POST /api/chat` (see API contracts below).
   - **TTS** must expose `POST /speak`.
   - (Optional) **ASR** endpoint for your STT service.

3. **Open the graph editor**:
   - Use the toolbar buttons: **Add ASR**, **Add LLM**, **Add TTS**.
   - Wire **ASR.final → LLM.prompt → TTS.text** for a voice assistant.
   - Click ⚙ on any node to set `base`, `api`, `model`, etc.
   - Press ▶ on an **ASR** node to acquire the mic for that node.

4. **Talk!**  
   Watch **LLM.delta** update while TTS speaks **sentence by sentence**.

---

## 🖱️ Graph Editor Primer

### Ports & Wires
- **Click-click**: Click an **output** port to select it, then click an **input** to connect.
- **Drag-from port**:
  - Drag from an **output** to an **input** to create a link.
  - Drag from an **input** (that already has a wire) to **retarget** it to a different output.
- **Retarget existing wire**: Drag either end to a new port; ordering and exclusivity rules are enforced.
- **Disconnect**
  - Alt/Ctrl/Meta-click a **port** to delete all wires attached to that port.
  - Alt/Ctrl/Meta-click a **wire** (or double-click) to delete just that wire.
- **Cancel**: `Esc` or click on empty workspace/SVG to cancel an in-progress link/drag.

### Rules
- **Inputs are exclusive** (one incoming wire max). Creating a new link to an input replaces the old one.
- **Outputs fan-out** (one output may drive many inputs).
- **No self-links** (node → same node).

### Persistence
- Graph state is saved under `LS.set('graph.workspace', ...)`:
  ```json
  {
    "nodes": [{ "id": "nabc123", "type": "LLM", "x": 380, "y": 180 }],
    "links": [{ "from": {"node":"nasr","port":"final"}, "to": {"node":"nllm","port":"prompt"} }],
    "nodeConfigs": {
      "nllm": { "type":"LLM", "config": { "base":"http://127.0.0.1:11434", "model":"llama3", "stream": true } }
    }
  }
````

* **Export**/**Import** from the toolbar to move graphs between machines.

---

## 🔌 Dataflow & Router

The app uses a small `Router` to connect publishers to subscribers:

* **Wire keys** are strings:
  `from:  "<nodeId>:out:<portName>"`
  `to:    "<nodeId>:in:<portName>"`
* Graph changes call `Router.render()` with `Router.wires = [ {from, to}, ... ]`.
* Nodes **register** inputs:

  ```js
  Router.register(`${node.id}:in:prompt`, someElement, (payload) => LLM.onPrompt(node.id, payload));
  ```
* Nodes **emit** outputs:

  ```js
  Router.sendFrom(nodeId, 'delta', { nodeId, type: 'text', text: chunk });
  Router.sendFrom(nodeId, 'final', { nodeId, text: sentence, eos: true });
  ```

This indirection lets you add new node types and wire them without coupling.

---

## 🧩 Node Types & Settings

All settings UIs are generated from the **schema** entries defined in `TYPES`.

### ASR (Speech-to-Text)

* **Outputs**: `partial`, `phrase`, `final`
* **Key settings**

  | Key                                                | Description                                             |
  | -------------------------------------------------- | ------------------------------------------------------- |
  | `base`                                             | Base URL of ASR service (e.g., `http://localhost:8126`) |
  | `relay`                                            | NKN relay address (optional)                            |
  | `api`                                              | API key/header (optional)                               |
  | `model`                                            | Model or preset (`base/small/medium/large-v3`)          |
  | `mode`                                             | `fast` or `accurate`                                    |
  | `rate`, `chunk`, `live`                            | Audio capture params                                    |
  | `rms`, `hold`, `emaMs`                             | VAD parameters                                          |
  | `phraseOn`, `phraseMin`, `phraseStable`, `silence` | Phrase detection                                        |
  | `prevWin`, `prevStep`, `prevModel`                 | Preview streaming hints                                 |
  | `prompt`                                           | Biasing prompt for decoding                             |

> The ASR node shows a VU bar, a ▶/■ button to own/release the mic, and scroll areas for `partial` & `final` text.

### LLM (Chat / Reasoning)

* **Inputs**: `prompt`, `system`
* **Outputs**: `delta`, `final`, `memory`
* **Key settings**

  | Key             | Description                                              |
  | --------------- | -------------------------------------------------------- |
  | `base`          | Base URL of LLM service (e.g., `http://127.0.0.1:11434`) |
  | `relay`         | NKN relay (optional)                                     |
  | `api`           | API key/header (optional)                                |
  | `model`         | Model name (e.g., `llama3`, `gpt-…`)                     |
  | `stream`        | `true` to enable NDJSON streaming                        |
  | `useSystem`     | Include a system message in prompts                      |
  | `system`        | System prompt text                                       |
  | `memoryOn`      | Keep chat memory per node                                |
  | `persistMemory` | Persist memory to storage                                |
  | `maxTurns`      | Cap on remembered user turns                             |

#### How streaming works (LLM)

* **Direct HTTP**: `POST /api/chat` returns `application/x-ndjson`, lines like:

  ```json
  {"delta":" Hel"}
  {"delta":"lo"}
  {"done":true,"final":"Hello."}
  ```
* **NKN**: same payload, but lines can arrive **out of order**; each NDJSON line is tagged with a sequence number by the relay. The LLM client uses `expected/seq/stash` to restore order before parsing NDJSON.
* **Sentence Mux**: token deltas are buffered until an end-of-sentence delimiter is seen, then **a complete sentence** is emitted via:

  * `Router.sendFrom(nodeId, 'final', { nodeId, text: sentence, eos: true })`
  * Optionally, a **delta mirror** of the same sentence is emitted on `delta` to keep old listeners happy.

> Result: TTS receives **full sentences**, not distracting word-by-word fragments.

#### Memory

When `memoryOn` is enabled:

* Sliding window of up to `maxTurns` user messages (and their following assistant replies) is kept.
* Optional system message is preserved at position 0.
* After each completion, memory is updated and emitted on `memory` (`{type:'updated', size:n}`).

### TTS (Text-to-Speech)

* **Input**: `text`
* **Modes**: `stream` (default), `file` (`audio/ogg`)
* **Key settings**

  | Key     | Description                                        |
  | ------- | -------------------------------------------------- |
  | `base`  | Base URL (e.g., `http://localhost:8123`)           |
  | `relay` | NKN relay (optional)                               |
  | `api`   | API key/header (optional)                          |
  | `model` | Voice/Model (`glados_piper_medium` or a file name) |
  | `mode`  | `stream` or `file`                                 |

#### How streaming works (TTS)

* **Streaming** expects raw **16-bit signed PCM little-endian** at **22,050 Hz** chunks from `POST /speak`:

  * Direct HTTP: reads `ReadableStream` bytes, handles odd-length boundaries with a carry-over buffer.
  * NKN: chunks can arrive out of order; the TTS client reorders by `seq`, then decodes to `Int16`, converts to `Float32`, **resamples** if needed, and enqueues to the audio ring buffer.
* The TTS node inserts a **tiny preroll** (\~40ms) and **spacer** (\~30ms) between sentences to keep timing natural.
* **File** mode fetches an OGG blob and plays it in an `<audio>` element injected into the node body.

---

## 🛠️ Backend API Contracts

These are reference contracts; adjust to your server as needed.

### `POST /api/chat` (LLM)

* **Headers**

  * `Accept: application/x-ndjson` (for `stream:true`)
  * `Content-Type: application/json`
  * `Authorization: Bearer <api>` (optional)
* **Request**

  ```json
  {
    "model": "llama3",
    "messages": [
      {"role":"system", "content":"You are helpful."},
      {"role":"user", "content":"Say hello."}
    ],
    "stream": true
  }
  ```
* **NDJSON Stream**

  * Token deltas as `{"delta":" ..."}` or provider-specific shapes that include `message.content`.
  * Final line may include `{"done":true,"final":"..."}`
* **Non-streaming**

  ```json
  { "message": { "content": "Hello." } }
  ```

### `POST /speak` (TTS)

* **Streaming (raw PCM)**

  * **Request**: `{"text":"Hello world.","mode":"stream","format":"raw","model":"..." }`
  * **Response body**: a raw byte stream of **s16le @ 22050Hz** split into arbitrary chunk sizes. (Over NKN, chunks are relayed with sequence numbers.)
* **File (OGG)**

  * **Request**: `{"text":"Hello world.","mode":"file","format":"ogg","model":"..."}`
  * **Response (either)**:

    * `{ "files":[{"url":"/files/abc.ogg"}] }` (server-hosted)
      → client fetches `base + url` as blob
    * `{ "audio_b64": "<base64>" }` (inlined)

> Make sure your server sends the appropriate **CORS** headers if accessed cross-origin (see Troubleshooting).

---

## 🔐 CORS, HTTPS & NKN

* If your app is served over **HTTPS**, browsers will **block HTTP** calls to backends (mixed content). Use **HTTPS** backends or a same-origin reverse proxy.
* Cross-origin backends must respond to **preflight (OPTIONS)** and include:

  ```
  Access-Control-Allow-Origin: https://your-app-origin
  Access-Control-Allow-Methods: POST, OPTIONS
  Access-Control-Allow-Headers: Content-Type, Authorization, Accept, X-Relay-Stream
  ```
* **NKN** transport (`CFG.transport === 'nkn'`) tunnels requests/responses. The client attaches `X-Relay-Stream: chunks` for chunked streams and uses per-chunk **sequence numbers** to reconstruct order before decoding.

---

## 🧪 Common Flows

### Voice Assistant (ASR → LLM → TTS)

1. Add **ASR**, **LLM**, **TTS** nodes.
2. Wire: `ASR.final → LLM.prompt → TTS.text`.
3. Configure **LLM** base/model, **TTS** base/model.
4. Press **▶** on the ASR node to start the mic.
5. Speak; you’ll hear sentence-by-sentence TTS responses.

### Text Chat to TTS

* Wire `LLM.final → TTS.text`.
* Send a synthetic `prompt` into the LLM input via your own node or a test harness; the TTS will speak each sentence.

---

## ⚙️ Developer Notes

### File/Module Highlights

* `Graph` — workspace state (`WS`), node DOM, spline wires, linking logic, import/export, persistence.
* `TYPES` — node registry & **form schema** (drives settings modal).
* `Router` — little event bus binding `from` → `to` across wires.
* `NodeStore` — per-node config persistence (loads/saves objects keyed by node id).
* `ASR`, `LLM`, `TTS` — runtime modules that interface with your backends.

### Adding a New Node Type

1. Add an entry in `TYPES`:

   ```js
   TYPES.MyNode = {
     title: 'MyNode',
     inputs: [{name:'inA'}],
     outputs: [{name:'outB'}],
     schema: [{key:'base', label:'Base URL', type:'text'}]
   }
   ```
2. In `makeNodeEl`, inputs call `Router.register(...)` with your handler.
3. Emit with `Router.sendFrom(nodeId, 'outB', payload)`.
4. Persist optional config via `NodeStore.ensure/update/load`.

---

## 🧹 Text Sanitization (TTS)

Before sending text to your TTS, the app:

* Normalizes (`NFKC`), unifies quotes, strips URLs/markdown, compresses whitespace.
* Collapses ellipses to a single period, trims punctuation spacing.
* Purpose: produce **cleaner prosody** across TTS engines.

---

## 🔊 Audio Pipeline Details

* `AudioContext` + `ScriptProcessorNode(4096,1,1)` for simplicity and wide compatibility.
* Queue of `Float32Array` buffers (range `[-1,1]`).
* Converts `Int16LE` → `Float32` and **linearly resamples** if server != device rate.
* Tracks `underruns` for debugging; adds a tiny **preroll** and **inter-sentence spacer**.

---

## 🩹 Troubleshooting

### “Failed to fetch” (LLM or TTS)

* Usually **network/CORS/mixed content** rather than a 4xx/5xx. Check:

  * `CFG.<node>.base` includes protocol (`http://` or `https://`).
  * If your page is **https**, **don’t** call a `http://` backend.
  * Server exposes `POST /api/chat` and/or `POST /speak`.
  * CORS headers for **OPTIONS** + **POST** include your app’s origin.
  * For NKN, ensure the relay address is reachable and `CFG.transport==='nkn'`.

### No audio or choppy audio

* TTS server must send **16-bit little-endian PCM** at **22,050 Hz** for streaming mode.
* If you switch models mid-stream, flush or pause TTS to avoid mixed sample rates.
* Look at `underruns` in logs; increase preroll time or ensure the backend latency is stable.

### Sentences arriving out of order

* Ensure you’re using the built-in LLM/TTS NKN paths. They already **reorder by sequence** with `expected/stash/seen`.
* If you’ve written a custom relay, attach a monotonically increasing `seq` to each chunk/line.

---

## 🧰 Keyboard & Mouse Cheatsheet

* **Linking**: Click output → click input (or drag between ports).
* **Retarget wire**: Drag an existing wire end to a different compatible port.
* **Delete wire**: Double-click a wire, or Alt/Ctrl/Meta-click it.
* **Disconnect a port**: Alt/Ctrl/Meta-click the port.
* **Cancel**: `Esc`, or click empty workspace/SVG.
* **Move node**: Drag the header (snaps to 14px grid).

---

## 📦 Import / Export Format

Use the toolbar to export or import `realtime-graph.json`. It contains:

* Node layout (`id`, `type`, `x`, `y`)
* Links (`from`, `to`)
* Per-node configs (`nodeConfigs[id] = { type, config }`)

> Import replaces your current graph; export is a straightforward JSON dump.
