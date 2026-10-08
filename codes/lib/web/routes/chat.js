// 대화, 실시간 이벤트(SSE)·알림 기록, 업로드/파일, 웹 푸시 API.
import { getConfigIssue } from "../../onboarding.js";
import * as conversationsStore from "../conversations.js";
import { EmptyUploadError, MAX_UPLOAD_BYTES, UploadTooLargeError, getFile, publicAttachment, saveUploadStream, storedAttachment } from "../files.js";
import { emit, eventsSince } from "../bus.js";
import { dispatchMessage, stopConversation } from "../turns.js";
import { resolvePendingAskByAskId } from "../../agent/user-ask.js";
import { clearNotices, listNotices, markNoticesRead } from "../notices.js";
import { listRunningSessionKeys } from "../../agent/session.js";
import fs from "node:fs";
import { getVapidPublicKey, removeSubscription, saveSubscription } from "../push.js";

// ── 대화와 질문(user_ask) 응답 API. ──

function resolveConversationMeta(id) {
    return conversationsStore.getConversationMeta(id) || conversationsStore.ensureConversation(id);
}

function registerConversationsRoutes(router) {
    router.add("GET", "/api/conversations", (ctx) => {
        ctx.json200({ conversations: conversationsStore.listConversations() });
    });

    router.add("GET", "/api/conversations/:id", (ctx) => {
        const id = ctx.params.id;
        if (!conversationsStore.getConversationMeta(id)) resolveConversationMeta(id);
        const detail = conversationsStore.getConversationDetail(id);
        if (!detail) return ctx.json404();
        ctx.json200(detail);
    });

    router.add("POST", "/api/conversations/:id/messages", async (ctx) => {
        const id = ctx.params.id;
        const meta = resolveConversationMeta(id);
        if (!meta) return ctx.json404();
        const configIssue = getConfigIssue();
        if (configIssue) return ctx.json409("not_configured", { reason: configIssue });

        const body = await ctx.json();
        const text = String(body.text ?? "").trim();
        const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
        if (!text && !attachmentIds.length) return ctx.json400("empty_message");
        if (text.length > 32_000) return ctx.json400("message_too_long");

        const stored = [];
        for (const fid of attachmentIds) {
            const file = getFile(fid);
            if (!file) continue;
            stored.push(storedAttachment(file));
        }
        if (!text && !stored.length) return ctx.json400("empty_message");

        const published = stored.map(publicAttachment);
        dispatchMessage({
            sessionKey: id,
            agentId: meta.agentId,
            userText: text,
            displayText: text,
            attachments: stored,
        });
        // 멀티탭 동기화: 다른 클라이언트에도 사용자 메시지를 즉시 반영
        emit({
            type: "user_message",
            conversationId: id,
            text,
            attachments: published,
        });
        ctx.json200({ ok: true });
    });

    // 읽음 처리: 다른 기기의 배지도 지워지게 목록 변경을 알린다.
    router.add("POST", "/api/conversations/:id/read", (ctx) => {
        const changed = conversationsStore.markConversationRead(ctx.params.id);
        if (changed) emit({ type: "conversations_changed" });
        ctx.json200({ ok: true });
    });

    router.add("POST", "/api/conversations/:id/stop", (ctx) => {
        ctx.json200({ ok: stopConversation(ctx.params.id) });
    });

    router.add("GET", "/api/search/messages", (ctx) => {
        const q = String(ctx.query.q || "");
        if (!q.trim()) return ctx.json200({ results: [] });
        ctx.json200({ results: conversationsStore.searchMessages(q) });
    });
    router.add("POST", "/api/asks/:askId/answer", async (ctx) => {
        const body = await ctx.json();
        const answer = resolvePendingAskByAskId(ctx.params.askId, {
            choiceIndex: Number.isInteger(body.choiceIndex) ? body.choiceIndex : null,
            text: String(body.text ?? ""),
        });
        if (answer === null) return ctx.json404();
        ctx.json200({ ok: true, answer });
    });
}

// ── 실시간 이벤트(SSE)와 시스템 알림 기록 API. ──

function registerEventsRoutes(router) {
    router.add("GET", "/api/events", (ctx) => {
        ctx.sse();
        // 새로고침 직후 진행 중 턴을 바로 붙인다. 다음 phase 이벤트까지 기다리지 않는다.
        for (const conversationId of listRunningSessionKeys()) {
            emit({ type: "status", conversationId, phase: "generating" });
        }
    });
    router.add("GET", "/api/events/poll", (ctx) => {
        ctx.json200(eventsSince(ctx.query.since, ctx.query.recentMs));
    });

    router.add("GET", "/api/notices", (ctx) => {
        ctx.json200(listNotices());
    });

    // body.ids가 없으면 전부 읽음 처리. 다른 기기에 떠 있는 알림 모달도 닫히게 변경을 알린다.
    router.add("POST", "/api/notices/read", async (ctx) => {
        const body = await ctx.json().catch(() => ({}));
        if (markNoticesRead(Array.isArray(body?.ids) ? body.ids : null)) emit({ type: "notices_changed" });
        ctx.json200(listNotices());
    });

    router.add("DELETE", "/api/notices", (ctx) => {
        if (clearNotices()) emit({ type: "notices_changed" });
        ctx.json200(listNotices());
    });
}

// ── 업로드/파일 API. ──

function registerFilesRoutes(router) {
    router.add("POST", "/api/uploads", async (ctx) => {
        const mime = String(ctx.req.headers["content-type"] || "application/octet-stream")
            .split(";")[0]
            .trim();
        let originalName = "";
        try {
            originalName = decodeURIComponent(String(ctx.req.headers["x-file-name"] || ""));
        } catch {
            originalName = String(ctx.req.headers["x-file-name"] || "");
        }
        try {
            const entry = await saveUploadStream(ctx.req, mime, originalName);
            ctx.json200({
                id: entry.id,
                kind: entry.mime.startsWith("image/") ? "image" : "file",
                url: `/api/files/${entry.id}`,
                name: entry.name,
                mime: entry.mime,
                size: entry.size,
            });
        } catch (err) {
            if (err instanceof UploadTooLargeError || err?.code === "UPLOAD_TOO_LARGE") {
                return ctx.json413("upload_too_large", { maxBytes: MAX_UPLOAD_BYTES });
            }
            if (err instanceof EmptyUploadError || err?.code === "EMPTY_UPLOAD") {
                return ctx.json400("empty_upload");
            }
            throw err;
        }
    });

    // 미리보기 뷰어의 iframe이 inline 렌더를 요청할 때 허용하는 타입만 연다.
    // 스크립트 실행 가능한 형식(svg/html 등)은 절대 inline으로 서빙하지 않는다.
    const INLINE_PREVIEW_MIME = /^(video\/|audio\/|application\/pdf$)/i;
    // svg는 image/*지만 스크립트를 실행할 수 있어 직접 탭에서 열면 같은 오리진의
    // 토큰이 털릴 수 있다. <img> 임베드는 실행되지 않아 안전하므로 다운로드로만보낸다.
    const INLINE_IMAGE_MIME = /^image\/(?!svg)/i;
    router.add("GET", "/api/files/:id", (ctx) => {
        const file = getFile(ctx.params.id);
        if (!file) return ctx.json404();
        const stat = fs.statSync(file.filePath);
        const inline = INLINE_IMAGE_MIME.test(file.mime) || (ctx.query.inline === "1" && INLINE_PREVIEW_MIME.test(file.mime));
        ctx.res.writeHead(200, {
            "Content-Type": file.mime,
            "Content-Length": stat.size,
            "Content-Disposition": inline ? "inline" : `attachment; filename="${encodeURIComponent(file.name)}"`,
            "Cache-Control": "private, max-age=3600",
        });
        fs.createReadStream(file.filePath)
            .on("error", () => ctx.res.destroy())
            .pipe(ctx.res);
    });
}

// ── push.js ──

function registerPushRoutes(router) {
    router.add("GET", "/api/push/config", (ctx) => {
        ctx.json200({ publicKey: getVapidPublicKey() });
    });

    router.add("POST", "/api/push/subscribe", async (ctx) => {
        const body = await ctx.json();
        if (!saveSubscription(body)) return ctx.json400("invalid_subscription");
        ctx.json200({ ok: true });
    });

    router.add("POST", "/api/push/unsubscribe", async (ctx) => {
        const body = await ctx.json();
        removeSubscription(body);
        ctx.json200({ ok: true });
    });
}

export function registerChatRoutes(router) {
    registerConversationsRoutes(router);
    registerEventsRoutes(router);
    registerFilesRoutes(router);
    registerPushRoutes(router);
}
