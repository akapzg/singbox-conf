"""Download the official sing-box release for this machine, verify it against the SHA-256
digest GitHub publishes for the asset, extract it and print the binary's path.

Usage: python3 scripts/fetch-sing-box.py 1.14.3 <dest-dir>
Set GITHUB_TOKEN to avoid the unauthenticated API rate limit (CI does).
"""

import hashlib
import io
import json
import os
import platform
import sys
import tarfile
import urllib.request
import zipfile

version, dest = sys.argv[1], sys.argv[2]
system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[platform.system()]
arch = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine().lower()]
ext = "zip" if system == "windows" else "tar.gz"
name = f"sing-box-{version}-{system}-{arch}"
asset_name = f"{name}.{ext}"


def get(url: str, api: bool = False) -> bytes:
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN")
    if api and token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


release = json.loads(get(f"https://api.github.com/repos/SagerNet/sing-box/releases/tags/v{version}", api=True))
asset = next(a for a in release["assets"] if a["name"] == asset_name)
expected = (asset.get("digest") or "").removeprefix("sha256:")
if not expected:
    sys.exit(f"no published digest for {asset_name}")
data = get(asset["browser_download_url"])
actual = hashlib.sha256(data).hexdigest()
if actual != expected:
    sys.exit(f"checksum mismatch for {asset_name}: {actual} != {expected}")

os.makedirs(dest, exist_ok=True)
if ext == "zip":
    zipfile.ZipFile(io.BytesIO(data)).extractall(dest)
else:
    tarfile.open(fileobj=io.BytesIO(data)).extractall(dest, filter="data")
binary = os.path.join(dest, name, "sing-box.exe" if system == "windows" else "sing-box")
os.chmod(binary, 0o755)
print(binary)
