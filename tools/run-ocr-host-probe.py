"""Bounded HOST-ONLY diagnostic for the fixed local Swift OCR probe.

Not an isolation provider: no file/network confinement or XPC service lifecycle
guarantees. Only called by ignored tests with generated synthetic images.
"""
import json
from pathlib import Path
import resource
import subprocess
import sys
import time


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024,) * 2)


def main():
    binary, image, work = map(Path, sys.argv[1:])
    assert binary.is_absolute() and binary.is_file()
    assert image.is_absolute() and image.is_file()
    assert work.is_absolute() and work.is_dir()
    started = time.monotonic()
    try:
        output = subprocess.run(
            [str(binary), str(image)], cwd=work,
            env={"HOME": str(work), "TMPDIR": str(work), "LC_ALL": "C", "OMP_THREAD_LIMIT": "1"},
            stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
            start_new_session=True, preexec_fn=limits,
        )
        stdout, stderr = output.stdout, output.stderr
        code = output.returncode if output.returncode >= 0 else None
        if output.returncode < 0:
            stderr += f"\nHost probe terminated by signal {-output.returncode}\n".encode()
    except subprocess.TimeoutExpired as error:
        stdout, stderr, code = error.stdout or b"", error.stderr or b"", None
        stderr += b"\nHost probe exceeded 60 second timeout\n"
    if len(stdout) + len(stderr) > 64 * 1024:
        stdout, stderr, code = b"", b"Host probe output exceeded 64 KiB\n", None
    print(json.dumps({"stdout": list(stdout), "stderr": list(stderr), "exitCode": code,
                      "durationMs": int((time.monotonic() - started) * 1000)}))


if __name__ == "__main__":
    main()
