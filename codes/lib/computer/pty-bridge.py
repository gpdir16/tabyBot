#!/usr/bin/env python3
# PTY 브리지: Node 측 pty.js가 stdio 파이프로 구동한다.
#   argv: [shell, cwd, cols, rows]
#   fd 0: PTY로 전달할 입력(raw bytes)
#   fd 1: PTY 출력(raw bytes)
#   fd 3: 제어 채널 — 줄 단위 JSON ({"type":"resize","cols":N,"rows":N})
import os
import sys
import json
import struct
import fcntl
import termios
import select
import signal


def main():
    shell = sys.argv[1] or "/bin/sh"
    cwd = sys.argv[2] or "/"
    cols = int(sys.argv[3] or 80)
    rows = int(sys.argv[4] or 24)

    try:
        pid, fd = os.forkpty()
    except AttributeError:
        import pty

        pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            pass
        try:
            os.execvp(shell, [shell])
        except OSError:
            os.execvp("/bin/sh", ["/bin/sh"])
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    ctrl = os.fdopen(3, "rb", buffering=0)
    stdin_no = 0
    out = os.fdopen(1, "wb", buffering=0)
    os.set_blocking(fd, False)
    os.set_blocking(stdin_no, False)
    os.set_blocking(3, False)

    ctrl_buf = b""
    alive = True
    stdin_open = True
    while alive:
        fds = [fd, 3] + ([stdin_no] if stdin_open else [])
        try:
            r, _, _ = select.select(fds, [], [], 0.5)
        except InterruptedError:
            continue
        # 자식 프로세스 종료 감지
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            done = pid
        if done:
            # 남은 출력을 마저 비운 뒤 종료
            try:
                while True:
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    out.write(data)
                    out.flush()
            except OSError:
                pass
            alive = False
            continue
        for f in r:
            if f == fd:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    alive = False
                    break
                try:
                    out.write(data)
                    out.flush()
                except OSError:
                    alive = False
                    break
            elif f == stdin_no:
                try:
                    data = os.read(stdin_no, 65536)
                except OSError:
                    data = b""
                if not data:
                    stdin_open = False
                    try:
                        os.kill(pid, signal.SIGHUP)
                    except OSError:
                        pass
                else:
                    try:
                        os.write(fd, data)
                    except OSError:
                        alive = False
                        break
            elif f == 3:
                try:
                    data = os.read(3, 65536)
                except OSError:
                    data = b""
                if not data:
                    continue
                ctrl_buf += data
                while b"\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                    try:
                        msg = json.loads(line.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if msg.get("type") == "resize":
                        try:
                            c = max(1, min(500, int(msg.get("cols") or cols)))
                            rr = max(1, min(500, int(msg.get("rows") or rows)))
                            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rr, c, 0, 0))
                        except (OSError, ValueError):
                            pass


if __name__ == "__main__":
    main()
