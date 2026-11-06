#!/bin/sh
# Downloads the Triton model weights listed in models/manifest.json into models/<name>/1/model.onnx
# and verifies each sha256. Unpinned entries (url or sha256 null) are an error: models are
# released only after eval/ passes, and are always pinned by checksum.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
import hashlib, json, sys, urllib.request
from pathlib import Path
manifest = json.loads(Path('models/manifest.json').read_text())
failed = False
for m in manifest['models']:
    if not m['url'] or not m['sha256']:
        print(f"{m['name']}: not pinned (url/sha256 missing)", file=sys.stderr)
        failed = True
        continue
    dest = Path('models') / m['name'] / '1' / 'model.onnx'
    with urllib.request.urlopen(m['url']) as r:  # noqa: S310 - pinned https URLs only
        data = r.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != m['sha256']:
        print(f"{m['name']}: sha256 {digest} does not match the manifest", file=sys.stderr)
        failed = True
        continue
    dest.write_bytes(data)
    print(f"{m['name']}: {len(data)} bytes, verified")
sys.exit(1 if failed else 0)
PY
