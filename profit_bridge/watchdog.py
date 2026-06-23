"""
Watchdog v2.2 - Monitor externo do ProfitBridge
- Heartbeat real via bridge.status
- Reinicia SOMENTE se: processo morreu OU heartbeat parado >5min OU dll_connected=false >5min
- NAO reinicia por ausencia de logs
"""
import subprocess, time, os, datetime, ctypes, json
from pathlib import Path

STATUS_FILE = Path(r'C:\ProfitBridge\bridge.status')
LOCK_FILE   = Path(r'C:\ProfitBridge\bridge.lock')
PYTHON      = r'C:\Program Files\Python311\python.exe'
BRIDGE      = r'C:\ProfitBridge\profit_bridge.py'
DLL_PATH    = os.environ.get('PROFIT_DLL_PATH', r'C:\ProfitBridge\Win64\ProfitDLL.dll')
MAX_IDLE    = 300  # 5 minutos sem heartbeat = problema real

def wlog(msg):
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f'{ts} [WATCHDOG] {msg}'
    print(line)
    with open(r'C:\ProfitBridge\logs\watchdog.log', 'a') as f:
        f.write(line + '\n')

def get_status():
    """Le bridge.status — retorna None se nao existe ou invalido"""
    try:
        return json.loads(STATUS_FILE.read_text())
    except Exception:
        return None

def get_heartbeat_age():
    """Retorna quantos segundos desde o ultimo heartbeat"""
    status = get_status()
    if not status:
        return float('inf')
    try:
        last = datetime.datetime.fromisoformat(status['last_heartbeat'])
        return (datetime.datetime.now() - last).total_seconds()
    except Exception:
        return float('inf')

def kill_lock():
    if LOCK_FILE.exists():
        try:
            LOCK_FILE.unlink()
            wlog("Lock file removido")
        except Exception as e:
            wlog(f"Erro ao remover lock: {e}")

def finalize_dll():
    try:
        dll = ctypes.CDLL(DLL_PATH)
        dll.DLLFinalize()
        wlog("DLLFinalize() chamado com sucesso")
        time.sleep(3)
    except Exception as e:
        wlog(f"DLLFinalize ignorado: {e}")

def kill_process(proc):
    finalize_dll()
    try:
        proc.kill()
        proc.wait(timeout=10)
    except Exception:
        pass
    # Limpar status antigo
    try:
        STATUS_FILE.unlink()
    except Exception:
        pass
    time.sleep(5)

proc = None
dll_fail_since = None
wlog("Watchdog v2.2 iniciado - heartbeat real via bridge.status")

while True:
    # Iniciar processo se nao existe ou morreu
    if proc is None or proc.poll() is not None:
        kill_lock()
        wlog("Iniciando profit_bridge.py...")
        proc = subprocess.Popen([PYTHON, BRIDGE], cwd=r'C:\ProfitBridge')
        dll_fail_since = None
        time.sleep(15)
        continue

    # Verificar heartbeat
    age = get_heartbeat_age()
    status = get_status()

    if age > MAX_IDLE:
        wlog(f"Heartbeat parado ha {age:.0f}s — reiniciando...")
        kill_process(proc)
        proc = None
        continue

    # Verificar dll_connected
    if status and not status.get('dll_connected', True):
        if dll_fail_since is None:
            dll_fail_since = time.time()
            wlog("DLL desconectada — iniciando contagem...")
        elif time.time() - dll_fail_since > MAX_IDLE:
            wlog(f"DLL desconectada ha {MAX_IDLE}s — reiniciando...")
            kill_process(proc)
            proc = None
            dll_fail_since = None
            continue
    else:
        dll_fail_since = None

    time.sleep(30)
