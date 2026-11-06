import socket
verdict = "BLOCKED"
for host in ("1.1.1.1", "169.254.169.254", "10.0.0.1"):
    try:
        socket.create_connection((host, 80), timeout=1).close()
        verdict = "LEAKED " + host
    except OSError:
        pass
try:
    socket.getaddrinfo("example.com", 80)
    verdict = "LEAKED dns"
except OSError:
    pass
print(verdict)
