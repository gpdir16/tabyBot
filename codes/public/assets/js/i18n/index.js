/* tabyBot 웹 클라이언트: i18n 코어(언어 결정, t(), 정적 DOM 번역). 사전은 i18n/{en,ko,ja}.js가 채운다. */
((T) => {
    "use strict";

    const DICT = T.i18nDict;

    let lang = "en";
    const listeners = [];

    // t('key', {n:5})는 치환된 문자열을 돌려준다. 키가 없으면 영어 사전, 그것도 없으면 키 이름을 쓴다.
    function t(key, vars) {
        let s = DICT[lang]?.[key] || DICT.en[key] || key;
        if (vars) {
            for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
        }
        return s;
    }

    function getLang() {
        return lang;
    }

    function applyStatic() {
        document.querySelectorAll("[data-i18n]").forEach((el) => {
            el.textContent = t(el.getAttribute("data-i18n"));
        });
        document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
            el.placeholder = t(el.getAttribute("data-i18n-ph"));
        });
        document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
            const key = el.getAttribute("data-i18n-aria");
            if (t(key) !== key) el.setAttribute("aria-label", t(key));
        });
        document.querySelectorAll("[data-i18n-tip]").forEach((el) => {
            const key = el.getAttribute("data-i18n-tip");
            if (t(key) !== key) el.setAttribute("data-tip", t(key));
        });
    }

    // 언어는 서버 설정이 기준이며, 초기 연결 전에는 브라우저 언어를 임시로 사용한다.
    function setLang(requested) {
        const l = DICT[requested] ? requested : "en";
        lang = l;
        document.documentElement.lang = l;
        applyStatic();
        listeners.forEach((fn) => {
            try {
                fn(l);
            } catch {
                // 구독자 하나의 오류가 다른 구독자 호출을 막지 않게 한다
            }
        });
    }

    // 초기 언어 결정: 서버값 > 브라우저 언어
    function init(server) {
        const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
        const cand = server || (["ko", "ja"].indexOf(nav) > -1 ? nav : "en");
        setLang(cand);
    }

    function onChange(fn) {
        listeners.push(fn);
    }

    T.i18n = { t, getLang, setLang, init, applyStatic, onChange };
})(window.Taby);
