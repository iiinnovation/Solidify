"""Generate a deterministic NON-PRODUCTION package and Minisign test signature.

Uses RFC 8032 section 7.1 test vector 1's publicly documented key. It has no
security value and must NEVER be added to TRUSTED_RELEASE_KEYS. OpenSSL 3 is
needed only to regenerate fixtures; cargo tests use the checked-in artifacts.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import struct
import tempfile
import zipfile


def encode(value):
    return (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openssl", required=True, help="Path to an OpenSSL 3 executable")
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[1] / "src-tauri/src/fs/sandbox_exec/package/fixtures"
    files = {
        "bin/tesseract": b"TEST ONLY: not executable OCR code\n",
        # Minimal classic container, no recognition model; never OCR evidence.
        "tessdata/chi_sim.traineddata": struct.pack("<IqqB", 2, 20, 20, 0),
        "tessdata/eng.traineddata": struct.pack("<IqqB", 2, 20, 20, 0),
    }
    manifest = {
        "schemaVersion": 1, "platform": "macos", "architecture": "x86_64",
        "packageVersion": "test-rfc8032", "tesseract": "bin/tesseract", "tesseractVersion": "test-only",
        "pdfinfo": None, "pdftoppm": None, "popplerVersion": None, "tessdataDir": "tessdata",
        "languageVersions": {"chi_sim": "test-only", "eng": "test-only"},
        "files": [{"path": name, "sha256": sha(data), "bytes": len(data)} for name, data in files.items()],
    }
    manifest_bytes = encode(manifest)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, data in {"manifest.json": manifest_bytes, **files}.items():
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            archive.writestr(info, data)
    package = buffer.getvalue()
    descriptor = encode({
        "schemaVersion": 1, "component": "solidify-ocr", "platform": "macos", "architecture": "x86_64",
        "version": "test-rfc8032", "archiveBytes": len(package), "archiveSha256": sha(package),
        "manifestSha256": sha(manifest_bytes),
    })
    # Published RFC test seed, never a generated or production credential.
    seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    public_key = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    key_id = b"TESTONLY"
    comment = b"TEST ONLY public RFC 8032 key; never trust for releases"
    with tempfile.TemporaryDirectory(prefix="solidify-test-signature-") as directory:
        directory = Path(directory)
        key = directory / "public-test-seed.der"
        key.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + seed)

        def sign(data):
            message = directory / "message.bin"
            message.write_bytes(data)
            return subprocess.run([args.openssl, "pkeyutl", "-sign", "-rawin", "-keyform", "DER",
                                   "-inkey", str(key), "-in", str(message)], check=True, capture_output=True).stdout

        signature = sign(hashlib.blake2b(descriptor).digest())
        global_signature = sign(signature + comment)
    output.mkdir(parents=True, exist_ok=True)
    (output / "test-release.zip").write_bytes(package)
    (output / "test-release.json").write_bytes(descriptor)
    (output / "test-release.pub").write_text(base64.b64encode(b"Ed" + key_id + public_key).decode() + "\n")
    (output / "test-release.json.minisig").write_text(
        "untrusted comment: TEST ONLY public RFC 8032 key\n"
        + base64.b64encode(b"ED" + key_id + signature).decode() + "\n"
        + "trusted comment: " + comment.decode() + "\n"
        + base64.b64encode(global_signature).decode() + "\n"
    )


if __name__ == "__main__":
    main()
