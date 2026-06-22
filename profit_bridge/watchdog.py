"""
Watchdog v2.0 — Monitor externo do ProfitBridge
- Sem auto-update (versão determinística em produção)
- Timeout de 5 minutos (não mata por falta de ticks normais)
- Mata lock file antigo antes de reiniciar
"""
import subprocess, time, os, datetime
from pathlib import Path

LOG_FILE  = Path(r'C:\ProfitBridge\logs\bridge.log')
LOCK_FILE = Path(r'C:\ProfitBridge\bridge.lock')
PYTHON    = r'C:\Program Files\Python311\python.exe'
BRIDGE    = r'C:\ProfitBridge\profit_bridge.py'
MAX_IDLE  = 300  # 5 minutos sem log = processo travado

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
    """Remove lock file antigo antes de reiniciar"""
    if LOCK_FILE.exists():
        try:
            LOCK_FILE.unlink()
            wlog("Lock file removido")
        except Exception as e:
            wlog(f"Erro ao remover lock: {e}")

proc = None

wlog("Watchdog v2.0 iniciado — timeout 5min, sem auto-update")

while True:
    # Iniciar processo se não existe
    if proc is None or proc.poll() is not None:
        kill_lock()
        wlog("Iniciando profit_bridge.py...")
        proc = subprocess.Popen([PYTHON, BRIDGE], cwd=r'C:\ProfitBridge')
        time.sleep(15)
        continue

    # Verificar inatividade
    idle = time.time() - get_log_mtime()
    if idle > MAX_IDLE:
        wlog(f"Bridge inativo {idle:.0f}s — reiniciando...")
        try:
            proc.kill()
            proc.wait(timeout=10)
        except Exception:
            pass
        proc = None
        time.sleep(5)
    else:
        time.sleep(30)
