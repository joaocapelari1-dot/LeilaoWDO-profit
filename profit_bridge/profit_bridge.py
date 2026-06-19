"""
ProfitBridge v1.0
Conecta à ProfitDLL da Nelogica e expõe dados via WebSocket local.

Fluxo:
  ProfitDLL → callbacks → fila → WebSocket ws://0.0.0.0:8787 → profit_client.js (Node.js)

Requisitos:
  pip install websockets
  Windows 64-bit
  ProfitDLL.dll na pasta Win64/

Uso:
  python profit_bridge.py

Variáveis de ambiente (.env ou sistema):
  PROFIT_ACTIVATION_KEY  = chave de ativação fornecida pela Nelogica
  PROFIT_USERNAME        = usuário da conta Nelogica
  PROFIT_PASSWORD        = senha da conta Nelogica
  PROFIT_WS_PORT         = porta WebSocket (default: 8787)
  PROFIT_DLL_PATH        = caminho para ProfitDLL.dll (default: ./Win64/ProfitDLL.dll)
  SYMBOLS                = símbolos a assinar (default: WDOFUT,DOLFUT,WINFUT,INDFUT)
"""

import asyncio
import json
import os
import queue
import threading
import time
import logging
from ctypes import WinDLL, WINFUNCTYPE, c_int, c_wchar_p, c_double, c_longlong, byref
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import websockets
except ImportError:
    print("ERRO: pip install websockets")
    raise

# ── Configuração ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('ProfitBridge')

ACTIVATION_KEY = os.getenv('PROFIT_ACTIVATION_KEY', '')
USERNAME       = os.getenv('PROFIT_USERNAME', '')
PASSWORD       = os.getenv('PROFIT_PASSWORD', '')
WS_PORT        = int(os.getenv('PROFIT_WS_PORT', '8787'))
DLL_PATH       = os.getenv('PROFIT_DLL_PATH', r'.\Win64\ProfitDLL.dll')
SYMBOLS_RAW    = os.getenv('SYMBOLS', 'WDOFUT,DOLFUT,WINFUT,INDFUT')
SYMBOLS        = [s.strip() for s in SYMBOLS_RAW.split(',')]

# ── Constantes DLL ───────────────────────────────────────────────────────────
CONNECTION_STATE_LOGIN        = 0
CONNECTION_STATE_ROTEAMENTO   = 1
CONNECTION_STATE_MARKET_DATA  = 2
CONNECTION_STATE_MARKET_LOGIN = 3

LOGIN_CONNECTED           = 0
MARKET_CONNECTED          = 4
CONNECTION_ACTIVATE_VALID = 0

# ── Estado global ────────────────────────────────────────────────────────────
msg_queue    = queue.Queue(maxsize=10000)  # fila produtor-consumidor
clients      = set()                        # WebSocket clients conectados
dll          = None
connected    = {'login': False, 'market': False, 'ativacao': False}
pronto       = threading.Event()            # sinaliza quando DLL está pronta

# ── Helpers ──────────────────────────────────────────────────────────────────
def brt_now():
    return datetime.now(timezone(timedelta(hours=-3))).strftime('%H:%M:%S.%f')[:-3]

def enfileirar(msg: dict):
    """Enfileira mensagem para broadcast — chamado dos callbacks (não bloqueia)."""
    try:
        msg_queue.put_nowait(msg)
    except queue.Full:
        pass  # descarta se fila cheia

# ── Callbacks da ProfitDLL ───────────────────────────────────────────────────

@WINFUNCTYPE(None, c_int, c_int)
def state_callback(state_type, result):
    """Chamado quando estado de conexão muda."""
    if state_type == CONNECTION_STATE_LOGIN and result == LOGIN_CONNECTED:
        connected['login'] = True
        log.info('✅ Login conectado')
    elif state_type == CONNECTION_STATE_MARKET_DATA and result == MARKET_CONNECTED:
        connected['market'] = True
        log.info('✅ Market Data conectado')
    elif state_type == CONNECTION_STATE_MARKET_LOGIN and result == CONNECTION_ACTIVATE_VALID:
        connected['ativacao'] = True
        log.info('✅ Ativação válida')

    # Quando tudo pronto → assina símbolos
    if all(connected.values()) and not pronto.is_set():
        pronto.set()
        log.info(f'🟢 DLL pronta — assinando: {", ".join(SYMBOLS)}')
        for sym in SYMBOLS:
            dll.SubscribeTicker(c_wchar_p(sym))
        log.info(f'✅ Assinado {len(SYMBOLS)} símbolos')

    enfileirar({'type': 'connection_state', 'state_type': state_type, 'result': result, 'timestamp': int(time.time() * 1000)})


@WINFUNCTYPE(None, c_wchar_p, c_wchar_p, c_int, c_double, c_double,
             c_double, c_double, c_int, c_double, c_double,
             c_double, c_double, c_double, c_int)
def new_trade_callback(symbol, date, trade_number, price, qty,
                       buy_agent, sell_agent, trade_type, bid, ask,
                       theor_price, theor_qty, surplus, surplus_side):
    """Callback para cada negócio em tempo real (SQT/tape)."""
    try:
        side = 'buy' if surplus_side > 0 else ('sell' if surplus_side < 0 else 'balanced')

        tick = {
            'type':        'tick',
            'symbol':      symbol,
            'timestamp':   int(time.time() * 1000),
            'time_brt':    brt_now(),
            'last':        float(price),
            'qty':         int(qty),
            'bid':         float(bid),
            'ask':         float(ask),
            'theor_price': float(theor_price),
            'theor_qty':   int(theor_qty),
            'surplus':     float(surplus),
            'surplus_side': side,
            'buy_agent':   int(buy_agent),
            'sell_agent':  int(sell_agent),
            'trade_type':  int(trade_type),
        }
        enfileirar(tick)
    except Exception as e:
        log.warning(f'new_trade_callback erro: {e}')


@WINFUNCTYPE(None, c_wchar_p, c_int, c_int, c_double, c_int, c_int)
def offer_book_callback(symbol, position, side, price, qty, broker):
    """Callback para cada entrada/atualização no Book L2 (BQT)."""
    try:
        book_entry = {
            'type':     'book_entry',
            'symbol':   symbol,
            'timestamp': int(time.time() * 1000),
            'position': int(position),
            'side':     'bid' if side == 0 else 'ask',
            'price':    float(price),
            'qty':      int(qty),
            'broker':   int(broker),
        }
        enfileirar(book_entry)
    except Exception as e:
        log.warning(f'offer_book_callback erro: {e}')


@WINFUNCTYPE(None, c_wchar_p, c_int, c_double, c_int)
def tiny_book_callback(symbol, side, price, qty):
    """Callback para topo do book (bid/ask)."""
    try:
        enfileirar({
            'type':     'tiny_book',
            'symbol':   symbol,
            'timestamp': int(time.time() * 1000),
            'side':     'bid' if side == 0 else 'ask',
            'price':    float(price),
            'qty':      int(qty),
        })
    except Exception as e:
        log.warning(f'tiny_book_callback erro: {e}')


@WINFUNCTYPE(None, c_wchar_p, c_int, c_double, c_int)
def price_book_callback(symbol, position, price, qty):
    """Callback para Book de Preços agregado."""
    try:
        enfileirar({
            'type':     'price_book',
            'symbol':   symbol,
            'timestamp': int(time.time() * 1000),
            'position': int(position),
            'price':    float(price),
            'qty':      int(qty),
        })
    except Exception as e:
        log.warning(f'price_book_callback erro: {e}')


@WINFUNCTYPE(None, c_wchar_p, c_double, c_double, c_double,
             c_double, c_double, c_double, c_int)
def new_daily_callback(symbol, open_, high, low, close, qty, contracts):
    """Callback para dados diários agregados."""
    try:
        enfileirar({
            'type':      'daily',
            'symbol':    symbol,
            'timestamp': int(time.time() * 1000),
            'open':      float(open_),
            'high':      float(high),
            'low':       float(low),
            'close':     float(close),
            'qty':       float(qty),
            'contracts': int(contracts),
        })
    except Exception as e:
        log.warning(f'new_daily_callback erro: {e}')


@WINFUNCTYPE(None, c_int, c_int)
def progress_callback(asset_id, progress):
    """Callback de progresso de requisições históricas."""
    pass  # não usado no bridge


# ── Inicialização DLL ─────────────────────────────────────────────────────────
def init_dll():
    global dll
    dll_path = Path(DLL_PATH)
    if not dll_path.exists():
        raise FileNotFoundError(f'ProfitDLL.dll não encontrada em: {dll_path.resolve()}')

    log.info(f'Carregando DLL: {dll_path.resolve()}')
    dll = WinDLL(str(dll_path))

    log.info(f'Inicializando Market Data — usuário: {USERNAME}')
    result = dll.DLLInitializeMarketLogin(
        c_wchar_p(ACTIVATION_KEY),
        c_wchar_p(USERNAME),
        c_wchar_p(PASSWORD),
        state_callback,
        new_trade_callback,
        new_daily_callback,
        price_book_callback,
        offer_book_callback,
        None,            # history_trade_callback (não usado)
        progress_callback,
        tiny_book_callback,
    )

    if result != 0:
        raise RuntimeError(f'DLLInitializeMarketLogin retornou: {result}')

    log.info('DLL inicializada — aguardando conexão...')

    # Aguarda conexão completa (timeout 30s)
    if not pronto.wait(timeout=30):
        raise TimeoutError('DLL não conectou em 30 segundos')


# ── WebSocket Server ──────────────────────────────────────────────────────────
async def ws_handler(websocket):
    """Handler para cada cliente WebSocket conectado."""
    clients.add(websocket)
    addr = websocket.remote_address
    log.info(f'Cliente conectado: {addr} (total: {len(clients)})')

    # Envia status inicial
    await websocket.send(json.dumps({
        'type': 'connected',
        'symbols': SYMBOLS,
        'timestamp': int(time.time() * 1000),
    }))

    try:
        await websocket.wait_closed()
    finally:
        clients.discard(websocket)
        log.info(f'Cliente desconectado: {addr} (total: {len(clients)})')


async def broadcast_loop():
    """Loop que consome a fila e faz broadcast para todos os clientes."""
    loop = asyncio.get_event_loop()

    def get_msgs():
        msgs = []
        try:
            while True:
                msgs.append(msg_queue.get_nowait())
        except queue.Empty:
            pass
        return msgs

    while True:
        await asyncio.sleep(0.001)  # 1ms polling

        msgs = await loop.run_in_executor(None, get_msgs)
        if not msgs or not clients:
            continue

        payload = json.dumps(msgs if len(msgs) > 1 else msgs[0])
        dead = set()
        for ws in clients.copy():
            try:
                await ws.send(payload)
            except Exception:
                dead.add(ws)
        clients -= dead


async def main():
    log.info(f'🚀 ProfitBridge iniciando — WebSocket ws://0.0.0.0:{WS_PORT}')

    # Inicializa DLL em thread separada (bloqueia até conectar)
    init_thread = threading.Thread(target=init_dll, daemon=True)
    init_thread.start()
    init_thread.join()

    log.info(f'🟢 ProfitBridge pronto — {len(SYMBOLS)} símbolos ativos')

    # Inicia WebSocket server + broadcast loop
    async with websockets.serve(ws_handler, '0.0.0.0', WS_PORT):
        log.info(f'WebSocket ouvindo em ws://0.0.0.0:{WS_PORT}')
        await broadcast_loop()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info('Encerrando ProfitBridge...')
        if dll:
            dll.DLLFinalize()
        log.info('DLL finalizada. Até logo.')
