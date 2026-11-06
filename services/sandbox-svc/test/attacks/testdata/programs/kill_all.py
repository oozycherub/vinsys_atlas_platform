import os, signal
try:
    os.kill(-1, signal.SIGKILL)
except OSError:
    pass
print("ALIVE")
