"""
Watchdog v2.1 - Monitor externo do ProfitBridge
- DLLFinalize antes de matar processo
- Timeout de 5 minutos
- Mata lock file antigo antes de reiniciar
"""
import subprocess, time, os, datetime, ctypes
from pathlib import Path

LOG_FILE  = Path(r'C:\ProfitBridge\logs\bridge.log')
LOCK_FILE = Path(r'C:\ProfitBridge\bridge.lock')
PYTHON    = r'C:\Program Files\Python311\python.exe'
BRIDGE    = r'C:\ProfitBridge\profit_bridge.py'
DLL_PATH  = os.environ.get('PROFIT_DLL_PATH', r'C:\ProfitBridge\Win64\ProfitDLL.dll')
MAX_IDLE  = 300

def get_log_mtime():
    try: return os.path.getmtime(LOG_FILE)
    except: return 0

def wlog(msg):
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f'{ts} [WATCHDOG] {msg}'
    print(line)
    with open(r'C:\ProfitBridge\logs\watchdog.log', 'a') as f:
        f.write(line + '\n')

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
    time.sleep(5)

proc = None
wlog("Watchdog v2.1 iniciado - timeout 5min, DLLFinalize ativo")

while True:
    if proc is None or proc.poll() is not None:
        kill_lock()
        wlog("Iniciando profit_bridge.py...")
        proc = subprocess.Popen([PYTHON, BRIDGE], cwd=r'C:\ProfitBridge')
        time.sleep(15)
        continue

    idle = time.time() - get_log_mtime()
    if idle > MAX_IDLE:
        wlog(f"Bridge inativo {idle:.0f}s - reiniciando...")
        kill_process(proc)
        proc = None
    else:
        time.sleep(30)
