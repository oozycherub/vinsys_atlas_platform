data = bytearray(2 * 1024 * 1024 * 1024)
for i in range(0, len(data), 4096):
    data[i] = 1
print(len(data))
