"""
ProfitBridge v5.0 - Conforme documentacao oficial Nelogica
Papel: DLL -> JSON -> WebSocket. Zero logica de negocio.
"""
import asyncio, ctypes, json, logging, math, os, queue, sys, threading, time
from datetime import datetime
from pathlib import Path

import websockets
from dotenv import load_dotenv

load_dotenv()

# ── Logging ──────────────────────────────────────────────────────
LOG_DIR = Path(r"C:\ProfitBridge\logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "bridge.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("ProfitBridge")

# ── Configuracao ─────────────────────────────────────────────────
ACTIVATION_KEY = os.getenv("PROFIT_ACTIVATION_KEY", "")
USERNAME       = os.getenv("PROFIT_USERNAME", "")
PASSWORD       = os.getenv("PROFIT_PASSWORD", "")
DLL_PATH       = os.getenv("PROFIT_DLL_PATH", r"C:\ProfitBridge\Win64\ProfitDLL.dll")
# Documentacao Nelogica usa ticker generico (WDOFUT) para PriceDepth.
# Tickers especificos com vencimento (WDON26) podem nao funcionar com SubscribePriceDepth.
# Mantemos SubscribeTicker com o vencimento especifico (trades/tiny_book funcionam normalmente)
# mas testamos PriceDepth tambem com o ticker generico como fallback.
SYMBOLS_RAW    = os.getenv("SYMBOLS", "WDON26,DOLN26")
SYMBOLS        = [s.strip() for s in SYMBOLS_RAW.split(",")]
RAILWAY_URL    = os.getenv("RAILWAY_WS_URL", "wss://leilaowdo-profit-production.up.railway.app/bridge")
BRIDGE_SECRET  = os.getenv("BRIDGE_SECRET", "")
EXCHANGE_BMF   = "F"
LOCK_FILE      = Path(r"C:\ProfitBridge\bridge.lock")

log.info(f"=== ProfitBridge v5.0 ===")
log.info(f"Railway: {RAILWAY_URL}")
log.info(f"Simbolos: {SYMBOLS}")

# ── Fila thread-safe ─────────────────────────────────────────────
event_queue = queue.Queue(maxsize=30000)

def enqueue(obj):
    try:
        event_queue.put_nowait(obj)
    except queue.Full:
        pass

def safe_json(obj):
    """Serializa para JSON tratando -inf, inf e NaN como null."""
    def sanitize(o):
        if isinstance(o, dict):
            return {k: sanitize(v) for k, v in o.items()}
        if isinstance(o, list):
            return [sanitize(v) for v in o]
        if isinstance(o, float):
            if not math.isfinite(o):
                return None
        return o
    return json.dumps(sanitize(obj))

# ── Estruturas ctypes (documentacao Nelogica) ────────────────────
class TAssetIDRec(ctypes.Structure):
    _fields_ = [
        ("pwcTicker", ctypes.c_wchar_p),
        ("pwcBolsa",  ctypes.c_wchar_p),
        ("nFeed",     ctypes.c_int),
    ]

class TConnectorAssetIdentifier(ctypes.Structure):
    _fields_ = [
        ("Version",  ctypes.c_ubyte),
        ("Ticker",   ctypes.c_wchar * 25),
        ("Exchange", ctypes.c_wchar * 4),
        ("FeedType", ctypes.c_int),
    ]

class TConnectorPriceGroup(ctypes.Structure):
    _fields_ = [
        ("Version",         ctypes.c_ubyte),
        ("Price",           ctypes.c_double),
        ("Count",           ctypes.c_uint),
        ("Quantity",        ctypes.c_longlong),   # Int64 — OBRIGATORIO c_longlong
        ("PriceGroupFlags", ctypes.c_uint),
    ]

# ── Tipos de callback (documentacao Nelogica) ────────────────────
TStateCallback             = ctypes.WINFUNCTYPE(None, ctypes.c_int, ctypes.c_int)
TNewTradeCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p,
                                ctypes.c_uint32, ctypes.c_double, ctypes.c_double,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_char)
TNewDailyCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p,
                                ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
                                ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
                                ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int)
TPriceBookCallback         = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_double,
                                ctypes.c_void_p, ctypes.c_void_p)
TOfferBookCallback         = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int64,
                                ctypes.c_double, ctypes.c_char, ctypes.c_char, ctypes.c_char,
                                ctypes.c_char, ctypes.c_char, ctypes.c_wchar_p,
                                ctypes.c_void_p, ctypes.c_void_p)
THistoryTradeCallback      = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p,
                                ctypes.c_uint32, ctypes.c_double, ctypes.c_double,
                                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int)
TTinyBookCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_double, ctypes.c_int, ctypes.c_int)
TTheoreticalPriceCallback  = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_double, ctypes.c_int64)
TChangeStateTickerCallback = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_wchar_p, ctypes.c_int)
TProgressCallback          = ctypes.WINFUNCTYPE(None, TAssetIDRec, ctypes.c_int)

# Asset identifier passado POR VALOR no callback (nao como ponteiro)
TConnectorPriceDepthCallback = ctypes.WINFUNCTYPE(
    None,
    TConnectorAssetIdentifier,  # por valor — sem POINTER
    ctypes.c_ubyte,             # side: 0=buy 1=sell
    ctypes.c_int,               # position
    ctypes.c_ubyte,             # updateType
)

# ── Callbacks — SO ENFILEIRAM ────────────────────────────────────
_cb_refs = {}
_dll_ref = None
dll_ready = threading.Event()

def _cb_state(t, r):
    names   = {0:"LOGIN", 1:"ROTEAMENTO", 2:"MARKET_DATA", 3:"MARKET_LOGIN"}
    results = {0:"CONNECTED", 1:"CONNECTING", 2:"WAITING", 3:"NOT_LOGGED", 4:"CONNECTED", 5:"BROKER_CONNECTED"}
    log.info(f"STATE [{names.get(t,'?')}] -> {results.get(r, str(r))}")
    # MARKET_DATA=2 + CONNECTED=4 => pronto para subscribes
    if t == 2 and r == 4:
        dll_ready.set()
    enqueue({"type": "connection_state", "conn_type": t, "result": r,
             "ts": datetime.now().isoformat()})

def _cb_trade(a, d, n, p, v, q, ba, sa, tt, e):
    # tt: 2=BUY_AGRESSIVO 3=SELL_AGRESSIVO 4=AUCTION
    agg = {2: "buyer", 3: "seller", 4: "auction"}.get(tt)
    enqueue({"type": "trade", "ticker": a.pwcTicker, "price": p, "volume": v,
             "quantity": q, "buy_agent": ba, "sell_agent": sa,
             "aggressor": agg, "ts": datetime.now().isoformat()})

def _cb_theo(a, p, q):
    enqueue({"type": "theoretical_price", "ticker": a.pwcTicker,
             "theoretical_price": p, "theoretical_qty": q,
             "ts": datetime.now().isoformat()})

def _cb_state_ticker(a, d, s):
    names = {0:"OPENED", 4:"AUCTIONED", 6:"CLOSED", 10:"PRE_CLOSING", 13:"PRE_OPENING"}
    sn = names.get(s, f"UNKNOWN_{s}")
    log.info(f"TICKER [{a.pwcTicker}] -> {sn}")
    enqueue({"type": "ticker_state", "ticker": a.pwcTicker, "state": sn,
             "in_auction": (s == 4), "ts": datetime.now().isoformat()})

def _cb_tiny(a, p, q, s):
    enqueue({"type": "tiny_book", "ticker": a.pwcTicker, "price": p,
             "quantity": q, "side": "BUY" if s == 0 else "SELL",
             "ts": datetime.now().isoformat()})

def _cb_daily(a, d, o, h, l, c, v, *x):
    enqueue({"type": "daily", "ticker": a.pwcTicker,
             "open": o, "high": h, "low": l, "close": c, "volume": v,
             "ts": datetime.now().isoformat()})

def _cb_offer(*a):
    # OfferBook legado (API DLLInitializeMarketLogin) — nao usado para profundidade.
    # A documentacao Nelogica recomenda SubscribePriceDepth + TConnectorPriceDepthCallback
    # (ja implementado em _cb_price_depth) como API atual para livro de profundidade.
    # Este callback fica registrado mas vazio pois nao e a via documentada para o livro.
    pass
def _cb_stub(*a):  pass

def _cb_price_depth(asset, side, position, update_type):
    """
    Callback do PriceDepth — roda na ConnectorThread.
    SO ENFILEIRA — nao chama funcoes da DLL aqui.
    """
    enqueue({"type": "_pd_notify", "ticker": asset.Ticker,
             "side": side, "pos": position, "ut": update_type})

def _read_price_depth(dll, ticker):
    """
    Le o livro completo via GetPriceGroup.
    Chamado FORA do callback (thread consumidora).
    Documentacao: posicao 0 = topo do livro.
    Durante leilao, Price pode ser -INF — usar GetTheoreticalValues.
    """
    try:
        asset = TConnectorAssetIdentifier()
        asset.Version  = 0
        asset.Ticker   = ticker
        asset.Exchange = EXCHANGE_BMF
        asset.FeedType = 0

        bids, asks = [], []
        for side, arr in [(0, bids), (1, asks)]:
            total = dll.GetPriceDepthSideCount(ctypes.byref(asset), side)
            for pos in range(min(40, total)):
                g = TConnectorPriceGroup()
                g.Version = 0
                ret = dll.GetPriceGroup(ctypes.byref(asset), side, pos, ctypes.byref(g))
                if ret != 0:
                    continue
                is_theoric = bool(g.PriceGroupFlags & 1)
                price = g.Price
                # Se preco teorico, buscar valor real
                if is_theoric or not math.isfinite(price):
                    tp = ctypes.c_double(0)
                    tq = ctypes.c_int64(0)
                    if dll.GetTheoreticalValues(ctypes.byref(asset), ctypes.byref(tp), ctypes.byref(tq)) == 0:
                        price = tp.value
                if price > 0 and math.isfinite(price):
                    arr.append({"price": price, "qty": g.Quantity,
                                "count": g.Count, "is_theoric": is_theoric})

        if bids or asks:
            enqueue({"type": "price_depth", "ticker": ticker,
                     "bids": bids, "asks": asks,
                     "ts": datetime.now().isoformat()})
    except Exception as e:
        log.error(f"_read_price_depth [{ticker}]: {e}")

# ── Inicializacao da DLL ─────────────────────────────────────────
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
    dll.DLLInitializeMarketLogin.argtypes = [
        ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
        TStateCallback, TNewTradeCallback, TNewDailyCallback,
        TPriceBookCallback, TOfferBookCallback, THistoryTradeCallback,
        TProgressCallback, TTinyBookCallback,
    ]
    r = dll.DLLInitializeMarketLogin(
        ACTIVATION_KEY, USERNAME, PASSWORD,
        _cb_refs["s"], _cb_refs["t"], _cb_refs["d"],
        _cb_refs["pb"], _cb_refs["ob"], _cb_refs["ht"],
        _cb_refs["pr"], _cb_refs["tb"],
    )
    if r != 0:
        raise RuntimeError(f"DLLInitializeMarketLogin falhou: {hex(r)}")
    log.info("DLL inicializada OK")

def subscribe(dll):
    global _dll_ref
    _dll_ref = dll

    # Registrar callbacks adicionais (SetXCallback — apos inicializacao)
    _cb_refs["theo"] = TTheoreticalPriceCallback(_cb_theo)
    dll.SetTheoreticalPriceCallback.restype  = ctypes.c_int
    dll.SetTheoreticalPriceCallback.argtypes = [TTheoreticalPriceCallback]
    dll.SetTheoreticalPriceCallback(_cb_refs["theo"])

    _cb_refs["st"] = TChangeStateTickerCallback(_cb_state_ticker)
    dll.SetChangeStateTickerCallback.restype  = ctypes.c_int
    dll.SetChangeStateTickerCallback.argtypes = [TChangeStateTickerCallback]
    dll.SetChangeStateTickerCallback(_cb_refs["st"])

    # PriceDepth callback — asset por VALOR, nao ponteiro
    _cb_refs["pd"] = TConnectorPriceDepthCallback(_cb_price_depth)
    dll.SetPriceDepthCallback.restype  = ctypes.c_int
    dll.SetPriceDepthCallback.argtypes = [TConnectorPriceDepthCallback]
    dll.SetPriceDepthCallback(_cb_refs["pd"])

    # Configurar argtypes antes de chamar
    dll.SubscribeTicker.restype       = ctypes.c_int
    dll.SubscribeTicker.argtypes      = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    dll.SubscribePriceDepth.restype   = ctypes.c_int
    dll.SubscribePriceDepth.argtypes  = [ctypes.POINTER(TConnectorAssetIdentifier)]
    dll.GetPriceDepthSideCount.restype  = ctypes.c_int
    dll.GetPriceDepthSideCount.argtypes = [ctypes.POINTER(TConnectorAssetIdentifier), ctypes.c_int]
    dll.GetPriceGroup.restype  = ctypes.c_int
    dll.GetPriceGroup.argtypes = [ctypes.POINTER(TConnectorAssetIdentifier),
                                   ctypes.c_int, ctypes.c_int,
                                   ctypes.POINTER(TConnectorPriceGroup)]
    dll.GetTheoreticalValues.restype  = ctypes.c_int
    dll.GetTheoreticalValues.argtypes = [ctypes.POINTER(TConnectorAssetIdentifier),
                                          ctypes.POINTER(ctypes.c_double),
                                          ctypes.POINTER(ctypes.c_int64)]

    for sym in SYMBOLS:
        # SubscribeTicker: ativa trade + tinybook + daily de uma vez
        # Documentacao: ret != 0 = NL_OK violado (codigo de erro Nelogica)
        t = dll.SubscribeTicker(sym, EXCHANGE_BMF)
        log.info(f"SubscribeTicker [{sym}] = {t} ({'OK' if t == 0 else 'ERRO codigo ' + str(t)})")

        # SubscribePriceDepth: livro de profundidade agregado por nivel
        # Documentacao: https://ajuda.nelogica.com.br/.../Como-utilizar-o-Livro-de-Profundidade
        asset = TConnectorAssetIdentifier()
        asset.Version  = 0
        asset.Ticker   = sym
        asset.Exchange = EXCHANGE_BMF
        asset.FeedType = 0
        pd = dll.SubscribePriceDepth(ctypes.byref(asset))
        if pd == 0:
            log.info(f"SubscribePriceDepth [{sym}] = OK")
        else:
            log.warning(f"SubscribePriceDepth [{sym}] = ERRO codigo {pd} — usando TinyBook como fallback")

        # SubscribeOfferBook: livro de ofertas granular (oferta individual com agente)
        # Documentacao: distinto do PriceDepth — callback TOfferBookCallbackV2 via SetOfferBookCallbackV2
        try:
            ob = dll.SubscribeOfferBook(sym, EXCHANGE_BMF)
            if ob == 0:
                log.info(f"SubscribeOfferBook [{sym}] = OK")
            else:
                log.warning(f"SubscribeOfferBook [{sym}] = ERRO codigo {ob}")
        except Exception as e:
            log.warning(f"SubscribeOfferBook [{sym}] indisponivel nesta DLL: {e}")

def dll_thread_fn(dll):
    try:
        init_dll(dll)
        log.info("Aguardando MARKET_DATA CONNECTED...")
        if not dll_ready.wait(timeout=90):
            log.error("Timeout aguardando conexao DLL")
            return
        time.sleep(1)
        subscribe(dll)
    except Exception as e:
        log.exception(f"Erro na thread DLL: {e}")

# ── Lock de processo unico ───────────────────────────────────────
def acquire_lock():
    if LOCK_FILE.exists():
        try:
            pid = int(LOCK_FILE.read_text().strip())
            import ctypes as _ct
            h = _ct.windll.kernel32.OpenProcess(0x1000, False, pid)
            if h:
                _ct.windll.kernel32.CloseHandle(h)
                log.error(f"Bridge ja rodando (PID {pid})")
                sys.exit(1)
        except Exception:
            pass
    LOCK_FILE.write_text(str(os.getpid()))
    log.info(f"Lock adquirido (PID {os.getpid()})")

# ── Loop WebSocket → Railway ─────────────────────────────────────
async def railway_loop():
    backoff = 5
    while True:
        try:
            log.info(f"Conectando: {RAILWAY_URL}")
            async with websockets.connect(
                RAILWAY_URL,
                additional_headers={"X-Bridge-Secret": BRIDGE_SECRET},
                ping_interval=10,
                ping_timeout=20,
                close_timeout=5,
            ) as ws:
                log.info("CONECTADO ao Railway via /bridge!")
                backoff = 5
                last_hb = asyncio.get_event_loop().time()

                while True:
                    events = []
                    try:
                        for _ in range(100):
                            msg = event_queue.get_nowait()
                            if msg.get("type") == "_pd_notify":
                                # Ler livro FORA do callback — documentacao Nelogica
                                ut = msg.get("ut", -1)
                                # utAdd=0 utEdit=1 utDelete=2 utFullBook=4 utFlush=6
                                if ut in (0, 1, 4, 6) and _dll_ref:
                                    ticker = msg["ticker"]
                                    dll    = _dll_ref
                                    asyncio.get_event_loop().run_in_executor(
                                        None, lambda t=ticker, d=dll: _read_price_depth(d, t)
                                    )
                            else:
                                events.append(msg)
                    except queue.Empty:
                        pass

                    if events:
                        payload = events if len(events) > 1 else events[0]
                        await ws.send(safe_json(payload))

                    # Gravar bridge.status para o watchdog
                    now_t = asyncio.get_event_loop().time()
                    if now_t - last_hb >= 8:
                        last_hb = now_t
                        await ws.send(json.dumps({"type": "heartbeat", "ts": int(now_t)}))
                        # Atualizar status file para o watchdog
                        try:
                            status = {
                                "last_heartbeat": datetime.now().isoformat(),
                                "dll_connected": True,
                                "railway_connected": True,
                            }
                            Path(r"C:\ProfitBridge\bridge.status").write_text(json.dumps(status))
                        except Exception:
                            pass

                    await asyncio.sleep(0.05)

        except Exception as e:
            log.error(f"Desconectado: {e} — retry em {backoff}s")
            # Marcar desconectado no status
            try:
                status = {
                    "last_heartbeat": datetime.now().isoformat(),
                    "dll_connected": True,
                    "railway_connected": False,
                }
                Path(r"C:\ProfitBridge\bridge.status").write_text(json.dumps(status))
            except Exception:
                pass
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 120)

# ── Entry point ──────────────────────────────────────────────────
if __name__ == "__main__":
    if not all([ACTIVATION_KEY, USERNAME, PASSWORD]):
        log.error("Credenciais faltando — verificar launcher.py")
        sys.exit(1)

    p = Path(DLL_PATH)
    if not p.exists():
        log.error(f"DLL nao encontrada: {p}")
        sys.exit(1)

    acquire_lock()

    try:
        # WinDLL = stdcall (OBRIGATORIO conforme documentacao Nelogica)
        dll = ctypes.WinDLL(str(p))
        threading.Thread(target=dll_thread_fn, args=(dll,), daemon=True, name="DLLThread").start()
        asyncio.run(railway_loop())
    except KeyboardInterrupt:
        log.info("Encerrando...")
        try:
            dll.DLLFinalize()
        except Exception:
            pass
    finally:
        try:
            LOCK_FILE.unlink()
        except Exception:
            pass
