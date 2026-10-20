/* tabyBot 웹 클라이언트: 생성 중인 답변을 실시간 마크다운으로 그린다.
   덜 쓴 마크다운은 닫는 기호를 미리 붙여(예측 완성) 기호가 나오자마자 서식이 적용되고 기호 자체는 보이지 않는다.
   받은 글을 단어 단위로 조금씩 풀어 보여 주고, 새로 나온 글자는 서서히 나타난다. */
((T) => {
    "use strict";

    const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

    // 단어를 풀어 내는 속도: 기본 초당 글자 수와, 밀린 글을 따라잡는 데 쓰는 시간.
    const MIN_CPS = 90;
    const CATCHUP_MS = 350;
    // 공백 없이 긴 글(코드, 주소)에서 한 번에 너무 많이 드러나지 않게 단어 끝까지 늘리는 최대 길이.
    const MAX_WORD_STRETCH = 24;
    // 새 글자가 서서히 나타나는 시간(CSS .stream-in과 같다).
    const FADE_MS = 280;

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

    /* ── 블록 경계 ─────────────────────────────────────────── */
    // 줄 단위로 훑어 코드 펜스 상태와 마지막 블록의 시작 위치를 찾는다.
    // 블록은 펜스 밖의 빈 줄, 또는 닫힌 펜스 바로 뒤에서 새로 시작한다.
    function scanBlocks(text) {
        let fence = null;
        let blockStart = 0;
        let pos = 0;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const next = pos + line.length + 1;
            const last = i === lines.length - 1;
            if (fence) {
                const m = FENCE_OPEN_RE.exec(line);
                // 닫는 펜스는 여는 펜스와 같은 문자로 같은 길이 이상이고 그 뒤에 글이 없다.
                if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim() && !last) {
                    fence = null;
                    blockStart = next;
                }
            } else {
                const m = FENCE_OPEN_RE.exec(line);
                if (m) {
                    fence = m[1];
                    blockStart = pos;
                } else if (!line.trim() && !last) {
                    blockStart = next;
                }
            }
            pos = next;
        }
        return { fence, blockStart: Math.min(blockStart, text.length) };
    }

    /* ── 예측 완성 ─────────────────────────────────────────── */
    // 쓰는 중인 마지막 줄이 기호뿐이면(목록 머리, 제목 기호, 밑줄형 제목, 표 첫 파이프) 아직 보여 주지 않는다.
    // 남겨 두면 "-" 한 글자가 앞 줄을 제목으로 바꿨다가 되돌리는 깜빡임이 생긴다.
    function dropDanglingLine(block) {
        const nl = block.lastIndexOf("\n");
        const line = block.slice(nl + 1);
        if (/^[ \t]*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>|=+|-{2}|\|)[ \t]*$/.test(line)) return nl === -1 ? "" : block.slice(0, nl);
        return block;
    }

    // 표: 머리 행이 나오면 구분 행을 미리 채워 바로 표로 그린다. 쓰는 중인 구분 행도 완성한다.
    function completeTable(block) {
        const lines = block.split("\n");
        const head = lines[0];
        // "|"로 시작하는 줄은 첫 칸을 쓰는 중이어도 표 머리로 본다(파이프가 글자로 보였다가 표로 바뀌지 않게).
        if (!/^[ \t]*\|/.test(head)) return block;
        const cells = Math.max(1, head.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length);
        const delim = `|${" --- |".repeat(cells)}`;
        if (lines.length === 1) return `${/\|[ \t]*$/.test(head) ? head : `${head} |`}\n${delim}`;
        if (/^[ \t]*\|?[ \t:|-]*$/.test(lines[1])) lines[1] = delim;
        return lines.join("\n");
    }

    // 링크와 이미지: 덜 쓴 주소는 임시 주소로 닫고, 닫히지 않은 대괄호는 글자만 보인다. 덜 쓴 이미지는 숨긴다.
    function completeLinks(block) {
        let s = block.replace(/!\[[^\]\n]*(?:\](?:\([^)\s]*)?)?$/, "");
        s = s.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "[$1](#)");
        s = s.replace(/\[([^\]\n]*)$/, "$1");
        return s;
    }

    const isSpace = (ch) => ch === undefined || /\s/.test(ch);
    const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

    // i 위치의 서식 기호. 없으면 null.
    function markAt(block, i) {
        for (const mark of ["**", "__", "~~"]) if (block.startsWith(mark, i)) return mark;
        return block[i] === "*" || block[i] === "_" ? block[i] : null;
    }

    // 서식 기호 하나를 스택에 반영한다: 같은 기호가 열려 있으면 닫고, 아니면 연다.
    function applyMark(stack, block, i, mark) {
        const before = block[i - 1];
        const after = block[i + mark.length];
        if (stack.at(-1)?.mark === mark && !isSpace(before)) {
            stack.pop();
            return;
        }
        // 여는 기호는 뒤에 공백이 오지 않는다(줄 머리의 "* " 목록 기호나 "2 * 3"이 여기서 걸러진다).
        if (isSpace(after) && after !== undefined) return;
        // 밑줄은 단어 사이(snake_case)에 쓰인 것은 서식이 아니다.
        if (mark[0] === "_" && isWord(before)) return;
        stack.push({ mark, at: i });
    }

    // 열린 인라인 서식(굵게, 기울임, 취소선, 인라인 코드)을 찾는다.
    function openMarks(block) {
        const stack = [];
        let i = 0;
        while (i < block.length) {
            if (block[i] === "\\") {
                i += 2;
                continue;
            }
            if (block[i] === "`") {
                // 인라인 코드 안의 기호는 서식이 아니다. 닫히지 않았으면 끝까지 코드다.
                let n = 1;
                while (block[i + n] === "`") n++;
                const close = block.indexOf("`".repeat(n), i + n);
                if (close === -1) {
                    stack.push({ mark: "`".repeat(n), at: i });
                    break;
                }
                i = close + n;
                continue;
            }
            const mark = markAt(block, i);
            if (mark) applyMark(stack, block, i, mark);
            i += mark ? mark.length : 1;
        }
        return stack;
    }

    // 열린 인라인 서식을 닫는다.
    // 기호 뒤에 아직 글이 없으면 닫지 않고 기호를 뺀다(빈 서식 기호가 글자로 보이지 않게).
    function completeInline(block) {
        const stack = openMarks(block);
        let out = block;
        let closers = "";
        for (let k = stack.length - 1; k >= 0; k--) {
            const { mark, at } = stack[k];
            if (!closers && !out.slice(at + mark.length).trim()) {
                out = out.slice(0, at);
                continue;
            }
            closers += mark;
        }
        return closers ? out.replace(/\s+$/, "") + closers : out;
    }

    // 지금까지 받은 글을 마크다운으로 그릴 수 있게 완성한다.
    function complete(text) {
        const src = String(text || "");
        const { fence, blockStart } = scanBlocks(src);
        if (fence) {
            // 코드 블록 안: 여는 줄(언어 이름)을 쓰는 중이면 코드 블록만 연 채로 둔다.
            const tail = src.slice(blockStart);
            const body = tail.includes("\n") ? src : `${src.slice(0, blockStart)}${fence}`;
            return `${body}${body.endsWith("\n") ? "" : "\n"}${fence}`;
        }
        let block = src.slice(blockStart);
        block = dropDanglingLine(block);
        block = completeTable(block);
        block = completeLinks(block);
        block = completeInline(block);
        return src.slice(0, blockStart) + block;
    }

    /* ── 서서히 나타나기 ───────────────────────────────────── */
    // 화면 글자 위치 [from, to)가 at에 처음 보였다는 기록으로, 아직 나타나는 중인 글자를 span으로 감싼다.
    // 프레임마다 다시 그려도 음수 지연으로 애니메이션이 이어진다.
    function applyFade(root, base, reveals, now) {
        const active = reveals.filter((r) => now - r.at < FADE_MS);
        if (!active.length || reduceMotion?.matches) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        let offset = base;
        for (const node of nodes) {
            const s = node.nodeValue;
            const start = offset;
            const end = start + s.length;
            offset = end;
            const hits = active.filter((r) => r.to > start && r.from < end);
            if (!hits.length) continue;
            const frag = document.createDocumentFragment();
            let cur = start;
            for (const r of hits) {
                const a = Math.max(r.from, cur);
                const b = Math.min(r.to, end);
                if (a >= b) continue;
                if (a > cur) frag.append(s.slice(cur - start, a - start));
                const span = document.createElement("span");
                span.className = "stream-in";
                span.style.animationDelay = `-${Math.round(now - r.at)}ms`;
                span.textContent = s.slice(a - start, b - start);
                frag.append(span);
                cur = b;
            }
            if (cur < end) frag.append(s.slice(cur - start));
            node.replaceWith(frag);
        }
    }

    /* ── 스트림 ─────────────────────────────────────────────── */
    // host 안에 생성 중인 답변을 그린다. shown: 이미 보여 준 글자 수(다시 그릴 때 처음부터 다시 풀지 않게).
    // onRender(): 그린 뒤 호출(스크롤, 말풍선 모양 맞춤). onProgress(n): 보여 준 글자 수가 바뀔 때 호출.
    function create(host, { shown = 0, onRender, onProgress } = {}) {
        const stableEl = document.createElement("div");
        const tailEl = document.createElement("div");
        host.replaceChildren(stableEl, tailEl);
        let target = "";
        let visible = shown;
        let stableSrc = null;
        let stableLen = 0;
        let lastTotal = -1;
        let reveals = [];
        let raf = 0;
        let lastTick = 0;

        function reset() {
            visible = 0;
            stableSrc = null;
            stableLen = 0;
            lastTotal = -1;
            reveals = [];
            stableEl.replaceChildren();
            tailEl.replaceChildren();
        }

        function draw(now) {
            const src = target.slice(0, visible);
            // 마지막 블록만 프레임마다 다시 그린다. 그 앞은 끝난 블록이라 바뀔 때만 그린다.
            // 코드 블록이 열려 있으면 여는 펜스부터가 마지막 블록이다.
            const cut = scanBlocks(src).blockStart;
            const stable = src.slice(0, cut);
            if (stable !== stableSrc) {
                stableSrc = stable;
                const el = stable.trim() ? T.md.render(stable, { highlight: false }) : document.createElement("div");
                applyFade(el, 0, reveals, now);
                stableEl.replaceChildren(el);
                stableLen = el.textContent.length;
            }
            const tail = src.slice(cut);
            const el = tail.trim() ? T.md.render(complete(tail), { highlight: false }) : document.createElement("div");
            const total = stableLen + el.textContent.length;
            if (lastTotal >= 0 && total > lastTotal) reveals.push({ from: lastTotal, to: total, at: now });
            if (total !== lastTotal) lastTotal = total;
            reveals = reveals.filter((r) => now - r.at < FADE_MS);
            applyFade(el, stableLen, reveals, now);
            tailEl.replaceChildren(el);
            onRender?.();
        }

        function tick(now) {
            raf = 0;
            if (!host.isConnected) return;
            const dt = lastTick ? Math.min(now - lastTick, 100) : 16;
            lastTick = now;
            const backlog = target.length - visible;
            if (backlog > 0) {
                const budget = Math.max((MIN_CPS * dt) / 1000, (backlog * dt) / CATCHUP_MS);
                let next = Math.min(target.length, visible + Math.max(1, Math.ceil(budget)));
                const limit = Math.min(target.length, next + MAX_WORD_STRETCH);
                while (next < limit && !/\s/.test(target[next])) next++;
                visible = next;
                onProgress?.(visible);
                draw(now);
            }
            if (visible < target.length) raf = requestAnimationFrame(tick);
            else lastTick = 0;
        }

        function update(text) {
            const next = String(text || "");
            // 새 모델 호출로 본문이 처음부터 다시 쌓이면(앞부분이 달라지면) 처음부터 다시 푼다.
            if (!next.startsWith(target.slice(0, visible))) {
                reset();
                onProgress?.(0);
            }
            const first = !target && visible > 0;
            target = next;
            if (visible > target.length) visible = target.length;
            // 다시 그려 붙인 스트림: 이미 보여 준 부분은 바로 그린다.
            if (first) draw(performance.now());
            if (!raf && visible < target.length) raf = requestAnimationFrame(tick);
            if (!target) {
                stableEl.replaceChildren();
                tailEl.replaceChildren();
                stableSrc = null;
                lastTotal = -1;
            }
        }

        return {
            update,
            get text() {
                return target.slice(0, visible);
            },
        };
    }

    T.mdStream = { create, complete };
})(window.Taby);
