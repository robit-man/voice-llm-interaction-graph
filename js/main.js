import { CFG, saveCFG } from './config.js';
import { setBadge, log, qs, b64ToBytes, SIGNOFF_RE, td } from './utils.js';
import { makeTransportButtonUpdater } from './transport.js';
import { Net } from './net.js';
import { Router } from './router.js';
import { NodeStore } from './nodeStore.js';
import { createSentenceMux, makeNdjsonPump, stripEOT } from './sentence.js';
import { setupQrScanner, openQrScanner, closeQrScanner, registerQrResultHandler } from './qrScanner.js';
import { createLLM } from './llm.js';
import { createTTS } from './tts.js';
import { createASR } from './asr.js';
import { createNknDM } from './nknDm.js';
import { createGraph } from './graph.js';

const updateTransportButton = makeTransportButtonUpdater({ CFG, Net });
Net.setTransportUpdater(updateTransportButton);

const graphAccess = {
  getNode: () => null
};

const LLM = createLLM({
  getNode: (id) => graphAccess.getNode(id),
  NodeStore,
  Router,
  Net,
  CFG,
  createSentenceMux,
  makeNdjsonPump,
  stripEOT,
  log
});

const TTS = createTTS({
  getNode: (id) => graphAccess.getNode(id),
  NodeStore,
  Net,
  CFG,
  log,
  b64ToBytes
});

const ASR = createASR({
  getNode: (id) => graphAccess.getNode(id),
  Router,
  NodeStore,
  Net,
  CFG,
  SIGNOFF_RE,
  td,
  setBadge,
  log
});

const NknDM = createNknDM({
  getNode: (id) => graphAccess.getNode(id),
  NodeStore,
  Net,
  CFG,
  Router,
  log
});

const Graph = createGraph({
  Router,
  NodeStore,
  LLM,
  TTS,
  ASR,
  NknDM,
  Net,
  CFG,
  saveCFG,
  openQrScanner,
  closeQrScanner,
  registerQrResultHandler,
  updateTransportButton
});

graphAccess.getNode = (id) => Graph.getNode(id);

function bindUI() {
  const toggle = qs('#transportToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (CFG.transport === 'nkn') {
        CFG.transport = 'http';
        try {
          Net.nkn.client && Net.nkn.client.close();
        } catch (err) {
          // ignore
        }
        Net.nkn.client = null;
        Net.nkn.ready = false;
        Net.nkn.addr = '';
        saveCFG();
        updateTransportButton();
        setBadge('HTTP mode');
      } else {
        CFG.transport = 'nkn';
        saveCFG();
        updateTransportButton();
        Net.ensureNkn();
        setBadge('Connecting via NKN…');
      }
    });
  }
  updateTransportButton();
}

function init() {
  setupQrScanner();
  bindUI();
  Graph.init();
  Router.render();
  if (CFG.transport === 'nkn') Net.ensureNkn();
  setBadge('Ready');
}

document.addEventListener('DOMContentLoaded', init);
