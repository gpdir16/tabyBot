/* tabyBot 웹 클라이언트: REST 클라이언트.
   계정이 있으면 모든 요청에 Authorization: Bearer <세션 토큰> 헤더.
   세션 토큰은 localStorage('tabybot.web.token')에 보관. */
((T) => {
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
        } catch {
            // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 저장하지 않고 넘어간다
        }
    }

    class ApiError extends Error {
        constructor(status, payload, network) {
            super(network ? "network error" : `API error ${status}`);
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
        if (tk) headers.Authorization = `Bearer ${tk}`;

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
        // 세션 중 401(토큰 변경/만료)은 토스트만으론 복구 불가: 토큰 입력 화면을 띄운다.
        if (res.status === 401) T.app?.handleUnauthorized?.();
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

        accountState: () => request("/api/account/state"),
        accountSetup: (b) => request("/api/account/setup", { method: "POST", json: b }),
        accountLogin: (b) => request("/api/account/login", { method: "POST", json: b }),
        accountLogout: () => request("/api/account/logout", { method: "POST", json: {} }),
        accountLogoutAll: () => request("/api/account/logout-all", { method: "POST", json: {} }),
        accountUpdate: (b) => request("/api/account", { method: "PUT", json: b }),

        conversations: () => request("/api/conversations"),
        conversation: (id) => request(`/api/conversations/${enc(id)}`),

        sendMessage: (id, text, attachmentIds, clientId) => {
            const body = { text };
            if (clientId) body.clientId = clientId;
            if (Array.isArray(attachmentIds) && attachmentIds.length) body.attachmentIds = attachmentIds;
            return request(`/api/conversations/${enc(id)}/messages`, { method: "POST", json: body });
        },
        markRead: (id) => request(`/api/conversations/${enc(id)}/read`, { method: "POST", json: {} }),
        stopConversation: (id) => request(`/api/conversations/${enc(id)}/stop`, { method: "POST", json: {} }),
        searchMessages: (q) => request(`/api/search/messages?q=${enc(q || "")}`),
        eventsPoll: (since, recentMs) => request(`/api/events/poll?since=${enc(since || 0)}${recentMs ? `&recentMs=${enc(recentMs)}` : ""}`),

        upload: (file) =>
            request("/api/uploads", {
                method: "POST",
                raw: file,
                rawType: file.type || "application/octet-stream",
                rawName: file.name,
            }),

        models: (payload) => request("/api/models/fetch", { method: "POST", json: payload || {} }),
        openRouterProviders: (model, profile) =>
            request(`/api/providers/openrouter/endpoints?model=${enc(model || "")}${profile ? `&profile=${enc(profile)}` : ""}`),

        getSettings: () => request("/api/settings"),
        putSettings: (patch) => request("/api/settings", { method: "PUT", json: patch }),
        addProviderProfile: (providerId) => request("/api/provider-profiles", { method: "POST", json: { providerId } }),
        updateProviderProfile: (uid, body) => request(`/api/provider-profiles/${enc(uid)}`, { method: "PUT", json: body }),
        deleteProviderProfile: (uid) => request(`/api/provider-profiles/${enc(uid)}`, { method: "DELETE" }),
        createModelPreset: (body) => request("/api/model-presets", { method: "POST", json: body }),
        updateModelPreset: (uid, body) => request(`/api/model-presets/${enc(uid)}`, { method: "PUT", json: body }),
        defaultModelPreset: (uid) => request(`/api/model-presets/${enc(uid)}/default`, { method: "POST", json: {} }),
        deleteModelPreset: (uid) => request(`/api/model-presets/${enc(uid)}`, { method: "DELETE" }),
        compressAllSessions: (chatIds) =>
            request("/api/sessions/compress-all", { method: "POST", json: Array.isArray(chatIds) && chatIds.length ? { chatIds } : {} }),
        restartAllSessions: () => request("/api/sessions/restart-all", { method: "POST", json: {} }),

        agents: () => request("/api/agents"),
        createAgent: (b) => request("/api/agents", { method: "POST", json: b }),
        updateAgent: (id, b) => request(`/api/agents/${enc(id)}`, { method: "PATCH", json: b }),
        deleteAgent: (id) => request(`/api/agents/${enc(id)}`, { method: "DELETE" }),

        skills: () => request("/api/skills"),
        skill: (name, source) => request(`/api/skills/${enc(name)}${source ? `?source=${enc(source)}` : ""}`),
        createSkill: (b) => request("/api/skills", { method: "POST", json: b }),
        updateSkill: (name, b) => request(`/api/skills/${enc(name)}`, { method: "PUT", json: b }),
        deleteSkill: (name, source) => request(`/api/skills/${enc(name)}${source ? `?source=${enc(source)}` : ""}`, { method: "DELETE" }),

        mcpServers: () => request("/api/mcp"),
        createMcpServer: (b) => request("/api/mcp", { method: "POST", json: b }),
        updateMcpServer: (name, b) => request(`/api/mcp/${enc(name)}`, { method: "PUT", json: b }),
        deleteMcpServer: (name) => request(`/api/mcp/${enc(name)}`, { method: "DELETE" }),

        secrets: () => request("/api/secrets"),
        createSecret: (b) => request("/api/secrets", { method: "POST", json: b }),
        updateSecret: (id, b) => request(`/api/secrets/${enc(id)}`, { method: "PUT", json: b }),
        deleteSecret: (id) => request(`/api/secrets/${enc(id)}`, { method: "DELETE" }),

        createFolder: (b) => request("/api/folders", { method: "POST", json: b }),
        updateFolder: (id, b) => request(`/api/folders/${enc(id)}`, { method: "PATCH", json: b }),
        deleteFolder: (id) => request(`/api/folders/${enc(id)}`, { method: "DELETE" }),
        orderFolders: (ids) => request("/api/folders/order", { method: "POST", json: { ids } }),
        createGroup: (b) => request("/api/groups", { method: "POST", json: b }),
        updateGroup: (id, b) => request(`/api/groups/${enc(id)}`, { method: "PATCH", json: b }),
        deleteGroup: (id) => request(`/api/groups/${enc(id)}`, { method: "DELETE" }),
        // 프로필 사진. key는 에이전트 uuid나 그룹 방 id. 응답은 /api/agents와 같은 전체 스냅샷이다.
        setAvatar: (key, blob) => request(`/api/avatars/${enc(key)}`, { method: "PUT", raw: blob, rawType: blob.type || "application/octet-stream" }),
        removeAvatar: (key) => request(`/api/avatars/${enc(key)}`, { method: "DELETE" }),
        avatarPresets: () => request("/api/avatar-presets"),

        todos: () => request("/api/todos"),
        createTodo: (b) => request("/api/todos", { method: "POST", json: b }),
        updateTodo: (todoId, b) => request(`/api/todos/${enc(todoId)}`, { method: "PATCH", json: b }),
        deleteTodo: (todoId) => request(`/api/todos/${enc(todoId)}`, { method: "DELETE" }),
        completeTodo: (todoId) => request(`/api/todos/${enc(todoId)}/complete`, { method: "POST", json: {} }),
        reopenTodo: (todoId) => request(`/api/todos/${enc(todoId)}/reopen`, { method: "POST", json: {} }),
        approveTodo: (id, b) => request(`/api/todos/suggestions/${enc(id)}/approve`, { method: "POST", json: b || {} }),
        rejectTodo: (id) => request(`/api/todos/suggestions/${enc(id)}/reject`, { method: "POST", json: {} }),
        acceptHandoff: (todoId, agentId) => request(`/api/todos/${enc(todoId)}/handoff/${enc(agentId)}`, { method: "POST", json: {} }),
        unassignTodo: (todoId) => request(`/api/todos/${enc(todoId)}/unassign`, { method: "POST", json: {} }),
        runTodo: (todoId) => request(`/api/todos/${enc(todoId)}/run`, { method: "POST", json: {} }),

        notices: () => request("/api/notices"),
        readNotices: (ids) => request("/api/notices/read", { method: "POST", json: Array.isArray(ids) ? { ids } : {} }),
        clearNotices: () => request("/api/notices", { method: "DELETE" }),

        pendingAsks: () => request("/api/asks"),
        answerAsk: (askId, body) => request(`/api/asks/${enc(askId)}/answer`, { method: "POST", json: body }),

        computerStatus: () => request("/api/computer/status"),
        computerScreenStart: (geometry) => request("/api/computer/screen/start", { method: "POST", json: geometry ? { geometry } : {} }),
        computerScreenStop: () => request("/api/computer/screen/stop", { method: "POST", json: {} }),
        computerBrowserOpen: (agentId, url) => request("/api/computer/browser/open", { method: "POST", json: { agentId, url } }),
        computerWindows: () => request("/api/computer/windows"),
        computerRaiseWindow: (user, tabId) => request("/api/computer/windows/raise", { method: "POST", json: { user, tabId } }),
        containerFiles: (path) => request(`/api/computer/files?path=${enc(path || "")}`),
        containerFileText: (path) => request(`/api/computer/files/text?path=${enc(path || "")}`),
        resolveContainerPaths: (paths) => request("/api/computer/files/resolve", { method: "POST", json: { paths: paths || [] } }),
        containerFileHref: (path, inline) => {
            const qs = new URLSearchParams({ path: String(path || "") });
            if (inline) qs.set("inline", "1");
            const tk = getToken();
            if (tk) qs.set("token", tk);
            return `/api/computer/files/raw?${qs.toString()}`;
        },

        authStatus: () => request("/api/auth/status"),
        claudeAuthStatus: () => request("/api/auth/claude/status"),
        startClaudeLogin: () => request("/api/auth/claude/login/start", { method: "POST", json: {} }),
        submitClaudeLoginCode: (code) => request("/api/auth/claude/login/code", { method: "POST", json: { code } }),
        cancelClaudeLogin: () => request("/api/auth/claude/login/cancel", { method: "POST", json: {} }),
        startOauth: (kind) => request(`/api/auth/${enc(kind)}/start`, { method: "POST", json: {} }),
        cancelOauth: (kind) => request(`/api/auth/${enc(kind)}/cancel`, { method: "POST", json: {} }),

        pushConfig: () => request("/api/push/config"),
        pushSubscribe: (sub) => request("/api/push/subscribe", { method: "POST", json: sub }),
        pushUnsubscribe: (sub) => request("/api/push/unsubscribe", { method: "POST", json: sub }),

        // img src / 일반 링크는 Authorization 헤더를 못 붙이므로 쿼리 토큰을 쓴다.
        fileHref: (id) => {
            const path = `/api/files/${enc(id)}`;
            const tk = getToken();
            return tk ? `${path}?token=${encodeURIComponent(tk)}` : path;
        },
        // 사진이 바뀌면 버전(v)이 바뀌어 주소도 바뀐다. img는 헤더를 못 붙이므로 토큰은 쿼리로 보낸다.
        avatarHref: (key, version) => {
            const qs = new URLSearchParams({ v: String(version || "") });
            const tk = getToken();
            if (tk) qs.set("token", tk);
            return `/api/avatars/${enc(key)}?${qs.toString()}`;
        },
    };

    T.api = api;
})(window.Taby);
