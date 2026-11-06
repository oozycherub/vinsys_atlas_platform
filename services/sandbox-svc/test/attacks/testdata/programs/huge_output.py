import sys
chunk = "x" * (1 << 20)
for _ in range(50):
    sys.stdout.write(chunk)
