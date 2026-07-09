"""
SentinelStream monitoring agent: streams log lines to the WPF dashboard over WebSockets.

Sources (all optional, env-driven — see agent/.env.example):
- Tail files (LOG_TAIL_PATH / LOG_TAIL_PATHS)
- Mock interval
- HTTP POST /ingest/log (push from scripts, SIEM hooks, curl)
- Syslog UDP (SYSLOG_UDP_PORT) → broadcast to all connected dashboards
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, WebSocket, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from agora_token import generate_rtc_token

load_dotenv()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

SeverityName = Literal["debug", "info", "warning", "error", "critical"]


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %s", name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw, 10)
    except ValueError:
        logger.warning("Invalid %s=%r, using default %s", name, raw, default)
        return default


def _env_path(name: str) -> Path | None:
    raw = os.getenv(name, "").strip()
    return Path(raw) if raw else None


def _ingest_token_expected() -> str | None:
    t = os.getenv("INGEST_TOKEN", "").strip()
    return t or None


def _verify_ingest_token(header_val: str | None) -> None:
    expected = _ingest_token_expected()
    if not expected:
        return
    if header_val != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Sentinel-Token")


def _tail_paths_from_env() -> list[Path]:
    """Comma-separated LOG_TAIL_PATHS wins; else single LOG_TAIL_PATH. Max 32 paths."""
    raw = os.getenv("LOG_TAIL_PATHS", "").strip()
    if raw:
        out: list[Path] = []
        for part in raw.split(","):
            p = part.strip()
            if p:
                out.append(Path(p))
        return out[:32]
    one = _env_path("LOG_TAIL_PATH")
    return [one] if one else []


def _build_log_entry(
    *,
    message: str,
    severity: str = "info",
    source: str = "agent",
    raw: str | None = None,
) -> dict:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "severity": severity,
        "source": source,
        "message": message,
        "rawData": raw if raw is not None else message,
    }


def _guess_severity_from_text(text: str) -> str:
    ul = text.upper()
    if "CRITICAL" in ul or "ALERT" in ul or "EMERG" in ul:
        return "critical"
    if "ERROR" in ul or " ERR " in ul:
        return "error"
    if "WARN" in ul:
        return "warning"
    if "DEBUG" in ul:
        return "debug"
    return "info"


# --- RFC3164-ish PRI strip: <30>message
_pri_re = re.compile(r"^<\d{1,3}>")


def _strip_syslog_pri(text: str) -> str:
    return _pri_re.sub("", text, count=1).strip()


class WsHub:
    """All connected dashboard WebSockets (for ingest + syslog broadcast)."""

    def __init__(self) -> None:
        self._clients: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.append(ws)

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self._clients:
                self._clients.remove(ws)

    async def count(self) -> int:
        async with self._lock:
            return len(self._clients)

    async def broadcast(self, payload: dict) -> int:
        text = json.dumps(payload, ensure_ascii=False)
        async with self._lock:
            snapshot = list(self._clients)
        dead: list[WebSocket] = []
        sent = 0
        for ws in snapshot:
            try:
                await ws.send_text(text)
                sent += 1
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self._clients:
                        self._clients.remove(ws)
        return sent


hub = WsHub()


class IngestLogBody(BaseModel):
    """Body for POST /ingest/log — matches WPF LogEntry JSON (camelCase / PascalCase)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    message: str = Field(
        ...,
        min_length=1,
        max_length=65536,
        validation_alias=AliasChoices("message", "Message"),
    )
    severity: SeverityName = Field(
        default="info",
        validation_alias=AliasChoices("severity", "Severity"),
    )
    source: str = Field(
        default="ingest",
        max_length=256,
        validation_alias=AliasChoices("source", "Source"),
    )
    timestamp: datetime | None = Field(
        default=None,
        validation_alias=AliasChoices("timestamp", "Timestamp"),
    )

    @field_validator("severity", mode="before")
    @classmethod
    def _normalize_severity(cls, v):
        if isinstance(v, str):
            return v.lower()
        return v

    def to_payload(self) -> dict:
        ts = self.timestamp
        if ts is None:
            ts = datetime.now(timezone.utc)
        elif ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return {
            "timestamp": ts.isoformat(),
            "severity": self.severity,
            "source": self.source[:256],
            "message": self.message,
            "rawData": self.message,
        }


@asynccontextmanager
async def _lifespan(app: FastAPI):
    udp_transport: asyncio.DatagramTransport | None = None
    consumer_task: asyncio.Task | None = None
    queue: asyncio.Queue | None = None

    port = _env_int("SYSLOG_UDP_PORT", 0)
    if port > 0:
        queue = asyncio.Queue(maxsize=_env_int("SYSLOG_QUEUE_MAX", 1000))

        class SyslogReceiver(asyncio.DatagramProtocol):
            def __init__(self, q: asyncio.Queue) -> None:
                self._q = q

            def datagram_received(self, data: bytes, addr) -> None:
                try:
                    self._q.put_nowait((data, addr))
                except asyncio.QueueFull:
                    logger.warning("Syslog queue full, drop from %s", addr)

        loop = asyncio.get_event_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: SyslogReceiver(queue), local_addr=("0.0.0.0", port)
        )
        udp_transport = transport
        consumer_task = asyncio.create_task(_syslog_consumer(queue, hub))
        logger.info("Syslog UDP listening on 0.0.0.0:%s", port)

    yield

    if consumer_task:
        consumer_task.cancel()
        try:
            await consumer_task
        except asyncio.CancelledError:
            pass
    if udp_transport:
        udp_transport.close()


app = FastAPI(title="AgoraWatchtower Security Agent", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _syslog_consumer(queue: asyncio.Queue, h: WsHub) -> None:
    while True:
        data, addr = await queue.get()
        text = data.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        text = _strip_syslog_pri(text)
        payload = _build_log_entry(
            message=text,
            severity=_guess_severity_from_text(text),
            source=f"syslog:{addr[0]}:{addr[1]}",
            raw=text,
        )
        n = await h.broadcast(payload)
        if n == 0:
            logger.debug("Syslog message received but no WebSocket clients connected")


class SecurityAlert(BaseModel):
    message: str = Field(..., min_length=1, max_length=1024)
    severity: str = Field(default="critical", max_length=32)
    source: str = Field(default="unknown", max_length=128)
    channel: str = Field(default="watchtower", max_length=128)


@app.get("/")
def read_root():
    return {"status": "running", "component": "AgoraWatchtower.Agent"}


@app.get("/api/token")
def get_token(
    channelName: str = Query(..., description="Name of the Agora channel"),
    uid: str = Query(..., description="User ID or string account name"),
    role: int = Query(1, description="1 = Publisher, 2 = Subscriber")
):
    """Retrieve an Agora RTC token for a channel and user account/uid."""
    token = generate_rtc_token(channelName, uid, role=role)
    app_id = os.getenv("AGORA_APP_ID", "").strip()
    return {
        "token": token,
        "appId": app_id
    }


@app.post("/api/alert")
async def trigger_alert(alert: SecurityAlert):
    """Manually trigger a security alert, broadcasting it to all connected dashboards."""
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": "alert",
        "severity": alert.severity.lower(),
        "source": alert.source,
        "message": alert.message,
        "channel": alert.channel,
    }
    n = await hub.broadcast(payload)
    return {"ok": True, "delivered_to_ws_clients": n, "payload": payload}


@app.get("/health")
async def health():
    paths = _tail_paths_from_env()
    mock_iv = _env_float("AGENT_MOCK_INTERVAL_SEC", 0.0)
    sp = _env_int("SYSLOG_UDP_PORT", 0)
    return {
        "log_tail_paths": [str(p) for p in paths],
        "log_tail_paths_existing": [str(p) for p in paths if p.is_file()],
        "mock_interval_sec": mock_iv,
        "syslog_udp_port": sp if sp > 0 else None,
        "ingest_token_required": _ingest_token_expected() is not None,
        "websocket_clients": await hub.count(),
    }


@app.post("/ingest/log")
async def ingest_log(
    body: IngestLogBody,
    x_sentinel_token: Annotated[str | None, Header(alias="X-Sentinel-Token")] = None,
):
    """Push one log line to every connected WPF dashboard (same JSON as WebSocket stream)."""
    _verify_ingest_token(x_sentinel_token)
    payload = body.to_payload()
    n = await hub.broadcast(payload)
    return {"ok": True, "delivered_to_ws_clients": n}


@app.post("/ingest/log/batch")
async def ingest_log_batch(
    entries: list[IngestLogBody],
    x_sentinel_token: Annotated[str | None, Header(alias="X-Sentinel-Token")] = None,
):
    _verify_ingest_token(x_sentinel_token)
    if len(entries) > 500:
        raise HTTPException(status_code=400, detail="Max 500 entries per batch")
    total = 0
    for body in entries:
        n = await hub.broadcast(body.to_payload())
        total += n
    return {"ok": True, "entries": len(entries), "send_operations": total}


async def send_json(websocket: WebSocket, payload: dict) -> None:
    await websocket.send_text(json.dumps(payload, ensure_ascii=False))


async def tail_file_task(websocket: WebSocket, file_path: Path) -> None:
    """Follow a growing text file and emit each new line as JSON."""
    source = f"tail:{file_path.name}"
    try:
        for _ in range(600):
            if file_path.is_file():
                break
            await asyncio.sleep(0.5)
        else:
            await send_json(
                websocket,
                _build_log_entry(
                    message=f"LOG_TAIL_PATH file not found: {file_path}",
                    severity="warning",
                    source=source,
                ),
            )
            return

        with file_path.open("r", encoding="utf-8", errors="replace") as handle:
            handle.seek(0, os.SEEK_END)
            while True:
                line = handle.readline()
                if line:
                    text = line.rstrip("\r\n")
                    if text:
                        sev = _guess_severity_from_text(text)
                        await send_json(
                            websocket,
                            _build_log_entry(
                                message=text, severity=sev, source=source, raw=text
                            ),
                        )
                else:
                    await asyncio.sleep(0.4)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.exception("tail_file_task failed")
        try:
            await send_json(
                websocket,
                _build_log_entry(
                    message=f"Tail error: {e}", severity="error", source=source
                ),
            )
        except Exception:
            pass


async def mock_interval_task(websocket: WebSocket, interval_sec: float) -> None:
    template = os.getenv(
        "AGENT_MOCK_MESSAGE",
        "Synthetic heartbeat — set LOG_TAIL_PATH(S), SYSLOG_UDP_PORT, or POST /ingest/log",
    )
    source = os.getenv("AGENT_MOCK_SOURCE", "mock")
    while True:
        msg = template.replace("{iso}", datetime.now(timezone.utc).isoformat())
        await send_json(
            websocket,
            _build_log_entry(message=msg, severity="info", source=source),
        )
        await asyncio.sleep(max(interval_sec, 0.5))


@app.websocket("/ws/logs")
async def websocket_logs(websocket: WebSocket):
    await websocket.accept()
    await hub.add(websocket)
    logger.info("WebSocket connected (hub size ~%s)", await hub.count())

    tail_paths = _tail_paths_from_env()
    mock_interval = _env_float("AGENT_MOCK_INTERVAL_SEC", 0.0)

    tasks: list[asyncio.Task] = []
    try:
        for path in tail_paths:
            tasks.append(asyncio.create_task(tail_file_task(websocket, path)))

        if mock_interval > 0:
            tasks.append(
                asyncio.create_task(mock_interval_task(websocket, mock_interval))
            )

        if not tasks:
            await send_json(
                websocket,
                _build_log_entry(
                    message=(
                        "Agent idle: configure LOG_TAIL_PATH(S), AGENT_MOCK_INTERVAL_SEC, "
                        "SYSLOG_UDP_PORT, or push events via POST /ingest/log (see README)."
                    ),
                    severity="warning",
                    source="agent",
                ),
            )
            while True:
                await asyncio.sleep(60)
        else:
            await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.error("WebSocket handler error: %s", e)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await hub.remove(websocket)
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("WebSocket closed.")


if __name__ == "__main__":
    print("Use: uvicorn log_exporter:app --host 0.0.0.0 --port 8000")
