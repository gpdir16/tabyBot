/* tabyBot 웹 클라이언트: 창. 설정, 할 일 상세, 대화 정보가 모두 같은 창이다.
   데스크톱: 본문(채팅·할 일 목록·컴퓨터) 오른쪽에 창이 띠로 늘어선다. 넘치면 앱 전체가 가로로 스크롤한다.
     창을 연 창 바로 오른쪽에 새 창이 열리고(본문에서 열면 본문 바로 오른쪽), 닫기 버튼은 그 창만 닫는다.
   모바일: 같은 목록을 쌓인 화면으로 본다. 맨 위(마지막) 창만 보이고, 뒤로 버튼·밀기·브라우저 뒤로가 맨 위 창을 닫는다.
   주소: 경로는 본문이고, 열린 창들은 ?w=<id>,<id>… 하나에 담는다. 새로 고쳐도 같은 창들이 다시 열린다.

   창 종류는 define(kind, factory)로 등록한다. id는 "kind" 또는 "kind:arg"다.
   factory(arg, data)는 화면 { title(), build(body, win), cls?, on?, gone?(), beforeClose?(win), dirty?() }을 돌려준다(못 열면 null).
   - build: 본문을 채운다. 머리의 동작 버튼과 고친 것 여부는 slot.action / slot.dirty에 넣는다(settings/components.js의 headAction·trackForm).
   - on: 이 상태 이벤트가 오면 다시 그린다(고친 것이 있거나 입력 중이면 건드리지 않는다).
   - gone: 대상이 사라졌으면 true. 다시 그릴 때 보고 창을 닫는다.
   - beforeClose: 닫아도 되면 true(기본: 고친 것이 있으면 버릴지 묻는다). */
((T) => {
    "use strict";

    const { state } = T;
    const t = (k, v) => T.i18n.t(k, v);
    const mobileMq = window.matchMedia("(max-width: 860px)");
    const isMobile = () => mobileMq.matches;
    const VIEW_MS = 420; // 창이 열리고 닫히는 시간(app.css의 --nav-dur와 같게)

    const kinds = new Map(); // kind → factory
    let wins = []; // 띠 순서(왼쪽부터). 모바일에서는 마지막이 맨 위다
    let host = null; // .win-host
    let restored = false; // 주소의 창들을 연 뒤인지. 그 전에는 주소의 w를 그대로 지킨다
    let skipPop = false; // 창을 닫으며 스스로 일으킨 뒤로 가기
    let shownPath = location.pathname; // 지금 그려진 본문 경로. 뒤로/앞으로 가기에서 본문이 옮겨졌는지 가린다(util이 주소를 쓸 때마다 noteUrl로 맞춘다)
    let settleTimer = 0;
    let settleFn = null;
    const topics = new Set();

    // 창을 그리는 동안 화면이 채워 넣는 칸: action(머리 오른쪽 버튼), dirty(고친 것이 있는지).
    const slot = { action: null, dirty: null };

    /* ── id와 주소 ─────────────────────────────────────────── */
    function splitId(id) {
        const i = id.indexOf(":");
        return i < 0 ? [id, null] : [id.slice(0, i), id.slice(i + 1)];
    }

    function idOf(kind, arg) {
        return arg == null || arg === "" ? kind : `${kind}:${arg}`;
    }

    // 주소의 w 값. 각 id는 encodeURIComponent로 감싸 쉼표로 잇는다(URLSearchParams는 %2C를 쉼표로 풀어 버려 쓰지 않는다).
    function rawParam(search) {
        const m = /[?&]w=([^&#]*)/.exec(search || "");
        return m ? m[1] : "";
    }

    function idsFrom(search) {
        const raw = rawParam(search);
        if (!raw) return [];
        const ids = [];
        for (const part of raw.split(",")) {
            try {
                const id = decodeURIComponent(part);
                if (id && !ids.includes(id)) ids.push(id);
            } catch {
                // 잘못 인코딩된 조각은 건너뛴다
            }
        }
        return ids;
    }

    function encodeIds(ids) {
        return ids.map((id) => encodeURIComponent(id)).join(",");
    }

    // url(경로·쿼리·해시)에 창 목록을 담는다. ids를 주지 않으면 지금 열린 창들이다.
    function urlWith(url, ids) {
        const u = new URL(url, location.origin);
        const list = ids || (restored ? wins.map((w) => w.id) : idsFrom(location.search));
        const params = new URLSearchParams(u.search);
        params.delete("w");
        const rest = params.toString();
        const w = list.length ? `w=${encodeIds(list)}` : "";
        const query = [rest, w].filter(Boolean).join("&");
        return u.pathname + (query ? `?${query}` : "") + u.hash;
    }

    const here = () => location.pathname + location.search + location.hash;

    // 지금 창들을 주소에 반영한다. push: 모바일에서 창을 열 때(뒤로 가기가 그 창을 닫는다).
    // 모바일에서 넣은 칸에는 그때의 창 수(depth)를 적어 둔다. 폭이 좁아질 때 모자란 칸을 채우는 데 쓴다(stackHistory).
    function syncUrl(mode = "replace") {
        if (mode === "push") T.util.pushUrl(here(), { tbWin: true, depth: wins.length });
        else T.util.replaceUrl(here(), history.state);
    }

    // 폭이 좁아져 쌓인 화면이 됐다: 데스크톱에서 연 창들은 기록 칸이 없으므로, 뒤로 가기가 창을 하나씩 닫도록 칸을 채운다.
    // 지금 칸이 이미 창 d개짜리 칸이면 그 위의 창들만큼 더 넣는다.
    function stackHistory() {
        const ids = wins.map((w) => w.id);
        const d = history.state?.tbWin ? Math.min(Number(history.state.depth) || 0, ids.length) : 0;
        if (d >= ids.length) return;
        try {
            history.replaceState(d ? { tbWin: true, depth: d } : null, "", urlWith(here(), ids.slice(0, d)));
            for (let k = d + 1; k <= ids.length; k++) history.pushState({ tbWin: true, depth: k }, "", urlWith(here(), ids.slice(0, k)));
        } catch {
            // 주소 갱신이 막힌 환경에서는 그대로 둔다
        }
    }

    // 모바일에서 맨 위 창을 닫았다: 그 창을 열 때 넣은 기록 칸을 걷는다.
    function dropEntry() {
        if (history.state?.tbWin) {
            skipPop = true;
            history.back();
        } else {
            syncUrl();
        }
    }

    /* ── 창 그리기 ─────────────────────────────────────────── */
    // 이어진 설정 행들을 둥근 묶음(.set-group) 하나로 감싼다. 화면마다 행을 그냥 늘어놓아도 묶음 목록이 된다.
    function groupRows(root) {
        for (const box of [root, ...root.querySelectorAll(".set-section, .agent-editor")]) {
            let run = null;
            for (const el of [...box.children]) {
                if (el.matches(".set-row, .ext-row")) {
                    if (!run) {
                        run = T.h("div", { class: "set-group" });
                        el.before(run);
                    }
                    run.append(el);
                } else {
                    run = null;
                }
            }
        }
    }

    // 닫기 버튼: 데스크톱은 ×(그 창만 닫는다), 모바일은 ‹(쌓인 화면의 뒤로).
    function closeButton(win) {
        const mobile = isMobile();
        return T.h(
            "button",
            {
                type: "button",
                class: "btn-icon sp-back",
                "aria-label": t(mobile ? "back" : "close"),
                "data-tip": mobile ? null : t("close"),
                onclick: () => void close(win),
            },
            [T.icon(mobile ? "chevron-left" : "x")],
        );
    }

    function render(win) {
        const top = win.body?.scrollTop || 0;
        const title = T.h("div", { class: "sp-title", text: win.screen.title() });
        const head = T.h("header", { class: "sp-head" }, [
            // 채팅 헤더와 같은 점진적 블러: 내용이 머리 밑으로 흐려지며 지나간다.
            T.h(
                "div",
                { class: "pblur", "aria-hidden": "true" },
                Array.from({ length: 8 }, () => T.h("i")),
            ),
            closeButton(win),
            title,
        ]);
        const body = T.h("div", { class: "sp-body" });
        // 그리는 도중 다른 창을 다시 그릴 수 있으므로 칸을 지켜 둔다.
        const saved = { ...slot };
        slot.action = null;
        slot.dirty = null;
        win.screen.build(body, win);
        groupRows(body);
        const { action, dirty } = slot;
        Object.assign(slot, saved);
        if (action) {
            head.append(action);
            // 저장할 것이 생기기 전에는 꺼 둔다. 저장하는 동안에는 버튼이 스스로 꺼져 있다(components.js의 headAction).
            action.sync = () => {
                if (!action.busy) action.disabled = !!dirty && !dirty();
            };
            for (const type of ["input", "change", "click"]) body.addEventListener(type, action.sync);
            action.sync();
        }
        win.dirtyFn = dirty || null;
        win.el.replaceChildren(head, body);
        win.head = head;
        win.body = body;
        if (top) body.scrollTop = top;
    }

    function makeWin(id, data) {
        const [kind, arg] = splitId(id);
        const factory = kinds.get(kind);
        if (!factory) return null;
        const screen = factory(arg, data);
        if (!screen) return null;
        for (const topic of screen.on || []) subscribe(topic);
        const win = {
            id,
            kind,
            arg,
            screen,
            el: T.h("div", { class: `sp-view win${screen.cls ? ` ${screen.cls}` : ""}`, dataset: { win: id } }),
            head: null,
            body: null,
            dirtyFn: null,
        };
        win.rebuild = () => render(win);
        win.close = (o) => close(win, o);
        win.open = (next, o) => open(next, { ...o, from: win });
        win.replace = (next, o) => replace(win, next, o);
        win.isDirty = () => !!(win.dirtyFn?.() || screen.dirty?.());
        render(win);
        return win;
    }

    /* ── 띠(층) ────────────────────────────────────────────── */
    function ensureHost() {
        if (!host) {
            host = T.h("div", { class: "win-host" });
            host.addEventListener("keydown", (e) => {
                // 창 안의 입력이 전역 단축키(/ 등)로 새지 않게 한다.
                e.stopPropagation();
                if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
                const el = e.target.closest?.(".win");
                const win = wins.find((w) => w.el === el) || wins[wins.length - 1];
                if (!win) return;
                e.preventDefault();
                void close(win);
            });
        }
        // 모바일은 문서 맨 위 층, 데스크톱은 본문 오른쪽(#app 안)이다.
        const parent = isMobile() ? document.body : document.getElementById("app");
        if (host.parentNode !== parent) parent.append(host);
        return host;
    }

    // 층 순서. 데스크톱은 앞쪽 창이 뒤쪽 창보다 위(새 창이 왼쪽 이웃 밑에서 미끄러져 나오도록),
    // 모바일은 쌓인 화면이라 뒤쪽(나중에 연) 창이 위다(새 창이 위로 덮으며 들어오고, 닫히는 창이 위에서 밀려 나간다).
    // 창 목록이 바뀔 때마다 불리므로 바뀐 것을 알린다(사이드바의 설정 버튼 등).
    function restack() {
        const mobile = isMobile();
        wins.forEach((w, i) => {
            w.el.style.zIndex = String(mobile ? i + 1 : wins.length - i + 1);
        });
        document.body.classList.toggle("win-open", wins.length > 0);
        state.emit("windows");
    }

    // 모바일: 맨 위 창만 보인다.
    function showOnlyTop() {
        const top = wins[wins.length - 1];
        for (const w of wins) w.el.hidden = isMobile() && w !== top;
    }

    // 진행 중인 모바일 전환을 바로 끝낸다.
    function settleNow() {
        clearTimeout(settleTimer);
        const fn = settleFn;
        settleFn = null;
        fn?.();
    }

    function afterView(fn) {
        settleNow();
        settleFn = fn;
        settleTimer = setTimeout(settleNow, VIEW_MS);
    }

    const MOVE = ["sp-in-right", "sp-in-left", "sp-out-left", "sp-out-right", "sp-leaving"];

    function reduceMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    // 데스크톱의 새 창: 왼쪽 이웃 밑에서 미끄러져 나온다(app.css의 col-in). 다 나오면 표시를 걷는다.
    function columnIn(el) {
        el.classList.add("col-in");
        const done = (e) => {
            if (e.target !== el) return;
            el.removeEventListener("animationend", done);
            el.classList.remove("col-in");
        };
        el.addEventListener("animationend", done);
    }

    // 창을 띠에 붙인다. anim: true면 열리는 움직임을 건다.
    function mount(win, anim) {
        ensureHost();
        const i = wins.indexOf(win);
        const next = wins.slice(i + 1).find((w) => w.el.parentNode === host);
        host.insertBefore(win.el, next ? next.el : null);
        restack();
        if (isMobile()) {
            const prev = wins[i - 1];
            if (!anim || reduceMotion() || i !== wins.length - 1) {
                showOnlyTop();
                return;
            }
            settleNow();
            win.el.hidden = false;
            win.el.classList.add("sp-in-right");
            prev?.el.classList.add("sp-leaving", "sp-out-left");
            afterView(() => {
                for (const el of [win.el, prev?.el]) el?.classList.remove(...MOVE);
                showOnlyTop();
            });
            return;
        }
        showOnlyTop();
        if (anim && !reduceMotion()) columnIn(win.el);
        reveal(win);
    }

    // 창을 띠에서 뗀다. 데스크톱은 왼쪽 이웃 밑으로 미끄러져 들어간 뒤, 모바일은 오른쪽으로 밀려 나간 뒤 치운다.
    function unmount(win, instant) {
        const el = win.el;
        const wasTop = wins[wins.length - 1] === win;
        wins = wins.filter((w) => w !== win);
        restack();
        if (el.contains(document.activeElement)) document.activeElement.blur();
        if (instant || reduceMotion() || !el.isConnected) {
            if (isMobile()) instantLayer();
            el.remove();
            showOnlyTop();
            return;
        }
        if (isMobile()) {
            settleNow();
            if (!wasTop) {
                el.remove();
                showOnlyTop();
                return;
            }
            const under = wins[wins.length - 1];
            if (under) {
                under.el.hidden = false;
                under.el.classList.add("sp-in-left");
            }
            el.classList.remove(...MOVE);
            // 층 순서는 남은 창들로만 다시 매겼다. 밀려 나가는 창은 드러나는 창 위에 있어야 한다.
            el.style.zIndex = String(wins.length + 1);
            el.classList.add("sp-leaving", "sp-out-right");
            afterView(() => {
                el.remove();
                under?.el.classList.remove(...MOVE);
                showOnlyTop();
            });
            return;
        }
        el.classList.remove("col-in");
        // 닫히는 창은 왼쪽 이웃 밑으로 들어가야 한다. 층 순서는 남은 창들로만 다시 매겼으므로 이 창은 맨 밑으로 내린다.
        el.style.zIndex = "0";
        el.classList.add("col-out");
        setTimeout(() => el.remove(), VIEW_MS);
    }

    // 손가락으로 이미 다 밀어냈다: 밑의 층(채팅·목록)이 물러난 자리에서 미끄러져 돌아오지 않게 전환을 잠깐 끈다.
    function instantLayer() {
        document.body.classList.add("mobile-route-sync");
        requestAnimationFrame(() => document.body.classList.remove("mobile-route-sync"));
    }

    // 데스크톱: 창이 창 밖에 걸쳐 있으면 앱의 가로 스크롤을 옮겨 다 보이게 한다.
    // 브라우저의 부드러운 스크롤은 그사이 포커스가 옮겨지거나 창을 다시 그리면 멈추므로 직접 움직인다.
    let revealRaf = 0;
    function reveal(win) {
        const app = document.getElementById("app");
        const el = win?.el;
        if (isMobile() || !app || !el?.isConnected) return;
        cancelAnimationFrame(revealRaf);
        const a = app.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        // 열리는 중인 창은 아직 왼쪽 이웃 밑에 겹쳐 있다(app.css의 colIn). 다 열렸을 때의 자리를 기준으로 한다.
        const tucked = -Math.min(0, parseFloat(getComputedStyle(el).marginLeft) || 0);
        const right = r.right + tucked;
        const left = r.left + tucked;
        let delta = 0;
        if (right > a.right) delta = right - a.right;
        // 창이 앱보다 넓으면 왼쪽 끝을 맞춘다.
        if (left - delta < a.left) delta = left - a.left;
        if (Math.abs(delta) < 1) return;
        const from = app.scrollLeft;
        if (reduceMotion()) {
            app.scrollLeft = from + delta;
            return;
        }
        const t0 = performance.now();
        // 사용자가 직접 스크롤하기 시작하면 그만둔다.
        const stop = () => cancelAnimationFrame(revealRaf);
        app.addEventListener("wheel", stop, { once: true, passive: true });
        const step = (now) => {
            const p = Math.min(1, (now - t0) / VIEW_MS);
            app.scrollLeft = from + delta * (1 - (1 - p) ** 4);
            if (p < 1) revealRaf = requestAnimationFrame(step);
            else app.removeEventListener("wheel", stop);
        };
        revealRaf = requestAnimationFrame(step);
    }

    /* ── 열기·닫기 ─────────────────────────────────────────── */
    function get(id) {
        return wins.find((w) => w.id === id) || null;
    }

    // from: 창, 창 안의 요소, 창 id. 없으면 본문에서 연 것이다.
    function winOf(from) {
        if (!from) return null;
        if (typeof from === "string") return get(from);
        if (wins.includes(from)) return from;
        const el = from.closest?.(".win");
        return wins.find((w) => w.el === el) || null;
    }

    // 창을 연다. 이미 열려 있으면 그 창을 보인다. o: { from, data }
    function open(id, o = {}) {
        const have = get(id);
        if (have) {
            bringUp(have);
            return have;
        }
        const win = makeWin(id, o.data);
        if (!win) return null;
        const from = winOf(o.from);
        // 모바일은 쌓인 화면이라 늘 맨 위에 놓는다.
        const at = isMobile() ? wins.length : from ? wins.indexOf(from) + 1 : 0;
        wins.splice(at, 0, win);
        mount(win, true);
        syncUrl(isMobile() ? "push" : "replace");
        return win;
    }

    // 이미 열린 창으로 간다. 데스크톱은 그 창이 보이게 스크롤하고, 모바일은 맨 위로 올린다.
    function bringUp(win) {
        if (!isMobile()) {
            reveal(win);
            return;
        }
        if (wins[wins.length - 1] === win) return;
        wins = wins.filter((w) => w !== win);
        wins.push(win);
        mount(win, true);
        syncUrl("push");
    }

    // 고친 것이 있는 창들을 버려도 되는지 묻는다. 버리겠다고 하면 그 입력은 더 묻지 않는다.
    async function confirmDiscard(list) {
        if (!list.some((w) => w.isDirty())) return true;
        const ok = await T.confirm({ title: t("unsavedTitle"), text: t("unsavedText"), confirmLabel: t("unsavedDiscard"), danger: true });
        if (ok) for (const w of list) w.dirtyFn = null;
        return ok;
    }

    // 창을 닫는다. 닫았으면 true. o: { force(묻지 않음), instant(움직임 없음), fromPop(주소는 이미 바뀌었다) }
    async function close(target, o = {}) {
        const win = typeof target === "string" ? get(target) : target;
        if (!win || !wins.includes(win)) return true;
        if (!o.force) {
            const ok = win.screen.beforeClose ? await win.screen.beforeClose(win) : await confirmDiscard([win]);
            if (!ok) return false;
            if (!wins.includes(win)) return true;
        }
        const wasTop = wins[wins.length - 1] === win;
        unmount(win, o.instant);
        win.screen.onClose?.(win);
        // 이 창에 딸린 창(사진 고르기, 모델 고르기 등)은 대상이 없어졌으므로 같이 닫는다.
        for (const w of wins.slice()) if (w.screen.gone?.()) unmount(w, true);
        if (!o.fromPop) {
            // 창을 열며 넣은 기록 칸(모바일에서 열었다)이면 걷는다. 접어서 연 뒤 펼친 데스크톱에서도 그 칸이 남아 있다.
            if (wasTop && history.state?.tbWin) dropEntry();
            else syncUrl();
        }
        return true;
    }

    // 이 창 자리에 다른 창을 연다(새로 만들고 바로 그 편집으로 넘어갈 때 등).
    function replace(win, next, o = {}) {
        const opened = open(next, { ...o, from: win });
        if (opened && opened !== win) void close(win, { force: true, instant: true });
        return opened;
    }

    // 조건에 맞는 창을 모두 닫는다(묻지 않는다). 다른 화면으로 떠나며 정리할 때 쓴다.
    function closeWhere(pred, o = {}) {
        const list = wins.filter(pred);
        for (const w of list) void close(w, { force: true, instant: o.instant, fromPop: true });
        if (list.length) syncUrl();
    }

    // 입력 중인 창은 다시 그리지 않는다(포커스와 입력 중인 글자를 잃는다).
    function typing(win) {
        const ae = document.activeElement;
        return !!ae && win.el.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
    }

    // 창들을 다시 그린다. 대상이 사라진 창은 닫고, 고친 것이 있거나 입력 중인 창은 건드리지 않는다.
    // o.force: 고친 것이 있어도 다시 그린다(저장한 직후 등).
    function refresh(pred = () => true, o = {}) {
        for (const win of wins.slice()) {
            if (!pred(win)) continue;
            if (win.screen.gone?.()) {
                void close(win, { force: true });
                continue;
            }
            if (!o.force && (win.isDirty() || typing(win))) continue;
            render(win);
        }
    }

    function subscribe(topic) {
        if (topics.has(topic)) return;
        topics.add(topic);
        state.on(topic, () => refresh((w) => !!w.screen.on?.includes(topic)));
    }

    // 주소가 가리키는 창들을 연다(처음 한 번). 그 전에 연 창들은 그대로 두고 뒤에 붙인다.
    function restore() {
        if (restored) return;
        const ids = idsFrom(location.search);
        restored = true;
        for (const id of ids) {
            if (get(id)) continue;
            const win = makeWin(id);
            if (!win) continue;
            wins.push(win);
            mount(win, false);
        }
        syncUrl();
        // 모바일로 새로 열었으면 뒤로 가기가 창을 하나씩 닫도록 칸을 채운다.
        if (isMobile()) stackHistory();
    }

    // 주소의 창 목록에 맞춘다(모바일의 뒤로/앞으로 가기). 닫히는 창에 고친 것이 있으면 묻고, 남겠다고 하면 주소를 되돌린다.
    async function applyUrl() {
        const want = idsFrom(location.search);
        const extra = wins.filter((w) => !want.includes(w.id));
        if (extra.length) {
            if (!(await confirmDiscard(extra))) {
                syncUrl("push");
                return;
            }
            for (const w of extra.reverse()) await close(w, { force: true, fromPop: true });
        }
        for (const id of want) {
            if (get(id)) continue;
            const win = makeWin(id);
            if (!win) continue;
            wins.push(win);
            mount(win, true);
        }
        syncUrl();
    }

    /* ── 뒤로 제스처(ui/gestures.js) ────────────────────────────
       begin: 밀려 나갈 맨 위 창과 그 밑에서 드러날 화면(밑의 창, 창이 하나면 채팅이나 대화 목록)을 돌려준다.
       end: 끝까지 밀었으면 그 창을 닫고, 아니면 드러냈던 창을 다시 숨긴다. */
    function underLayer() {
        return document.getElementById(document.body.classList.contains("mobile-chat") ? "main" : "sidebar");
    }

    const gesture = {
        host: () => host,
        canPop: () => isMobile() && wins.length > 0,
        begin() {
            settleNow();
            const win = wins[wins.length - 1];
            const below = wins[wins.length - 2] || null;
            if (below) below.el.hidden = false;
            return { top: win.el, under: below ? below.el : underLayer(), win, below };
        },
        end(commit, { win, below }) {
            if (!commit) {
                showOnlyTop();
                return;
            }
            // 이미 손가락을 따라 다 넘어왔으므로 움직임 없이 닫는다. 닫지 못하면(남겠다고 함) 그대로 다시 보인다.
            void close(win, { instant: true }).then((ok) => {
                if (!ok && below) showOnlyTop();
            });
        },
    };

    /* ── 전역 바인딩 ────────────────────────────────────────── */
    // 뒤로/앞으로 가기. app.js의 라우터보다 먼저 받는다(스크립트 순서).
    window.addEventListener("popstate", (e) => {
        if (skipPop) {
            skipPop = false;
            e.stopImmediatePropagation();
            // 걷어 낸 칸의 주소가 지금 창들과 다를 수 있다(그사이 대상이 사라져 닫힌 창 등).
            syncUrl();
            return;
        }
        const want = idsFrom(location.search);
        const bodyMoved = location.pathname !== shownPath;
        shownPath = location.pathname;
        if (!restored || want.join(",") === wins.map((w) => w.id).join(",")) return;
        // 모바일이거나, 본문은 그대로이고 창 목록만 다른 칸(접은 채 창을 열며 넣은 칸을 펼친 뒤 되돌아감): 주소의 창 목록에 맞춘다.
        if (isMobile() || !bodyMoved) {
            e.stopImmediatePropagation();
            void applyUrl();
            return;
        }
        // 데스크톱의 본문 이동: 창들은 본문을 옮겨도 그대로 남으므로 주소를 지금 창들로 고쳐 쓴다. 본문은 app.js가 그린다.
        syncUrl();
    });

    // 폭이 모바일과 데스크톱 사이를 오가면 층의 자리와 닫기 버튼이 달라진다.
    mobileMq.addEventListener("change", () => {
        if (!host) return;
        settleNow();
        // 데스크톱에서 닫히던 창은 바로 치운다(목록에서는 이미 빠졌다).
        for (const el of host.querySelectorAll(".col-out")) el.remove();
        ensureHost();
        for (const w of wins) {
            w.el.classList.remove(...MOVE, "col-in", "col-out");
            render(w);
        }
        restack();
        showOnlyTop();
        if (isMobile()) stackHistory();
    });

    T.i18n?.onChange?.(() => refresh());

    T.windows = {
        define: (kind, factory) => kinds.set(kind, factory),
        idOf,
        open,
        close,
        closeWhere,
        get,
        list: () => wins.slice(),
        refresh,
        restore,
        urlWith,
        // 주소가 바뀌었다(util.pushUrl/replaceUrl): 본문 경로를 기억해 둔다.
        noteUrl: () => {
            shownPath = location.pathname;
        },
        idsFrom,
        reveal,
        groupRows,
        confirmDiscard,
        slot,
        gesture,
        isMobile,
    };
})(window.Taby);
