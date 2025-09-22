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

<img width="2665" height="1523" alt="image" src="https://github.com/user-attachments/assets/12578329-a3d5-4b00-b519-beeade881ef5" />

## Features

* **Visual graph editor**

  * Drag nodes on a snap grid; links are smooth SVG splines.
  * Click-to-connect, drag-to-connect, and **retarget** existing wires by dragging either end.
  * Inputs are **exclusive** (one incoming wire). Outputs **fan-out** (one output to many inputs).
  * Alt/Ctrl/Meta-click a port to disconnect; Alt/Ctrl/Meta-click or double-click a wire to delete.
  * Import/Export the entire workspace JSON.

* **Node types**

  * **ASR** (Speech-to-Text): outputs `partial`, `phrase`, `final`.
  * **LLM** (Chat/Reasoning): inputs `prompt`, `system`; outputs `delta`, `final`, `memory`.
  * **TTS** (Text-to-Speech): input `text`; modes `stream` (raw PCM) or `file` (OGG).

* **Streaming designed for speech**

  * **Sentence-aware LLM delta**: token deltas are buffered and flushed at end-of-sentence delimiters (`.?!` / newlines) so TTS speaks coherent sentences.
  * **Reliable ordering** over NKN: both NDJSON text chunks and TTS audio frames are reassembled using sequence numbers (`expected / seen / stash`) to prevent out-of-order playback.

* **Dynamic per-node settings**

  * Settings modals are generated from schemas and persisted (via `NodeStore`) to LocalStorage.
  * Works with direct HTTP and NKN transports (toggle via `CFG.transport`).

* **Audio pipeline**

  * `AudioContext` + `ScriptProcessorNode` queue, underrun protection, preroll and inter-sentence spacers, linear resampling to device rate.

---

## Quick Start

1. Serve the app with any static server (e.g., `vite`, `webpack`, `python -m http.server`). If the page is HTTPS, use HTTPS backends or a same-origin proxy.
2. Add nodes via the toolbar: **ASR**, **LLM**, **TTS**.
3. Wire: `ASR.final → LLM.prompt → TTS.text`.
4. Open ⚙ on nodes to set `base`, `api`, `model`, etc.
5. Press ▶ on an ASR node to acquire the mic and speak. You should hear sentence-by-sentence TTS.

---

## Graph Editor

* **Make links**

  * Click output → click input.
  * Drag from an output to an input.
  * Drag from a connected input to another output (**retarget**).
* **Rules**

  * One incoming wire per input (new links replace the old one).
  * Outputs may feed multiple inputs.
  * Self-links are disallowed.
* **Cancel**

  * `Esc`, or click empty workspace/SVG.
* **Persistence**

  * Saved automatically to LocalStorage (`LS.set('graph.workspace', …)`).
  * Import/Export via toolbar.

---

## Node Types & Settings

All settings UIs are generated from each type’s schema.

### ASR

* **Outputs:** `partial`, `phrase`, `final`.
* **Key options:** `base`, `relay`, `api`, `model`, `mode (fast|accurate)`, capture (`rate`, `chunk`, `live`), VAD (`rms`, `hold`, `emaMs`), phrase detection (`phraseOn`, `phraseMin`, `phraseStable`, `silence`), preview (`prevWin`, `prevStep`, `prevModel`), decoding `prompt`.
* In-node UI: VU meter, ▶/■ control, scrollers for partial/final text.

### LLM

* **Inputs:** `prompt`, `system`.
* **Outputs:** `delta`, `final`, `memory`.
* **Key options:** `base`, `relay`, `api`, `model`, `stream`, `useSystem`, `system`, `memoryOn`, `persistMemory`, `maxTurns`.
* **Streaming:** Expects NDJSON; buffers token deltas and flushes full sentences to `final` (and mirrors to `delta`).
* **Memory:** Sliding window capped by `maxTurns` user turns (+ matching assistant replies). Optional system message retained at index 0. Emits `memory` updates.

### TTS

* **Input:** `text`.
* **Modes:** `stream` (default), `file` (OGG).
* **Key options:** `base`, `relay`, `api`, `model` (voice), `mode`.
* **Streaming:** Server returns raw **s16le @ 22050 Hz**. Client reorders (if NKN), converts to `Float32`, resamples if needed, and enqueues. Adds tiny preroll and inter-sentence spacer.
* **File mode:** Fetches OGG blob (via URL or base64) and plays in an `<audio>` element added to the node.

---

## Transport

* **Direct HTTP(S):** `fetch` with streaming (`ReadableStream`) for NDJSON (LLM) and bytes (TTS).
* **NKN relay:** Set `CFG.transport === 'nkn'`. The client sends `X-Relay-Stream: chunks`; relay provides sequence numbers. Client restores order before parsing/playing.

---

## Backend API Contracts (reference)

### POST `/api/chat` (LLM)

Headers:

```
Accept: application/x-ndjson
Content-Type: application/json
Authorization: Bearer <api>  (optional)
```

Request:

```json
{
  "model": "llama3",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Say hello."}
  ],
  "stream": true
}
```

NDJSON stream (examples):

```
{"delta":" Hel"}
{"delta":"lo"}
{"done":true,"final":"Hello."}
```

Non-streaming:

```json
{ "message": { "content": "Hello." } }
```

### POST `/speak` (TTS)

Streaming (raw):

```json
{ "text": "Hello world.", "mode": "stream", "format": "raw", "model": "glados_piper_medium" }
```

Response body: raw s16le 22,050 Hz bytes (arbitrary chunking). Over NKN, chunks are sequenced.

File (OGG):

```json
{ "text": "Hello world.", "mode": "file", "format": "ogg", "model": "glados_piper_medium" }
```

Response either:

```json
{ "files": [{ "url": "/files/abc.ogg" }] }
```

or

```json
{ "audio_b64": "<base64>" }
```

---

## Text Preparation for TTS

The client normalizes text before synthesis: Unicode normalization (NFKC), quote unification, URL/markdown stripping, ellipsis collapse, punctuation spacing tightening, and whitespace compression. This improves prosody and robustness across engines.

---

## Troubleshooting

**“Failed to fetch”**

* Check protocol: if your app is HTTPS, do not call HTTP backends (mixed content).
* Verify endpoints exist: `POST /api/chat`, `POST /speak`.
* Ensure CORS for cross-origin access (see below).
* For NKN, confirm relay reachability and `CFG.transport==='nkn'`.

**CORS**

* Backends should respond to preflight and include:

  ```
  Access-Control-Allow-Origin: https://<your-app-origin>
  Access-Control-Allow-Methods: POST, OPTIONS
  Access-Control-Allow-Headers: Content-Type, Authorization, Accept, X-Relay-Stream
  ```

**Audio glitches / shuffling**

* TTS server must emit consistent format (s16le 22,050 Hz).
* The client reorders NKN frames; if you customize the relay, maintain monotonically increasing sequence numbers.
* Increase preroll if underruns appear in logs.

---

## Import / Export

Use toolbar buttons to export/import `realtime-graph.json`. The file contains:

* Node layout (`id`, `type`, `x`, `y`)
* Links (`from`, `to`)
* Per-node configs (`nodeConfigs[id] = { type, config }`)

Import replaces the current workspace.

---

## Developer Notes

* **Graph**: workspace state, node DOM, spline drawing, linking/retargeting, persistence.
* **TYPES**: registry + per-node schema powering settings UIs.
* **Router**: binds `from: "<id>:out:<port>"` to `to: "<id>:in:<port>"`.
* **NodeStore**: per-node config persistence keyed by node id.
* **ASR / LLM / TTS**: runtime modules talking to your services.

To add a node type:

1. Extend `TYPES` with `inputs`, `outputs`, `schema`.
2. `makeNodeEl` registers inputs with `Router.register(...)`.
3. Emit via `Router.sendFrom(nodeId, '<port>', payload)`.
4. Persist configuration via `NodeStore.ensure/update/load`.
