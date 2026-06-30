"""
ProfitBridge v6.0
Implementado exclusivamente a partir da documentacao oficial Nelogica:
  - Ecossistema ProfitDLL e primeiros passos
  - Funcoes Real Time - DLL
  - Como utilizar o Livro de Profundidade (Price Depth) via DLL Real Time
  - Como saber se a DLL esta conectada

Papel deste processo: DLL -> JSON -> WebSocket. Nenhuma logica de negocio aqui.
Todo calculo de leilao, risco ou sinal acontece no backend (Railway), nunca aqui.
"""
import asyncio
import ctypes
import json
import logging
import math
import os
import queue
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import websockets
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────
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

# ──────────────────────────────────────────────────────────────────
# Configuracao (variaveis de ambiente — ver launcher.py)
# ──────────────────────────────────────────────────────────────────
ACTIVATION_KEY = os.getenv("PROFIT_ACTIVATION_KEY", "")
USERNAME       = os.getenv("PROFIT_USERNAME", "")
PASSWORD       = os.getenv("PROFIT_PASSWORD", "")
DLL_PATH       = os.getenv("PROFIT_DLL_PATH", r"C:\ProfitBridge\Win64\ProfitDLL.dll")
SYMBOLS_RAW    = os.getenv("SYMBOLS", "WDON26,DOLN26")
SYMBOLS        = [s.strip() for s in SYMBOLS_RAW.split(",") if s.strip()]
RAILWAY_URL    = os.getenv("RAILWAY_WS_URL", "wss://leilaowdo-profit-production.up.railway.app/bridge")
BRIDGE_SECRET  = os.getenv("BRIDGE_SECRET", "")
EXCHANGE_BMF   = "F"
LOCK_FILE      = Path(r"C:\ProfitBridge\bridge.lock")
STATUS_FILE    = Path(r"C:\ProfitBridge\bridge.status")

log.info("=== ProfitBridge v6.0 ===")
log.info(f"Railway: {RAILWAY_URL}")
log.info(f"Simbolos: {SYMBOLS}")

# ──────────────────────────────────────────────────────────────────
# Fila thread-safe — callbacks SO enfileiram, nunca processam
# (documentacao: callbacks rodam na ConnectorThread, bloquear = atraso)
# ──────────────────────────────────────────────────────────────────
event_queue = queue.Queue(maxsize=30000)


def enqueue(obj):
    try:
        event_queue.put_nowait(obj)
    except queue.Full:
        pass


def safe_json(obj):
    """JSON nao aceita -inf/inf/NaN. A doc menciona que Price pode vir -INF
    durante leilao (sinalizacao de preco teorico) — sanitizamos antes de serializar."""
    def sanitize(o):
        if isinstance(o, dict):
            return {k: sanitize(v) for k, v in o.items()}
        if isinstance(o, list):
            return [sanitize(v) for v in o]
        if isinstance(o, float) and not math.isfinite(o):
            return None
        return o
    return json.dumps(sanitize(obj))


# ──────────────────────────────────────────────────────────────────
# Estruturas ctypes — exatamente como documentado
# ──────────────────────────────────────────────────────────────────

class TAssetID(ctypes.Structure):
    """Struct legada usada pelos callbacks de inicializacao (trade, daily, tiny_book).
    Documentacao: 'Topo do livro (TinyBook)' e 'Ecossistema ProfitDLL'."""
    _fields_ = [
        ("Ticker",   ctypes.c_wchar_p),
        ("Bolsa",    ctypes.c_wchar_p),
        ("Feed",     ctypes.c_int),
    ]


class TConnectorAssetIdentifier(ctypes.Structure):
    """Struct moderna usada por SubscribePriceDepth, GetPriceGroup,
    GetPriceDepthSideCount, GetTheoreticalValues e pelo callback de PriceDepth.

    IMPORTANTE: Ticker e Exchange sao ponteiros (c_wchar_p), NAO arrays fixos.
    A documentacao web mostra como array fixo (c_wchar*25), mas isso causa
    Access Violation dentro de ConnectorUtilsU.GetAssetID (confirmado via
    Erro.log da propria DLL: 'Read of address ...' em System.@PWCharLen,
    chamado a partir de System.@UStrFromPWChar). A funcao interna da DLL
    espera ler uma string Delphi via ponteiro, nao copiar de um buffer
    embutido na struct. Usar c_wchar_p resolve o Access Violation e faz
    SubscribePriceDepth retornar 0 (sucesso) em vez de -2147483647.
    """
    _fields_ = [
        ("Version",  ctypes.c_ubyte),
        ("Ticker",   ctypes.c_wchar_p),
        ("Exchange", ctypes.c_wchar_p),
        ("FeedType", ctypes.c_int),
    ]


class TConnectorPriceGroup(ctypes.Structure):
    """Retornada por GetPriceGroup. Quantity e Int64 — documentacao alerta
    explicitamente para usar c_longlong, nunca c_long (trunca em Windows x64)."""
    _fields_ = [
        ("Version",         ctypes.c_ubyte),
        ("Price",           ctypes.c_double),
        ("Count",           ctypes.c_uint),
        ("Quantity",        ctypes.c_longlong),
        ("PriceGroupFlags", ctypes.c_uint),
    ]


# ──────────────────────────────────────────────────────────────────
# Tipos de callback — assinaturas exatas da documentacao
# ──────────────────────────────────────────────────────────────────

# Callback de estado de conexao (login, roteamento, market data, market login)
TStateCallback = ctypes.WINFUNCTYPE(None, ctypes.c_int, ctypes.c_int)

# Callback de trade legado, usado na inicializacao (DLLInitializeMarketLogin).
# A doc indica TConnectorTradeCallback + SetTradeCallbackV2 como API atual de trade,
# mas a assinatura abaixo e a exigida pelos parametros de DLLInitializeMarketLogin.
TNewTradeCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_wchar_p, ctypes.c_uint32,
    ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_char,
)

# Callback de dados diarios consolidados — NAO e tempo real (doc: "atualizado
# em intervalos maiores, na ordem de segundos").
TNewDailyCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_wchar_p,
    ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
    ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double,
    ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
)

# Callbacks exigidos como parametro de DLLInitializeMarketLogin mas nao usados
# para extracao de dados (mantidos como stub vazio, apenas para satisfazer a assinatura).
TPriceBookCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_double,
    ctypes.c_void_p, ctypes.c_void_p,
)
TOfferBookCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_int64, ctypes.c_double,
    ctypes.c_char, ctypes.c_char, ctypes.c_char, ctypes.c_char, ctypes.c_char,
    ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_void_p,
)
THistoryTradeCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_wchar_p, ctypes.c_uint32,
    ctypes.c_double, ctypes.c_double, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int,
)
TProgressCallback = ctypes.WINFUNCTYPE(None, TAssetID, ctypes.c_int)

# Topo do livro — TTinyBookCallback (documentacao: "Topo do livro (TinyBook)")
# Assinatura: (asset, price, qty, side) — side: 0=bid, 1=ask
TTinyBookCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_double, ctypes.c_int, ctypes.c_int,
)

# Preco teorico durante leilao (SetTheoreticalPriceCallback)
TTheoreticalPriceCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_double, ctypes.c_int64,
)

# Mudanca de estado do ticker (abertura, leilao, fechamento)
TChangeStateTickerCallback = ctypes.WINFUNCTYPE(
    None, TAssetID, ctypes.c_wchar_p, ctypes.c_int,
)

# Livro de profundidade — TConnectorPriceDepthCallback
# Documentacao: "asset passado POR VALOR (nao como ponteiro)";
# ordem (asset, side, position, updateType); updateType e byte (c_ubyte).
TConnectorPriceDepthCallback = ctypes.WINFUNCTYPE(
    None,
    TConnectorAssetIdentifier,  # por valor
    ctypes.c_ubyte,             # side: 0=buy, 1=sell
    ctypes.c_int,               # position
    ctypes.c_ubyte,             # updateType
)


# ──────────────────────────────────────────────────────────────────
# Callbacks — SO enfileiram (documentacao: "Apenas enfileire dentro
# do callback; processe em outra thread")
# ──────────────────────────────────────────────────────────────────
_cb_refs = {}     # mantem referencias vivas — anti garbage-collector
_dll_ref = None
dll_ready = threading.Event()


def _cb_state(conn_type, result):
    names_type   = {0: "LOGIN", 1: "ROTEAMENTO", 2: "MARKET_DATA", 3: "MARKET_LOGIN"}
    names_result = {0: "DISCONNECTED", 1: "CONNECTING", 2: "WAITING", 3: "NOT_LOGGED",
                     4: "CONNECTED", 5: "BROKER_CONNECTED"}
    log.info(f"STATE [{names_type.get(conn_type, conn_type)}] -> "
             f"{names_result.get(result, result)}")

    # Pronto para subscribes quando MARKET_DATA reporta CONNECTED
    if conn_type == 2 and result == 4:
        dll_ready.set()

    enqueue({
        "type": "connection_state",
        "conn_type": conn_type,
        "result": result,
        "ts": datetime.now().isoformat(),
    })


def _cb_trade(asset, date_str, trade_number, price, volume, qty,
              buy_agent, sell_agent, trade_type, edit):
    # trade_type: 2=compra agressiva, 3=venda agressiva, 4=leilao (conforme uso ja validado)
    aggressor = {2: "buyer", 3: "seller", 4: "auction"}.get(trade_type)
    enqueue({
        "type": "trade",
        "ticker": asset.Ticker,
        "price": price,
        "volume": volume,
        "quantity": qty,
        "buy_agent": buy_agent,
        "sell_agent": sell_agent,
        "aggressor": aggressor,
        "ts": datetime.now().isoformat(),
    })


def _cb_daily(asset, date_str, sopen, high, low, close, volume, *rest):
    enqueue({
        "type": "daily",
        "ticker": asset.Ticker,
        "open": sopen, "high": high, "low": low, "close": close,
        "volume": volume,
        "ts": datetime.now().isoformat(),
    })


def _cb_tiny_book(asset, price, qty, side):
    enqueue({
        "type": "tiny_book",
        "ticker": asset.Ticker,
        "price": price,
        "quantity": qty,
        "side": "BUY" if side == 0 else "SELL",
        "ts": datetime.now().isoformat(),
    })


def _cb_theoretical_price(asset, price, qty):
    enqueue({
        "type": "theoretical_price",
        "ticker": asset.Ticker,
        "theoretical_price": price,
        "theoretical_qty": qty,
        "ts": datetime.now().isoformat(),
    })


def _cb_state_ticker(asset, date_str, state):
    names = {0: "OPENED", 4: "AUCTIONED", 6: "CLOSED", 10: "PRE_CLOSING", 13: "PRE_OPENING"}
    state_name = names.get(state, f"UNKNOWN_{state}")
    log.info(f"TICKER [{asset.Ticker}] -> {state_name}")
    enqueue({
        "type": "ticker_state",
        "ticker": asset.Ticker,
        "state": state_name,
        "in_auction": (state == 4),
        "ts": datetime.now().isoformat(),
    })


def _cb_price_depth(asset, side, position, update_type):
    """Documentacao: 'Nao chame funcoes da DLL dentro do callback' e
    'apenas enfileire'. A leitura real do livro (GetPriceGroup) acontece
    fora deste callback, na thread consumidora da fila."""
    enqueue({
        "type": "_price_depth_notify",
        "ticker": asset.Ticker,
        "side": side,
        "position": position,
        "update_type": update_type,
    })


def _cb_stub(*args):
    """Callbacks exigidos pela assinatura de DLLInitializeMarketLogin mas
    sem uso de dados neste bridge (PriceBook legado, OfferBook legado,
    historico de trades, progresso)."""
    pass


# ──────────────────────────────────────────────────────────────────
# Leitura do livro de profundidade — fora do callback
# Documentacao: posicao 0 = topo do livro; durante leilao Price pode
# vir -INF (use GetTheoreticalValues nesse caso).
# ──────────────────────────────────────────────────────────────────
def _read_price_depth(dll, ticker, max_levels=40):
    try:
        _t = ctypes.create_unicode_buffer(ticker)
        _e = ctypes.create_unicode_buffer(EXCHANGE_BMF)
        asset = TConnectorAssetIdentifier()
        asset.Version  = 0
        asset.Ticker   = ctypes.cast(_t, ctypes.c_wchar_p)
        asset.Exchange = ctypes.cast(_e, ctypes.c_wchar_p)
        asset.FeedType = 0

        bids, asks = [], []
        _counts_log = {}
        for side, bucket in [(0, bids), (1, asks)]:
            total = dll.GetPriceDepthSideCount(ctypes.byref(asset), side)
            _counts_log['BID' if side==0 else 'ASK'] = total
            for pos in range(min(max_levels, total)):
                group = TConnectorPriceGroup()
                group.Version = 0
                ret = dll.GetPriceGroup(ctypes.byref(asset), side, pos, ctypes.byref(group))
                if ret != 0:
                    continue

                is_theoric = bool(group.PriceGroupFlags & 1)
                price = group.Price

                if is_theoric or not math.isfinite(price):
                    theo_price = ctypes.c_double(0)
                    theo_qty   = ctypes.c_int64(0)
                    ret_theo = dll.GetTheoreticalValues(
                        ctypes.byref(asset), ctypes.byref(theo_price), ctypes.byref(theo_qty)
                    )
                    if ret_theo == 0:
                        price = theo_price.value

                if price > 0 and math.isfinite(price):
                    bucket.append({
                        "price": price,
                        "qty": group.Quantity,
                        "count": group.Count,
                        "is_theoric": is_theoric,
                    })

        if not hasattr(_read_price_depth, '_log_count'):
            _read_price_depth._log_count = {}
        _lc = _read_price_depth._log_count
        _lc[ticker] = _lc.get(ticker, 0) + 1
        if _lc[ticker] <= 10 or _lc[ticker] % 200 == 0:
            log.info(f"[DEPTH_COUNT] {ticker} counts={_counts_log} bids_lidos={len(bids)} asks_lidos={len(asks)} #{_lc[ticker]}")

        if bids or asks:
            enqueue({
                "type": "price_depth",
                "ticker": ticker,
                "bids": bids,
                "asks": asks,
                "ts": datetime.now().isoformat(),
            })
    except Exception as e:
        log.error(f"_read_price_depth [{ticker}]: {e}")


# ──────────────────────────────────────────────────────────────────
# Inicializacao da DLL
# Documentacao: DLLInitializeMarketLogin(activation, user, password, callbacks...)
# ──────────────────────────────────────────────────────────────────
def init_dll(dll):
    _cb_refs["state"]  = TStateCallback(_cb_state)
    _cb_refs["trade"]  = TNewTradeCallback(_cb_trade)
    _cb_refs["daily"]  = TNewDailyCallback(_cb_daily)
    _cb_refs["pbook"]  = TPriceBookCallback(_cb_stub)
    _cb_refs["obook"]  = TOfferBookCallback(_cb_stub)
    _cb_refs["htrade"] = THistoryTradeCallback(_cb_stub)
    _cb_refs["progress"] = TProgressCallback(_cb_stub)
    _cb_refs["tiny"]   = TTinyBookCallback(_cb_tiny_book)

    dll.DLLInitializeMarketLogin.restype  = ctypes.c_int
    dll.DLLInitializeMarketLogin.argtypes = [
        ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
        TStateCallback, TNewTradeCallback, TNewDailyCallback,
        TPriceBookCallback, TOfferBookCallback, THistoryTradeCallback,
        TProgressCallback, TTinyBookCallback,
    ]

    ret = dll.DLLInitializeMarketLogin(
        ACTIVATION_KEY, USERNAME, PASSWORD,
        _cb_refs["state"], _cb_refs["trade"], _cb_refs["daily"],
        _cb_refs["pbook"], _cb_refs["obook"], _cb_refs["htrade"],
        _cb_refs["progress"], _cb_refs["tiny"],
    )
    if ret != 0:
        raise RuntimeError(f"DLLInitializeMarketLogin falhou: codigo {ret} ({hex(ret)})")
    log.info("DLL inicializada")


# ──────────────────────────────────────────────────────────────────
# Assinaturas de tempo real
# Documentacao "Funcoes Real Time - DLL": tabela de Subscribe -> Callback
# ──────────────────────────────────────────────────────────────────
def subscribe(dll):
    global _dll_ref
    _dll_ref = dll

    # SetTheoreticalPriceCallback — precisa ser registrado apos a inicializacao
    _cb_refs["theo"] = TTheoreticalPriceCallback(_cb_theoretical_price)
    dll.SetTheoreticalPriceCallback.restype  = ctypes.c_int
    dll.SetTheoreticalPriceCallback.argtypes = [TTheoreticalPriceCallback]
    dll.SetTheoreticalPriceCallback(_cb_refs["theo"])

    # SetChangeStateTickerCallback — mudancas de estado do ticker (leilao etc)
    _cb_refs["state_ticker"] = TChangeStateTickerCallback(_cb_state_ticker)
    dll.SetChangeStateTickerCallback.restype  = ctypes.c_int
    dll.SetChangeStateTickerCallback.argtypes = [TChangeStateTickerCallback]
    dll.SetChangeStateTickerCallback(_cb_refs["state_ticker"])

    # SetPriceDepthCallback — registra o callback do livro de profundidade.
    # Documentacao: asset passado por valor, sem POINTER.
    _cb_refs["price_depth"] = TConnectorPriceDepthCallback(_cb_price_depth)
    dll.SetPriceDepthCallback.restype  = ctypes.c_int
    dll.SetPriceDepthCallback.argtypes = [TConnectorPriceDepthCallback]
    dll.SetPriceDepthCallback(_cb_refs["price_depth"])

    # Assinaturas das funcoes usadas no loop de subscribe abaixo
    dll.SubscribeTicker.restype          = ctypes.c_int
    dll.SubscribeTicker.argtypes         = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    dll.SubscribePriceDepth.restype      = ctypes.c_int
    dll.SubscribePriceDepth.argtypes     = [ctypes.POINTER(TConnectorAssetIdentifier)]
    dll.GetPriceDepthSideCount.restype   = ctypes.c_int
    dll.GetPriceDepthSideCount.argtypes  = [ctypes.POINTER(TConnectorAssetIdentifier), ctypes.c_int]
    dll.GetPriceGroup.restype            = ctypes.c_int
    dll.GetPriceGroup.argtypes           = [
        ctypes.POINTER(TConnectorAssetIdentifier),
        ctypes.c_int, ctypes.c_int,
        ctypes.POINTER(TConnectorPriceGroup),
    ]
    dll.GetTheoreticalValues.restype     = ctypes.c_int
    dll.GetTheoreticalValues.argtypes    = [
        ctypes.POINTER(TConnectorAssetIdentifier),
        ctypes.POINTER(ctypes.c_double),
        ctypes.POINTER(ctypes.c_int64),
    ]

    for sym in SYMBOLS:
        # SubscribeTicker — ativa trade + tinybook + dados diarios de uma vez
        ret_ticker = dll.SubscribeTicker(sym, EXCHANGE_BMF)
        log.info(f"SubscribeTicker [{sym}] = {ret_ticker} "
                 f"({'OK' if ret_ticker == 0 else 'ERRO'})")

        # SubscribePriceDepth — livro de profundidade agregado por nivel
        # Manter referencia das strings vivas — c_wchar_p nao copia a string,
        # so guarda o ponteiro. Se a string Python for coletada pelo GC antes
        # da DLL usar, vira ponteiro invalido (mesmo bug do Access Violation).
        _ticker_str = ctypes.create_unicode_buffer(sym)
        _exchange_str = ctypes.create_unicode_buffer(EXCHANGE_BMF)
        _cb_refs[f"ticker_{sym}"] = _ticker_str
        _cb_refs[f"exchange_{sym}"] = _exchange_str
        asset = TConnectorAssetIdentifier()
        asset.Version  = 0
        asset.Ticker   = ctypes.cast(_ticker_str, ctypes.c_wchar_p)
        asset.Exchange = ctypes.cast(_exchange_str, ctypes.c_wchar_p)
        asset.FeedType = 0
        ret_depth = dll.SubscribePriceDepth(ctypes.byref(asset))
        log.info(f"SubscribePriceDepth [{sym}] = {ret_depth} "
                 f"({'OK' if ret_depth == 0 else 'ERRO'})")


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


# ──────────────────────────────────────────────────────────────────
# Lock de processo unico
# ──────────────────────────────────────────────────────────────────
def acquire_lock():
    if LOCK_FILE.exists():
        try:
            pid = int(LOCK_FILE.read_text().strip())
            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                log.error(f"Bridge ja em execucao (PID {pid})")
                sys.exit(1)
        except Exception:
            pass
    LOCK_FILE.write_text(str(os.getpid()))
    log.info(f"Lock adquirido (PID {os.getpid()})")


def release_lock():
    try:
        LOCK_FILE.unlink()
    except Exception:
        pass


def write_status(railway_connected: bool):
    try:
        STATUS_FILE.write_text(json.dumps({
            "last_heartbeat": datetime.now().isoformat(),
            "dll_connected": dll_ready.is_set(),
            "railway_connected": railway_connected,
        }))
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────
# Loop principal — WebSocket para o Railway
# ──────────────────────────────────────────────────────────────────
async def railway_loop():
    backoff = 5
    while True:
        try:
            log.info(f"Conectando: {RAILWAY_URL}")
            async with websockets.connect(
                RAILWAY_URL,
                additional_headers={"X-Bridge-Secret": BRIDGE_SECRET},
                ping_interval=8,
                ping_timeout=12,
                close_timeout=5,
            ) as ws:
                log.info("Conectado ao Railway (/bridge)")
                backoff = 5
                last_heartbeat = asyncio.get_event_loop().time()

                while True:
                    # Watchdog interno: conexao zumbi (sem erro mas tambem sem
                    # enviar nada) forca reconexao apos 30s de silencio total.
                    if asyncio.get_event_loop().time() - last_heartbeat > 30:
                        log.warning("Sem heartbeat ha 30s — forcando reconexao")
                        raise ConnectionError("Watchdog: conexao zumbi detectada")

                    batch = []
                    # Debounce: varias notificacoes de PriceDepth chegam em rajada
                    # (cada nivel alterado dispara uma notificacao). Em vez de reler
                    # o livro inteiro a cada notificacao individual (causa flicker
                    # no frontend por reenviar snapshot dezenas de vezes/segundo),
                    # acumula os tickers que mudaram e le o livro UMA VEZ por ciclo.
                    depth_tickers_dirty = set()
                    try:
                        for _ in range(100):
                            msg = event_queue.get_nowait()

                            if msg.get("type") == "_price_depth_notify":
                                update_type = msg.get("update_type", -1)
                                if update_type in (0, 1, 4, 6):
                                    depth_tickers_dirty.add(msg["ticker"])
                            else:
                                batch.append(msg)
                    except queue.Empty:
                        pass

                    if depth_tickers_dirty and _dll_ref is not None:
                        dll = _dll_ref
                        for ticker in depth_tickers_dirty:
                            asyncio.get_event_loop().run_in_executor(
                                None, lambda t=ticker, d=dll: _read_price_depth(d, t)
                            )

                    if batch:
                        payload = batch if len(batch) > 1 else batch[0]
                        await ws.send(safe_json(payload))

                    now = asyncio.get_event_loop().time()
                    if now - last_heartbeat >= 8:
                        last_heartbeat = now
                        await ws.send(json.dumps({"type": "heartbeat", "ts": int(now)}))
                        write_status(railway_connected=True)

                    await asyncio.sleep(0.05)

        except Exception as e:
            log.error(f"Desconectado: {e} — nova tentativa em {backoff}s")
            write_status(railway_connected=False)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 120)


# ──────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not all([ACTIVATION_KEY, USERNAME, PASSWORD]):
        log.error("Credenciais ausentes — verificar launcher.py")
        sys.exit(1)

    dll_path = Path(DLL_PATH)
    if not dll_path.exists():
        log.error(f"DLL nao encontrada em: {dll_path}")
        sys.exit(1)

    acquire_lock()
    dll_handle = None

    try:
        # Documentacao: comunicacao stdcall -> WinDLL (CDLL corrompe a pilha silenciosamente)
        dll_handle = ctypes.WinDLL(str(dll_path))
        threading.Thread(
            target=dll_thread_fn, args=(dll_handle,), daemon=True, name="DLLThread"
        ).start()
        asyncio.run(railway_loop())
    except KeyboardInterrupt:
        log.info("Encerrando...")
    finally:
        if dll_handle is not None:
            try:
                dll_handle.DLLFinalize()
            except Exception:
                pass
        release_lock()
