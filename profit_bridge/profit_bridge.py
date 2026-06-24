"""
ProfitBridge v3.0 — Arquitetura Invertida + Produção Estável
Fixes: lock file, exponential backoff, heartbeat, sem auto-update, Windows-only
"""
import asyncio, ctypes, json, logging, math, os, queue, sys, threading, time
from datetime import datetime
from pathlib import Path
import websockets
from dotenv import load_dotenv

# ── Verificar Windows ────────────────────────────────────────────
if sys.platform != "win32":
    print(f"ERRO: profit_bridge.py requer Windows. Plataforma detectada: {sys.platform}")
    sys.exit(1)

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("C:\\ProfitBridge\\logs\\bridge.log", encoding="utf-8")
    ]
)
log = logging.getLogger("ProfitBridge")

ACTIVATION_KEY  = os.getenv("PROFIT_ACTIVATION_KEY", "")
USERNAME        = os.getenv("PROFIT_USERNAME", "")
PASSWORD        = os.getenv("PROFIT_PASSWORD", "")
DLL_PATH        = os.getenv("PROFIT_DLL_PATH", r"C:\ProfitBridge\Win64\ProfitDLL.dll")
SYMBOLS         = [s.strip() for s in os.getenv("SYMBOLS", "WDON26,DOLN26").split(",")]  # IMPORTANTE: vencimento explícito — Nelogica não aceita WDOFUT
RAILWAY_WS_URL  = os.getenv("RAILWAY_WS_URL", "wss://leilaowdo-profit-production.up.railway.app/bridge")
BRIDGE_SECRET   = os.getenv("BRIDGE_SECRET", "321Angelin@@")
EXCHANGE_BMF    = "F"
LOCK_FILE       = Path(r"C:\ProfitBridge\bridge.lock")

# ── Lock file — garantir única instância ─────────────────────────
def acquire_lock():
    if LOCK_FILE.exists():
        try:
            pid = int(LOCK_FILE.read_text().strip())
            import ctypes as _ct
            handle = _ct.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                _ct.windll.kernel32.CloseHandle(handle)
                log.error(f"Bridge já rodando (PID {pid}). Encerrando.")
                sys.exit(1)
        except Exception:
            pass
    LOCK_FILE.write_text(str(os.getpid()))
    log.info(f"Lock adquirido (PID {os.getpid()})")

def release_lock():
    try:
        if LOCK_FILE.exists():
            LOCK_FILE.unlink()
            log.info("Lock liberado")
    except Exception:
        pass

# ── Callbacks e fila ─────────────────────────────────────────────
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
    if t == 2:  # MARKET_DATA
        if r == 4:    # CONNECTED
            dll_ready.set()
        elif r in (0, 1, 2):  # DISCONNECTED, CONNECTING, WAITING
            dll_ready.clear()
    # Atualizar bridge.status imediatamente ao mudar estado DLL
    if t == 2:
        try:
            Path(r'C:\ProfitBridge\bridge.status').write_text(json.dumps({
                "last_heartbeat": datetime.now().isoformat(),
                "railway_connected": True,
                "dll_connected": dll_ready.is_set(),
                "pid": os.getpid()
            }))
        except Exception:
            pass
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
    # DESATIVADO: crash MakeOfferBookPointers na ProfitDLL 4.0.0.40
    # Access violation em TConnectorCallbackManager.MakeOfferBookPointers
    # OfferBook não é usado durante leilão — dados vêm do TinyBook + Trade
    pass

def _cb_stub(*a): pass

def safe_json(obj):
    return json.dumps(obj, default=lambda x: None if isinstance(x, float) and not math.isfinite(x) else x)

# ── DLL ──────────────────────────────────────────────────────────
def init_dll(dll):
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

def subscribe(dll):
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
    try:
        init_dll(dll)
        if not dll_ready.wait(timeout=60):
            log.error("Timeout Market Data")
            return
        time.sleep(1)
        subscribe(dll)
    except Exception as e:
        log.exception(f"Erro DLL: {e}")

# ── WebSocket com exponential backoff ────────────────────────────
async def railway_client():
    backoff = 5
    MAX_BACKOFF = 300  # máximo 5 minutos

    while True:
        try:
            log.info(f"Conectando no Railway: {RAILWAY_WS_URL}")
            async with websockets.connect(
                RAILWAY_WS_URL,
                additional_headers={"X-Bridge-Secret": BRIDGE_SECRET},
                ping_interval=20,
                ping_timeout=30,
                close_timeout=10
            ) as ws:
                log.info("CONECTADO no Railway via /bridge!")
                backoff = 5  # reset backoff ao conectar
                await ws.send(json.dumps({"type":"bridge_auth","secret":BRIDGE_SECRET,"symbols":SYMBOLS}))
                last_heartbeat = asyncio.get_event_loop().time()

                while True:
                    events = []
                    try:
                        for _ in range(50): events.append(event_queue.get_nowait())
                    except queue.Empty: pass
                    if events:
                        await ws.send(safe_json(events) if len(events) > 1 else safe_json(events[0]))
                    # Heartbeat a cada 30s
                    now = asyncio.get_event_loop().time()
                    if now - last_heartbeat >= 30:
                        await ws.send(json.dumps({"type":"heartbeat","ts":int(now)}))
                        last_heartbeat = now
                        # Escrever bridge.status para watchdog
                        try:
                            import json as _json
                            Path(r'C:\\ProfitBridge\\bridge.status').write_text(_json.dumps({
                                "last_heartbeat": datetime.now().isoformat(),
                                "railway_connected": True,
                                "dll_connected": dll_ready.is_set(),
                                "pid": os.getpid()
                            }))
                        except Exception:
                            pass
                    await asyncio.sleep(0.1)

        except Exception as e:
            log.error(f"Desconectado: {e} — reconectando em {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)  # exponential backoff

# ── Main ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("=== ProfitBridge v3.0 Produção ===")
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
        threading.Thread(target=dll_thread, args=(dll,), daemon=True).start()
        asyncio.run(railway_client())
    except KeyboardInterrupt:
        log.info("Encerrando...")
        try: dll.DLLFinalize()
        except: pass
    finally:
        release_lock()
