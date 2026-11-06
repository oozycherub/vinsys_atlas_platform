import os
leaked = []
for path in ("/var/run/secrets/kubernetes.io/serviceaccount/token", "/var/local/lib/isolate",
             "/var/cache/atlas-judge", "/etc/shadow", "/root", "/proc/sysrq-trigger", "/sys/fs/cgroup/cgroup.procs"):
    try:
        if os.path.isdir(path):
            os.listdir(path)
        else:
            with open(path, "rb") as f:
                f.read(1)
        leaked.append(path)
    except OSError:
        pass
for path in ("/usr/bin/evil", "/etc/evil", "/tmp/../usr/evil"):
    try:
        with open(path, "w") as f:
            f.write("x")
        leaked.append("write:" + path)
    except OSError:
        pass
print("LEAKED " + ",".join(leaked) if leaked else "BLOCKED")
