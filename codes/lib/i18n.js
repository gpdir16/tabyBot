const MESSAGES = {
    tool_rounds_exceeded: {
        en: "I hit the tool call limit for this message. Please try again or simplify the request.",
        ko: "이 메시지의 도구 호출 한도에 도달했습니다. 다시 시도하거나 요청을 단순화해 주세요.",
        ja: "このメッセージのツール呼び出し上限に達しました。再試行するか、リクエストを簡略化してください。",
    },
    empty_reply_exhausted: {
        en: "I finished the work but could not produce a text reply after several attempts. Please ask again or request a summary.",
        ko: "작업은 마쳤지만 텍스트 응답을 여러 번 시도해도 생성하지 못했습니다. 다시 요청하거나 결과 요약을 요청해 주세요.",
        ja: "作業は完了しましたが、テキスト応答を複数回試しても生成できませんでした。再度依頼するか、結果の要約を求めてください。",
    },
    agent_error: {
        en: "Something went wrong while processing your message.",
        ko: "메시지 처리 중 오류가 발생했습니다.",
        ja: "メッセージの処理中にエラーが発生しました。",
    },
    agent_error_transport_closed: {
        en: "The model connection closed unexpectedly while receiving the response. This is usually a temporary provider/network issue. Please try again.",
        ko: "응답을 받는 중 모델 연결이 예기치 않게 종료되었습니다. 보통 일시적인 제공자/네트워크 문제입니다. 잠시 후 다시 시도해 주세요.",
        ja: "応答受信中にモデル接続が予期せず切断されました。通常は一時的なプロバイダー/ネットワーク問題です。少し待って再試行してください。",
    },
    stopped_by_user: {
        en: "Stopped.",
        ko: "중지했습니다.",
        ja: "停止しました。",
    },
    schedule_no_output: {
        en: "(no output)",
        ko: "(출력 없음)",
        ja: "(出力なし)",
    },
};

export function t(key, lang = "en", vars = {}) {
    const bucket = MESSAGES[key] || MESSAGES.agent_error;
    const text = bucket[lang] || bucket.en;
    return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export function formatAgentError(err, lang = "en") {
    const raw = String(err?.message || err || "");
    const lowered = raw.toLowerCase();
    if (lowered.includes("premature close") || lowered.includes("und_err_socket") || lowered.includes("socket hang up")) {
        return t("agent_error_transport_closed", lang);
    }

    const base = t("agent_error", lang);
    const detail = raw.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!detail) return base;
    return `${base}\n\n${detail}`;
}
