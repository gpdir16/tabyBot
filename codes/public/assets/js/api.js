/* tabyBot 웹 클라이언트 — REST 클라이언트.
   TABYBOT_WEB_TOKEN 설정 시 모든 요청에 Authorization: Bearer 헤더.
   토큰은 localStorage('tabybot.web.token')에 보관. */
(function (T) {
    "use strict";

    const TOKEN_KEY = "tabybot.web.token";

    function getToken() {
        try {
            return localStorage.getItem(TOKEN_KEY) || "";
        } catch (_) {
            return "";
        }
    }
    function setToken(v) {
        try {
            if (v) localStorage.setItem(TOKEN_KEY, v);
            else localStorage.removeItem(TOKEN_KEY);
        } catch (_) {}
    }

    class ApiError extends Error {
        constructor(status, payload, network) {
            super(network ? "network error" : "API error " + status);
            this.status = status || 0;
            this.payload = payload;
            this.network = !!network;
        }
    }

    // API 응답에서 사용자에게 보여줄 오류 원인을 추출한다.
    function errorDetail(err) {
        if (err?.network) return T.i18n?.t("networkError") || "Network request failed. Check the server connection.";
        const payload = err?.payload;
        if (payload?.error === "not_configured") {
            const key = payload.reason === "model_missing" ? "modelRequired" : "providerRequired";
            return T.i18n?.t(key) || (key === "modelRequired" ? "Choose a model in Settings." : "Connect the selected provider in Settings.");
        }
        const detail =
            (typeof payload === "string" && payload) ||
            (typeof payload?.error === "string" && payload.error) ||
            payload?.error?.message ||
            payload?.message ||
            payload?.detail ||
            (err?.status ? `HTTP ${err.status}` : "");
        if (detail) return String(detail).replace(/\s+/g, " ").trim().slice(0, 500);
        if (err?.message && !/^API error \d+$/.test(err.message)) return String(err.message).slice(0, 500);
        return "Unknown error";
    }

    function errorText(err, fallback) {
        const detail = errorDetail(err);
        return detail ? `${fallback}: ${detail}` : fallback;
    }

    function enc(s) {
        return encodeURIComponent(String(s));
    }

    async function request(path, opt) {
        const o = opt || {};
        const headers = { Accept: "application/json" };
        let body;
        if (o.json !== undefined) {
            body = JSON.stringify(o.json);
            headers["Content-Type"] = "application/json";
        } else if (o.raw != null) {
            body = o.raw; // 업로드: 파일 원본 바디
            headers["Content-Type"] = o.rawType || "application/octet-stream";
            if (o.rawName) headers["X-File-Name"] = encodeURIComponent(o.rawName);
        }
        const tk = getToken();
        if (tk) headers.Authorization = "Bearer " + tk;

        let res;
        try {
            res = await fetch(path, { method: o.method || "GET", headers, body });
        } catch (_) {
            throw new ApiError(0, null, true);
        }
        let data = null;
        const txt = await res.text();
        if (txt) {
            try {
                data = JSON.parse(txt);
            } catch (_) {
                data = txt;
            }
        }
        if (!res.ok) throw new ApiError(res.status, data);
        return data;
    }

    const api = {
        ApiError,
        errorDetail,
        errorText,
        getToken,
        setToken,

        bootstrap: () => request("/api/bootstrap"),

        conversations: () => request("/api/conversations"),
        conversation: (id) => request("/api/conversations/" + enc(id)),

        sendMessage: (id, text, attachmentIds) => {
            const body = { text };
            if (Array.isArray(attachmentIds) && attachmentIds.length) body.attachmentIds = attachmentIds;
            return request("/api/conversations/" + enc(id) + "/messages", { method: "POST", json: body });
        },
        stopConversation: (id) => request("/api/conversations/" + enc(id) + "/stop", { method: "POST", json: {} }),
        eventsPoll: (since, recentMs) => request("/api/events/poll?since=" + enc(since || 0) + (recentMs ? "&recentMs=" + enc(recentMs) : "")),

        upload: (file) =>
            request("/api/uploads", {
                method: "POST",
                raw: file,
                rawType: file.type || "application/octet-stream",
                rawName: file.name,
            }),

        models: (payload) => request("/api/models/fetch", { method: "POST", json: payload || {} }),

        getSettings: () => request("/api/settings"),
        putSettings: (patch) => request("/api/settings", { method: "PUT", json: patch }),

        agents: () => request("/api/agents"),
        createAgent: (b) => request("/api/agents", { method: "POST", json: b }),
        updateAgent: (id, b) => request("/api/agents/" + enc(id), { method: "PATCH", json: b }),
        deleteAgent: (id) => request("/api/agents/" + enc(id), { method: "DELETE" }),

        todos: () => request("/api/todos"),
        createTodo: (b) => request("/api/todos", { method: "POST", json: b }),
        updateTodo: (todoId, b) => request("/api/todos/" + enc(todoId), { method: "PATCH", json: b }),
        deleteTodo: (todoId) => request("/api/todos/" + enc(todoId), { method: "DELETE" }),
        completeTodo: (todoId) => request("/api/todos/" + enc(todoId) + "/complete", { method: "POST", json: {} }),
        reopenTodo: (todoId) => request("/api/todos/" + enc(todoId) + "/reopen", { method: "POST", json: {} }),
        approveTodo: (id, b) => request("/api/todos/suggestions/" + enc(id) + "/approve", { method: "POST", json: b || {} }),
        rejectTodo: (id) => request("/api/todos/suggestions/" + enc(id) + "/reject", { method: "POST", json: {} }),
        acceptHandoff: (todoId, agentId) => request("/api/todos/" + enc(todoId) + "/handoff/" + enc(agentId), { method: "POST", json: {} }),
        unassignTodo: (todoId) => request("/api/todos/" + enc(todoId) + "/unassign", { method: "POST", json: {} }),
        runTodo: (todoId) => request("/api/todos/" + enc(todoId) + "/run", { method: "POST", json: {} }),

        answerAsk: (askId, body) => request("/api/asks/" + enc(askId) + "/answer", { method: "POST", json: body }),

        authStatus: () => request("/api/auth/status"),
        startOauth: (kind) => request("/api/auth/" + enc(kind) + "/start", { method: "POST", json: {} }),
        cancelOauth: (kind) => request("/api/auth/" + enc(kind) + "/cancel", { method: "POST", json: {} }),

        pushConfig: () => request("/api/push/config"),
        pushSubscribe: (sub) => request("/api/push/subscribe", { method: "POST", json: sub }),
        pushUnsubscribe: (sub) => request("/api/push/unsubscribe", { method: "POST", json: sub }),

        // img src / 일반 링크는 Authorization 헤더를 못 붙이므로 쿼리 토큰을 쓴다.
        fileHref: (id) => {
            const path = "/api/files/" + enc(id);
            const tk = getToken();
            return tk ? path + "?token=" + encodeURIComponent(tk) : path;
        },
    };

    T.api = api;
})((window.Taby = window.Taby || {}));
