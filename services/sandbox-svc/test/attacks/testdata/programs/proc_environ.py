import os
leaked = []
for path in ("/proc/1/environ", "/proc/self/environ"):
    try:
        with open(path, "rb") as f:
            if b"ATLAS_" in f.read():
                leaked.append(path)
    except OSError:
        pass
if any(k.startswith("ATLAS_") for k in os.environ):
    leaked.append("os.environ")
print("LEAKED " + ",".join(leaked) if leaked else "BLOCKED")
