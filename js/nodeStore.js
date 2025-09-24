import { LS, ASR_DEFAULT_PROMPT } from './utils.js';

const NodeStore = {
  key: (id) => `graph.node.${id}`,
  defaultsByType: {
    ASR: {
      base: 'http://localhost:8126',
      relay: '',
      api: '',
      model: '',
      mode: 'fast',
      rate: 16000,
      chunk: 120,
      live: true,
      rms: 0.2,
      hold: 250,
      emaMs: 120,
      phraseOn: true,
      phraseMin: 3,
      phraseStable: 350,
      silence: 900,
      prompt: ASR_DEFAULT_PROMPT,
      prevWin: '',
      prevStep: '',
      prevModel: ''
    },
    LLM: {
      base: 'http://127.0.0.1:11434',
      relay: '',
      api: '',
      model: '',
      stream: true,
      useSystem: false,
      system: '',
      memoryOn: false,
      persistMemory: false,
      maxTurns: 16,
      memory: []
    },
    TTS: {
      base: 'http://localhost:8123',
      relay: '',
      api: '',
      model: '',
      mode: 'stream'
    },
    TextInput: {
      placeholder: '',
      text: '',
      lastSent: ''
    },
    Template: {
      template: 'Hello {name}',
      variables: {}
    },
    TextDisplay: {
      text: ''
    },
    NknDM: {
      address: '',
      chunkBytes: 1800,
      heartbeatInterval: 15,
      componentId: '',
      handshake: { status: 'idle', peer: '', direction: 'idle', remoteId: '', graphId: '' },
      peer: null,
      allowedPeers: [],
      autoAccept: false
    }
  },

  ensure(id, type) {
    let obj = LS.get(this.key(id), null);
    if (!obj || obj.type !== type) {
      obj = { id, type, config: { ...this.defaultsByType[type] } };
      this.saveObj(id, obj);
    }
    return obj;
  },

  load(id) {
    return LS.get(this.key(id), null);
  },

  saveObj(id, obj) {
    LS.set(this.key(id), obj);
  },

  saveCfg(id, type, cfg) {
    this.saveObj(id, { id, type, config: cfg });
  },

  update(id, patch) {
    const current = this.load(id) || this.ensure(id, patch.type);
    const cfg = { ...(current.config || {}), ...patch };
    this.saveCfg(id, current.type, cfg);
    return cfg;
  },

  erase(id) {
    LS.del(this.key(id));
  },

  setRelay(id, type, relay) {
    const current = this.ensure(id, type);
    const cfg = { ...(current.config || {}), relay };
    this.saveCfg(id, type, cfg);
    return cfg;
  }
};

export { NodeStore };
