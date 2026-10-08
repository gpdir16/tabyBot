/* tabyBot 웹 클라이언트: 컴퓨터 화면(원격 데스크톱)의 포인터·휠·키보드 제스처 엔진.
   - 마우스: 절대 좌표 그대로(기존 데스크톱 동작)
   - 터치·트랙패드 모드: 맥북 트랙패드식. 한 손가락=커서, 탭=클릭, 탭 후 드래그=드래그,
     두 손가락 탭=우클릭, 두 손가락 이동=스크롤, 핀치=로컬 확대(원격 전송 아님)
   - 터치·직접 모드: 탭=그 지점 클릭, 드래그=스크롤, 길게 누르고 드래그=원격 드래그 */
((T) => {
    "use strict";

    T.computerCtx ??= {};
    const C = T.computerCtx;

    const TAP_MAX_MS = 280; // 이보다 짧게 떼면 탭
    const TAP_MAX_MOVE = 12; // 탭으로 칠 수 있는 최대 이동량(px)
    const DOUBLE_TAP_MS = 380; // 두 번째 탭이 이 안에 오면 더블 클릭/탭 후 드래그
    const DOUBLE_TAP_DIST = 12;
    const LONG_PRESS_MS = 480;
    const MOVE_THROTTLE_MS = 60;
    const SCROLL_STEP_PX = 42;
    const TWO_FINGER_TAP_MS = 300;
    const MAX_ZOOM = 5;

    const now = () => performance.now();
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const mouseButtonOf = (e) => (e.button === 2 ? 3 : e.button === 1 ? 2 : 1);
    const roundPoint = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

    // env: 화면 쪽 의존성.
    //   dims() → {w, h} 원격 화면 크기, zoom, cursor(원격 좌표의 가상 커서), touchMode() → "trackpad" | "direct",
    //   stageRect() → 화면 영역의 위치, screenPoint(e) → 원격 좌표 또는 null,
    //   send(obj) → 원격으로 전송, applyZoom(scale, x, y), renderCursor(), keymap
    class ScreenGestures {
        constructor(el, env) {
            this.el = el;
            this.env = env;
            this.ptrs = new Map(); // pointerId → {x, y}
            this.down = null; // 단일 포인터 제스처 상태
            this.pinch = null; // 두 손가락 제스처 상태
            this.dragging = false; // 원격 마우스 버튼이 눌린 상태(드래그 중)
            this.lpTimer = 0;
            this.lastTap = { at: 0, x: -1e4, y: -1e4 };
            this.moveAt = 0;
            this.scrollAcc = { x: 0, y: 0 };
        }

        bind() {
            const { el } = this;
            el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
            el.addEventListener("pointermove", (e) => this.onPointerMove(e));
            el.addEventListener("pointerup", (e) => this.onPointerUp(e));
            el.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
            el.addEventListener("contextmenu", (e) => e.preventDefault());
            el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
            el.addEventListener("keydown", (e) => this.onKeyDown(e));
            el.addEventListener("paste", (e) => this.onPaste(e));
        }

        get touchMode() {
            return this.env.touchMode();
        }

        // transform이 반영된 실제 표시 배율: 손가락 델타를 원격 픽셀로 환산
        effectiveScale() {
            const r = this.el.getBoundingClientRect();
            const { w, h } = this.env.dims();
            return Math.min(r.width / w, r.height / h) || 1;
        }

        stagePoint(clientX, clientY) {
            const sr = this.env.stageRect();
            return { x: clientX - sr.left, y: clientY - sr.top };
        }

        throttledMove(p) {
            const t = now();
            if (t - this.moveAt < MOVE_THROTTLE_MS) return;
            this.moveAt = t;
            this.env.send({ type: "move", ...roundPoint(p) });
        }

        // 자연 스크롤(맥): 손가락이 가는 방향으로 컨텐츠가 따라간다. 일정 거리가 쌓일 때마다 한 번에 보낸다.
        emitScroll(dx, dy, at) {
            const acc = this.scrollAcc;
            acc.x += dx;
            acc.y += dy;
            const amountOf = (v) => Math.min(20, Math.max(1, Math.round(Math.abs(v) / SCROLL_STEP_PX)));
            if (Math.abs(acc.y) >= SCROLL_STEP_PX) {
                this.env.send({ type: "scroll", x: at.x, y: at.y, direction: acc.y < 0 ? "down" : "up", amount: amountOf(acc.y) });
                acc.y = 0;
            }
            if (Math.abs(acc.x) >= SCROLL_STEP_PX) {
                this.env.send({ type: "scroll", x: at.x, y: at.y, direction: acc.x < 0 ? "right" : "left", amount: amountOf(acc.x) });
                acc.x = 0;
            }
        }

        startRemoteDrag(at) {
            this.dragging = true;
            this.env.send({ type: "mousedown", x: at.x, y: at.y, button: 1 });
        }

        /* ── 누를 때 ── */
        onPointerDown(e) {
            this.el.focus({ preventScroll: true });
            try {
                this.el.setPointerCapture(e.pointerId);
            } catch {
                // 포인터가 이미 사라졌으면 캡처를 건너뛴다
            }
            this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.ptrs.size === 2) {
                this.startPinch(e);
                return;
            }
            if (this.ptrs.size > 2) return;
            this.startSingle(e);
        }

        // 두 번째 손가락이 닿으면 핀치 줌과 두 손가락 스크롤(양쪽 모드 공통)
        startPinch(e) {
            clearTimeout(this.lpTimer);
            this.down = null;
            const [a, b] = [...this.ptrs.values()];
            this.pinch = {
                d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                s0: this.env.zoom.s,
                lx: (a.x + b.x) / 2,
                ly: (a.y + b.y) / 2,
                t0: now(),
                moved: 0,
            };
            e.preventDefault();
        }

        startSingle(e) {
            const isMouse = e.pointerType === "mouse";
            const rel = this.touchMode === "trackpad" && !isMouse;
            const down = {
                x: e.clientX,
                y: e.clientY,
                t: now(),
                moved: 0,
                p: this.env.screenPoint(e),
                mode: rel ? "rel" : isMouse ? "abs" : "scroll",
                tapdrag: rel && now() - this.lastTap.at < DOUBLE_TAP_MS,
                button: mouseButtonOf(e),
            };
            this.down = down;
            if (down.mode === "scroll") {
                // 직접 모드: 길게 누른 채 움직이면 원격 드래그로 전환
                this.lpTimer = setTimeout(() => {
                    if (this.down && this.down.mode === "scroll" && this.down.moved < 10 && this.down.p) this.startRemoteDrag(this.down.p);
                }, LONG_PRESS_MS);
            }
            e.preventDefault();
        }

        /* ── 움직일 때 ── */
        onPointerMove(e) {
            const prev = this.ptrs.get(e.pointerId);
            if (!prev) {
                this.hover(e);
                return;
            }
            const dx = e.clientX - prev.x;
            const dy = e.clientY - prev.y;
            this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.pinch && this.ptrs.size === 2) {
                this.movePinch(e, dx, dy);
                return;
            }
            if (!this.down || this.ptrs.size !== 1) return;
            this.down.moved += Math.abs(dx) + Math.abs(dy);
            this.moveSingle(e, dx, dy);
            e.preventDefault();
        }

        // 누르지 않은 마우스 이동 = 호버: 원격 커서를 절대 좌표로 옮긴다.
        hover(e) {
            if (e.pointerType !== "mouse") return;
            const p = this.env.screenPoint(e);
            if (!p) return;
            this.env.cursor.x = p.x;
            this.env.cursor.y = p.y;
            this.throttledMove(p);
        }

        movePinch(e, dx, dy) {
            const pinch = this.pinch;
            const [a, b] = [...this.ptrs.values()];
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            const cx = (a.x + b.x) / 2;
            const cy = (a.y + b.y) / 2;
            const sp = this.stagePoint(cx, cy);
            this.env.applyZoom(clamp((pinch.s0 * d) / pinch.d0, 1, MAX_ZOOM), sp.x, sp.y);
            // 중심점 이동 = 두 손가락 스크롤. 트랙패드 모드는 커서 위치에서, 직접 모드는 손가락 아래 지점에서 스크롤한다.
            const rp = this.touchMode === "trackpad" ? this.env.cursor : this.env.screenPoint({ clientX: cx, clientY: cy });
            if (rp) this.emitScroll(cx - pinch.lx, cy - pinch.ly, roundPoint(rp));
            pinch.lx = cx;
            pinch.ly = cy;
            pinch.moved += Math.abs(dx) + Math.abs(dy);
            e.preventDefault();
        }

        // 트랙패드: 손가락 상대 이동이 커서 이동. 두 번째 탭 후 드래그면 원격 드래그.
        moveRelative(dx, dy) {
            const { cursor } = this.env;
            const { w, h } = this.env.dims();
            if (this.down.tapdrag && !this.dragging && this.down.moved > 6) this.startRemoteDrag(roundPoint(cursor));
            const scale = this.effectiveScale();
            const accel = 1 + Math.min(2, Math.hypot(dx, dy) / 24); // 맥식 포인터 가속
            cursor.x = clamp(cursor.x + (dx / scale) * accel, 0, w - 1);
            cursor.y = clamp(cursor.y + (dy / scale) * accel, 0, h - 1);
            this.throttledMove(cursor);
            this.env.renderCursor();
        }

        moveSingle(e, dx, dy) {
            const down = this.down;
            if (down.mode === "rel") {
                this.moveRelative(dx, dy);
            } else if (this.dragging) {
                const p = this.env.screenPoint(e);
                if (p) {
                    down.p = p;
                    this.throttledMove(p);
                }
            } else if (down.mode === "abs" && down.moved > 6 && down.p) {
                // 마우스 절대 모드: 드래그 = 원격 드래그
                this.startRemoteDrag(down.p);
            } else if (down.mode === "scroll" && down.moved > 10) {
                clearTimeout(this.lpTimer);
                const p = this.env.screenPoint(e);
                if (p) this.emitScroll(dx, dy, p);
            }
        }

        /* ── 뗄 때 ── */
        onPointerUp(e) {
            this.ptrs.delete(e.pointerId);
            if (this.pinch) {
                this.endPinch(e);
                return;
            }
            if (!this.down) return;
            clearTimeout(this.lpTimer);
            const down = this.down;
            const rp = down.mode === "rel" ? this.env.cursor : down.p;
            if (this.dragging) {
                this.dragging = false;
                if (rp) this.env.send({ type: "mouseup", ...roundPoint(rp), button: 1 });
            } else {
                this.finishTap(down, rp);
            }
            this.down = null;
            e.preventDefault();
        }

        endPinch(e) {
            const pinch = this.pinch;
            if (this.ptrs.size === 0) {
                // 두 손가락 동시 탭 = 우클릭
                if (now() - pinch.t0 < TWO_FINGER_TAP_MS && pinch.moved < 14 && Math.abs(this.env.zoom.s - pinch.s0) < 0.05) {
                    const rp = this.touchMode === "trackpad" ? this.env.cursor : this.env.screenPoint(e);
                    if (rp) this.env.send({ type: "click", ...roundPoint(rp), button: 3 });
                }
                this.pinch = null;
            } else if (this.ptrs.size === 1) {
                // 남은 손가락을 새 단일 제스처로 재개(탭으로 오인하지 않게 moved 시드)
                const rest = [...this.ptrs.values()][0];
                this.pinch = null;
                this.down = {
                    x: rest.x,
                    y: rest.y,
                    t: now(),
                    moved: 20,
                    p: null,
                    mode: this.touchMode === "trackpad" ? "rel" : "scroll",
                    tapdrag: false,
                    button: 1,
                };
            }
            e.preventDefault();
        }

        // 짧고 거의 움직이지 않았으면 클릭(방금 탭과 가까우면 더블 클릭)으로 보낸다.
        finishTap(down, rp) {
            // 쓰로틀된 move가 잘려 원격 커서가 가상 커서보다 뒤처지지 않게 마지막 위치를 보낸다
            if (down.mode === "rel" && down.moved > 2) this.env.send({ type: "move", ...roundPoint(this.env.cursor) });
            const duration = now() - down.t;
            if (duration >= TAP_MAX_MS || down.moved >= TAP_MAX_MOVE || !rp) return;
            const dbl = now() - this.lastTap.at < DOUBLE_TAP_MS && Math.hypot(rp.x - this.lastTap.x, rp.y - this.lastTap.y) < DOUBLE_TAP_DIST;
            this.env.send({ type: "click", ...roundPoint(rp), button: down.button, double: dbl });
            this.lastTap = { at: now(), x: rp.x, y: rp.y };
        }

        onPointerCancel(e) {
            this.ptrs.delete(e.pointerId);
            clearTimeout(this.lpTimer);
            if (this.dragging) {
                this.dragging = false;
                this.env.send({ type: "mouseup", ...roundPoint(this.env.cursor), button: 1 });
            }
            this.down = null;
            if (this.ptrs.size < 2) this.pinch = null;
        }

        /* ── 휠·키보드·붙여넣기 ── */
        onWheel(e) {
            if (e.ctrlKey || e.metaKey) {
                // 데스크톱 트랙패드 핀치는 ctrl+wheel로 들어온다. 로컬 확대만
                const sp = this.stagePoint(e.clientX, e.clientY);
                this.env.applyZoom(clamp(this.env.zoom.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 1, MAX_ZOOM), sp.x, sp.y);
            } else {
                const p = this.env.screenPoint(e);
                if (!p) return;
                const direction = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? (e.deltaY < 0 ? "up" : "down") : e.deltaX < 0 ? "left" : "right";
                this.env.send({ type: "scroll", x: p.x, y: p.y, direction, amount: 3 });
            }
            e.preventDefault();
        }

        onKeyDown(e) {
            if (e.metaKey && (e.key === "c" || e.key === "v" || e.key === "a" || e.key === "x")) return; // OS 단축키
            // IME 조합 중엔 keydown이 중간 글자를 보낸다. 조합 완료 후 input이 확정 문자를 내므로 여기서도 내면 중복 입력이 된다.
            if (e.isComposing || e.key === "Process" || e.key === "Unidentified") return;
            const sym = this.env.keymap[e.key];
            if (sym) {
                this.env.send({ type: "key", key: sym, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
                e.preventDefault();
                return;
            }
            if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                this.env.send({ type: "type", text: e.key });
                e.preventDefault();
            } else if ((e.ctrlKey || e.altKey) && e.key && e.key.length === 1) {
                const k = e.key.toLowerCase();
                if (/^[a-z0-9]$/.test(k)) {
                    this.env.send({ type: "key", key: k, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
                    e.preventDefault();
                }
            }
        }

        onPaste(e) {
            const text = e.clipboardData?.getData("text");
            if (text) this.env.send({ type: "type", text: text.slice(0, 4096) });
            e.preventDefault();
        }
    }

    C.ScreenGestures = ScreenGestures;
})(window.Taby);
