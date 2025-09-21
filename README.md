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

<img width="1885" height="1801" alt="image" src="https://github.com/user-attachments/assets/646d3fc7-bac6-4ce1-bd19-0570fe7858ee" />


This frontend is a **full, resilient, browser-only control surface** for three services and an end-to-end voice assistant:

* **LLM / Ollama Relay** (`/api/*`)
* **ASR (speech-to-text)** (`/health`, `/models`, `/recognize`, `/recognize/stream/*`)
* **TTS (text-to-speech)** (`/health`, `/models`, `/speak`, `/models/pull`)
* **Graph/Wiring page:** routes **ASR → LLM → TTS**, streams every hop, and shows live state.

All pages speak to backends over either **HTTP(S)** or **NKN Relay (DM)** and **autosave** their settings and UI state in `localStorage` so your layout and choices survive reloads.

---

## 0) Quick Start

### One Liner Quickstart
```bash
git clone https://github.com/robit-man/voice-llm-interaction-graph.git && cd voice-llm-interaction-graph && python3 -u server.py
```
then ctrl + click the link generated in console, otherwise, proceed with the following command list.

1. **Serve the static files** (any static host works):

   ```bash
   python3 server.py
   ```

   Open `http://localhost:<port>` (default 443).

2. **Pick a transport (top-left Settings):**

   * **HTTP(S) Direct** when the browser can reach the service URL (e.g., `http://127.0.0.1:11434`).
   * **NKN Relay (DM)** when you want to reach a service *through* an NKN relay host.
     Paste the **full NKN address** (including identifier) of your relay.

3. **Save**. All pages remember:

   * transport, base URL, relay address(es), API key / session, and per-page controls.

4. **Check Health / Load Models** to confirm the transport is good.

5. Use either page standalone, or go to **Graph** to wire **Mic → ASR → LLM → TTS** end-to-end.

---

## 1) Transports, Auth & Resilience

### 1.1 Transports

* **HTTP(S) Direct:** normal `fetch` with streaming support (NDJSON, SSE, or raw bytes).
* **NKN Relay:** the UI wraps your request in an NKN DM with `event: "http.request"`.
  Streaming responses are split into **ordered DM “chunks”** (begin/chunk/keepalive/end) and reassembled in order in the browser.

> **Tip:** When using NKN, **Base URL** must be correct **from the relay host’s point of view** (e.g., `http://127.0.0.1:11434` if the relay runs next to Ollama).

### 1.2 Auth

* The UI automatically sets either:

  * `Authorization: Bearer <session_key>` (after a “Handshake → Session”), or
  * `X-API-Key: <your_key>` if provided.
* For **multipart uploads**, we never force `Content-Type` (browser sets boundaries correctly).
* For NKN streaming we set `X-Relay-Stream: chunks` to opt into binary chunking.

### 1.3 Resilience & Backoff

* **NKN MultiClient** with ID (`webui`, `asr-webui`):

  * Exponential reconnect, watchdog pings, stale connections recycle.
  * Ordered chunk assembly and **late chunk grace** to smooth stream tails.
* **HTTP health loops** ping `/api/version` (Ollama) or `/health` (ASR/TTS).
* **Model polls** run in the background with adaptive intervals and retry backoff.

### 1.4 Making NKN the Default Transport

* Each page remembers your last selection. To make NKN “default on first load” you can:

  * Pre-seed localStorage (before first open):

    ```js
    localStorage.setItem('ollama.transport','nkn');
    localStorage.setItem('asr.transport','nkn');
    localStorage.setItem('tts.transport','nkn');
    ```
  * Or in the JS, change the initial `S.transport` default to `'nkn'`.

---

## 2) Page: **Ollama Relay Playground**

A full client for **/api/** with live token streaming and model administration.

### 2.1 Settings

* **Transport, Base URL, Relay NKN Address, API Key**
  Keys saved under:

  * `ollama.transport`, `ollama.base`, `ollama.relayAddr`, `ollama.apiKey`

### 2.2 Inspect

* **GET /api/tags** — models list (auto-populates selectors elsewhere).
* **GET /api/ps**, **GET /api/version**

### 2.3 Generate (POST /api/generate)

* **Stream true/false**. When `true`, prints **NDJSON** deltas live.
* Optional **format** (`"json"` or JSON schema) and **options** (JSON).
* Output panel scrolls and appends in real time.

### 2.4 Chat (POST /api/chat)

* **Model selector** is auto-populated from `/api/tags`.
* **Sessions per model** are stored under `ollama.chat.v1`:

  * New/Rename/Delete, **Download JSON** of messages, **Upload** messages.
* **Streaming** prints assistant tokens **as they arrive** (both HTTP & NKN).
  UI uses an “in-flight assistant bubble” that grows with each token, then persists to session.

### 2.5 Model Admin

* **Create / Show / Copy / Delete / Pull / Push**, each wired to the corresponding `/api/*` endpoint and with streaming log panels for long operations.

### 2.6 Embeddings

* Modern `/api/embed` and legacy `/api/embeddings`.

### 2.7 Blobs

* **HEAD /api/blobs/\:digest** and **POST** file uploads (HTTP preferred for big files).
  When on NKN, large files are prevented by design.

### 2.8 Status/Logs

* Top-right **status badge** switches colors and messages (OK/Warn/Error).
* **Status / Logs** card shows recent activity.

---

## 3) Page: **ASR Service**

Minimal UI for **file transcription** and **live mic streaming** with on-screen partial/final captions.

### 3.1 Settings

* **Transport, Base URL, Relay, API Key** saved under:

  * `asr.transport`, `asr.base`, `asr.relayAddr`, `asr.apiKey`
* Optional **Handshake → Session** (saves `asr.sessionKey`, `asr.sessionExp`).

### 3.2 Models & Health

* **/health** shows service status.
* **/models** autocompletes `Use Model` (e.g., `base`, `small`, `large-v3`).

### 3.3 File Transcription

* Pick an audio file, optional **format** & **sample rate** hints, and an optional **prompt** to bias decoding.
* For HTTP: multipart upload to `/recognize`.
* For NKN: JSON with `{body_b64, format?, sample_rate?, prompt?}` to `/recognize`.
* UI prints:

  * **Text** (flattened transcript),
  * **JSON** (full result with segments),
  * **Log** of the request/response.

### 3.4 Live Mic → ASR

* Controls: **target sample rate**, **stream chunk size**, optional **prompt**.
* Start:

  * Begins an ASR **session** (`/recognize/stream/start`), shows **Session** indicator.
  * WebAudio **RMS VU meter** animates live.
  * PCM16LE frames are posted to `/recognize/stream/:sid/audio?format=pcm16&sr=…` as the buffer fills.
* **Events stream** (HTTP SSE or NKN chunked):

  * **Partial** captions update in the **left bubble** (`livePartial`).
  * **Final** utterances append to the **right column** (`finalList`) as separate bubbles.
  * Errors also print to the log panel.
* Stop:

  * Sends `/recognize/stream/:sid/end`, closes event stream, clears buffers.

> The **Graph** page adds **ASR VAD gates** and **finalization thresholds** (RMS/timeout) for when to cut and pass text onward.

---

## 4) Page: **TTS Service**

Generate audio **to a file**, **stream live to the browser** (raw PCM), or **play on server**.

### 4.1 Settings

* Stored under: `tts.transport`, `tts.base`, `tts.relayAddr`, `tts.apiKey` (+ session if handshaken).

### 4.2 Models

* **/models** populates the datalist for `Use Model`.
* **Pull Voice** downloads an ONNX + JSON combo into the server’s `./voices`.

### 4.3 Generate → File

* **/speak** with `mode: "file"`; after JSON returns the file URL, the UI **fetches the blob** and shows:

  * `<audio>` player,
  * download link,
  * mime/size metadata.
* Works via **HTTP** or **NKN** (the latter streams the bytes as ordered DMs and reassembles).

### 4.4 Stream → Browser (Live)

* **/speak** with `mode: "stream"`, **format: "raw"** (PCM16 mono 22.05k).
* HTTP: reads `ReadableStream` bytes and feeds a **ScriptProcessorNode** ring buffer.
* NKN: receives chunked DMs, reorders, and feeds the same ring buffer.
* The page shows:

  * **AudioContext sample rate**, **buffered sample count** (live),
  * a **log panel** for stream begin/end/errors.
* **Stop** aborts the fetch and clears audio buffers.

### 4.5 Play on Server

* **/speak** with `mode: "play"`; server plays via `aplay/ffplay`.

---

## 5) Page: **Graph / Wiring (ASR → LLM → TTS)**

A visual “patch bay” that connects sources and sinks. The default recipe is:

```
Mic → ASR (partial/final) → LLM (prompted chat) → TTS → Speakers
```

### 5.1 What it Guarantees

* **NKN routing option is the default** once saved — and the graph will honor the same transport/auth for **all endpoints** (ASR, LLM, TTS).
  Use the Settings panel to select **NKN**, Save once; it persists across reloads.
* **Parallel relay strategy (NKN):** when configured with multiple relay addresses, the client can DM **up to 3 relays in parallel**:

  * **Requests fan-out** to all configured relays.
  * **First valid response wins**; for streams, chunks are deduped and merged in order.
  * Health pings & stale detection recycle unhealthy paths.

> If you run a single relay, just use one address. If you run 2–3 for redundancy, paste them all.

### 5.2 Controls & Persistence

* **Wire Mode** toggle: on → endpoint cards become “nodes” you can wire.

  * The connection set is saved to `localStorage` and restored on reload.
* **ASR Thresholds:** set **RMS gate** and **max silence timeout** to decide *when* to finalize utterances:

  * RMS below gate for `N ms` ⇒ cut turn and emit **final** text downstream.
  * All values auto-save.
* **Model selectors** for ASR / LLM / TTS **auto-populate** from their `/models` or `/api/tags` and are saved.
* **System & prompt templates** for LLM are saved; you can inject the final transcript into the prompt via `${text}` or `${transcript}` in the Graph settings.
* **Live state panes**:

  * **ASR**: live VU, partial caption (left), final list (right).
  * **LLM**: **streaming tokens** are appended to a growing bubble, then committed.
  * **TTS**: raw PCM **queues and plays live**; shows queued samples.

### 5.3 How Data Flows

1. **Mic → ASR**
   PCM16 chunks posted at fixed cadence. SSE/NKN events deliver:

   * `asr.partial` → updates “Partial” bubble.
   * `asr.final` → appended to “Final” list **and** enqueued into the **LLM**.

2. **ASR Final → LLM**
   The final utterance gets templated into your **LLM messages**:

   * Prepend optional **system** message.
   * Append **user** message with the transcript text.
   * **stream\:true** so NDJSON deltas arrive line by line.
   * The UI prints each **delta token** as it arrives; the message is then saved to the current **LLM session**.

3. **LLM → TTS**
   After the assistant completes (or on partials, if “speak while streaming” is on):

   * Text is sent to **/speak** with `mode:"stream"`, and **audio plays** immediately in the browser.
   * If you prefer: `mode:"file"` (batch playback after full render) is also supported.

4. **Status/Recovery**

   * Any transport error prints to the node’s **log panel**.
   * NKN stale: auto recycle with exponential backoff.
   * Model lists refresh in the background; selectors keep your previous choice if still present.

### 5.4 Useful Variants

* **Barge-in:** if a new ASR final arrives while TTS is playing, stop the current stream and start the new answer.
* **Hands-free (VAD gate):** RMS gate + silence timeout ⇒ auto turn taking.
* **Token-sync speech:** option to begin TTS after the first *N* tokens (reduces latency further).

---

## 6) LocalStorage Map (what gets saved)

* **Ollama:**
  `ollama.transport`, `ollama.base`, `ollama.relayAddr`, `ollama.apiKey`, `ollama.chat.v1` (per-model sessions)
* **ASR:**
  `asr.transport`, `asr.base`, `asr.relayAddr`, `asr.apiKey`, `asr.sessionKey`, `asr.sessionExp`
* **TTS:**
  `tts.transport`, `tts.base`, `tts.relayAddr`, `tts.apiKey`, `tts.sessionKey`, `tts.sessionExp`
* **Graph:**
  `graph.transport`, `graph.base.*` (per service), `graph.relayAddrs` (array),
  `graph.wires.v1` (connections), `graph.asr.thresholds`,
  `graph.llm.model`, `graph.llm.system`, `graph.llm.stream`,
  `graph.tts.model`, `graph.tts.mode`, `graph.tts.volume`, etc.

> Names may differ slightly by build; keys are simple strings and safe to inspect/clear in DevTools.

---

## 7) Streaming Protocols & Parsers (under the hood)

* **LLM**: NDJSON lines (`{"message":{"content":"..."}}`, `{"response":"..."}`, `{"done":true}`)
  The UI strips known end-of-turn tokens (e.g., `</s>`) from deltas.
* **ASR**: SSE events over HTTP (`event: asr.partial / asr.final`) or JSON lines chunked via NKN.
  Parser collects `data:` blocks until blank line, then `JSON.parse`.
* **TTS**: Raw **PCM16LE mono 22.05kHz** audio frames streamed over HTTP or chunked via NKN.
  Browser combines bytes, converts to Float32, resamples if needed, then writes to a ScriptProcessor queue.

---

## 8) Health, Debugging & Recovery

* **Status badge** (top right) flips colors (OK/Warn/Error). Hovering is not required — messages are printed inline.
* Each long operation (model pull/push/create, streaming) has a **log panel**.
* **Network online/offline** events trigger toasts & gentle refresh.
* **Visibility change** (tab hidden/shown) debounces background polling.

---

## 9) Security & CORS

* When using **HTTP(S)**:

  * If the service is on a different origin, enable CORS for the static host origin or use a reverse proxy.
* When using **NKN**, the browser never hits the service directly — your relay does; set **Base URL** for the relay’s local network view.

---

## 10) Extending

* **Add a new endpoint**: copy one of the transport-aware helpers (`getJSON`, `callJSON`, `postBytes`, or `nknFetchJSON`) and wire a button/handler.
* **Add a new node in Graph**: define the node’s inputs/outputs, UI panel, and register a small adapter that:

  1. translates inbound messages to the node’s request,
  2. starts its stream,
  3. forwards deltas or finals downstream, and
  4. updates the node’s display/log.

---

## 11) FAQ

**Q: I switched transports and nothing happened.**
A: Click **Save**. The choice is persisted and immediately applied; background loops restart.

**Q: Model lists are empty.**
A: Check **Health** and **/models** or **/api/tags** in the Inspect panel. On NKN, ensure the **Base URL** is reachable from the relay host.

**Q: ASR partials show, but no finals.**
A: Increase the **silence timeout** or raise the **RMS gate** so the ASR knows when to cut.

**Q: TTS stutters on low-power devices.**
A: That’s the WebAudio callback starving — reduce `stream chunk` sizes upstream or start speaking after a small prebuffer (Graph option).

**Q: How do I force NKN on first boot?**
A: Pre-seed `localStorage` keys (see §1.4) or set the JS defaults to `'nkn'` before shipping.

---

## 12) Known Good Versions

* **nkn-sdk** browser build: `1.3.6` (pinned in the HTML)
* Browsers: recent **Chromium/Firefox** (WebAudio + Streams supported)

---

## 13) Minimal End-to-End Checklist (Voice Assistant)

1. Open **ASR**, **TTS**, **Ollama** pages once to **Save** base URLs/relays and confirm **Health**.
2. In **Graph**:

   * Transport = **NKN** (or HTTP if local), Save.
   * Pick **ASR model**, **LLM model** (auto-filled), **TTS voice** (auto-filled).
   * Set **RMS gate** and **silence** (start with gate `0.02`, silence `650 ms`).
   * Turn **Wire Mode** on; ensure the default path is **Mic → ASR → LLM → TTS**.
3. Click **Start** (Mic permission is requested once).
4. **Speak** → see **Partial** on left, **Final** on right, **LLM tokens** stream in the middle, **TTS** plays live.
5. Click **Stop** to end the session.
