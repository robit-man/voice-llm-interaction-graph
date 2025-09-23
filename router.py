#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Unified NKN router — multiplex Whisper ASR, Piper TTS, and Ollama over multiple NKN identities.

Features
- Spins up any number of NKN bridge sidecars (redundant addresses) from a single process
- Resilient Node.js bridge watcher with durable DM queue and exponential restart backoff
- Shared HTTP worker pool per node with streaming support (NDJSON lines, SSE, base64 chunks)
- Service helpers covering asr.* events and generic relay.http requests
- Curses dashboard listing all active addresses, queue depth, and recent activity
"""

import argparse
import base64
import codecs
import contextlib
import json
import logging
import os
import queue
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, IO, List, Optional, Tuple

# ──────────────────────────────────────────────────────────────
# Lightweight venv bootstrap so the router stays self-contained
# ──────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
VENV_DIR = BASE_DIR / ".venv_router"
BIN_DIR = VENV_DIR / ("Scripts" if os.name == "nt" else "bin")
PY_BIN = BIN_DIR / ("python.exe" if os.name == "nt" else "python")
PIP_BIN = BIN_DIR / ("pip.exe" if os.name == "nt" else "pip")


def _in_venv() -> bool:
    try:
        return Path(sys.executable).resolve() == PY_BIN.resolve()
    except Exception:
        return False


def _ensure_venv() -> None:
    if VENV_DIR.exists():
        return
    import venv

    venv.EnvBuilder(with_pip=True).create(VENV_DIR)
    subprocess.check_call([str(PY_BIN), "-m", "pip", "install", "--upgrade", "pip"], cwd=BASE_DIR)


def _ensure_deps() -> None:
    need = []
    for mod in ("requests", "python-dotenv", "qrcode"):
        try:
            if mod == "python-dotenv":
                __import__("dotenv")
            else:
                __import__(mod)
        except Exception:
            need.append(mod)
    if need:
        subprocess.check_call([str(PIP_BIN), "install", *need], cwd=BASE_DIR)


if not _in_venv():
    _ensure_venv()
    os.execv(str(PY_BIN), [str(PY_BIN), *sys.argv])

_ensure_deps()

import requests  # type: ignore
import qrcode  # type: ignore

try:
    import curses  # type: ignore
except Exception:  # pragma: no cover
    curses = None

# ──────────────────────────────────────────────────────────────
# Configuration bootstrap
# ──────────────────────────────────────────────────────────────
CONFIG_PATH = BASE_DIR / "router_config.json"
DEFAULT_TARGETS = {
    "ollama": "http://127.0.0.1:11434",
    "asr": "http://127.0.0.1:8126",
    "tts": "http://127.0.0.1:8123",
}

DAEMON_SENTINEL = Path.home() / ".unified_router_daemon.json"


class DaemonManager:
    """Lightweight sentinel-based daemon tracker."""

    def __init__(self, sentinel: Optional[Path] = None):
        self.sentinel = Path(sentinel or DAEMON_SENTINEL)

    def check(self) -> Optional[dict]:
        if not self.sentinel.exists():
            return None
        try:
            data = json.loads(self.sentinel.read_text())
        except Exception:
            data = {"error": "unreadable sentinel"}
        data.setdefault("path", str(self.sentinel))
        return data

    def enable(self, base_dir: Path, config_path: Path) -> dict:
        info = {
            "enabled": True,
            "ts": int(time.time()),
            "base_dir": str(base_dir),
            "config": str(config_path),
            "path": str(self.sentinel),
            "note": "Sentinel for external daemon integration."
        }
        self.sentinel.parent.mkdir(parents=True, exist_ok=True)
        self.sentinel.write_text(json.dumps(info, indent=2))
        return info

    def disable(self) -> None:
        if self.sentinel.exists():
            self.sentinel.unlink()

    def path(self) -> Path:
        return self.sentinel


# ──────────────────────────────────────────────────────────────
# QR helpers
# ──────────────────────────────────────────────────────────────
def _qr_matrix(text: str, error: str = "H", border: int = 2) -> List[List[bool]]:
    qr = qrcode.QRCode(
        version=None,
        error_correction={
            "L": qrcode.constants.ERROR_CORRECT_L,
            "M": qrcode.constants.ERROR_CORRECT_M,
            "Q": qrcode.constants.ERROR_CORRECT_Q,
            "H": qrcode.constants.ERROR_CORRECT_H,
        }.get(error.upper(), qrcode.constants.ERROR_CORRECT_H),
        box_size=1,
        border=max(0, border),
    )
    qr.add_data(text)
    qr.make(fit=True)
    return qr.get_matrix()


def render_qr_ascii(text: str, scale: int = 1, invert: bool = False) -> str:
    matrix = _qr_matrix(text)
    scale = max(1, int(scale))
    block_full = "█"
    block_up = "▀"
    block_down = "▄"
    blank = " "

    def pix(val: bool) -> bool:
        return not val if invert else val

    h = len(matrix)
    if not h:
        return text
    w = len(matrix[0])
    lines: List[str] = []
    for y in range(0, h, 2):
        top = matrix[y]
        bottom = matrix[y + 1] if (y + 1) < h else [False] * w
        row_chars: List[str] = []
        for x in range(w):
            t = pix(top[x])
            b = pix(bottom[x])
            if t and b:
                ch = block_full
            elif t:
                ch = block_up
            elif b:
                ch = block_down
            else:
                ch = blank
            row_chars.append(ch * scale)
        row = "".join(row_chars)
        for _ in range(scale):
            lines.append(row)
    lines.append("(scan with camera)")
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────
# Service watchdog (embedded)
# ──────────────────────────────────────────────────────────────
SERVICES_ROOT = BASE_DIR / ".services"
LOGS_ROOT = BASE_DIR / ".logs"
METADATA_ROOT = SERVICES_ROOT / "meta"


@dataclass
class ServiceDefinition:
    name: str
    repo_url: str
    script_path: str
    description: str

    @property
    def script_name(self) -> str:
        return Path(self.script_path).name


@dataclass
class ServiceState:
    definition: ServiceDefinition
    workdir: Path
    script_path: Path
    log_path: Path
    metadata_path: Path
    process: Optional[subprocess.Popen] = None
    supervisor: Optional[threading.Thread] = None
    stop_event: threading.Event = field(default_factory=threading.Event)
    restart_count: int = 0
    last_exit_code: Optional[int] = None
    last_exit_at: Optional[float] = None
    running_since: Optional[float] = None
    last_error: Optional[str] = None
    log_handle: Optional[IO[str]] = None
    terminal_proc: Optional[subprocess.Popen] = None
    fallback_mode: bool = False
    restart_attempts: int = 0

    def snapshot(self) -> Dict[str, object]:
        running = (self.process is not None and self.process.poll() is None) or self.fallback_mode
        if self.fallback_mode:
            status = "system fallback"
        elif running:
            status = "running"
        else:
            status = self.last_error or "stopped"
        return {
            "name": self.definition.name,
            "description": self.definition.description,
            "script": str(self.script_path),
            "log": str(self.log_path),
            "running": running,
            "pid": self.process.pid if self.process and self.process.poll() is None else None,
            "restart_count": self.restart_count,
            "running_since": self.running_since,
            "last_exit_code": self.last_exit_code,
            "last_exit_at": self.last_exit_at,
            "last_error": self.last_error,
            "status": status,
            "terminal_alive": self.terminal_proc is not None and self.terminal_proc.poll() is None,
            "fallback": self.fallback_mode,
        }


class ServiceWatchdog:
    """Supervises a set of long-running Python services."""

    TERMINAL_TEMPLATES = [
        ["x-terminal-emulator", "-T", "{title}", "-e", "bash", "-lc", "{cmd}"],
        ["gnome-terminal", "--title", "{title}", "--", "bash", "-lc", "{cmd}"],
        ["konsole", "-T", "{title}", "-e", "bash", "-lc", "{cmd}"],
        ["xterm", "-T", "{title}", "-e", "bash", "-lc", "{cmd}"],
        ["alacritty", "-t", "{title}", "-e", "bash", "-lc", "{cmd}"],
    ]

    DEFINITIONS: List[ServiceDefinition] = [
        ServiceDefinition(
            name="piper_tts",
            repo_url="https://github.com/robit-man/piper-tts-service.git",
            script_path="tts/tts_service.py",
            description="Piper text-to-speech REST service",
        ),
        ServiceDefinition(
            name="whisper_asr",
            repo_url="https://github.com/robit-man/whisper-asr-service.git",
            script_path="asr/asr_service.py",
            description="Whisper ASR streaming/batch REST service",
        ),
        ServiceDefinition(
            name="ollama_farm",
            repo_url="https://github.com/robit-man/ollama-nkn-relay.git",
            script_path="farm/ollama_farm.py",
            description="Ollama parallel proxy with concurrency guard",
        ),
    ]

    def __init__(self, base_dir: Optional[Path] = None, enable_logs: bool = True):
        self.base_dir = Path(base_dir or BASE_DIR)
        self.enable_logs = enable_logs
        SERVICES_ROOT.mkdir(parents=True, exist_ok=True)
        LOGS_ROOT.mkdir(parents=True, exist_ok=True)
        METADATA_ROOT.mkdir(parents=True, exist_ok=True)
        self._states: Dict[str, ServiceState] = {}
        self._global_stop = threading.Event()
        self._lock = threading.Lock()
        self._terminal_template = self._detect_terminal()
        if not self._terminal_template:
            print("[watchdog] No terminal emulator found; log windows will not be opened.")

    def ensure_sources(self) -> None:
        if not shutil.which("git"):
            raise SystemExit("git is required for ServiceWatchdog; please install git")

        for definition in self.DEFINITIONS:
            state = self._prepare_service(definition)
            self._states[definition.name] = state

    def start_all(self) -> None:
        for state in self._states.values():
            if state.supervisor and state.supervisor.is_alive():
                continue
            state.stop_event.clear()
            t = threading.Thread(target=self._run_service_loop, args=(state,), daemon=True)
            state.supervisor = t
            t.start()

    def shutdown(self, timeout: float = 15.0) -> None:
        self._global_stop.set()
        for state in self._states.values():
            state.stop_event.set()
            proc = state.process
            if proc and proc.poll() is None:
                with contextlib.suppress(Exception):
                    proc.terminate()
                try:
                    proc.wait(timeout=timeout)
                except Exception:
                    with contextlib.suppress(Exception):
                        proc.kill()
            term = state.terminal_proc
            if term and term.poll() is None:
                with contextlib.suppress(Exception):
                    term.terminate()
                try:
                    term.wait(timeout=timeout)
                except Exception:
                    with contextlib.suppress(Exception):
                        term.kill()
            state.terminal_proc = None
            if state.supervisor and state.supervisor.is_alive():
                state.supervisor.join(timeout=timeout)

    def get_snapshot(self) -> List[Dict[str, object]]:
        return [state.snapshot() for state in self._states.values()]

    # internal helpers -------------------------------------------------
    def _detect_terminal(self) -> Optional[List[str]]:
        for template in self.TERMINAL_TEMPLATES:
            if shutil.which(template[0]):
                return template
        return None

    def _prepare_service(self, definition: ServiceDefinition) -> ServiceState:
        svc_dir = SERVICES_ROOT / definition.name
        script_dest = svc_dir / definition.script_name
        svc_dir.mkdir(parents=True, exist_ok=True)
        log_path = LOGS_ROOT / f"{definition.name}.log"
        meta_path = METADATA_ROOT / f"{definition.name}.json"

        if not script_dest.exists():
            self._fetch_and_extract(definition, svc_dir, script_dest, meta_path)
        else:
            self._write_metadata(meta_path, definition, "cached")

        return ServiceState(
            definition=definition,
            workdir=svc_dir,
            script_path=script_dest,
            log_path=log_path,
            metadata_path=meta_path,
        )

    def _fetch_and_extract(self, definition: ServiceDefinition, svc_dir: Path, script_dest: Path, meta_path: Path) -> None:
        tmp_dir = SERVICES_ROOT / f"tmp_{definition.name}_{int(time.time())}"
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        subprocess.check_call(["git", "clone", "--depth", "1", definition.repo_url, str(tmp_dir)])
        source_file = tmp_dir / definition.script_path
        if not source_file.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise FileNotFoundError(f"Service script {definition.script_path} not found in repo {definition.repo_url}")
        svc_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source_file), str(script_dest))
        self._write_metadata(meta_path, definition, "fetched")
        shutil.rmtree(tmp_dir, ignore_errors=True)

    def _write_metadata(self, path: Path, definition: ServiceDefinition, status: str) -> None:
        meta = {
            "name": definition.name,
            "repo": definition.repo_url,
            "script": definition.script_path,
            "status": status,
            "ts": int(time.time()),
        }
        path.write_text(json.dumps(meta, indent=2))

    def _run_service_loop(self, state: ServiceState) -> None:
        backoff = 1.0
        state.restart_attempts = 0
        while not self._global_stop.is_set() and not state.stop_event.is_set():
            try:
                if state.definition.name == "ollama_farm":
                    if self._handle_ollama(state):
                        state.restart_attempts = 0
                        time.sleep(5)
                        continue
                else:
                    if self._manage_standard_service(state):
                        state.restart_attempts = 0
                        continue
            except Exception as exc:
                state.last_error = str(exc)
                state.last_exit_at = time.time()
                state.process = None
                self._close_log(state)
                state.last_exit_code = None
                state.restart_count += 1
                time.sleep(min(backoff, 60.0))
                backoff = min(backoff * 2.0, 60.0)
                state.restart_attempts += 1
                continue
            state.restart_count += 1
            state.restart_attempts += 1
            if state.definition.name != "ollama_farm" and state.restart_attempts == 1:
                self._free_ports(self._service_ports(state.definition.name))
                continue
            if state.restart_attempts <= 2:
                time.sleep(min(backoff, 60.0))
                backoff = min(backoff * 2.0, 60.0)
                continue
            state.last_error = state.last_error or "Repeated startup failures"
            state.process = None
            state.running_since = None
            self._close_log(state)
            break
        state.running_since = None

    def _start_process(self, state: ServiceState) -> None:
        if state.process and state.process.poll() is None:
            return
        python = sys.executable
        if not Path(python).exists():
            raise RuntimeError("Python executable not found for watchdog launch")
        log_file = open(state.log_path, "a", buffering=1, encoding="utf-8", errors="replace")
        state.log_handle = log_file
        cmd = [python, str(state.script_path)]
        state.process = subprocess.Popen(
            cmd,
            cwd=state.workdir,
            stdout=log_file,
            stderr=log_file,
            text=True,
            bufsize=1,
        )
        state.running_since = time.time()
        state.last_error = None
        log_file.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] watchdog: started {cmd}\n")
        log_file.flush()
        self._ensure_terminal_tail(state)

    def _handle_ollama(self, state: ServiceState) -> bool:
        if state.fallback_mode:
            if self._ollama_health_ok():
                state.last_error = None
            else:
                state.last_error = "system ollama unhealthy"
            return True

        if self._ollama_health_ok():
            state.fallback_mode = True
            state.last_error = None
            state.running_since = time.time()
            return True

        self._free_ports([11434, 8080])
        self._start_process(state)
        proc = state.process
        if not proc:
            state.last_error = "ollama_farm failed to spawn"
            return False
        ready = self._wait_for_ollama_health(timeout=20)
        if ready:
            state.last_error = None
            state.restart_attempts = 0
            return True

        state.last_error = "ollama_farm failed to start; falling back"
        self._terminate_process(state)
        if self._ollama_health_ok():
            state.fallback_mode = True
            state.running_since = time.time()
            state.process = None
            self._close_log(state)
            state.restart_attempts = 0
            return True
        state.last_error = "ollama fallback unavailable"
        return False

    def _manage_standard_service(self, state: ServiceState) -> bool:
        service_ports = self._service_ports(state.definition.name)
        if any(self._port_in_use(p) for p in service_ports if p > 0):
            self._free_ports(service_ports)
        self._start_process(state)
        proc = state.process
        if not proc:
            state.last_error = "spawn failed"
            return False
        ret = proc.wait()
        state.last_exit_code = ret
        state.last_exit_at = time.time()
        state.process = None
        self._close_log(state)
        if state.stop_event.is_set() or self._global_stop.is_set():
            return True
        state.last_error = f"Exited with code {ret}"
        return False

    def _service_ports(self, service_name: str) -> List[int]:
        if service_name == "piper_tts":
            return [8123]
        if service_name == "whisper_asr":
            return [8126]
        if service_name == "ollama_farm":
            return [11434, 8080]
        return []

    def _terminate_process(self, state: ServiceState) -> None:
        proc = state.process
        if proc and proc.poll() is None:
            with contextlib.suppress(Exception):
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                with contextlib.suppress(Exception):
                    proc.kill()
        state.process = None
        self._close_log(state)

    def _wait_for_ollama_health(self, timeout: float) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if self._ollama_health_ok():
                return True
            time.sleep(2)
        return False

    def _ollama_health_ok(self) -> bool:
        import urllib.request

        try:
            with urllib.request.urlopen("http://127.0.0.1:11434/", timeout=3) as resp:
                body = resp.read().decode("utf-8", "ignore")
                return "Ollama is running" in body
        except Exception:
            return False

    def _free_ports(self, ports: List[int]) -> None:
        for port in ports:
            if port <= 0:
                continue
            if not self._port_in_use(port):
                continue
            pids = self._find_pids_on_port(port)
            for pid in pids:
                with contextlib.suppress(Exception):
                    os.kill(pid, signal.SIGTERM)
            time.sleep(0.2)
            if self._port_in_use(port):
                pids = self._find_pids_on_port(port)
                for pid in pids:
                    with contextlib.suppress(Exception):
                        os.kill(pid, signal.SIGKILL)
                time.sleep(0.2)

    def _port_in_use(self, port: int) -> bool:
        import socket

        with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.2)
            try:
                return sock.connect_ex(("127.0.0.1", port)) == 0
            except Exception:
                return False

    def _find_pids_on_port(self, port: int) -> List[int]:
        pids: List[int] = []
        if shutil.which("lsof"):
            try:
                out = subprocess.check_output(["lsof", "-ti", f":{port}"], text=True)
                for line in out.splitlines():
                    with contextlib.suppress(Exception):
                        pids.append(int(line.strip()))
            except subprocess.CalledProcessError:
                pass
        elif shutil.which("fuser"):
            try:
                out = subprocess.check_output(["fuser", "-n", "tcp", str(port)], text=True)
                for token in out.split():
                    with contextlib.suppress(Exception):
                        pids.append(int(token))
            except subprocess.CalledProcessError:
                pass
        return pids

    def _ensure_terminal_tail(self, state: ServiceState) -> None:
        if not self._terminal_template:
            return
        if state.terminal_proc and state.terminal_proc.poll() is None:
            return
        title = f"{state.definition.name} logs"
        cmd = f"tail -n 200 -f {shlex.quote(str(state.log_path))}"
        args = [segment.format(title=title, cmd=cmd) for segment in self._terminal_template]
        try:
            state.terminal_proc = subprocess.Popen(args, cwd=state.workdir, start_new_session=True)
        except Exception as exc:
            state.last_error = f"terminal launch failed: {exc}"

    def _close_log(self, state: ServiceState) -> None:
        if state.log_handle:
            with contextlib.suppress(Exception):
                state.log_handle.flush()
                state.log_handle.close()
            state.log_handle = None
        term = state.terminal_proc
        if term:
            if term.poll() is None:
                with contextlib.suppress(Exception):
                    term.terminate()
                try:
                    term.wait(timeout=2)
                except Exception:
                    with contextlib.suppress(Exception):
                        term.kill()
            state.terminal_proc = None


# Router logging setup
ROUTER_LOG = LOGS_ROOT / "router.log"
ROUTER_LOG.parent.mkdir(parents=True, exist_ok=True)
LOGGER = logging.getLogger("unified_router")
if not LOGGER.handlers:
    file_handler = logging.FileHandler(ROUTER_LOG, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOGGER.addHandler(file_handler)
LOGGER.setLevel(logging.INFO)


def _default_config() -> dict:
    seeds = [secrets.token_hex(32) for _ in range(3)]
    return {
        "schema": 1,
        "targets": DEFAULT_TARGETS,
        "http": {
            "workers": 4,
            "max_body_b": 2 * 1024 * 1024,
            "verify_default": True,
            "chunk_raw_b": 12 * 1024,
            "heartbeat_s": 10,
            "batch_lines": 24,
            "batch_latency": 0.08,
            "retries": 4,
            "retry_backoff": 0.5,
            "retry_cap": 4.0,
        },
        "bridge": {
            "num_subclients": 2,
            "seed_ws": "",
            "self_probe_ms": 12000,
            "self_probe_fails": 3,
        },
        "nodes": [
            {"name": "relay-A", "seed_hex": seeds[0]},
            {"name": "relay-B", "seed_hex": seeds[1]},
            {"name": "relay-C", "seed_hex": seeds[2]},
        ],
        "service_assignments": {
            "piper_tts": "relay-A",
            "whisper_asr": "relay-B",
            "ollama_farm": "relay-C",
        },
    }


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(_default_config(), indent=2))
        print(f"→ wrote default config {CONFIG_PATH}")
    cfg = json.loads(CONFIG_PATH.read_text())
    if "schema" not in cfg:
        cfg["schema"] = 1
    # ensure targets exist
    cfg.setdefault("targets", DEFAULT_TARGETS.copy())
    http = cfg.setdefault("http", {})
    http.setdefault("workers", 4)
    http.setdefault("max_body_b", 2 * 1024 * 1024)
    http.setdefault("verify_default", True)
    http.setdefault("chunk_raw_b", 12 * 1024)
    http.setdefault("heartbeat_s", 10)
    http.setdefault("batch_lines", 24)
    http.setdefault("batch_latency", 0.08)
    http.setdefault("retries", 4)
    http.setdefault("retry_backoff", 0.5)
    http.setdefault("retry_cap", 4.0)
    bridge = cfg.setdefault("bridge", {})
    bridge.setdefault("num_subclients", 2)
    bridge.setdefault("seed_ws", "")
    bridge.setdefault("self_probe_ms", 12000)
    bridge.setdefault("self_probe_fails", 3)
    nodes = cfg.setdefault("nodes", [])
    if not nodes:
        nodes.extend(_default_config()["nodes"])
    cfg.setdefault("service_assignments", {})
    return cfg


# ──────────────────────────────────────────────────────────────
# Node.js bridge scaffold (shared for all RelayNodes)
# ──────────────────────────────────────────────────────────────
BRIDGE_DIR = BASE_DIR / "bridge-node"
BRIDGE_JS = BRIDGE_DIR / "nkn_bridge.js"
PKG_JSON = BRIDGE_DIR / "package.json"
BRIDGE_SRC = r"""
'use strict';
const nkn = require('nkn-sdk');
const readline = require('readline');

const SEED_HEX = (process.env.NKN_SEED_HEX || '').toLowerCase().replace(/^0x/,'');
const IDENT = String(process.env.NKN_IDENTIFIER || 'relay');
const NUM = parseInt(process.env.NKN_NUM_SUBCLIENTS || '2', 10) || 2;
const SEED_WS = (process.env.NKN_BRIDGE_SEED_WS || '').split(',').map(s=>s.trim()).filter(Boolean);
const PROBE_EVERY_MS = parseInt(process.env.NKN_SELF_PROBE_MS || '12000', 10);
const PROBE_FAILS_EXIT = parseInt(process.env.NKN_SELF_PROBE_FAILS || '3', 10);

function out(obj){
  try{ process.stdout.write(JSON.stringify(obj)+'\n'); }
  catch(e){ /* ignore */ }
}

function spawn(){
  if(!/^[0-9a-f]{64}$/.test(SEED_HEX)){
    out({type:'crit', msg:'bad seed'});
    process.exit(1);
  }

  const client = new nkn.MultiClient({
    seed: SEED_HEX,
    identifier: IDENT,
    numSubClients: NUM,
    seedWsAddr: SEED_WS.length ? SEED_WS : undefined,
    wsConnHeartbeatTimeout: 120000,
  });

  let probeFails = 0;
  let probeTimer = null;
  function startProbe(){
    stopProbe();
    probeTimer = setInterval(async ()=>{
      try {
        await client.send(String(client.addr||''), JSON.stringify({event:'relay.selfprobe', ts: Date.now()}), {noReply:true});
        probeFails = 0;
        out({type:'status', state:'probe_ok'});
      } catch (e){
        probeFails++;
        out({type:'status', state:'probe_fail', fails:probeFails, msg:String(e&&e.message||e)});
        if (probeFails >= PROBE_FAILS_EXIT){
          out({type:'status', state:'probe_exit'});
          process.exit(3);
        }
      }
    }, PROBE_EVERY_MS);
  }
  function stopProbe(){
    if (probeTimer){ clearInterval(probeTimer); probeTimer=null; }
  }

  client.on('connect', ()=>{
    out({type:'ready', address:String(client.addr||''), ts: Date.now()});
    startProbe();
  });
  client.on('error', (e)=>{ out({type:'status', state:'error', msg:String(e&&e.message||e)}); process.exit(2); });
  client.on('close', ()=>{ out({type:'status', state:'close'}); process.exit(2); });

  client.on('message', (a, b)=>{
    try{
      let src, payload;
      if (a && typeof a==='object' && a.payload!==undefined){ src=String(a.src||''); payload=a.payload; }
      else { src=String(a||''); payload=b; }
      const s = Buffer.isBuffer(payload) ? payload.toString('utf8') : (typeof payload==='string'? payload : String(payload));
      let parsed=null; try{ parsed=JSON.parse(s); }catch{}
      out({type:'nkn-dm', src, msg: parsed || {event:'<non-json>', raw:s}});
    }catch(e){ out({type:'err', msg:String(e&&e.message||e)}); }
  });

  const rl = readline.createInterface({input: process.stdin});
  rl.on('line', line=>{
    let cmd; try{ cmd=JSON.parse(line); }catch{return; }
    if(cmd && cmd.type==='dm' && cmd.to && cmd.data){
      const opts = cmd.opts || {noReply:true};
      client.send(cmd.to, JSON.stringify(cmd.data), opts).catch(err=>{
        out({type:'status', state:'send_error', msg:String(err&&err.message||err)});
      });
    }
  });

  process.on('exit', ()=>{ stopProbe(); if(probeTimer){ clearInterval(probeTimer);} });
  process.on('unhandledRejection', e=>{ out({type:'status', state:'unhandledRejection', msg:String(e)}); process.exit(1); });
  process.on('uncaughtException', e=>{ out({type:'status', state:'uncaughtException', msg:String(e)}); process.exit(1); });
}

spawn();
"""


def ensure_bridge() -> None:
    if not BRIDGE_DIR.exists():
        BRIDGE_DIR.mkdir(parents=True)
    if not shutil.which("node"):
        raise SystemExit("Node.js binary 'node' not found; install Node.js to run the router.")
    if not shutil.which("npm"):
        raise SystemExit("npm not found; install Node.js/npm to run the router.")
    if not PKG_JSON.exists():
        subprocess.check_call(["npm", "init", "-y"], cwd=BRIDGE_DIR)
        subprocess.check_call(["npm", "install", "nkn-sdk@^1.3.6"], cwd=BRIDGE_DIR)
    if not BRIDGE_JS.exists() or BRIDGE_JS.read_text() != BRIDGE_SRC:
        BRIDGE_JS.write_text(BRIDGE_SRC)


# ──────────────────────────────────────────────────────────────
# Unified curses UI
# ──────────────────────────────────────────────────────────────
class UnifiedUI:
    def __init__(self, enabled: bool):
        self.enabled = enabled and curses is not None and sys.stdout.isatty()
        self.events: "queue.Queue[tuple[str, str, str, str]]" = queue.Queue()
        self.nodes: Dict[str, dict] = {}
        self.services: Dict[str, dict] = {}
        self.daemon_info: Optional[dict] = None
        self.stop = threading.Event()
        self.action_handler: Optional[Callable[[dict], None]] = None
        self.selected_index = 0
        self._interactive_rows: List[dict] = []
        self.qr_candidates: List[dict] = []
        self.qr_cycle_index: int = 0
        self.qr_cycle_label: str = ""
        self.qr_cycle_lines: List[str] = []
        self.qr_next_ts: float = 0.0
        self.qr_locked: bool = False

    def add_node(self, node_id: str, name: str):
        self.nodes.setdefault(node_id, {
            "name": name,
            "addr": "—",
            "state": "booting",
            "last": "",
            "in": 0,
            "out": 0,
            "err": 0,
            "queue": 0,
            "services": [],
            "started": time.time(),
        })

    def set_action_handler(self, handler: Callable[[dict], None]):
        self.action_handler = handler

    def set_addr(self, node_id: str, addr: Optional[str]):
        if node_id in self.nodes:
            self.nodes[node_id]["addr"] = addr or "—"
            self.nodes[node_id]["state"] = "online" if addr else "waiting"

    def set_state(self, node_id: str, state: str):
        if node_id in self.nodes:
            self.nodes[node_id]["state"] = state

    def set_queue(self, node_id: str, size: int):
        if node_id in self.nodes:
            self.nodes[node_id]["queue"] = max(0, size)

    def set_node_services(self, node_id: str, services: List[str]):
        if node_id in self.nodes:
            self.nodes[node_id]["services"] = services

    def update_service_info(self, name: str, info: dict):
        cur = self.services.get(name, {})
        cur.update(info)
        self.services[name] = cur

    def set_daemon_info(self, info: Optional[dict]):
        self.daemon_info = info

    def bump(self, node_id: str, kind: str, msg: str):
        target = self.nodes.get(node_id)
        if target:
            target["last"] = msg
            if kind == "IN":
                target["in"] += 1
            elif kind == "OUT":
                target["out"] += 1
            elif kind == "ERR":
                target["err"] += 1
        if self.enabled:
            self.events.put((node_id, kind, msg, time.strftime("%H:%M:%S")))
        else:
            print(f"[{time.strftime('%H:%M:%S')}] {node_id:<8} {kind:<3} {msg}")

    def run(self):
        if not self.enabled:
            try:
                while not self.stop.is_set():
                    time.sleep(0.25)
            except KeyboardInterrupt:
                pass
            return
        curses.wrapper(self._main)

    def shutdown(self):
        self.stop.set()

    # ──────────────────────────────────────────────
    # curses helpers
    # ──────────────────────────────────────────────
    def _main(self, stdscr):
        curses.curs_set(0)
        stdscr.nodelay(True)
        stdscr.timeout(120)
        color_enabled = False
        header_attr = curses.A_BOLD
        node_attr = curses.A_NORMAL
        section_attr = curses.A_DIM
        if curses.has_colors():
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_CYAN, -1)
            curses.init_pair(2, curses.COLOR_GREEN, -1)
            curses.init_pair(3, curses.COLOR_MAGENTA, -1)
            header_attr = curses.color_pair(1) | curses.A_BOLD
            node_attr = curses.color_pair(2)
            section_attr = curses.color_pair(3) | curses.A_BOLD
            color_enabled = True
        while not self.stop.is_set():
            try:
                while True:
                    _ = self.events.get_nowait()
            except queue.Empty:
                pass

            stdscr.erase()
            stdscr.addnstr(0, 0, "Unified NKN Router — ↑↓ navigate, Enter details, press e for QR, q quit", max(0, curses.COLS - 1), header_attr)
            if self.daemon_info:
                daemon_line = f"Daemon: enabled at {self.daemon_info.get('path','?')}"
            else:
                daemon_line = "Daemon: disabled"
            stdscr.addnstr(1, 0, daemon_line[: curses.COLS - 1], curses.A_DIM)

            rows = self._build_rows()
            self._interactive_rows = [row for row in rows if row.get("selectable")]
            if self._interactive_rows:
                self.selected_index = max(0, min(self.selected_index, len(self._interactive_rows) - 1))
                selected_row = self._interactive_rows[self.selected_index]
            else:
                selected_row = None

            now = time.time()
            qr_candidates = [row for row in rows if row.get("type") in ("node", "service")]
            if qr_candidates:
                if qr_candidates != self.qr_candidates:
                    self.qr_candidates = qr_candidates
                    self.qr_cycle_index = self.qr_cycle_index % len(self.qr_candidates)
                if not self.qr_locked and (now >= self.qr_next_ts or not self.qr_cycle_lines):
                    self._advance_qr_cycle()
            else:
                self.qr_candidates = []
                if not self.qr_locked:
                    self.qr_cycle_lines = []

            screen_row = 3
            width = max(0, curses.COLS - 1)
            for row in rows:
                if screen_row >= curses.LINES - 1:
                    break
                rtype = row.get("type")
                if rtype == "separator":
                    screen_row += 1
                    continue
                attr = node_attr if rtype in ("node", "service") else curses.A_NORMAL
                if rtype == "header":
                    attr = header_attr
                if rtype == "section":
                    attr = section_attr
                prefix = ""
                if row.get("selectable"):
                    prefix = "• " if (selected_row and row is selected_row) else "  "
                text = prefix + row.get("text", "")
                if selected_row and row is selected_row and row.get("selectable"):
                    attr |= curses.A_REVERSE
                try:
                    stdscr.addnstr(screen_row, 0, text[:width], attr)
                except curses.error:
                    pass
                screen_row += 1

            if self.qr_cycle_lines:
                mode = "locked" if self.qr_locked else "auto"
                label_line = f"QR ({mode} every 10s): {self.qr_cycle_label}" if self.qr_cycle_label else f"QR ({mode})"
                if screen_row < curses.LINES - 1:
                    try:
                        stdscr.addnstr(screen_row, 0, label_line[:width], curses.A_DIM | curses.A_BOLD)
                    except curses.error:
                        pass
                    screen_row += 1
                for ln in self.qr_cycle_lines:
                    if screen_row >= curses.LINES - 1:
                        break
                    try:
                        stdscr.addnstr(screen_row, 0, ln[:width], curses.A_DIM)
                    except curses.error:
                        pass
                    screen_row += 1

            stdscr.refresh()

            try:
                ch = stdscr.getch()
                if ch in (ord('q'), ord('Q')):
                    self.stop.set()
                elif ch in (curses.KEY_UP, ord('k')):
                    self._move_selection(-1)
                elif ch in (curses.KEY_DOWN, ord('j')):
                    self._move_selection(1)
                elif ch in (ord('e'), ord('E')):
                    if selected_row:
                        if self.qr_locked:
                            self.qr_locked = False
                            self._advance_qr_cycle()
                        else:
                            label, lines = self._qr_text_for_row(selected_row, include_detail=False)
                            self.qr_locked = True
                            self._set_cycle_display(label, lines, lock=True)
                elif ch in (curses.KEY_ENTER, 10, 13):
                    if selected_row:
                        self._handle_enter(stdscr, selected_row)
            except Exception:
                pass

    def _move_selection(self, delta: int) -> None:
        if not self._interactive_rows:
            return
        self.selected_index = (self.selected_index + delta) % len(self._interactive_rows)

    def _build_rows(self) -> List[dict]:
        rows: List[dict] = []
        rows.append({"type": "header", "text": "NKN Endpoints", "selectable": False})
        for node_id, data in sorted(self.nodes.items()):
            addr = data.get("addr") or "(awaiting bridge ready)"
            status = data.get("state")
            line = f"{data['name']}: {addr}"
            rows.append({"type": "node", "id": node_id, "text": line, "selectable": True})
            stats = f"   status:{status}  in:{data.get('in',0)} out:{data.get('out',0)} err:{data.get('err',0)} queue:{data.get('queue',0)}"
            rows.append({"type": "info", "text": stats, "selectable": False})
            started = data.get("started") or time.time()
            duration = max(1.0, time.time() - started)
            total = max(0, data.get("in", 0) + data.get("out", 0))
            rate = total / duration
            bar_len = min(40, int(rate * 4))
            bar = "█" * bar_len + "░" * (40 - bar_len)
            thr_line = f"   throughput {rate:.2f} req/s   [{bar}]"
            rows.append({"type": "info", "text": thr_line, "selectable": False})

        rows.append({"type": "separator", "text": "", "selectable": False})
        rows.append({"type": "section", "text": "Services", "selectable": False})
        for name, info in sorted(self.services.items()):
            assigned = info.get("assigned_node") or "—"
            addr = info.get("assigned_addr") or "—"
            status = info.get("status") or ("running" if info.get("running") else (info.get("last_error") or "stopped"))
            term = "yes" if info.get("terminal_alive") else "no"
            line = f"{name} → node:{assigned}  addr:{addr}  status:{status}  terminal:{term}"
            rows.append({"type": "service", "id": name, "text": line, "selectable": True})

        rows.append({"type": "separator", "text": "", "selectable": False})
        rows.append({"type": "daemon", "id": "daemon", "text": "Daemon controls (Enter)", "selectable": True})
        return rows

    def _handle_enter(self, stdscr, row: dict) -> None:
        row_type = row.get("type")
        if row_type == "node":
            self._show_qr_for_row(stdscr, row, include_detail=True)
            return
        elif row_type == "service":
            self._show_qr_for_row(stdscr, row, include_detail=True)
            return
        elif row_type == "daemon":
            enabled = bool(self.daemon_info)
            if enabled:
                options = ["Disable daemon", "Show daemon info", "Cancel"]
            else:
                options = ["Enable daemon", "Cancel"]
            choice = self._prompt_menu(stdscr, "Daemon Controls", options)
            if self.action_handler:
                if not enabled and choice == 0:
                    self.action_handler({"type": "daemon", "op": "enable"})
                elif enabled and choice == 0:
                    self.action_handler({"type": "daemon", "op": "disable"})
                elif enabled and choice == 1:
                    info = json.dumps(self.daemon_info or {}, indent=2)
                    self._show_message(stdscr, info)

    def _show_log_tail(self, stdscr, path: Optional[str]) -> None:
        if not path:
            self._show_message(stdscr, "No log file path available")
            return
        try:
            log_path = Path(path)
            if not log_path.exists():
                raise FileNotFoundError(path)
            lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-20:]
            text = "\n".join(lines) if lines else "(log empty)"
            self._show_message(stdscr, text)
        except Exception as exc:
            self._show_message(stdscr, f"Log read failed: {exc}")

    def _show_node_logs(self, stdscr, node_name: str) -> None:
        logs = []
        for svc, info in self.services.items():
            if info.get("assigned_node") == node_name and info.get("log"):
                logs.append((svc, info.get("log")))
        if not logs:
            self._show_message(stdscr, "No logs associated with this node yet.")
            return
        output_lines: List[str] = []
        for svc, path in logs:
            try:
                log_path = Path(path)
                if not log_path.exists():
                    raise FileNotFoundError(path)
                lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-10:]
                output_lines.append(f"[{svc}] {path}")
                output_lines.extend(lines if lines else ["(log empty)"])
            except Exception as exc:
                output_lines.append(f"[{svc}] log read failed: {exc}")
            output_lines.append("")
        self._show_message(stdscr, "\n".join(output_lines))

    def _qr_text_for_row(self, row: dict, include_detail: bool = False) -> Tuple[str, List[str]]:
        rtype = row.get("type")
        label = ""
        detail_lines: List[str] = []
        addr = ""
        if rtype == "node":
            node = self.nodes.get(row.get("id"))
            if not node:
                return ("", ["(Node not found)"])
            addr = (node.get("addr") or "").strip()
            label = f"Node {node.get('name','')} ({addr or '—'})"
            if include_detail:
                services = ", ".join(node.get("services", [])) or "—"
                detail = (
                    f"Node: {node.get('name','')}\n"
                    f"Address: {node.get('addr','')}\n"
                    f"State: {node.get('state','')}\n"
                    f"Queue: {node.get('queue',0)}\n"
                    f"Counts: IN={node.get('in',0)} OUT={node.get('out',0)} ERR={node.get('err',0)}\n"
                    f"Services: {services}"
                )
                detail_lines = detail.splitlines()
        elif rtype == "service":
            service_id = row.get("id")
            info = self.services.get(service_id, {})
            addr = (info.get("assigned_addr") or "").strip()
            label = f"Service {service_id} ({addr or '—'})"
            if include_detail:
                detail = (
                    f"Service: {service_id}\n"
                    f"Assigned node: {info.get('assigned_node','—')}\n"
                    f"Address: {info.get('assigned_addr','—')}\n"
                    f"Status: {info.get('status','?')}"
                )
                detail_lines = detail.splitlines()
        else:
            return ("", ["(Unsupported item)"])

        lines: List[str] = []
        if include_detail and detail_lines:
            lines.extend(detail_lines)
            lines.append("")

        if addr:
            ascii_lines = render_qr_ascii(addr).splitlines()
            lines.extend(ascii_lines)
        else:
            lines.append("(No NKN address yet)")
        return (label, lines)

    def _set_cycle_display(self, label: str, lines: List[str], delay: float = 10.0, lock: bool = False) -> None:
        if not lines:
            lines = ["(No data)"]
        self.qr_cycle_label = label
        self.qr_cycle_lines = lines
        self.qr_next_ts = time.time() + delay
        if lock:
            self.qr_locked = True

    def _advance_qr_cycle(self) -> None:
        if not self.qr_candidates:
            self.qr_cycle_lines = []
            return
        row = self.qr_candidates[self.qr_cycle_index % len(self.qr_candidates)]
        self.qr_cycle_index = (self.qr_cycle_index + 1) % max(1, len(self.qr_candidates))
        label, lines = self._qr_text_for_row(row, include_detail=False)
        self._set_cycle_display(label, lines)

    def _show_qr_for_row(self, stdscr, row: dict, include_detail: bool = False) -> None:
        if not row:
            return
        label_detail, lines_detail = self._qr_text_for_row(row, include_detail=True)
        label_inline, lines_inline = self._qr_text_for_row(row, include_detail=False)
        if include_detail and lines_detail:
            self._show_message(stdscr, "\n".join(lines_detail))
        self._set_cycle_display(label_inline, lines_inline)
    def _prompt_menu(self, stdscr, title: str, options: List[str]) -> Optional[int]:
        if not options:
            return None
        height = len(options) + 4
        width = max(len(title), *(len(opt) for opt in options)) + 6
        y = max(2, (curses.LINES - height) // 2)
        x = max(2, (curses.COLS - width) // 2)
        win = curses.newwin(height, width, y, x)
        win.box()
        win.addnstr(1, 2, title, width - 4, curses.A_BOLD)
        idx = 0
        while True:
            for i, opt in enumerate(options):
                attr = curses.A_REVERSE if i == idx else curses.A_NORMAL
                win.addnstr(3 + i, 2, opt[: width - 4], attr)
            win.refresh()
            ch = win.getch()
            if ch in (curses.KEY_UP, ord('k')):
                idx = (idx - 1) % len(options)
            elif ch in (curses.KEY_DOWN, ord('j')):
                idx = (idx + 1) % len(options)
            elif ch in (curses.KEY_ENTER, 10, 13):
                win.clear(); win.refresh(); return idx
            elif ch in (27, ord('q')):
                win.clear(); win.refresh(); return None

    def _show_message(self, stdscr, message: str) -> None:
        lines = message.splitlines() or [message]
        height = min(len(lines) + 4, curses.LINES - 2)
        width = min(max(len(line) for line in lines) + 4, curses.COLS - 2)
        y = max(1, (curses.LINES - height) // 2)
        x = max(1, (curses.COLS - width) // 2)
        win = curses.newwin(height, width, y, x)
        win.box()
        for i, line in enumerate(lines[: height - 4]):
            win.addnstr(2 + i, 2, line[: width - 4], curses.A_NORMAL)
        win.addnstr(height - 2, 2, "Press Enter", curses.A_DIM)
        win.refresh()
        while True:
            ch = win.getch()
            if ch in (curses.KEY_ENTER, 10, 13, 27, ord('q')):
                break
        win.clear()
        win.refresh()


# ──────────────────────────────────────────────────────────────
# BridgeManager supervising the Node child
# ──────────────────────────────────────────────────────────────
DM_OPTS_STREAM = {"noReply": False, "maxHoldingSeconds": 120}
DM_OPTS_SINGLE = {"noReply": True}
BRIDGE_MIN_S = 0.5
BRIDGE_MAX_S = 30.0
SEND_QUEUE_MAX = 2000


class BridgeManager:
    def __init__(self, node_id: str, env: dict, ui: UnifiedUI, on_dm: Callable[[str, dict], None], on_ready: Optional[Callable[[Optional[str]], None]] = None):
        self.node_id = node_id
        self.env = env
        self.ui = ui
        self.on_dm = on_dm
        self.on_ready = on_ready
        self.proc: Optional[subprocess.Popen[str]] = None
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.addr = ""
        self.backoff = BRIDGE_MIN_S
        self.stdout_thread: Optional[threading.Thread] = None
        self.stderr_thread: Optional[threading.Thread] = None
        self.sender_thread: Optional[threading.Thread] = None
        self.send_q: "queue.Queue[tuple[str, dict, dict]]" = queue.Queue(maxsize=SEND_QUEUE_MAX)

    def start(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return
            try:
                self.proc = subprocess.Popen(
                    ["node", str(BRIDGE_JS)],
                    cwd=BRIDGE_DIR,
                    env=self.env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
                self.addr = ""
                self.backoff = BRIDGE_MIN_S
                if self.on_ready:
                    self.on_ready(None)
            except Exception as e:  # pragma: no cover
                self.ui.bump(self.node_id, "ERR", f"bridge spawn failed: {e}")
                return
        self.stdout_thread = threading.Thread(target=self._stdout_pump, daemon=True)
        self.stdout_thread.start()
        self.stderr_thread = threading.Thread(target=self._stderr_pump, daemon=True)
        self.stderr_thread.start()
        if not self.sender_thread:
            self.sender_thread = threading.Thread(target=self._sender_loop, daemon=True)
            self.sender_thread.start()

    def dm(self, to: str, data: dict, opts: Optional[dict] = None):
        payload = (to, data, opts or {})
        try:
            self.send_q.put_nowait(payload)
        except queue.Full:
            with contextlib.suppress(Exception):
                _ = self.send_q.get_nowait()
            with contextlib.suppress(Exception):
                self.send_q.put_nowait(payload)

    def shutdown(self):
        self.stop.set()
        with self.lock:
            proc = self.proc
        if proc and proc.poll() is None:
            with contextlib.suppress(Exception):
                if proc.stdin:
                    proc.stdin.close()
            with contextlib.suppress(Exception):
                proc.terminate()
        if self.on_ready:
            self.on_ready(None)

    # internal --------------------------------------------------
    def _stdout_pump(self):
        p = self.proc
        if not p or not p.stdout:
            return
        while not self.stop.is_set():
            line = p.stdout.readline()
            if not line:
                if p.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            try:
                msg = json.loads(line.strip())
            except Exception:
                continue
            typ = msg.get("type")
            if typ == "ready":
                self.addr = msg.get("address") or ""
                self.ui.set_addr(self.node_id, self.addr)
                self.ui.bump(self.node_id, "SYS", f"ready {self.addr}")
                if self.on_ready:
                    self.on_ready(self.addr)
            elif typ == "status":
                state = msg.get("state", "")
                if state in ("probe_fail", "probe_exit", "error", "close"):
                    self.ui.set_state(self.node_id, state)
                self.ui.bump(self.node_id, "SYS", f"bridge {state}")
            elif typ == "nkn-dm":
                src = msg.get("src") or ""
                body = msg.get("msg") or {}
                if isinstance(body, dict) and body.get("event") == "relay.selfprobe":
                    continue
                self.on_dm(src, body)
            elif typ == "err":
                self.ui.bump(self.node_id, "ERR", msg.get("msg", "bridge error"))
        self._restart_later()

    def _stderr_pump(self):
        p = self.proc
        if not p or not p.stderr:
            return
        while not self.stop.is_set():
            line = p.stderr.readline()
            if not line:
                if p.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            self.ui.bump(self.node_id, "ERR", line.strip())

    def _sender_loop(self):
        while not self.stop.is_set():
            try:
                to, data, opts = self.send_q.get(timeout=0.2)
            except queue.Empty:
                continue
            wrote = False
            while not wrote and not self.stop.is_set():
                with self.lock:
                    proc = self.proc
                    stdin = proc.stdin if proc else None
                if proc and proc.poll() is None and stdin:
                    try:
                        payload = {"type": "dm", "to": to, "data": data}
                        if opts:
                            payload["opts"] = opts
                        stdin.write(json.dumps(payload) + "\n")
                        stdin.flush()
                        wrote = True
                        break
                    except Exception:
                        time.sleep(0.1)
                else:
                    time.sleep(0.2)
            self.send_q.task_done()

    def _restart_later(self):
        if self.stop.is_set():
            return
        delay = self.backoff
        self.backoff = min(self.backoff * 2.0, BRIDGE_MAX_S)
        self.ui.set_state(self.node_id, f"restart {delay:.1f}s")
        if self.on_ready:
            self.on_ready(None)
        def _kick():
            time.sleep(delay)
            if not self.stop.is_set():
                self.start()
        threading.Thread(target=_kick, daemon=True).start()


# ──────────────────────────────────────────────────────────────
# Helpers for ASR-specific control messages
# ──────────────────────────────────────────────────────────────
def req_from_asr_start(msg: dict) -> dict:
    opts = msg.get("opts") or {}
    service = (opts.get("service") or "asr").strip()
    return {
        "service": service,
        "path": "/recognize/stream/start",
        "method": "POST",
        "headers": opts.get("headers") or {},
        "timeout_ms": opts.get("timeout_ms") or 45000,
        "verify": opts.get("verify") if isinstance(opts.get("verify"), bool) else None,
        "insecure_tls": opts.get("insecure_tls") in (True, "1", "true", "on"),
    }


def req_from_asr_audio(msg: dict) -> dict:
    sid = (msg.get("sid") or "").strip()
    if not sid:
        raise ValueError("asr.audio missing sid")
    fmt = (msg.get("format") or "pcm16").strip()
    sr = int(msg.get("sr") or 16000)
    body_b64 = msg.get("body_b64") or ""
    if not body_b64:
        raise ValueError("asr.audio missing body_b64")
    opts = msg.get("opts") or {}
    service = (opts.get("service") or "asr").strip()
    headers = {"Content-Type": "application/octet-stream"}
    headers.update(opts.get("headers") or {})
    return {
        "service": service,
        "path": f"/recognize/stream/{sid}/audio?format={fmt}&sr={sr}",
        "method": "POST",
        "headers": headers,
        "body_b64": body_b64,
        "timeout_ms": opts.get("timeout_ms") or 45000,
        "verify": opts.get("verify") if isinstance(opts.get("verify"), bool) else None,
        "insecure_tls": opts.get("insecure_tls") in (True, "1", "true", "on"),
        "stream": False,
    }


def req_from_asr_end(msg: dict) -> dict:
    sid = (msg.get("sid") or "").strip()
    if not sid:
        raise ValueError("asr.end missing sid")
    opts = msg.get("opts") or {}
    service = (opts.get("service") or "asr").strip()
    return {
        "service": service,
        "path": f"/recognize/stream/{sid}/end",
        "method": "POST",
        "headers": opts.get("headers") or {},
        "timeout_ms": opts.get("timeout_ms") or 45000,
        "verify": opts.get("verify") if isinstance(opts.get("verify"), bool) else None,
        "insecure_tls": opts.get("insecure_tls") in (True, "1", "true", "on"),
    }


def req_from_asr_events(msg: dict) -> dict:
    sid = (msg.get("sid") or "").strip()
    if not sid:
        raise ValueError("asr.events missing sid")
    opts = msg.get("opts") or {}
    service = (opts.get("service") or "asr").strip()
    headers = {"Accept": "text/event-stream", "X-Relay-Stream": "chunks"}
    headers.update(opts.get("headers") or {})
    return {
        "service": service,
        "path": f"/recognize/stream/{sid}/events",
        "method": "GET",
        "headers": headers,
        "timeout_ms": opts.get("timeout_ms") or 300000,
        "verify": opts.get("verify") if isinstance(opts.get("verify"), bool) else None,
        "insecure_tls": opts.get("insecure_tls") in (True, "1", "true", "on"),
        "stream": "chunks",
    }


# ──────────────────────────────────────────────────────────────
# RelayNode combining bridge + HTTP workers
# ──────────────────────────────────────────────────────────────
class RelayNode:
    def __init__(self, node_cfg: dict, global_cfg: dict, ui: UnifiedUI,
                 assignment_lookup: Optional[Callable[[str], Tuple[Optional[str], Optional[str]]]],
                 address_callback: Optional[Callable[[str, Optional[str]], None]]):
        self.cfg = node_cfg
        self.global_cfg = global_cfg
        self.ui = ui
        self.node_id = node_cfg.get("name") or node_cfg.get("id") or secrets.token_hex(4)
        self.ui.add_node(self.node_id, self.node_id)
        self.targets = global_cfg.get("targets", {}).copy()
        self.targets.update(node_cfg.get("targets") or {})
        http_cfg = global_cfg.get("http", {})
        self.workers_count = int(node_cfg.get("workers") or http_cfg.get("workers") or 4)
        self.max_body = int(node_cfg.get("max_body_b") or http_cfg.get("max_body_b") or (2 * 1024 * 1024))
        self.verify_default = bool(node_cfg.get("verify_default") if node_cfg.get("verify_default") is not None else http_cfg.get("verify_default", True))
        self.chunk_raw_b = int(http_cfg.get("chunk_raw_b", 12 * 1024))
        self.heartbeat_s = float(http_cfg.get("heartbeat_s", 10))
        self.batch_lines = int(http_cfg.get("batch_lines", 24))
        self.batch_latency = float(http_cfg.get("batch_latency", 0.08))
        self.retry_attempts = int(http_cfg.get("retries", 4))
        self.retry_backoff = float(http_cfg.get("retry_backoff", 0.5))
        self.retry_cap = float(http_cfg.get("retry_cap", 4.0))
        self.jobs: "queue.Queue[dict]" = queue.Queue()
        self.assignment_lookup = assignment_lookup or self._default_assignment_lookup
        self.address_callback = address_callback or (lambda _node, _addr: None)
        self.current_address: Optional[str] = None
        self.alias_map = {
            "asr": "whisper_asr",
            "whisper": "whisper_asr",
            "tts": "piper_tts",
            "piper": "piper_tts",
            "ollama": "ollama_farm",
            "llm": "ollama_farm",
        }
        self.bridge = self._build_bridge()
        self.workers: list[threading.Thread] = []

    # lifecycle -------------------------------------------------
    def start(self):
        for _ in range(max(1, self.workers_count)):
            t = threading.Thread(target=self._http_worker, daemon=True)
            t.start()
            self.workers.append(t)
        self.bridge.start()

    def stop(self):
        for _ in self.workers:
            self.jobs.put(None)  # type: ignore
        self.bridge.shutdown()

    # bridge callbacks -----------------------------------------
    def _build_bridge(self) -> BridgeManager:
        bridge_cfg = self.global_cfg.get("bridge", {})
        env = os.environ.copy()
        env["NKN_SEED_HEX"] = (self.cfg.get("seed_hex") or "").lower().replace("0x", "")
        env["NKN_IDENTIFIER"] = self.node_id
        env["NKN_NUM_SUBCLIENTS"] = str(self.cfg.get("num_subclients") or bridge_cfg.get("num_subclients") or 2)
        env["NKN_BRIDGE_SEED_WS"] = str(self.cfg.get("seed_ws") or bridge_cfg.get("seed_ws") or "")
        env["NKN_SELF_PROBE_MS"] = str(self.cfg.get("self_probe_ms") or bridge_cfg.get("self_probe_ms") or 12000)
        env["NKN_SELF_PROBE_FAILS"] = str(self.cfg.get("self_probe_fails") or bridge_cfg.get("self_probe_fails") or 3)
        return BridgeManager(self.node_id, env, self.ui, self._handle_dm, self._on_ready)

    def _on_ready(self, addr: Optional[str]) -> None:
        self.current_address = addr
        self.address_callback(self.node_id, addr)

    def _handle_dm(self, src: str, body: dict):
        if not isinstance(body, dict):
            return
        event = (body.get("event") or "").lower()
        rid = body.get("id") or ""  # echoed back later
        self.ui.bump(self.node_id, "IN", f"{event or '<unknown>'} {rid}")
        if event in ("relay.ping", "ping"):
            self.bridge.dm(src, {"event": "relay.pong", "ts": int(time.time() * 1000), "addr": self.bridge.addr})
            return
        if event in ("relay.info", "info"):
            assign_map = self.assignment_lookup("__map__") if self.assignment_lookup else {}
            info = {
                "event": "relay.info",
                "ts": int(time.time() * 1000),
                "addr": self.bridge.addr,
                "services": sorted(self.targets.keys()),
                "workers": self.workers_count,
                "max_body_b": self.max_body,
                "verify_default": self.verify_default,
                "assignments": assign_map,
            }
            self.bridge.dm(src, info)
            return
        try:
            if event == "asr.start":
                req = req_from_asr_start(body)
                if self._check_assignment("whisper_asr", src, rid):
                    self._enqueue_request(src, rid, req)
                return
            if event == "asr.audio":
                req = req_from_asr_audio(body)
                if self._check_assignment("whisper_asr", src, rid):
                    self._enqueue_request(src, rid, req)
                return
            if event == "asr.end":
                req = req_from_asr_end(body)
                if self._check_assignment("whisper_asr", src, rid):
                    self._enqueue_request(src, rid, req)
                return
            if event == "asr.events":
                req = req_from_asr_events(body)
                if self._check_assignment("whisper_asr", src, rid):
                    self._enqueue_request(src, rid, req)
                return
        except Exception as e:
            self.bridge.dm(src, {
                "event": "relay.response",
                "id": rid,
                "ok": False,
                "status": 0,
                "headers": {},
                "json": None,
                "body_b64": None,
                "truncated": False,
                "error": f"{type(e).__name__}: {e}",
            }, DM_OPTS_SINGLE)
            self.ui.bump(self.node_id, "ERR", f"{event} {e}")
            return
        if event in ("relay.http", "http.request", "relay.fetch"):
            req = body.get("req") or {}
            service_hint = req.get("service") or req.get("target")
            canonical = self._canonical_service(service_hint)
            if self._check_assignment(canonical, src, rid):
                self._enqueue_request(src, rid, req)
            return
        # ignore unknown

    def _canonical_service(self, hint: Optional[str]) -> Optional[str]:
        if not hint:
            return None
        hint = str(hint).lower()
        return self.alias_map.get(hint, hint)

    def _check_assignment(self, service_name: Optional[str], src: str, rid: str) -> bool:
        if not service_name:
            return True
        result = self.assignment_lookup(service_name) if self.assignment_lookup else (None, None)
        if isinstance(result, dict):
            node_id, addr = result.get("node"), result.get("addr")
        else:
            node_id, addr = result
        if node_id and node_id != self.node_id:
            payload = {
                "event": "relay.redirect",
                "service": service_name,
                "id": rid,
                "node": node_id,
                "addr": addr,
                "ts": int(time.time() * 1000),
            }
            if not addr:
                payload["error"] = "service currently offline"
            self.bridge.dm(src, payload, DM_OPTS_SINGLE)
            self.ui.bump(self.node_id, "OUT", f"redirect {service_name} -> {node_id}")
            return False
        return True

    def _default_assignment_lookup(self, service: str):
        if service == "__map__":
            return {}
        return (None, None)

    def _enqueue_request(self, src: str, rid: str, req: dict):
        self.jobs.put({"src": src, "id": rid, "req": req})
        try:
            self.ui.set_queue(self.node_id, self.jobs.qsize())
        except Exception:
            pass

    # HTTP workers ---------------------------------------------
    def _resolve_url(self, req: dict) -> str:
        url = (req.get("url") or "").strip()
        if url:
            return url
        svc = (req.get("service") or "").strip()
        base = self.targets.get(svc)
        if not base:
            raise ValueError(f"unknown service '{svc}'")
        path = req.get("path") or "/"
        if not path.startswith("/"):
            path = "/" + path
        return base.rstrip("/") + path

    def _http_request_with_retry(self, session: requests.Session, method: str, url: str, **kwargs):
        last_exc = None
        for attempt in range(self.retry_attempts):
            try:
                return session.request(method, url, **kwargs)
            except requests.RequestException as exc:
                last_exc = exc
                time.sleep(min(self.retry_backoff * (2 ** attempt), self.retry_cap))
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("request failed")

    def _http_worker(self):
        session = requests.Session()
        while True:
            job = self.jobs.get()
            if job is None:
                break
            src = job.get("src")
            rid = job.get("id")
            req = job.get("req") or {}
            try:
                self._process_request(session, src, rid, req)
            except Exception as e:
                self.bridge.dm(src, {
                    "event": "relay.response",
                    "id": rid,
                    "ok": False,
                    "status": 0,
                    "headers": {},
                    "json": None,
                    "body_b64": None,
                    "truncated": False,
                    "error": f"{type(e).__name__}: {e}",
                }, DM_OPTS_SINGLE)
                self.ui.bump(self.node_id, "ERR", f"http {type(e).__name__}: {e}")
            finally:
                self.jobs.task_done()
                try:
                    self.ui.set_queue(self.node_id, self.jobs.qsize())
                except Exception:
                    pass

    def _process_request(self, session: requests.Session, src: str, rid: str, req: dict):
        url = self._resolve_url(req)
        method = (req.get("method") or "GET").upper()
        headers = req.get("headers") or {}
        timeout_s = float(req.get("timeout_ms") or 30000) / 1000.0
        verify = self.verify_default
        if isinstance(req.get("verify"), bool):
            verify = bool(req.get("verify"))
        if req.get("insecure_tls") in (True, "1", "true", "on"):
            verify = False

        want_stream = False
        stream_mode = str(req.get("stream") or headers.get("X-Relay-Stream") or "").strip().lower()
        if stream_mode in ("1", "true", "yes", "on", "chunks", "dm", "lines", "ndjson", "sse", "events"):
            want_stream = True
        params: Dict[str, Any] = {"headers": headers, "timeout": timeout_s, "verify": verify}
        if "json" in req and req["json"] is not None:
            params["json"] = req["json"]
        elif "body_b64" in req and req["body_b64"] is not None:
            try:
                params["data"] = base64.b64decode(str(req["body_b64"]), validate=False)
            except Exception:
                params["data"] = b""
        elif "data" in req and req["data"] is not None:
            params["data"] = req["data"]

        if want_stream:
            resp = self._http_request_with_retry(session, method, url, stream=True, **params)
            stream_mode = self._infer_stream_mode(stream_mode, resp)
            self._handle_stream(src, rid, resp, stream_mode)
            return

        resp = self._http_request_with_retry(session, method, url, **params)
        raw = resp.content or b""
        truncated = False
        if len(raw) > self.max_body:
            raw = raw[: self.max_body]
            truncated = True
        payload = {
            "event": "relay.response",
            "id": rid,
            "ok": True,
            "status": int(resp.status_code),
            "headers": {k.lower(): v for k, v in resp.headers.items()},
            "json": None,
            "body_b64": None,
            "truncated": truncated,
            "error": None,
        }
        content_type = (resp.headers.get("Content-Type") or "").lower()
        if "application/json" in content_type:
            try:
                payload["json"] = resp.json()
            except Exception:
                payload["body_b64"] = base64.b64encode(raw).decode("ascii")
        elif len(raw) <= self.max_body:
            payload["body_b64"] = base64.b64encode(raw).decode("ascii")
        else:
            payload["body_b64"] = base64.b64encode(raw).decode("ascii")
        self.bridge.dm(src, payload, DM_OPTS_SINGLE)
        self.ui.bump(self.node_id, "OUT", f"{payload['status']} {rid}")

    def _infer_stream_mode(self, mode: str, resp: requests.Response) -> str:
        if mode in ("lines", "ndjson", "line"):
            return "lines"
        if mode in ("sse", "events"):
            return "lines"
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "text/event-stream" in ctype or "application/x-ndjson" in ctype:
            return "lines"
        if "json" in ctype and "stream" in ctype:
            return "lines"
        return "chunks"

    def _handle_stream(self, src: str, rid: str, resp: requests.Response, mode: str):
        headers = {k.lower(): v for k, v in resp.headers.items()}
        filename = None
        cd = resp.headers.get("Content-Disposition") or resp.headers.get("content-disposition") or ""
        if cd:
            import re
            import urllib.parse

            m = re.search(r"filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?", cd, re.I)
            if m:
                filename = urllib.parse.unquote(m.group(1) or m.group(2))
        cl_raw = resp.headers.get("Content-Length") or resp.headers.get("content-length")
        try:
            cl_num = int(cl_raw) if cl_raw is not None else None
        except Exception:
            cl_num = None
        begin_payload = {
            "event": "relay.response.begin",
            "id": rid,
            "ok": True,
            "status": int(resp.status_code),
            "headers": headers,
            "content_length": cl_num,
            "filename": filename,
            "ts": int(time.time() * 1000),
        }
        self.bridge.dm(src, begin_payload, DM_OPTS_STREAM)
        self.ui.bump(self.node_id, "OUT", f"stream begin {rid}")

        if mode == "lines":
            self._stream_lines(src, rid, resp)
        else:
            self._stream_chunks(src, rid, resp)

    def _stream_lines(self, src: str, rid: str, resp: requests.Response):
        decoder = codecs.getincrementaldecoder("utf-8")()
        text_buf = ""
        batch = []
        seq = 0
        total_bytes = 0
        total_lines = 0
        last_flush = time.time()
        hb_deadline = time.time() + self.heartbeat_s
        done_seen = False

        def flush_batch():
            nonlocal batch, last_flush
            if not batch:
                return
            payload = {
                "event": "relay.response.lines",
                "id": rid,
                "lines": batch,
            }
            self.bridge.dm(src, payload, DM_OPTS_STREAM)
            batch = []
            last_flush = time.time()

        try:
            for chunk in resp.iter_content(chunk_size=self.chunk_raw_b):
                if chunk:
                    total_bytes += len(chunk)
                    text_buf += decoder.decode(chunk)
                    while True:
                        idx = text_buf.find("\n")
                        if idx < 0:
                            break
                        line = text_buf[:idx]
                        text_buf = text_buf[idx + 1 :]
                        if not line.strip():
                            continue
                        seq += 1
                        total_lines += 1
                        try:
                            maybe = json.loads(line)
                            if isinstance(maybe, dict) and maybe.get("done") is True:
                                done_seen = True
                        except Exception:
                            pass
                        batch.append({"seq": seq, "ts": int(time.time() * 1000), "line": line})
                        if len(batch) >= self.batch_lines or (time.time() - last_flush) >= self.batch_latency:
                            flush_batch()
                if time.time() >= hb_deadline:
                    self.bridge.dm(src, {"event": "relay.response.keepalive", "id": rid, "ts": int(time.time() * 1000)}, DM_OPTS_STREAM)
                    hb_deadline = time.time() + self.heartbeat_s
            tail = decoder.decode(b"", final=True)
            if tail.strip():
                seq += 1
                total_lines += 1
                batch.append({"seq": seq, "ts": int(time.time() * 1000), "line": tail})
            flush_batch()
        except Exception as e:
            self.bridge.dm(src, {
                "event": "relay.response.end",
                "id": rid,
                "ok": False,
                "bytes": total_bytes,
                "last_seq": seq,
                "lines": total_lines,
                "error": f"{type(e).__name__}: {e}",
                "done_seen": done_seen,
            }, DM_OPTS_STREAM)
            self.ui.bump(self.node_id, "ERR", f"stream lines {e}")
            return
        self.bridge.dm(src, {
            "event": "relay.response.end",
            "id": rid,
            "ok": True,
            "bytes": total_bytes,
            "last_seq": seq,
            "lines": total_lines,
            "done_seen": done_seen,
        }, DM_OPTS_STREAM)
        self.ui.bump(self.node_id, "OUT", f"stream end {rid}")

    def _stream_chunks(self, src: str, rid: str, resp: requests.Response):
        total = 0
        seq = 0
        last_send = time.time()
        try:
            for chunk in resp.iter_content(chunk_size=self.chunk_raw_b):
                if not chunk:
                    if time.time() - last_send >= self.heartbeat_s:
                        self.bridge.dm(src, {"event": "relay.response.keepalive", "id": rid, "ts": int(time.time() * 1000)}, DM_OPTS_STREAM)
                        last_send = time.time()
                    continue
                total += len(chunk)
                seq += 1
                payload = {
                    "event": "relay.response.chunk",
                    "id": rid,
                    "seq": seq,
                    "b64": base64.b64encode(chunk).decode("ascii"),
                }
                self.bridge.dm(src, payload, DM_OPTS_STREAM)
                last_send = time.time()
        except Exception as e:
            self.bridge.dm(src, {
                "event": "relay.response.end",
                "id": rid,
                "ok": False,
                "bytes": total,
                "last_seq": seq,
                "truncated": False,
                "error": f"{type(e).__name__}: {e}",
            }, DM_OPTS_STREAM)
            self.ui.bump(self.node_id, "ERR", f"stream chunks {e}")
            return
        self.bridge.dm(src, {
            "event": "relay.response.end",
            "id": rid,
            "ok": True,
            "bytes": total,
            "last_seq": seq,
            "truncated": False,
            "error": None,
        }, DM_OPTS_STREAM)
        self.ui.bump(self.node_id, "OUT", f"stream end {rid}")


# ──────────────────────────────────────────────────────────────
# Router supervisor
# ──────────────────────────────────────────────────────────────
class Router:
    def __init__(self, cfg: dict, use_ui: bool):
        self.cfg = cfg
        self.use_ui = use_ui
        self.ui = UnifiedUI(use_ui)
        self.ui.set_action_handler(self.handle_ui_action)
        ensure_bridge()

        # Ensure node names exist for assignment mapping
        for idx, node_cfg in enumerate(self.cfg.get("nodes", [])):
            if not node_cfg.get("name"):
                node_cfg["name"] = node_cfg.get("id") or f"relay-{idx+1}"

        self.watchdog = ServiceWatchdog(BASE_DIR)
        self.watchdog.ensure_sources()
        self.latest_service_status: Dict[str, dict] = {
            snap["name"]: snap for snap in self.watchdog.get_snapshot()
        }

        self.assignment_lock = threading.Lock()
        self.config_dirty = False
        self.service_assignments = self._init_assignments()

        self.nodes: List[RelayNode] = []
        self.node_map: Dict[str, RelayNode] = {}
        self.node_addresses: Dict[str, Optional[str]] = {}

        self.stop = threading.Event()
        self.status_thread: Optional[threading.Thread] = None

        self.daemon_mgr = DaemonManager()
        self.daemon_info = self.daemon_mgr.check()
        self.ui.set_daemon_info(self.daemon_info)

        for node_cfg in self.cfg.get("nodes", []):
            node = RelayNode(node_cfg, self.cfg, self.ui, self.lookup_assignment, self._update_node_address)
            self.nodes.append(node)
            self.node_map[node.node_id] = node
            self.node_addresses[node.node_id] = None

        self._refresh_node_assignments()

    def start(self):
        LOGGER.info("Starting services via watchdog")
        self.watchdog.start_all()
        for node in self.nodes:
            node.start()
        self.status_thread = threading.Thread(target=self._status_monitor, daemon=True)
        self.status_thread.start()
        if self.config_dirty:
            self._save_config()

    def run(self):
        try:
            if self.use_ui:
                self.ui.run()
            else:
                while not self.stop.is_set():
                    time.sleep(1.0)
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def shutdown(self):
        if self.stop.is_set():
            return
        self.stop.set()
        LOGGER.info("Shutting down router")
        self.ui.shutdown()
        for node in self.nodes:
            node.stop()
        self.watchdog.shutdown()
        if self.status_thread and self.status_thread.is_alive():
            self.status_thread.join(timeout=5)
        if not self.config_dirty:
            return
        self._save_config()

    # ──────────────────────────────────────────
    # Assignments and status helpers
    # ──────────────────────────────────────────
    def _init_assignments(self) -> Dict[str, str]:
        assignments = self.cfg.setdefault("service_assignments", {})
        node_names = [node_cfg.get("name") for node_cfg in self.cfg.get("nodes", [])]
        if not node_names:
            raise SystemExit("No relay nodes configured; cannot build router")
        changed = False
        for idx, definition in enumerate(ServiceWatchdog.DEFINITIONS):
            assigned = assignments.get(definition.name)
            if assigned not in node_names:
                assignments[definition.name] = node_names[idx % len(node_names)]
                changed = True
        self.config_dirty = changed
        return assignments

    def _save_config(self):
        try:
            CONFIG_PATH.write_text(json.dumps(self.cfg, indent=2))
            self.config_dirty = False
            LOGGER.info("Config saved to %s", CONFIG_PATH)
        except Exception as exc:
            LOGGER.warning("Failed to write config %s: %s", CONFIG_PATH, exc)

    def _refresh_node_assignments(self):
        mapping: Dict[str, List[str]] = {node.node_id: [] for node in self.nodes}
        with self.assignment_lock:
            for service, node_id in self.service_assignments.items():
                mapping.setdefault(node_id, []).append(service)
        for node_id, services in mapping.items():
            self.ui.set_node_services(node_id, sorted(services))
        for service in self.service_assignments.keys():
            self._publish_assignment(service)

    def _publish_assignment(self, service: str):
        status = self.latest_service_status.get(service, {})
        with self.assignment_lock:
            node_id = self.service_assignments.get(service)
        addr = self.node_addresses.get(node_id)
        info = dict(status)
        running = info.get("running")
        info["status"] = info.get("status") or ("running" if running else info.get("last_error") or "stopped")
        info.update({
            "assigned_node": node_id,
            "assigned_addr": addr,
        })
        self.ui.update_service_info(service, info)

    def _status_monitor(self):
        while not self.stop.is_set():
            try:
                snapshot = self.watchdog.get_snapshot()
                for entry in snapshot:
                    self.latest_service_status[entry["name"]] = entry
                    self._publish_assignment(entry["name"])
            except Exception as exc:
                LOGGER.debug("Status monitor error: %s", exc)
            time.sleep(5)

    def _update_node_address(self, node_id: str, addr: Optional[str]):
        self.node_addresses[node_id] = addr
        self._refresh_node_assignments()

    # ──────────────────────────────────────────
    # Assignment lookup & UI actions
    # ──────────────────────────────────────────
    def lookup_assignment(self, service_name: str):
        with self.assignment_lock:
            if service_name == "__map__":
                result = {}
                for svc, node_id in self.service_assignments.items():
                    result[svc] = {
                        "node": node_id,
                        "addr": self.node_addresses.get(node_id),
                    }
                return result
            node_id = self.service_assignments.get(service_name)
        addr = self.node_addresses.get(node_id)
        return (node_id, addr)

    def handle_ui_action(self, action: dict):
        typ = action.get("type")
        if typ == "service":
            op = action.get("op")
            service = action.get("service")
            if op == "cycle":
                self._cycle_service(service)
            elif op == "diagnostics" and service:
                LOGGER.info("Diagnostics requested for %s", service)
                # Placeholder: extend with real health checks or request simulations.
                status = self.latest_service_status.get(service, {})
                LOGGER.info("Current status: %s", json.dumps(status, default=str))
        elif typ == "node" and action.get("op") == "diagnostics":
            node = action.get("node")
            LOGGER.info("Diagnostics requested for node %s", node)
        elif typ == "daemon":
            if action.get("op") == "enable":
                info = self.daemon_mgr.enable(BASE_DIR, CONFIG_PATH)
                self.daemon_info = info
                self.ui.set_daemon_info(info)
                LOGGER.info("Daemon sentinel created at %s", info.get("path"))
            elif action.get("op") == "disable":
                self.daemon_mgr.disable()
                self.daemon_info = None
                self.ui.set_daemon_info(None)
                LOGGER.info("Daemon sentinel removed")

    def _cycle_service(self, service: Optional[str]):
        if not service or service not in self.latest_service_status:
            return
        with self.assignment_lock:
            node_ids = [node.node_id for node in self.nodes]
            if not node_ids:
                return
            current = self.service_assignments.get(service)
            if current in node_ids:
                idx = node_ids.index(current)
                new_id = node_ids[(idx + 1) % len(node_ids)]
            else:
                new_id = node_ids[0]
            if self.service_assignments.get(service) == new_id:
                return
            self.service_assignments[service] = new_id
            self.config_dirty = True
        LOGGER.info("Reassigned %s to %s", service, new_id)
        self._refresh_node_assignments()
        self._save_config()



# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Unified NKN relay router")
    ap.add_argument("--config", default=str(CONFIG_PATH), help="Path to router_config.json")
    ap.add_argument("--no-ui", action="store_true", help="Disable curses dashboard")
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    global CONFIG_PATH
    CONFIG_PATH = Path(args.config).resolve()
    cfg = load_config()
    router = Router(cfg, use_ui=not args.no_ui)
    router.start()
    router.run()


if __name__ == "__main__":
    main()
