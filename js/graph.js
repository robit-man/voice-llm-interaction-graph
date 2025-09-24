import { LS, qs, qsa, setBadge, log } from './utils.js';

function createGraph({
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
}) {
  const WS = {
    el: null,
    svg: null,
    svgLayer: null,
    root: null,
    canvas: null,
    nodes: new Map(),
    wires: [],
    portSel: null,
    drag: null,
    view: { x: 0, y: 0, scale: 1 },
    _redrawReq: false
  };

  function ensureSvgLayer() {
    if (!WS.svg) return;
    if (!WS.svgLayer || WS.svgLayer.parentNode !== WS.svg) {
      WS.svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      WS.svg.appendChild(WS.svgLayer);
    }
  }

  function requestRedraw() {
    if (WS._redrawReq) return;
    WS._redrawReq = true;
    requestAnimationFrame(() => {
      WS._redrawReq = false;
      drawAllLinks();
    });
  }

  function applyViewTransform() {
    const t = `translate(${WS.view.x}px, ${WS.view.y}px) scale(${WS.view.scale})`;
    if (WS.canvas) WS.canvas.style.transform = t;
    if (WS.svgLayer) WS.svgLayer.setAttribute('transform', `translate(${WS.view.x},${WS.view.y}) scale(${WS.view.scale})`);
  }

  function clientToWorkspace(cx, cy) {
    const rect = WS.root?.getBoundingClientRect?.() || document.body.getBoundingClientRect();
    const x = (cx - rect.left - WS.view.x) / WS.view.scale;
    const y = (cy - rect.top - WS.view.y) / WS.view.scale;
    return { x, y };
  }

  function uid() {
    return 'n' + Math.random().toString(36).slice(2, 8);
  }

  function refreshNodeTransport(nodeId) {
    const node = WS.nodes.get(nodeId);
    if (!node) return;
    const btn = node.el?.querySelector('.node-transport');
    if (!btn) return;
    const rec = NodeStore.ensure(node.id, node.type);
    const relay = (rec.config?.relay || '').trim();
    btn.innerHTML = '';
    btn.classList.remove('active');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'NKN';
    if (relay) {
      btn.classList.add('active');
      if (CFG.transport === 'nkn' && Net?.nkn?.ready && Net.nkn.addr) dot.classList.add('ok');
      else if (CFG.transport === 'nkn') dot.classList.add('warn');
      else dot.classList.add('warn');
      btn.title = relay;
    } else {
      dot.classList.add('err');
      btn.title = 'Scan a relay QR code';
    }
    btn.append(dot, label);
  }

  function refreshAllNodeTransport() {
    WS.nodes.forEach((n) => refreshNodeTransport(n.id));
  }

  registerQrResultHandler(({ text, target }) => {
    if (!text) return;
    const form = qs('#settingsForm');
    const nodeId = form?.dataset?.nodeId;
    if (!nodeId) return;
    try {
      const node = WS.nodes.get(nodeId);
      if (!node) return;
      NodeStore.setRelay(nodeId, node.type, text);
      refreshNodeTransport(nodeId);
      saveGraph();
      updateTransportButton();
      setBadge('NKN relay saved');
    } catch (err) {
      log('[qr] ' + (err?.message || err));
    }
  });

  function makeNodeEl(node) {
    const TYPES = GraphTypes;
    const t = TYPES[node.type];
    const el = document.createElement('div');
    el.className = 'node';
    el.style.left = `${node.x || 60}px`;
    el.style.top = `${node.y || 60}px`;
    if (node.w) el.style.width = `${node.w}px`;
    if (node.h) el.style.height = `${node.h}px`;
    el.dataset.id = node.id;

    el.innerHTML = `
      <div class="head">
        <div class="titleRow"><div class="title">${t.title}</div><button type="button" class="node-transport">NKN</button></div>
        <div class="row" style="gap:6px;">
          <button class="gear" title="Settings">⚙</button>
          ${node.type === 'ASR' ? `<button class="gear asrPlay" title="Start/Stop">▶</button>` : ''}
          <button class="gear" title="Remove">🗑</button>
        </div>
      </div>
      <div class="body">
        <div class="ports">
          <div class="side left"></div>
          <div class="side right"></div>
        </div>
        ${node.type === 'ASR' ? `
          <canvas data-asr-vis style="margin-top:6px;width:100%;height:56px;background:rgba(0,0,0,.25);border-radius:4px"></canvas>
          <div class="muted" style="margin-top:6px;">Partial</div>
          <div class="bubble" data-asr-partial style="min-height:28px"></div>
          <div class="muted" style="margin-top:6px;">Finals</div>
          <div class="code" data-asr-final style="min-height:60px;max-height:120px"></div>
        ` : ''}
        ${node.type === 'LLM' ? `
          <div class="muted" style="margin-top:6px;">Output</div>
          <div class="code" data-llm-out style="min-height:60px;max-height:120px;overflow:auto;white-space:pre-wrap"></div>
        ` : ''}
        ${node.type === 'NknDM' ? `
          <div class="muted" style="margin-top:6px;">Local Address</div>
          <div class="dm-address-row">
            <div class="bubble" data-nkndm-local style="min-height:24px">(offline)</div>
            <button type="button" class="ghost" data-nkndm-copy>Copy</button>
            <span class="dm-indicator offline" data-nkndm-indicator title="Offline"></span>
          </div>
          <div class="muted" style="margin-top:6px;">Peer</div>
          <div class="dm-peer-row">
            <div class="bubble" data-nkndm-peer style="min-height:24px">(none)</div>
            <div class="dm-peer-actions hidden" data-nkndm-actions>
              <button type="button" class="ghost" data-nkndm-approve title="Trust peer">✔</button>
              <button type="button" class="ghost" data-nkndm-revoke title="Remove trust">✖</button>
            </div>
          </div>
          <div class="muted" style="margin-top:6px;">Log</div>
          <div class="code" data-nkndm-log style="min-height:60px;max-height:120px"></div>
        ` : ''}
        ${node.type === 'TextInput' ? `
          <div class="text-input-area" style="margin-top:6px;">
            <textarea data-textinput-field placeholder="Type a message…"></textarea>
            <div class="text-input-actions">
              <button type="button" class="secondary" data-textinput-send>Send</button>
            </div>
          </div>
        ` : ''}
        ${node.type === 'TextDisplay' ? `
          <div class="muted" style="margin-top:6px;">Latest Text</div>
          <div class="text-display-wrap" data-textdisplay-wrap style="position:relative;margin-top:4px;">
            <button type="button" class="ghost" data-textdisplay-copy title="Copy" style="position:absolute;top:4px;right:4px;padding:2px 8px;line-height:1.2;">Copy</button>
            <div class="bubble" data-textdisplay-content style="min-height:48px;padding-right:48px;white-space:pre-wrap;word-break:break-word;"></div>
          </div>
        ` : ''}
        ${node.type === 'Template' ? `
          <div class="template-editor" style="margin-top:6px;">
            <textarea data-template-editor placeholder="Hello {name}, welcome to {place}."></textarea>
            <div class="template-preview" data-template-preview></div>
          </div>
        ` : ''}
      </div>
    `;

    const transportBtn = el.querySelector('.node-transport');
    if (transportBtn) {
      transportBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rec = NodeStore.ensure(node.id, node.type);
        const relay = (rec.config?.relay || '').trim();
        if (relay) {
          NodeStore.setRelay(node.id, node.type, '');
          refreshNodeTransport(node.id);
          saveGraph();
          updateTransportButton();
          setBadge('Switched to HTTP');
        } else {
          openQrScanner(null, (txt) => {
            if (!txt) return;
            NodeStore.setRelay(node.id, node.type, txt.trim());
            refreshNodeTransport(node.id);
            saveGraph();
            updateTransportButton();
            setBadge('NKN relay saved');
          });
        }
      });
      refreshNodeTransport(node.id);
    }

    const resizeHandle = document.createElement('div');
    resizeHandle.setAttribute('data-resize', '');
    resizeHandle.title = 'Resize';
    resizeHandle.style.cssText = [
      'position:absolute',
      'right:4px',
      'bottom:4px',
      'width:12px',
      'height:12px',
      'border-bottom-right-radius:10px',
      'cursor:se-resize',
      'border-right:2px solid rgba(255,255,255,0.6)',
      'border-bottom:2px solid rgba(255,255,255,0.6)',
      'box-sizing:border-box',
      'z-index:2'
    ].join(';');
    el.appendChild(resizeHandle);

    let resizeState = null;
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const bounds = el.getBoundingClientRect();
      resizeState = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startW: bounds.width,
        startH: bounds.height
      };
      resizeHandle.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'se-resize';
    });

    resizeHandle.addEventListener('pointermove', (e) => {
      if (!resizeState) return;
      const dx = e.clientX - resizeState.startX;
      const dy = e.clientY - resizeState.startY;
      const minW = 180;
      const minH = 120;
      const w = Math.max(minW, Math.round(resizeState.startW + dx));
      const h = Math.max(minH, Math.round(resizeState.startH + dy));
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      node.w = w;
      node.h = h;
      requestRedraw();
    });

    const endResize = () => {
      if (!resizeState) return;
      resizeState = null;
      document.body.style.cursor = '';
      saveGraph();
    };
    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);

    const left = el.querySelector('.side.left');
    const right = el.querySelector('.side.right');

    if (node.type === 'TextInput') {
      initTextInputNode(node);
    }

    if (node.type === 'TextDisplay') {
      initTextDisplayNode(node);
    }

    if (node.type === 'NknDM') {
      initNknDmNode(node);
    }

    for (const p of (t.inputs || [])) {
      const portEl = document.createElement('div');
      portEl.className = 'wp-port in';
      portEl.dataset.port = p.name;
      portEl.title = `${p.name} (Alt-click to disconnect)`;
      portEl.innerHTML = `<span class="dot"></span><span>${p.name}</span>`;
      portEl.addEventListener('click', (ev) => {
        if (ev.altKey || ev.metaKey || ev.ctrlKey) {
          removeWiresAt(node.id, 'in', p.name);
          return;
        }
        onPortClick(node.id, 'in', p.name, portEl);
      });

      portEl.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'touch') ev.preventDefault();
        const wires = connectedWires(node.id, 'in', p.name);
        if (wires.length) {
          const w = wires[wires.length - 1];
          w.path?.setAttribute('stroke-dasharray', '6 4');
          const move = (e) => {
            if (e.pointerType === 'touch') e.preventDefault();
            if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
            const pt = clientToWorkspace(e.clientX, e.clientY);
            drawRetarget(w, 'to', pt.x, pt.y);
            if (WS.drag) updateDropHover(WS.drag.expected);
          };
          const up = (e) => {
            setDropHover(null);
            finishAnyDrag(e.clientX, e.clientY);
          };
          WS.drag = {
            kind: 'retarget',
            wireId: w.id,
            grabSide: 'to',
            path: w.path,
            pointerId: ev.pointerId,
            expected: 'out',
            lastClient: { x: ev.clientX, y: ev.clientY },
            _cleanup: () => window.removeEventListener('pointermove', move)
          };
          window.addEventListener('pointermove', move, { passive: false });
          window.addEventListener('pointerup', up, { once: true, passive: false });
          updateDropHover('out');
          return;
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(255,255,255,.6)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('opacity', '0.9');
        path.setAttribute('stroke-dasharray', '6 4');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        path.setAttribute('pointer-events', 'none');
        WS.svgLayer.appendChild(path);

        const move = (e) => {
          if (e.pointerType === 'touch') e.preventDefault();
          if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
          const pt = clientToWorkspace(e.clientX, e.clientY);
          drawTempFromPort({ nodeId: node.id, side: 'in', portName: p.name }, pt.x, pt.y);
          updateDropHover(WS.drag?.expected);
        };
        const up = (e) => {
          setDropHover(null);
          finishAnyDrag(e.clientX, e.clientY);
        };
        WS.drag = {
          kind: 'newFromInput',
          toNodeId: node.id,
          toPort: p.name,
          path,
          pointerId: ev.pointerId,
          expected: 'out',
          lastClient: { x: ev.clientX, y: ev.clientY },
          _cleanup: () => window.removeEventListener('pointermove', move)
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true, passive: false });
        const pt = clientToWorkspace(ev.clientX, ev.clientY);
        drawTempFromPort({ nodeId: node.id, side: 'in', portName: p.name }, pt.x, pt.y);
        updateDropHover('out');
      });

      left.appendChild(portEl);
      Router.register(`${node.id}:in:${p.name}`, portEl, (payload) => {
        if (node.type === 'LLM') {
          if (p.name === 'prompt') {
            pullLlmSystemInput(node.id);
            return LLM.onPrompt(node.id, payload);
          }
          if (p.name === 'system') return LLM.onSystem(node.id, payload);
        } else if (node.type === 'TTS') {
          if (p.name === 'text') return TTS.onText(node.id, payload);
        } else if (node.type === 'NknDM') {
          if (p.name === 'text') return NknDM.onText(node.id, payload);
        } else if (node.type === 'TextDisplay') {
          if (p.name === 'text') return handleTextDisplayInput(node.id, payload);
        } else if (node.type === 'Template') {
          if (p.name === 'trigger') return handleTemplateTrigger(node.id, payload);
        }
      });
    }

    for (const p of (t.outputs || [])) {
      const portEl = document.createElement('div');
      portEl.className = 'wp-port out';
      portEl.dataset.port = p.name;
      portEl.title = `${p.name} (Alt-click to disconnect)`;
      portEl.innerHTML = `<span>${p.name}</span><span class="dot"></span>`;
      portEl.addEventListener('click', (ev) => {
        if (ev.altKey || ev.metaKey || ev.ctrlKey) {
          removeWiresAt(node.id, 'out', p.name);
          return;
        }
        onPortClick(node.id, 'out', p.name, portEl);
      });

      portEl.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType === 'touch') ev.preventDefault();
        const wires = connectedWires(node.id, 'out', p.name);
        if (wires.length) {
          const w = wires[wires.length - 1];
          w.path?.setAttribute('stroke-dasharray', '6 4');
          const move = (e) => {
            if (e.pointerType === 'touch') e.preventDefault();
            if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
            const pt = clientToWorkspace(e.clientX, e.clientY);
            drawRetarget(w, 'from', pt.x, pt.y);
            if (WS.drag) updateDropHover(WS.drag.expected);
          };
          const up = (e) => {
            setDropHover(null);
            finishAnyDrag(e.clientX, e.clientY);
          };
          WS.drag = {
            kind: 'retarget',
            wireId: w.id,
            grabSide: 'from',
            path: w.path,
            pointerId: ev.pointerId,
            expected: 'in',
            lastClient: { x: ev.clientX, y: ev.clientY },
            _cleanup: () => window.removeEventListener('pointermove', move)
          };
          window.addEventListener('pointermove', move, { passive: false });
          window.addEventListener('pointerup', up, { once: true, passive: false });
          updateDropHover('in');
          return;
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(255,255,255,.6)');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('opacity', '0.9');
        path.setAttribute('stroke-dasharray', '6 4');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        path.setAttribute('pointer-events', 'none');
        WS.svgLayer.appendChild(path);

        const move = (e) => {
          if (e.pointerType === 'touch') e.preventDefault();
          if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
          const pt = clientToWorkspace(e.clientX, e.clientY);
          drawTempFromPort({ nodeId: node.id, side: 'out', portName: p.name }, pt.x, pt.y);
          updateDropHover(WS.drag?.expected);
        };
        const up = (e) => {
          setDropHover(null);
          finishAnyDrag(e.clientX, e.clientY);
        };
        WS.drag = {
          kind: 'new',
          fromNodeId: node.id,
          fromPort: p.name,
          path,
          pointerId: ev.pointerId,
          expected: 'in',
          lastClient: { x: ev.clientX, y: ev.clientY },
          _cleanup: () => window.removeEventListener('pointermove', move)
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true, passive: false });
        const pt = clientToWorkspace(ev.clientX, ev.clientY);
        drawTempFromPort({ nodeId: node.id, side: 'out', portName: p.name }, pt.x, pt.y);
        updateDropHover('in');
      });

      right.appendChild(portEl);
    }

    if (node.type === 'Template') {
      setupTemplateNode(node, left);
    }

    const head = el.querySelector('.head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const start = clientToWorkspace(e.clientX, e.clientY);
      drag = { dx: start.x - (node.x || 0), dy: start.y - (node.y || 0) };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = clientToWorkspace(e.clientX, e.clientY);
      const gx = Math.round((p.x - drag.dx) / 14) * 14;
      const gy = Math.round((p.y - drag.dy) / 14) * 14;
      el.style.left = `${gx}px`;
      el.style.top = `${gy}px`;
      node.x = gx;
      node.y = gy;
      requestRedraw();
    });
    head.addEventListener('pointerup', () => {
      drag = null;
      saveGraph();
    });

    const [btnGear, btnASR, btnDel] =
      node.type === 'ASR'
        ? el.querySelectorAll('.gear')
        : (() => {
          const all = el.querySelectorAll('.gear');
          return [all[0], null, all[1]];
        })();
    btnGear.addEventListener('click', () => openSettings(node.id));
    if (btnASR) {
      const glyph = () => {
        btnASR.textContent = (ASR.running && ASR.ownerId === node.id) ? '■' : '▶';
      };
      glyph();
      btnASR.addEventListener('click', async () => {
        if (ASR.running && ASR.ownerId === node.id) await ASR.stop();
        else await ASR.start(node.id);
        setTimeout(glyph, 0);
      });
    }
    btnDel.addEventListener('click', () => removeNode(node.id));
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => requestRedraw());
      ro.observe(el);
      node._ro = ro;
    }

    return el;
  }

  function onPortClick(nodeId, side, portName, el) {
    if (!WS.portSel) {
      if (side !== 'out') {
        setBadge('Pick an output first', false);
        return;
      }
      WS.portSel = { nodeId, side, portName, el };
      el.classList.add('sel');
      return;
    }
    if (side !== 'in') {
      setBadge('Connect to an input port', false);
      return;
    }
    if (nodeId === WS.portSel.nodeId) {
      setBadge('Cannot self-link', false);
      return;
    }
    addLink(WS.portSel.nodeId, WS.portSel.portName, nodeId, portName);
    WS.portSel.el.classList.remove('sel');
    WS.portSel = null;
  }

  function connectedWires(nodeId, side, portName) {
    return WS.wires.filter((w) =>
      (side === 'out' && w.from.node === nodeId && w.from.port === portName) ||
      (side === 'in' && w.to.node === nodeId && w.to.port === portName)
    );
  }

  function addLink(fromNodeId, fromPort, toNodeId, toPort) {
    if (WS.wires.find((w) => w.from.node === fromNodeId && w.from.port === fromPort && w.to.node === toNodeId && w.to.port === toPort)) return;
    const w = { id: uid(), from: { node: fromNodeId, port: fromPort }, to: { node: toNodeId, port: toPort }, path: null };
    WS.wires.push(w);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgba(255,255,255,.7)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('opacity', '0.95');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.dataset.id = w.id;
    const kill = (e) => {
      removeWireById(w.id);
      e.stopPropagation();
    };
    path.addEventListener('click', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey) kill(e);
    });
    path.addEventListener('dblclick', kill);
    WS.svgLayer.appendChild(path);
    w.path = path;

    const fk = `${fromNodeId}:out:${fromPort}`;
    const tk = `${toNodeId}:in:${toPort}`;
    if (!Router.wires.find((x) => x.from === fk && x.to === tk)) {
      Router.wires.push({ from: fk, to: tk });
      CFG.wires = Router.wires.slice();
      saveCFG();
      Router.render();
      log(`wired ${fk} → ${tk}`);
    }

    const targetNode = WS.nodes.get(toNodeId);
    if (targetNode?.type === 'LLM' && toPort === 'system') {
      pullLlmSystemInput(toNodeId);
    }

    requestRedraw();
    saveGraph();
  }

  function setDropHover(el) {
    if (WS.drag?.dropHover === el) return;
    if (WS.drag?.dropHover) WS.drag.dropHover.classList.remove('drop-hover');
    if (el) el.classList.add('drop-hover');
    if (WS.drag) WS.drag.dropHover = el || null;
  }

  function updateDropHover(expected) {
    if (!WS.drag || !WS.drag.lastClient || !expected) {
      setDropHover(null);
      return;
    }
    const el = document.elementFromPoint(WS.drag.lastClient.x, WS.drag.lastClient.y);
    const selector = expected === 'in' ? '.wp-port.in' : '.wp-port.out';
    const target = el && el.closest?.(selector);
    setDropHover(target || null);
  }

  function clearTempLink() {
    if (WS.drag?.kind && WS.drag.path) {
      if (WS.drag.kind === 'retarget') WS.drag.path.setAttribute('stroke-dasharray', '');
      else WS.drag.path.remove();
    }
  }

  function drawTempFromPort(from, mx, my) {
    if (!WS.drag?.path) return;
    const a = portCenter(from.nodeId, from.side, from.portName);
    const b = { x: mx, y: my };
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    WS.drag.path.setAttribute('d', `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`);
    if (WS.drag?.expected) updateDropHover(WS.drag.expected);
  }

  function drawRetarget(wire, grabSide, mx, my) {
    if (!wire?.path) return;
    const a = grabSide === 'from'
      ? { x: mx, y: my }
      : portCenter(wire.from.node, 'out', wire.from.port);
    const b = grabSide === 'to'
      ? { x: mx, y: my }
      : portCenter(wire.to.node, 'in', wire.to.port);
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    wire.path.setAttribute('d', `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`);
    if (WS.drag?.expected) updateDropHover(WS.drag.expected);
  }

  function finishAnyDrag(cx, cy) {
    try {
      WS.drag?._cleanup && WS.drag._cleanup();
    } catch (err) {
      // ignore
    }
    const el = document.elementFromPoint(cx, cy);
    setDropHover(null);

    if (WS.drag?.kind === 'new') {
      const target = el && el.closest?.('.wp-port.in');
      if (target) {
        const toNode = target.closest('.node')?.dataset?.id;
        const toPort = target.dataset.port;
        if (toNode && toPort && toNode !== WS.drag.fromNodeId) addLink(WS.drag.fromNodeId, WS.drag.fromPort, toNode, toPort);
        else setBadge('Invalid drop target', false);
      }
      clearTempLink();
      WS.drag = null;
      return;
    }

    if (WS.drag?.kind === 'newFromInput') {
      const target = el && el.closest?.('.wp-port.out');
      if (target) {
        const fromNode = target.closest('.node')?.dataset?.id;
        const fromPort = target.dataset.port;
        if (fromNode && fromPort && fromNode !== WS.drag.toNodeId) addLink(fromNode, fromPort, WS.drag.toNodeId, WS.drag.toPort);
        else setBadge('Invalid drop target', false);
      }
      clearTempLink();
      WS.drag = null;
      return;
    }

    if (WS.drag?.kind === 'retarget') {
      const wire = WS.wires.find((w) => w.id === WS.drag.wireId);
      if (!wire) {
        clearTempLink();
        WS.drag = null;
        return;
      }
      const need = WS.drag.grabSide === 'from' ? '.wp-port.in' : '.wp-port.out';
      const target = el && el.closest?.(need);
      wire.path?.setAttribute('stroke-dasharray', '');
      if (!target) {
        removeWireById(wire.id);
        clearTempLink();
        WS.drag = null;
        return;
      }
      const hitNodeId = target.closest('.node')?.dataset?.id;
      const hitPort = target.dataset?.port;
      if (!hitNodeId || !hitPort) {
        clearTempLink();
        WS.drag = null;
        return;
      }
      if (WS.drag.grabSide === 'from') {
        if (!target.classList.contains('in')) {
          setBadge('Drop on an input port', false);
          clearTempLink();
          requestRedraw();
          WS.drag = null;
          return;
        }
        if (hitNodeId === wire.from.node) {
          setBadge('Cannot self-link', false);
          clearTempLink();
          requestRedraw();
          WS.drag = null;
          return;
        }
        wire.to = { node: hitNodeId, port: hitPort };
      } else {
        if (!target.classList.contains('out')) {
          setBadge('Drop on an output port', false);
          clearTempLink();
          requestRedraw();
          WS.drag = null;
          return;
        }
        if (hitNodeId === wire.to.node) {
          setBadge('Cannot self-link', false);
          clearTempLink();
          requestRedraw();
          WS.drag = null;
          return;
        }
        wire.from = { node: hitNodeId, port: hitPort };
      }
      syncRouterFromWS();
      saveGraph();
      requestRedraw();
      clearTempLink();
      setBadge('Wire reconnected');
      WS.drag = null;
      return;
    }

    clearTempLink();
    WS.drag = null;
  }

  function portCenter(nodeId, side, portName) {
    const n = WS.nodes.get(nodeId);
    if (!n) return { x: 0, y: 0 };
    const dot = n.el.querySelector(`.wp-port.${side}[data-port="${CSS.escape(portName)}"] .dot`);
    if (!dot) return { x: 0, y: 0 };
    const rect = dot.getBoundingClientRect();
    return clientToWorkspace(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function drawLink(w) {
    const a = portCenter(w.from.node, 'out', w.from.port);
    const b = portCenter(w.to.node, 'in', w.to.port);
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    const d = `M ${a.x},${a.y} C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
    w.path.setAttribute('d', d);
  }

  function drawAllLinks() {
    for (const w of WS.wires) drawLink(w);
  }

  function removeWireById(id) {
    const w = WS.wires.find((x) => x.id === id);
    if (!w) return;
    w.path?.remove();
    WS.wires = WS.wires.filter((x) => x !== w);
    syncRouterFromWS();
    saveGraph();
    requestRedraw();
    setBadge('Wire removed');
  }

  function removeWiresAt(nodeId, side, portName) {
    const rm = WS.wires.filter((w) =>
      (side === 'out' && w.from.node === nodeId && w.from.port === portName) ||
      (side === 'in' && w.to.node === nodeId && w.to.port === portName)
    );
    rm.forEach((w) => w.path?.remove());
    WS.wires = WS.wires.filter((w) => !rm.includes(w));
    syncRouterFromWS();
    saveGraph();
    requestRedraw();
  }

  function syncRouterFromWS() {
    const newWires = WS.wires.map((w) => ({ from: `${w.from.node}:out:${w.from.port}`, to: `${w.to.node}:in:${w.to.port}` }));
    Router.wires = newWires;
    CFG.wires = newWires.slice();
    saveCFG();
    Router.render();
  }

  function saveGraph() {
    const data = {
      nodes: Array.from(WS.nodes.values()).map((n) => ({
        id: n.id,
        type: n.type,
        x: n.x,
        y: n.y,
        w: Math.round(n.el?.offsetWidth || n.w || 0),
        h: Math.round(n.el?.offsetHeight || n.h || 0)
      })),
      links: WS.wires.map((w) => ({ from: w.from, to: w.to })),
      nodeConfigs: {}
    };
    for (const n of WS.nodes.values()) {
      const rec = NodeStore.load(n.id);
      if (rec) data.nodeConfigs[n.id] = rec;
    }
    LS.set('graph.workspace', data);
  }

  function loadGraph() {
    const data = LS.get('graph.workspace', null);
    WS.canvas.innerHTML = '';
    WS.svg.innerHTML = '';
    ensureSvgLayer();
    WS.nodes.clear();
    WS.wires = [];
    if (!data) {
      const a = addNode('ASR', 90, 200);
      const l = addNode('LLM', 380, 180);
      const t = addNode('TTS', 680, 200);
      addLink(a.id, 'final', l.id, 'prompt');
      addLink(l.id, 'final', t.id, 'text');
      requestRedraw();
      saveGraph();
      return;
    }
    if (data.nodeConfigs) {
      for (const [id, obj] of Object.entries(data.nodeConfigs)) {
        if (obj && obj.type && obj.config) NodeStore.saveObj(id, obj);
      }
    }
    for (const n of (data.nodes || [])) {
      const node = { id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h };
      NodeStore.ensure(node.id, node.type);
      node.el = makeNodeEl(node);
      WS.canvas.appendChild(node.el);
      WS.nodes.set(node.id, node);
      if (node.type === 'TTS') requestAnimationFrame(() => TTS.refreshUI(node.id));
      if (node.type === 'TextInput') requestAnimationFrame(() => initTextInputNode(node));
      if (node.type === 'TextDisplay') requestAnimationFrame(() => initTextDisplayNode(node));
      if (node.type === 'Template') requestAnimationFrame(() => {
        const leftSide = node.el?.querySelector('.side.left');
        setupTemplateNode(node, leftSide);
        pullTemplateInputs(node.id);
      });
      if (node.type === 'NknDM') requestAnimationFrame(() => initNknDmNode(node));
    }
    for (const l of (data.links || [])) addLink(l.from.node, l.from.port, l.to.node, l.to.port);
    requestRedraw();
  }

  async function discoverASRModels(base, api, useNkn, relay) {
    const b = (base || '').replace(/\/+$/, '');
    if (!b) return [];
    try {
      const j = await Net.getJSON(b, '/models', api, useNkn, relay);
      const arr = Array.isArray(j?.models) ? j.models : (Array.isArray(j) ? j : []);
      const names = arr
        .map((m) => (m && (m.name || m.id || m)) ?? '')
        .filter(Boolean)
        .map(String);
      return Array.from(new Set(names));
    } catch (err) {
      return [];
    }
  }

  async function discoverLLMModels(base, api, useNkn, relay) {
    const out = [];
    const b = (base || '').replace(/\/+$/, '');
    if (!b) return out;
    try {
      const j = await Net.getJSON(b, '/api/tags', api, useNkn, relay);
      if (j && Array.isArray(j.models)) {
        for (const m of j.models) if (m && m.name) out.push(String(m.name));
      }
    } catch (err) {
      // ignore
    }
    try {
      const j = await Net.getJSON(b, '/v1/models', api, useNkn, relay);
      const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
      for (const m of arr) if (m && (m.id || m.name)) out.push(String(m.id || m.name));
    } catch (err) {
      // ignore
    }
    try {
      const j = await Net.getJSON(b, '/models', api, useNkn, relay);
      if (Array.isArray(j)) {
        for (const m of j) out.push(String(m.id || m.name || m));
      } else if (Array.isArray(j?.data)) {
        for (const m of j.data) out.push(String(m.id || m.name));
      }
    } catch (err) {
      // ignore
    }
    return Array.from(new Set(out.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  async function discoverTTSModels(base, api, useNkn, relay) {
    const b = (base || '').replace(/\/+$/, '');
    if (!b) return [];
    try {
      const j = await Net.getJSON(b, '/models', api, useNkn, relay);
      let arr = [];
      if (Array.isArray(j?.models)) arr = j.models;
      else if (Array.isArray(j?.data)) arr = j.data;
      else if (Array.isArray(j)) arr = j;
      const names = arr
        .map((m) => (m && (m.name || m.id || m)) ?? '')
        .filter(Boolean)
        .map(String);
      return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
    } catch (err) {
      return [];
    }
  }

  const GraphTypes = {
    ASR: {
      title: 'ASR',
      inputs: [],
      outputs: [{ name: 'partial' }, { name: 'phrase' }, { name: 'final' }],
      schema: [
        { key: 'base', label: 'Base URL', type: 'text', placeholder: 'http://localhost:8126' },
        { key: 'relay', label: 'NKN Relay', type: 'text' },
        { key: 'api', label: 'API Key', type: 'text' },
        { key: 'model', label: 'Model', type: 'select', options: [] },
        { key: 'mode', label: 'Mode', type: 'select', options: ['fast', 'accurate'], def: 'fast' },
        { key: 'rate', label: 'Sample Rate', type: 'number', def: 16000 },
        { key: 'chunk', label: 'Chunk (ms)', type: 'number', def: 120 },
        { key: 'live', label: 'Live Mode', type: 'select', options: ['true', 'false'], def: 'true' },
        { key: 'rms', label: 'RMS Threshold', type: 'text', def: 0.015 },
        { key: 'hold', label: 'Hold (ms)', type: 'number', def: 250 },
        { key: 'emaMs', label: 'EMA (ms)', type: 'number', def: 120 },
        { key: 'phraseOn', label: 'Phrase Mode', type: 'select', options: ['true', 'false'], def: 'true' },
        { key: 'phraseMin', label: 'Min Words', type: 'number', def: 3 },
        { key: 'phraseStable', label: 'Stable (ms)', type: 'number', def: 350 },
        { key: 'silence', label: 'Silence End (ms)', type: 'number', def: 900 },
        { key: 'prevWin', label: 'Preview Window (s)', type: 'text', placeholder: '(server default)' },
        { key: 'prevStep', label: 'Preview Step (s)', type: 'text', placeholder: '(server default)' },
        { key: 'prevModel', label: 'Preview Model', type: 'select', options: [] },
        { key: 'prompt', label: 'Prompt', type: 'textarea', placeholder: 'Bias decoding, names, spellings…' }
      ]
    },
    LLM: {
      title: 'LLM',
      inputs: [{ name: 'prompt' }, { name: 'system' }],
      outputs: [{ name: 'delta' }, { name: 'final' }, { name: 'memory' }],
      schema: [
        { key: 'base', label: 'Base URL', type: 'text', placeholder: 'http://127.0.0.1:11434' },
        { key: 'relay', label: 'NKN Relay', type: 'text' },
        { key: 'api', label: 'API Key', type: 'text' },
        { key: 'model', label: 'Model', type: 'select', options: [] },
        { key: 'stream', label: 'Stream', type: 'select', options: ['true', 'false'], def: 'true' },
        { key: 'useSystem', label: 'Use System Message', type: 'select', options: ['false', 'true'], def: 'false' },
        { key: 'system', label: 'System Prompt', type: 'textarea' },
        { key: 'memoryOn', label: 'Use Chat Memory', type: 'select', options: ['false', 'true'], def: 'false' },
        { key: 'persistMemory', label: 'Persist Memory', type: 'select', options: ['false', 'true'], def: 'false' },
        { key: 'maxTurns', label: 'Max Turns', type: 'number', def: 16 }
      ]
    },
    TTS: {
      title: 'TTS',
      inputs: [{ name: 'text' }],
      outputs: [],
      schema: [
        { key: 'base', label: 'Base URL', type: 'text', placeholder: 'http://localhost:8123' },
        { key: 'relay', label: 'NKN Relay', type: 'text' },
        { key: 'api', label: 'API Key', type: 'text' },
        { key: 'model', label: 'Voice/Model', type: 'select', options: [] },
        { key: 'mode', label: 'Mode', type: 'select', options: ['stream', 'file'], def: 'stream' }
      ]
    },
    TextInput: {
      title: 'Text Input',
      inputs: [],
      outputs: [{ name: 'text' }],
      schema: [
        { key: 'placeholder', label: 'Placeholder', type: 'text', placeholder: 'Type a message…' }
      ]
    },
    TextDisplay: {
      title: 'Text Display',
      inputs: [{ name: 'text' }],
      outputs: [],
      schema: []
    },
    Template: {
      title: 'Template',
      inputs: [{ name: 'trigger' }],
      outputs: [{ name: 'text' }],
      schema: [
        { key: 'template', label: 'Template Text', type: 'textarea', placeholder: 'Hello {name}, welcome to {place}.' }
      ]
    },
    NknDM: {
      title: 'NKN DM',
      inputs: [{ name: 'text' }],
      outputs: [{ name: 'incoming' }, { name: 'status' }, { name: 'raw' }],
      schema: [
        { key: 'address', label: 'Target Address', type: 'text', placeholder: 'nkn...' },
        { key: 'chunkBytes', label: 'Chunk Size (bytes)', type: 'number', def: 1800 },
        { key: 'heartbeatInterval', label: 'Heartbeat (s)', type: 'number', def: 15 }
      ]
    }
  };

  const TEMPLATE_VAR_RE = /\{([a-zA-Z0-9_]+)\}/g;

  function extractPayloadText(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'number') return String(payload);
    if (typeof payload === 'boolean') return payload ? 'true' : 'false';
    if (typeof payload !== 'object') return String(payload);
    if (payload.text != null) return String(payload.text);
    if (payload.value != null) return String(payload.value);
    if (payload.content != null) return String(payload.content);
    if (payload.data != null) return String(payload.data);
    try {
      return JSON.stringify(payload);
    } catch (err) {
      return String(payload);
    }
  }

  function extractTemplateVariables(template) {
    const names = new Set();
    String(template || '').replace(TEMPLATE_VAR_RE, (_, name) => {
      if (name) names.add(name);
      return '';
    });
    return Array.from(names);
  }

  function renderTemplateString(template, variables) {
    const vars = variables || {};
    return String(template || '').replace(TEMPLATE_VAR_RE, (_, name) => {
      const value = vars[name];
      return value != null ? String(value) : '';
    });
  }

  function updateTemplatePreview(node, cfg, renderedText) {
    const preview = node.el?.querySelector('[data-template-preview]');
    if (!preview) return;
    const text = renderedText ?? renderTemplateString(cfg?.template, cfg?.variables);
    preview.textContent = text || '';
  }

  function emitTemplate(nodeId, cfg) {
    const node = WS.nodes.get(nodeId);
    if (!node) return;
    const config = cfg || NodeStore.ensure(nodeId, 'Template').config || {};
    const text = renderTemplateString(config.template, config.variables);
    updateTemplatePreview(node, config, text);
    Router.sendFrom(nodeId, 'text', {
      nodeId,
      type: 'text',
      text,
      template: config.template,
      variables: config.variables
    });
  }

  function handleTemplateTrigger(nodeId) {
    const updated = pullTemplateInputs(nodeId);
    emitTemplate(nodeId, updated);
  }

  function handleTemplateVariable(nodeId, varName, payload) {
    const node = WS.nodes.get(nodeId);
    if (!node) return;
    const incoming = extractPayloadText(payload);
    const current = NodeStore.ensure(nodeId, 'Template').config || {};
    const vars = { ...(current.variables || {}) };
    vars[varName] = incoming;
    const updated = NodeStore.update(nodeId, { type: 'Template', variables: vars });
    updateTemplatePreview(node, updated);
    emitTemplate(nodeId, updated);
  }

  function removeTemplatePort(node, portName, portEl) {
    removeWiresAt(node.id, 'in', portName);
    if (portEl) {
      for (const [key, value] of Array.from(Router.ports.entries())) {
        if (value && value.el === portEl) {
          Router.ports.delete(key);
        }
      }
      portEl.remove();
    }
  }

  function createTemplateVariablePort(node, leftContainer, varName) {
    if (!leftContainer) return null;
    const portEl = document.createElement('div');
    portEl.className = 'wp-port in';
    portEl.dataset.port = varName;
    portEl.dataset.templateVar = varName;
    portEl.title = `${varName} (Alt-click to disconnect)`;
    portEl.innerHTML = `<span class="dot"></span><span>${varName}</span>`;

    portEl.addEventListener('click', (ev) => {
      if (ev.altKey || ev.metaKey || ev.ctrlKey) {
        removeTemplatePort(node, varName, portEl);
        return;
      }
      onPortClick(node.id, 'in', varName, portEl);
    });

    portEl.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'touch') ev.preventDefault();
      const wires = connectedWires(node.id, 'in', varName);
      if (wires.length) {
        const w = wires[wires.length - 1];
        w.path?.setAttribute('stroke-dasharray', '6 4');
        const move = (e) => {
          if (e.pointerType === 'touch') e.preventDefault();
          if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
          const pt = clientToWorkspace(e.clientX, e.clientY);
          drawRetarget(w, 'to', pt.x, pt.y);
          if (WS.drag) updateDropHover(WS.drag.expected);
        };
        const up = (e) => {
          setDropHover(null);
          finishAnyDrag(e.clientX, e.clientY);
        };
        WS.drag = {
          kind: 'retarget',
          wireId: w.id,
          grabSide: 'to',
          path: w.path,
          pointerId: ev.pointerId,
          expected: 'out',
          lastClient: { x: ev.clientX, y: ev.clientY },
          _cleanup: () => window.removeEventListener('pointermove', move)
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true, passive: false });
        updateDropHover('out');
        return;
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'rgba(255,255,255,.6)');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('opacity', '0.9');
      path.setAttribute('stroke-dasharray', '6 4');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('pointer-events', 'none');
      WS.svgLayer.appendChild(path);

      const move = (e) => {
        if (e.pointerType === 'touch') e.preventDefault();
        if (WS.drag) WS.drag.lastClient = { x: e.clientX, y: e.clientY };
        const pt = clientToWorkspace(e.clientX, e.clientY);
        drawTempFromPort({ nodeId: node.id, side: 'in', portName: varName }, pt.x, pt.y);
        updateDropHover(WS.drag?.expected);
      };
      const up = (e) => {
        setDropHover(null);
        finishAnyDrag(e.clientX, e.clientY);
      };
      WS.drag = {
        kind: 'newFromInput',
        toNodeId: node.id,
        toPort: varName,
        path,
        pointerId: ev.pointerId,
        expected: 'out',
        lastClient: { x: ev.clientX, y: ev.clientY },
        _cleanup: () => window.removeEventListener('pointermove', move)
      };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up, { once: true, passive: false });
      const pt = clientToWorkspace(ev.clientX, ev.clientY);
      drawTempFromPort({ nodeId: node.id, side: 'in', portName: varName }, pt.x, pt.y);
      updateDropHover('out');
    });

    leftContainer.appendChild(portEl);
    Router.register(`${node.id}:in:${varName}`, portEl, (payload) => handleTemplateVariable(node.id, varName, payload));
    return portEl;
  }

  function rebuildTemplateVariablePorts(node, leftContainer, cfg) {
    if (!leftContainer) return;
    node._templateVarPorts = node._templateVarPorts || new Map();
    const ports = node._templateVarPorts;
    const desiredVars = new Set(Object.keys((cfg && cfg.variables) || {}));

    for (const [varName, portEl] of Array.from(ports.entries())) {
      if (!desiredVars.has(varName)) {
        removeTemplatePort(node, varName, portEl);
        ports.delete(varName);
      }
    }

    desiredVars.forEach((varName) => {
      if (!ports.has(varName)) {
        const elPort = createTemplateVariablePort(node, leftContainer, varName);
        ports.set(varName, elPort);
      }
    });

    requestRedraw();
  }

  function setupTemplateNode(node, leftContainer) {
    const textarea = node.el?.querySelector('[data-template-editor]');
    const config = NodeStore.ensure(node.id, 'Template').config || {};
    const ensureVars = () => {
      const fresh = NodeStore.ensure(node.id, 'Template').config || {};
      const existingVars = { ...(fresh.variables || {}) };
      const names = extractTemplateVariables(fresh.template || '');
      let changed = false;
      const nextVars = {};
      names.forEach((name) => {
        if (Object.prototype.hasOwnProperty.call(existingVars, name)) {
          nextVars[name] = existingVars[name];
        } else {
          nextVars[name] = '';
        }
        if (!(name in existingVars)) changed = true;
      });
      for (const key of Object.keys(existingVars)) {
        if (!names.includes(key)) {
          changed = true;
        }
      }
      if (changed) {
        return NodeStore.update(node.id, { type: 'Template', variables: nextVars });
      }
      return fresh;
    };

    if (textarea) {
      if (!node._templateReady) {
        textarea.addEventListener('input', () => {
          const templateText = textarea.value || '';
          const existing = NodeStore.ensure(node.id, 'Template').config || {};
          const vars = { ...(existing.variables || {}) };
          const names = extractTemplateVariables(templateText);
          const nextVars = {};
          names.forEach((name) => {
            nextVars[name] = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : '';
          });
          const updated = NodeStore.update(node.id, { type: 'Template', template: templateText, variables: nextVars });
          rebuildTemplateVariablePorts(node, leftContainer, updated);
          updateTemplatePreview(node, updated);
        });
        node._templateReady = true;
      }
      textarea.value = config.template || '';
    }

    const updatedCfg = ensureVars();
    rebuildTemplateVariablePorts(node, leftContainer, updatedCfg);
    updateTemplatePreview(node, updatedCfg);
  }

  function pullTemplateInputs(nodeId) {
    const node = WS.nodes.get(nodeId);
    if (!node) return NodeStore.ensure(nodeId, 'Template').config || {};
    let config = NodeStore.ensure(nodeId, 'Template').config || {};
    const vars = { ...(config.variables || {}) };
    let changed = false;

    const names = Object.keys(vars);
    names.forEach((name) => {
      const wires = WS.wires.filter((w) => w.to.node === nodeId && w.to.port === name);
      for (const wire of wires) {
        const srcNode = WS.nodes.get(wire.from.node);
        if (!srcNode) continue;
        if (srcNode.type === 'TextInput') {
          const srcCfg = NodeStore.ensure(srcNode.id, 'TextInput').config || {};
          const candidate = srcCfg.text || srcCfg.lastSent || '';
          if (candidate !== vars[name]) {
            vars[name] = candidate;
            changed = true;
          }
          break;
        } else if (srcNode.type === 'Template') {
          const srcCfg = NodeStore.ensure(srcNode.id, 'Template').config || {};
          const candidate = renderTemplateString(srcCfg.template, srcCfg.variables);
          if (candidate !== vars[name]) {
            vars[name] = candidate;
            changed = true;
          }
          break;
        }
      }
    });

    if (changed) {
      config = NodeStore.update(nodeId, { type: 'Template', variables: vars });
      updateTemplatePreview(node, config);
    }
    return config;
  }

  function initTextInputNode(node) {
    const textarea = node.el?.querySelector('[data-textinput-field]');
    const sendBtn = node.el?.querySelector('[data-textinput-send]');
    const cfg = NodeStore.ensure(node.id, 'TextInput').config || {};
    if (textarea) {
      textarea.placeholder = cfg.placeholder || 'Type a message…';
      if (!node._textInputReady) {
        let suppressInput = false;
        const saveDraft = () => {
          if (suppressInput) return;
          NodeStore.update(node.id, { type: 'TextInput', text: textarea.value });
        };
        const send = () => {
          const current = textarea.value;
          const value = current.trim();
          if (!value) return;
          NodeStore.update(node.id, { type: 'TextInput', text: '', lastSent: value });
          Router.sendFrom(node.id, 'text', { nodeId: node.id, type: 'text', text: value });
          suppressInput = true;
          textarea.value = '';
          suppressInput = false;
        };
        sendBtn?.addEventListener('click', send);
        textarea.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        });
        textarea.addEventListener('input', saveDraft);
        node._textInputReady = true;
      }
      textarea.value = cfg.text || '';
    }
  }

  function updateTextDisplayContent(nodeId, text) {
    const node = WS.nodes.get(nodeId);
    const normalized = text != null ? String(text) : '';
    NodeStore.update(nodeId, { type: 'TextDisplay', text: normalized });
    const contentEl = node?.el?.querySelector('[data-textdisplay-content]');
    if (contentEl) {
      contentEl.textContent = normalized;
      contentEl.dataset.empty = normalized ? 'false' : 'true';
    }
  }

  function initTextDisplayNode(node) {
    const contentEl = node.el?.querySelector('[data-textdisplay-content]');
    const copyBtn = node.el?.querySelector('[data-textdisplay-copy]');
    const cfg = NodeStore.ensure(node.id, 'TextDisplay').config || {};
    if (contentEl) {
      contentEl.textContent = cfg.text || '';
      contentEl.dataset.empty = cfg.text ? 'false' : 'true';
    }
    if (copyBtn && !copyBtn._textDisplayBound) {
      copyBtn.addEventListener('click', async () => {
        try {
          const current = NodeStore.ensure(node.id, 'TextDisplay').config?.text || '';
          if (!current) {
            setBadge('Nothing to copy', false);
            return;
          }
          const hasClipboard = typeof navigator !== 'undefined' && navigator?.clipboard?.writeText;
          if (hasClipboard) {
            await navigator.clipboard.writeText(current);
            setBadge('Text copied');
          } else if (typeof document !== 'undefined' && document?.body) {
            const textarea = document.createElement('textarea');
            textarea.value = current;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            setBadge('Text copied');
          } else {
            setBadge('Copy not supported here', false);
          }
        } catch (err) {
          setBadge(`Copy failed: ${err?.message || err}`, false);
        }
      });
      copyBtn._textDisplayBound = true;
    }
  }

  function handleTextDisplayInput(nodeId, payload) {
    const text = extractPayloadText(payload);
    updateTextDisplayContent(nodeId, text);
  }

  function extractSystemTextFromNode(node) {
    if (!node) return '';
    const type = node.type;
    if (type === 'TextInput') {
      const cfg = NodeStore.ensure(node.id, 'TextInput').config || {};
      const last = typeof cfg.lastSent === 'string' ? cfg.lastSent : '';
      if (last && last.trim()) return last;
      return '';
    }
    if (type === 'Template') {
      const cfg = NodeStore.ensure(node.id, 'Template').config || {};
      return renderTemplateString(cfg.template, cfg.variables) || '';
    }
    if (type === 'TextDisplay') {
      const cfg = NodeStore.ensure(node.id, 'TextDisplay').config || {};
      return typeof cfg.text === 'string' ? cfg.text : '';
    }
    if (type === 'NknDM') {
      const cfg = NodeStore.ensure(node.id, 'NknDM').config || {};
      if (typeof cfg.lastPayload === 'string') return cfg.lastPayload;
      if (cfg.peer?.address) return cfg.peer.address;
      return '';
    }
    const cfg = NodeStore.ensure(node.id, type).config || {};
    if (typeof cfg.text === 'string') return cfg.text;
    return '';
  }

  function pullLlmSystemInput(nodeId) {
    const llmNode = WS.nodes.get(nodeId);
    const current = NodeStore.ensure(nodeId, 'LLM').config || {};
    if (!llmNode) return current;
    const wires = WS.wires.filter((w) => w.to.node === nodeId && w.to.port === 'system');
    if (!wires.length) return current;
    let chosen = '';
    for (const wire of wires) {
      const sourceNode = WS.nodes.get(wire.from.node);
      const candidate = extractSystemTextFromNode(sourceNode);
      if (!chosen) chosen = candidate || '';
      if (candidate && candidate.trim()) {
        chosen = candidate;
        break;
      }
    }
    const text = typeof chosen === 'string' ? chosen : String(chosen || '');
    const trimmed = text.trim();
    if (!trimmed) return current;
    if (trimmed === current.system && current.useSystem) return current;
    const patch = { type: 'LLM', system: trimmed, useSystem: true };
    return NodeStore.update(nodeId, patch);
  }

  function initNknDmNode(node) {
    const copyBtn = node.el?.querySelector('[data-nkndm-copy]');
    const approveBtn = node.el?.querySelector('[data-nkndm-approve]');
    const revokeBtn = node.el?.querySelector('[data-nkndm-revoke]');
    if (copyBtn && !copyBtn._nkndmCopyBound) {
      copyBtn.addEventListener('click', async () => {
        const localEl = node.el?.querySelector('[data-nkndm-local]');
        const text = localEl?.textContent?.trim();
        if (!text) {
          setBadge('Nothing to copy', false);
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          setBadge('Local NKN address copied');
        } catch (err) {
          setBadge('Clipboard unavailable', false);
        }
      });
      copyBtn._nkndmCopyBound = true;
    }
    if (approveBtn && !approveBtn._nkndmApproveBound) {
      approveBtn.addEventListener('click', () => {
        NknDM.approvePeer(node.id);
      });
      approveBtn._nkndmApproveBound = true;
    }
    if (revokeBtn && !revokeBtn._nkndmRevokeBound) {
      revokeBtn.addEventListener('click', () => {
        NknDM.revokePeer(node.id);
      });
      revokeBtn._nkndmRevokeBound = true;
    }
    NknDM.init(node.id);
  }

  function openSettings(nodeId) {
    const node = WS.nodes.get(nodeId);
    if (!node) return;
    const rec = NodeStore.ensure(nodeId, node.type);
    const cfg = rec.config || {};
    const modal = qs('#settingsModal');
    const fields = qs('#settingsFields');
    const help = qs('#settingsHelp');
    const form = qs('#settingsForm');
    fields.innerHTML = '';
    const schema = GraphTypes[node.type].schema || [];
    for (const field of schema) {
      const label = document.createElement('label');
      label.textContent = field.label;
      if (node.type === 'NknDM' && field.key === 'address') {
        const row = document.createElement('div');
        row.className = 'nkndm-settings-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.name = field.key;
        input.placeholder = field.placeholder || '';
        input.value = (cfg[field.key] !== undefined && cfg[field.key] !== null)
          ? String(cfg[field.key])
          : '';
        row.appendChild(input);

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'secondary';
        sendBtn.textContent = 'Send';
        sendBtn.dataset.nkndmSettingsSend = 'true';
        row.appendChild(sendBtn);

        const pingBtn = document.createElement('button');
        pingBtn.type = 'button';
        pingBtn.className = 'ghost';
        pingBtn.textContent = 'Ping';
        pingBtn.dataset.nkndmSettingsPing = 'true';
        row.appendChild(pingBtn);

        const spinner = document.createElement('span');
        spinner.className = 'dm-spinner hidden';
        spinner.dataset.nkndmSettingsSpinner = 'true';
        row.appendChild(spinner);

        const status = document.createElement('span');
        status.className = 'nkndm-settings-status';
        status.dataset.nkndmSettingsStatus = 'idle';
        row.appendChild(status);

        const wrap = document.createElement('div');
        wrap.className = 'nkndm-settings-control';
        wrap.appendChild(row);

        const peerInfo = document.createElement('div');
        peerInfo.className = 'nkndm-settings-peer';
        peerInfo.dataset.nkndmSettingsPeer = 'true';
        peerInfo.textContent = '—';
        wrap.appendChild(peerInfo);

        fields.appendChild(label);
        fields.appendChild(wrap);
        continue;
      }
      if (field.type === 'select') {
        const select = document.createElement('select');
        select.name = field.key;
        const currentValue = String((cfg[field.key] ?? field.def ?? ''));
        const addOption = (val, text = val) => {
          const opt = document.createElement('option');
          opt.value = String(val);
          opt.textContent = String(text);
          select.appendChild(opt);
        };
        if ((field.key === 'model' || (node.type === 'ASR' && field.key === 'prevModel')) &&
          (node.type === 'LLM' || node.type === 'TTS' || node.type === 'ASR')) {
          addOption('', '— loading models… —');
          select.value = '';
          (async () => {
            try {
              const viaNkn = CFG.transport === 'nkn';
              const base = cfg.base || '';
              const api = cfg.api || '';
              const relay = cfg.relay || '';
              const list = node.type === 'LLM'
                ? await discoverLLMModels(base, api, viaNkn, relay)
                : node.type === 'TTS'
                  ? await discoverTTSModels(base, api, viaNkn, relay)
                  : await discoverASRModels(base, api, viaNkn, relay);
              select.innerHTML = '';
              if (!list.length) addOption('', '— no models found —');
              for (const name of list) addOption(name);
              if (currentValue && !list.includes(currentValue)) addOption(currentValue, `${currentValue} (saved)`);
              select.value = currentValue || (list[0] ?? '');
            } catch (err) {
              select.innerHTML = '';
              if (currentValue) addOption(currentValue, `${currentValue} (saved)`);
              addOption('', '— fetch failed —');
              select.value = currentValue || '';
            }
          })();
        } else {
          for (const opt of field.options || []) addOption(opt);
          select.value = currentValue;
        }
        fields.appendChild(label);
        fields.appendChild(select);
      } else {
        const input = field.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
        if (field.type !== 'textarea') input.type = field.type || 'text';
        if (field.placeholder) input.placeholder = field.placeholder;
        input.name = field.key;
        input.value = (cfg[field.key] !== undefined && cfg[field.key] !== null) ? String(cfg[field.key]) : String(field.def ?? '');
        if (field.step) input.step = field.step;
        let control = input;
        if (field.key === 'relay') {
          const wrap = document.createElement('div');
          wrap.className = 'input-with-btn';
          wrap.appendChild(input);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ghost';
          btn.textContent = 'Scan QR';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            openQrScanner(input);
          });
          wrap.appendChild(btn);
          control = wrap;
        }
        fields.appendChild(label);
        fields.appendChild(control);
      }
    }
    form.dataset.nodeId = nodeId;
    help.textContent = `${GraphTypes[node.type].title} • ${nodeId}`;
    if (node.type === 'NknDM') {
      const sendBtn = fields.querySelector('[data-nkndm-settings-send]');
      const pingBtn = fields.querySelector('[data-nkndm-settings-ping]');
      if (sendBtn && !sendBtn._nkndmBound) {
        sendBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const input = fields.querySelector('input[name="address"]');
          const spinner = fields.querySelector('[data-nkndm-settings-spinner]');
          const statusEl = fields.querySelector('[data-nkndm-settings-status]');
          const value = input?.value?.trim?.() || '';
          NodeStore.update(nodeId, { type: 'NknDM', address: value });
          if (spinner) spinner.classList.remove('hidden');
          if (statusEl) {
            statusEl.textContent = '…';
            statusEl.classList.add('pending');
            statusEl.classList.remove('ok', 'err');
          }
          NknDM.refresh(nodeId);
          NknDM.sendHandshake(nodeId, () => {
            if (spinner) spinner.classList.add('hidden');
            NknDM.refresh(nodeId);
          });
        });
        sendBtn._nkndmBound = true;
      }
      if (pingBtn && !pingBtn._nkndmBound) {
        pingBtn.addEventListener('click', (e) => {
          e.preventDefault();
          NknDM.sendProbe(nodeId);
        });
        pingBtn._nkndmBound = true;
      }
      NknDM.refresh(nodeId);
    }
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    const modal = qs('#settingsModal');
    const form = qs('#settingsForm');
    delete form.dataset.nodeId;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    closeQrScanner();
  }

  function bindModal() {
    qs('#closeSettings')?.addEventListener('click', closeSettings);
    qs('#cancelSettings')?.addEventListener('click', closeSettings);
    qs('#closeBackdrop')?.addEventListener('click', closeSettings);
    qs('#saveSettings')?.addEventListener('click', (e) => {
      e.preventDefault();
      const form = qs('#settingsForm');
      const nodeId = form.dataset.nodeId;
      if (!nodeId) return;
      const node = WS.nodes.get(nodeId);
      if (!node) return;
      const fd = new FormData(form);
      const patch = {};
      for (const [k, v] of fd.entries()) {
        const schema = (GraphTypes[node.type].schema || []).find((s) => s.key === k);
        if (!schema) {
          patch[k] = String(v);
          continue;
        }
        if (schema.type === 'number') {
          const num = Number(String(v).trim());
          patch[k] = Number.isFinite(num) ? num : undefined;
        } else if (schema.type === 'select') {
          if (v === 'true' || v === 'false') patch[k] = v === 'true';
          else if (/^\d+$/.test(String(v))) patch[k] = Number(v);
          else patch[k] = String(v);
        } else {
          patch[k] = String(v);
        }
      }
      patch.type = node.type;
      const updatedCfg = NodeStore.update(nodeId, patch);
      if (node.type === 'TTS') {
        TTS.refreshUI(node.id);
      }
      if (node.type === 'TextInput') {
        initTextInputNode(node);
      }
      if (node.type === 'Template') {
        const leftSide = node.el?.querySelector('.side.left');
        setupTemplateNode(node, leftSide);
      }
      if (node.type === 'NknDM') {
        initNknDmNode(node);
      }
      if (node.type === 'Template') {
        pullTemplateInputs(nodeId);
      }
      setBadge('Settings saved');
      closeSettings();
    });
  }

  function addNode(type, x = 70, y = 70) {
    const id = uid();
    const node = { id, type, x, y };
    NodeStore.ensure(id, type);
    node.el = makeNodeEl(node);
    WS.canvas.appendChild(node.el);
    WS.nodes.set(id, node);
    if (type === 'TTS') requestAnimationFrame(() => TTS.refreshUI(id));
    if (type === 'TextInput') requestAnimationFrame(() => initTextInputNode(node));
    if (type === 'TextDisplay') requestAnimationFrame(() => initTextDisplayNode(node));
    if (type === 'Template') requestAnimationFrame(() => {
      const leftSide = node.el?.querySelector('.side.left');
      setupTemplateNode(node, leftSide);
      pullTemplateInputs(id);
    });
    if (type === 'NknDM') requestAnimationFrame(() => initNknDmNode(node));
    saveGraph();
    requestRedraw();
    return node;
  }

  function removeNode(nodeId) {
    const node = WS.nodes.get(nodeId);
    if (!node) return;
    if (node._ro) {
      try {
        node._ro.disconnect();
      } catch (err) {
        // ignore
      }
      delete node._ro;
    }
    if (node.type === 'NknDM') {
      NknDM.dispose(nodeId);
    }

    WS.wires.slice().forEach((w) => {
      if (w.from.node === nodeId || w.to.node === nodeId) {
        w.path?.remove();
        WS.wires = WS.wires.filter((x) => x !== w);
      }
    });
    node.el.remove();
    WS.nodes.delete(nodeId);
    NodeStore.erase(nodeId);
    syncRouterFromWS();
    saveGraph();
    requestRedraw();
    if (ASR.ownerId === nodeId) ASR.stop();
  }

  function exportGraph() {
    const data = LS.get('graph.workspace', { nodes: [], links: [], nodeConfigs: {} });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'realtime-graph.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importGraph() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      file.text()
        .then((text) => {
          const data = JSON.parse(text);
          LS.set('graph.workspace', data);
          loadGraph();
          setBadge('Graph imported');
        })
        .catch((err) => setBadge('Import failed: ' + err.message, false));
    };
    input.click();
  }

  function bindToolbar() {
    const menuToggle = qs('#nodeMenuToggle');
    const menuList = qs('#nodeMenuList');

    const nodeButtons = [
      { type: 'ASR', label: 'ASR Node', x: 90, y: 120 },
      { type: 'LLM', label: 'LLM Node', x: 360, y: 160 },
      { type: 'TTS', label: 'TTS Node', x: 650, y: 200 },
      { type: 'TextInput', label: 'Text Input', x: 420, y: 120 },
      { type: 'TextDisplay', label: 'Text Display', x: 540, y: 180 },
      { type: 'Template', label: 'Template', x: 540, y: 220 },
      { type: 'NknDM', label: 'NKN DM', x: 720, y: 140 }
    ];

    if (menuList) {
      menuList.innerHTML = '';
      nodeButtons.forEach((btnDef) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost';
        btn.textContent = btnDef.label;
        btn.addEventListener('click', () => {
          menuList.classList.add('hidden');
          addNode(btnDef.type, btnDef.x, btnDef.y);
        });
        menuList.appendChild(btn);
      });
    }

    if (menuToggle && menuList) {
      menuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        menuList.classList.toggle('hidden');
      });

      document.addEventListener('click', (e) => {
        if (!menuList.classList.contains('hidden')) {
          const target = e.target;
          if (!menuList.contains(target) && target !== menuToggle) {
            menuList.classList.add('hidden');
          }
        }
      });
    }

    qs('#exportGraph')?.addEventListener('click', exportGraph);
    qs('#importGraph')?.addEventListener('click', importGraph);
  }

  function cancelLinking() {
    if (WS.portSel?.el) WS.portSel.el.classList.remove('sel');
    WS.portSel = null;
    clearTempLink();
    setBadge('Linking cancelled');
  }

  function bindWorkspaceCancels() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (WS.portSel || WS.drag)) cancelLinking();
    });
    WS.el.addEventListener('pointerdown', (e) => {
      if (e.target === WS.el && (WS.portSel || WS.drag)) cancelLinking();
    });
    WS.svg.addEventListener('pointerdown', (e) => {
      if (e.target === WS.svg && (WS.portSel || WS.drag)) cancelLinking();
    });
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function zoomAt(clientX, clientY, dz) {
    const rect = WS.root?.getBoundingClientRect?.() || document.body.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const s0 = WS.view.scale;
    const s1 = clamp(s0 * Math.exp(dz), 0.4, 3.0);
    if (s1 === s0) return;
    const wx = (mx - WS.view.x) / s0;
    const wy = (my - WS.view.y) / s0;
    WS.view.x = mx - wx * s1;
    WS.view.y = my - wy * s1;
    WS.view.scale = s1;
    applyViewTransform();
  }

  function _hasScrollableY(el) {
    const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
  }

  function _hasScrollableX(el) {
    const cs = getComputedStyle(el);
    return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
  }

  function _nodeCanConsumeWheel(target, dx, dy, rootStop) {
    let cur = target instanceof Element ? target : null;
    while (cur && cur !== rootStop) {
      const isNode = cur.classList?.contains?.('node');
      if (_hasScrollableY(cur)) {
        const top = cur.scrollTop;
        const max = cur.scrollHeight - cur.clientHeight;
        if ((dy < 0 && top > 0) || (dy > 0 && top < max - 1)) return true;
      }
      if (_hasScrollableX(cur)) {
        const left = cur.scrollLeft;
        const maxX = cur.scrollWidth - cur.clientWidth;
        if ((dx < 0 && left > 0) || (dx > 0 && left < maxX - 1)) return true;
      }
      if (isNode) {
        cur = cur.parentElement;
        break;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function bindViewportControls() {
    let pan = null;
    const touches = new Map();
    let pinch = null;

    const updateTouch = (id, x, y) => {
      if (touches.has(id)) touches.set(id, { x, y });
    };

    const removeTouch = (id) => {
      touches.delete(id);
      if (pinch && !pinch.ids.every((pid) => touches.has(pid))) pinch = null;
    };

    const maybeStartPinch = () => {
      if (pinch || touches.size < 2 || WS.drag) return;
      const entries = Array.from(touches.entries()).slice(0, 2);
      if (entries.length < 2) return;
      const [[idA, a], [idB, b]] = entries;
      const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      pinch = { ids: [idA, idB], startDist: dist, startScale: WS.view.scale };
      pan = null;
    };

    const onPanDown = (e) => {
      const hitNode = e.target.closest('.node');
      const hitPort = e.target.closest('.wp-port');
      const hitResize = e.target.closest('[data-resize]');
      const hitWire = e.target.closest('path[data-id]');
      const isBackground = !hitNode && !hitPort && !hitResize && !hitWire && (
        e.target === WS.root ||
        e.target === WS.el ||
        e.target === WS.svg ||
        e.target.closest('#workspace') ||
        e.target.closest('#linksSvg')
      );
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        maybeStartPinch();
        e.preventDefault();
        if (pinch) return;
      }
      if (!isBackground || pinch) return;
      pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: WS.view.x, oy: WS.view.y, pointerType: e.pointerType };
      if (e.pointerType !== 'touch') WS.root?.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'mouse') document.body.style.cursor = 'grabbing';
    };

    const onPanMove = (e) => {
      if (touches.has(e.pointerId)) {
        updateTouch(e.pointerId, e.clientX, e.clientY);
        if (!pinch) maybeStartPinch();
      }
      if (pinch) {
        const pts = pinch.ids.map((id) => touches.get(id)).filter(Boolean);
        if (pts.length < 2) {
          pinch = null;
          return;
        }
        const dist = Math.max(10, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        const target = clamp(pinch.startScale * (dist / pinch.startDist), 0.4, 3.0);
        const current = WS.view.scale;
        if (target > 0 && Math.abs(target - current) > 1e-3) {
          const dz = Math.log(target / current);
          zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, dz);
        }
        return;
      }
      if (!pan || pan.id !== e.pointerId) return;
      const dx = e.clientX - pan.sx;
      const dy = e.clientY - pan.sy;
      WS.view.x = pan.ox + dx;
      WS.view.y = pan.oy + dy;
      applyViewTransform();
    };

    const onPanUp = (e) => {
      if (pan && pan.id === e.pointerId) {
        pan = null;
        if (e.pointerType === 'mouse') document.body.style.cursor = '';
      }
      removeTouch(e.pointerId);
    };

    const onPanCancel = (e) => {
      if (pan && pan.id === e.pointerId) {
        pan = null;
        if (e.pointerType === 'mouse') document.body.style.cursor = '';
      }
      removeTouch(e.pointerId);
    };

    const onWheel = (e) => {
      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const canScroll = _nodeCanConsumeWheel(e.target, dx, dy, WS.root);
      if (canScroll) return;
      e.preventDefault();
      const intensity = e.deltaMode === 1 ? 0.05 : 0.0015;
      const dz = -dy * intensity;
      zoomAt(e.clientX, e.clientY, dz);
    };

    const rootEl = WS.root || WS.el;
    rootEl.addEventListener('pointerdown', onPanDown, { passive: false });
    rootEl.addEventListener('pointermove', onPanMove, { passive: false });
    rootEl.addEventListener('pointerup', onPanUp, { passive: false });
    rootEl.addEventListener('pointercancel', onPanCancel, { passive: false });
    rootEl.addEventListener('pointerleave', onPanCancel, { passive: false });
    rootEl.addEventListener('wheel', onWheel, { passive: false });
  }

  function init() {
    WS.el = qs('#workspace');
    WS.svg = qs('#linksSvg');
    WS.root = WS.el?.parentElement || document.body;
    WS.canvas = qs('#wsCanvas');
    if (!WS.canvas) {
      WS.canvas = document.createElement('div');
      WS.canvas.id = 'wsCanvas';
      WS.el.appendChild(WS.canvas);
    }
    WS.root.style.position = 'relative';
    if (WS.svg) {
      WS.svg.style.position = 'absolute';
      WS.svg.style.left = '0';
      WS.svg.style.top = '0';
      WS.svg.style.width = '100%';
      WS.svg.style.height = '100%';
    }
    ensureSvgLayer();
    bindToolbar();
    bindModal();
    bindWorkspaceCancels();
    bindViewportControls();
    applyViewTransform();
    loadGraph();
    window.addEventListener('resize', () => requestRedraw());
    setTimeout(() => requestRedraw(), 50);
  }

  return {
    init,
    addNode,
    save: saveGraph,
    load: loadGraph,
    getNode: (id) => WS.nodes.get(id),
    refreshTransportButtons: refreshAllNodeTransport
  };
}

export { createGraph };
