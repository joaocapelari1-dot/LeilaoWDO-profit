import os, runpy

os.environ['PROFIT_ACTIVATION_KEY'] = '2331312907888866889'
os.environ['PROFIT_USERNAME']       = 'joaocapelari1@gmail.com'
os.environ['PROFIT_PASSWORD']       = '321Angelin@@@'
os.environ['PROFIT_DLL_PATH']       = r'C:\ProfitBridge\Win64\ProfitDLL.dll'
os.environ['SYMBOLS']               = 'WDOQ26,DOLQ26'
os.environ['RAILWAY_WS_URL']        = 'wss://leilaowdo-profit-production.up.railway.app/bridge'
os.environ['BRIDGE_SECRET']         = '321Angelin@@'

runpy.run_path(r'C:\ProfitBridge\watchdog.py', run_name='__main__')
