"""
ProfitBridge v4.0 — DLL e WebSocket com ciclos de vida independentes
- DLL nunca reinicia por queda do WebSocket
- WebSocket reconecta com exponential backoff sem tocar na DLL
- Heartbeat ping/pong a cada 20s
- Lock file para única instância
- Windows-only
"""
import asyncio, ctypes, json, logging, math, os, queue, sys, threading, time
from datetime import datetime
from pathlib import Path
import websockets
from dotenv import load_dotenv

if sys.platform != "win32":
    print(f"ERRO: Windows obrigatório. Plataforma: {sys.platform}")
    sys.exit(1)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(r"C:\ProfitBridge\logs\bridge.log", encoding="utf-8")
    ]
)
log = logging.getLogger("ProfitBridge")

ACTIVATION_KEY = os.getenv("PROFIT_ACTIVATION_KEY", "")
USERNAME       = os.getenv("PROFIT_USERNAME", "")
PASSWORD       = os.getenv("PROFIT_PASSWORD", "")
DLL_PATH       = os.getenv("PROFIT_DLL_PATH", r"C:\ProfitBridge\Win64\ProfitDLL.dll")
SYMBOLS        = [s.strip() for s in os.getenv("SYMBOLS", "WDOFUT,DOLFUT,WINFUT,INDFUT").split(",")]
RAILWAY_WS_URL = os.getenv("RAILWAY_WS_URL", "wss://leilaowdo-profit-production.up.railway.app/ws")
BRIDGE_SECRET  = os.getenv("BRIDGE_SECRET", "321Angelin@@")
EXCHANGE_BMF   = "F"
LOCK_FILE      = Path(r"C:\ProfitBridge\bridge.lock")

# ── Estados separados ────────────────────────────────────────────
class DLLState:
    STARTING = "STARTING"
    READY    = "READY"
    ERROR    = "ERROR"

class WSState:
    CONNECTING    = "CONNECTING"
    CONNECTED     = "CONNECTED"
    DISCONNECTED  = "DISCONNECTED"
    RECONNECTING  = "RECONNECTING"

dll_state = DLLState.STARTING
ws_state  = WSState.DISCONNECTED

# ── Lock file ────────────────────────────────────────────────────
def acquire_lock():
    if LOCK_FILE.exists():
        try:
            pid = int(LOCK_FILE.read_text().strip())
            import ctypes as _ct
            h = _ct.windll.kernel32.OpenProcess(0x1000, False, pid)
            if h:
                _ct.windll.kernel32.CloseHandle(h)
                log.error(f"Bridge já rodando (PID {pid}). Encerrando.")
                sys.exit(1)
        except Exception:
            pass
    LOCK_FILE.write_text(str(os.getpid()))
    log.info(f"Lock adquirido (PID {os.getpid()})")

def release_lock():
    try:
        LOCK_FILE.unlink(missing_ok=True)
        log.info("Lock liberado")
    except Exception:
        pass

# ── Fila de eventos e callbacks ──────────────────────────────────
event_queue = queue.Queue(maxsize=10000)
dll_ready   = threading.Event()
_cb_refs    = {}

class TAssetIDRec(ctypes.Structure):
    _fields_ = [("pwcTicker", ctypes.c_wchar_p), ("pwcBolsa", ctypes.c_wchar_p), ("nFeed", ctypes.c_int)]

TStateCallback             = ctypes.WINFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
TProgressCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int)
TNewTradeCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_char)
TNewDailyCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int)
TPriceBookCallback         = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_double, ctypes.c_void_p, ctypes.c_void_p)
TOfferBookCallback         = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int64, ctypes.c_double, ctypes.c_char, ctypes.c_char, ctypes.c_char, ctypes.c_char, ctypes.c_char, ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_void_p)
THistoryTradeCallback      = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int)
TTinyBookCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_double, ctypes.c_int, ctypes.c_int)
TTheoreticalPriceCallback  = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_double, ctypes.c_int64)
TChangeStateTickerCallback = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p, ctypes.c_int)

def enqueue(e):
    try: event_queue.put_nowait(e)
    except queue.Full: pass

def _cb_state(t, r):
    ms = {0:"DISCONNECTED",1:"CONNECTING",2:"WAITING",3:"NOT_LOGGED",4:"CONNECTED",5:"PERF_WARNING",6:"PARTIAL"}
    ls = {0:"CONNECTED",1:"INVALID",2:"INVALID_PASS",3:"BLOCKED",4:"EXPIRED",200:"UNKNOWN"}
    ns = {0:"LOGIN",1:"ROUTING",2:"MARKET_DATA",3:"MARKET_LOGIN"}
    tn = ns.get(t, str(t))
    rn = (ms if t == 2 else ls).get(r, str(r))
    log.info(f"STATE [{tn}] -> {rn}")
    if t == 2 and r == 4: dll_ready.set()
    enqueue({"type":"connection_state","conn_type":tn,"result":rn,"timestamp":datetime.now().isoformat()})

def _cb_trade(a, d, n, p, v, q, ba, sa, tt, e):
    agg = {2:"BUY",3:"SELL",4:"AUCTION"}.get(tt)
    enqueue({"type":"trade","ticker":a.pwcTicker,"price":p,"volume":v,"quantity":q,"buy_agent":ba,"sell_agent":sa,"trade_type":tt,"aggressor":agg,"timestamp":datetime.now().isoformat()})

def _cb_theo(a, p, q):
    log.info(f"THEO [{a.pwcTicker}] p={p} q={q}")
    enqueue({"type":"theoretical_price","ticker":a.pwcTicker,"theoretical_price":p,"theoretical_qty":q,"timestamp":datetime.now().isoformat()})

def _cb_state_ticker(a, d, s):
    names = {0:"OPENED",4:"AUCTIONED",6:"CLOSED",10:"PRE_CLOSING",13:"PRE_OPENING"}
    sn = names.get(s, f"UNKNOWN_{s}")
    log.info(f"TICKER [{a.pwcTicker}] -> {sn}")
    enqueue({"type":"ticker_state","ticker":a.pwcTicker,"state":sn,"state_code":s,"in_auction":(s==4),"timestamp":datetime.now().isoformat()})

def _cb_tiny(a, p, q, s):
    enqueue({"type":"tiny_book","ticker":a.pwcTicker,"price":p,"quantity":q,"side":"BUY" if s==0 else "SELL","timestamp":datetime.now().isoformat()})

def _cb_daily(a, d, o, h, l, c, v, *x):
    enqueue({"type":"daily","ticker":a.pwcTicker,"open":o,"high":h,"low":l,"close":c,"volume":v,"timestamp":datetime.now().isoformat()})

def _cb_offer(a, act, pos, side, qty, ag, oid, p, hp, hq, hd, ho, ha, d, ps, pb):
    acts = {0:"ADD",1:"EDIT",2:"DELETE",3:"DELETE_FROM",4:"FULL_BOOK"}
    enqueue({"type":"offer_book","ticker":a.pwcTicker,"action":acts.get(act),"side":"BUY" if side==0 else "SELL","quantity":qty,"price":p if hp==b'\x01' else None,"timestamp":datetime.now().isoformat()})

def _cb_stub(*a): pass

def safe_json(obj):
    return json.dumps(obj, default=lambda x: None if isinstance(x, float) and not math.isfinite(x) else x)

# ── DLL — ciclo de vida independente ─────────────────────────────
def init_dll(dll):
    global dll_state
    _cb_refs["s"]  = TStateCallback(_cb_state)
    _cb_refs["t"]  = TNewTradeCallback(_cb_trade)
    _cb_refs["d"]  = TNewDailyCallback(_cb_daily)
    _cb_refs["pb"] = TPriceBookCallback(_cb_stub)
    _cb_refs["ob"] = TOfferBookCallback(_cb_offer)
    _cb_refs["ht"] = THistoryTradeCallback(_cb_stub)
    _cb_refs["pr"] = TProgressCallback(_cb_stub)
    _cb_refs["tb"] = TTinyBookCallback(_cb_tiny)
    dll.DLLInitializeMarketLogin.restype  = ctypes.c_int
    dll.DLLInitializeMarketLogin.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p, TStateCallback, TNewTradeCallback, TNewDailyCallback, TPriceBookCallback, TOfferBookCallback, THistoryTradeCallback, TProgressCallback, TTinyBookCallback]
    r = dll.DLLInitializeMarketLogin(ACTIVATION_KEY, USERNAME, PASSWORD, _cb_refs["s"], _cb_refs["t"], _cb_refs["d"], _cb_refs["pb"], _cb_refs["ob"], _cb_refs["ht"], _cb_refs["pr"], _cb_refs["tb"])
    if r != 0: raise RuntimeError(f"DLL falhou: {r:#010x}")
    log.info("DLL inicializada.")

def subscribe_dll(dll):
    _cb_refs["theo"] = TTheoreticalPriceCallback(_cb_theo)
    _cb_refs["st"]   = TChangeStateTickerCallback(_cb_state_ticker)
    dll.SetTheoreticalPriceCallback.restype  = ctypes.c_int
    dll.SetTheoreticalPriceCallback.argtypes = [TTheoreticalPriceCallback]
    dll.SetTheoreticalPriceCallback(_cb_refs["theo"])
    dll.SetChangeStateTickerCallback.restype  = ctypes.c_int
    dll.SetChangeStateTickerCallback.argtypes = [TChangeStateTickerCallback]
    dll.SetChangeStateTickerCallback(_cb_refs["st"])
    dll.SubscribeTicker.restype     = ctypes.c_int
    dll.SubscribeTicker.argtypes    = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    dll.SubscribeOfferBook.restype  = ctypes.c_int
    dll.SubscribeOfferBook.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    for s in SYMBOLS:
        log.info(f"Subscribe [{s}] T={dll.SubscribeTicker(s, EXCHANGE_BMF)} O={dll.SubscribeOfferBook(s, EXCHANGE_BMF)}")

def dll_thread(dll):
    """DLL roda em thread separada — independente do WebSocket"""
    global dll_state
    attempt = 0
    while True:
        try:
            attempt += 1
            dll_state = DLLState.STARTING
            log.info(f"Inicializando DLL (tentativa {attempt})...")
            init_dll(dll)
            if not dll_ready.wait(timeout=60):
                wait = min(15 * attempt, 120)
                log.warning(f"Timeout Market Data (tentativa {attempt}) — aguardando {wait}s")
                dll_ready.clear()
                time.sleep(wait)
                continue
            time.sleep(1)
            subscribe_dll(dll)
            dll_state = DLLState.READY
            log.info("DLL PRONTA — mantém ativa independente do WebSocket")
            return  # DLL pronta, thread termina — DLL continua rodando via callbacks
        except Exception as e:
            wait = min(15 * attempt, 120)
            dll_state = DLLState.ERROR
            log.warning(f"DLL indisponivel (tentativa {attempt}): {e} — aguardando {wait}s")
            time.sleep(wait)

# ── WebSocket — ciclo de vida independente ───────────────────────
async def railway_client():
    """WebSocket reconecta sem tocar na DLL"""
    global ws_state
    backoff = 5
    BACKOFF_STEPS = [5, 10, 30, 60, 300]
    backoff_idx = 0

    while True:
        ws_state = WSState.CONNECTING
        try:
            log.info(f"Conectando no Railway: {RAILWAY_WS_URL}")
            async with websockets.connect(
                RAILWAY_WS_URL,
                additional_headers={"X-Bridge-Secret": BRIDGE_SECRET},
                ping_interval=20,
                ping_timeout=30,
                close_timeout=10
            ) as ws:
                ws_state = WSState.CONNECTED
                backoff_idx = 0  # reset backoff
                log.info("CONECTADO no Railway via /bridge!")
                await ws.send(json.dumps({
                    "type": "bridge_auth",
                    "secret": BRIDGE_SECRET,
                    "symbols": SYMBOLS,
                    "dll_state": dll_state
                }))
                last_heartbeat = asyncio.get_event_loop().time()

                while True:
                    # Enviar eventos da fila
                    events = []
                    try:
                        for _ in range(50): events.append(event_queue.get_nowait())
                    except queue.Empty:
                        pass
                    if events:
                        await ws.send(safe_json(events) if len(events) > 1 else safe_json(events[0]))

                    # Heartbeat a cada 20s
                    now = asyncio.get_event_loop().time()
                    if now - last_heartbeat >= 20:
                        await ws.send(json.dumps({
                            "type": "heartbeat",
                            "ts": int(now),
                            "dll_state": dll_state,
                            "symbols": SYMBOLS
                        }))
                        last_heartbeat = now

                    await asyncio.sleep(0.1)

        except Exception as e:
            ws_state = WSState.RECONNECTING
            backoff = BACKOFF_STEPS[min(backoff_idx, len(BACKOFF_STEPS)-1)]
            backoff_idx += 1
            log.warning(f"WebSocket desconectado: {e}")
            log.info(f"DLL state: {dll_state} — DLL NAO reinicia")
            log.info(f"Reconectando em {backoff}s (tentativa {backoff_idx})...")
            await asyncio.sleep(backoff)

# ── Main ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("=== ProfitBridge v4.0 — DLL e WS independentes ===")
    log.info(f"Railway: {RAILWAY_WS_URL}")

    if not all([ACTIVATION_KEY, USERNAME, PASSWORD]):
        log.error("Credenciais faltando")
        sys.exit(1)

    p = Path(DLL_PATH)
    if not p.exists():
        log.error(f"DLL nao encontrada: {p}")
        sys.exit(1)

    acquire_lock()
    try:
        dll = ctypes.CDLL(str(p))
        # DLL em thread separada — não bloqueia WebSocket
        threading.Thread(target=dll_thread, args=(dll,), daemon=True).start()
        # WebSocket em loop assíncrono — não afeta DLL
        asyncio.run(railway_client())
    except KeyboardInterrupt:
        log.info("Encerrando...")
        try: dll.DLLFinalize()
        except: pass
    finally:
        release_lock()
