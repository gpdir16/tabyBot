/* tabyBot 웹 클라이언트 — i18n 사전 + 공용 유틸리티.
   명세의 파일 구조를 유지하기 위해 공용 DOM 헬퍼를 이 파일에 둔다.
   전역 네임스페이스 Taby 아래에 부착된다(Chrome file:// 모듈 CORS 회피). */
(function (T) {
    "use strict";

    /* ── 공용 유틸 ─────────────────────────────────────────── */

    // 엘리먼트 생성 헬퍼: h('div', {class:'x', onclick:fn, text:'...'}, [children])
    function h(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                const v = attrs[k];
                if (v == null || v === false) continue;
                if (k === "class") el.className = v;
                else if (k === "text") el.textContent = v;
                else if (k === "html") throw new Error("HTML 속성은 XSS 방지를 위해 지원하지 않는다. 마크다운 파이프라인을 사용한다.");
                else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
                else if (k === "dataset") Object.assign(el.dataset, v);
                else if (k === "style") el.style.cssText = v;
                else el.setAttribute(k, v === true ? "" : v);
            }
        }
        if (children)
            for (const c of children) {
                if (c == null || c === false) continue;
                el.append(c);
            }
        return el;
    }

    // 스프라이트 아이콘: icon('copy') → <svg class="icon"><use href="#i-copy"/></svg>
    const SVG_NS = "http://www.w3.org/2000/svg";
    function icon(name, extraClass) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "icon" + (extraClass ? " " + extraClass : ""));
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(SVG_NS, "use");
        use.setAttribute("href", "#i-" + name);
        svg.appendChild(use);
        return svg;
    }

    // HTML 이스케이프(예외적 innerHTML 경로용)
    function esc(s) {
        return String(s).replace(
            /[&<>"']/g,
            (ch) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                })[ch],
        );
    }

    // 클립보드 복사(file:// 폴백 포함). 성공 여부 반환.
    function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext !== false) {
                return navigator.clipboard.writeText(text).then(
                    () => true,
                    () => fallbackCopy(text),
                );
            }
        } catch (_) {
            /* 폴백으로 진행 */
        }
        return Promise.resolve(fallbackCopy(text));
    }
    function fallbackCopy(text) {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    T.h = h;
    T.icon = icon;
    T.esc = esc;
    T.copyText = copyText;

    /* ── i18n 사전 (en / ko / ja) ──────────────────────────── */
    const DICT = {
        en: {
            newChat: "New chat",
            searchPlaceholder: "Search bots",
            botNoJob: "No job yet",
            editBot: "Edit bot",
            more: "More",
            lastBotTooltip: "The last bot cannot be deleted",
            botThreadIntro: "A conversation with {name} has started.",
            selectBotFirst: "Pick a bot first",
            collapse: "Collapse sidebar",
            expand: "Expand sidebar",
            noBots: "No bots match",
            today: "Today",
            yesterday: "Yesterday",
            previous7Days: "Previous 7 days",
            older: "Earlier",
            rename: "Rename",
            delete: "Delete",
            deleteConfirm: "Delete?",
            deleteNoUndo: "Conversation deleted. This cannot be undone.",
            cancel: "Cancel",
            save: "Save",
            saved: "Saved",
            saveFailed: "Failed to save",
            nameRequired: "Name is required",
            nameTooLong: "Name must be 32 characters or fewer",
            personaRequired: "Persona is required",
            personaTooLong: "Persona must be 500 characters or fewer",
            untitled: "Untitled conversation",
            settings: "Settings",
            general: "General",
            model: "Model",
            agents: "Agents",
            addAgent: "Add agent",
            editAgent: "Edit agent",
            agentName: "Name",
            persona: "Persona",
            personaPlaceholder: "Describe how this agent should behave…",
            mainAgentNotice: "The main agent cannot be deleted.",
            language: "Language",
            theme: "Theme",
            dark: "Dark",
            light: "Light",
            statsFooter: "Response stats footer",
            statsFooterExample: "3 model calls · 5 tool calls · 12,431 / 200,000",
            updateCheck: "Check for updates",
            thinkingLevel: "Reasoning depth",
            provider: "Provider",
            baseURL: "Base URL",
            apiKey: "API key",
            apiKeyOptional: "Key optional",
            apiKeySaved: "Saved",
            loadModels: "Load models",
            loadingModels: "Loading models…",
            modelsFailed: "Failed to load models",
            searchModels: "Filter models…",
            noModels: "No models found",
            manualModel: "Model ID",
            manualModelPlaceholder: "Enter a model ID",
            sendPlaceholder: "Ask anything…",
            generating: "Generating…",
            thinking: "Thinking…",
            runningTool: "Running tools…",
            compressing: "Compressing context…",
            selfImproving: "Self-improving…",
            searching: "Searching…",
            stop: "Stop",
            regenerate: "Regenerate",
            copy: "Copy",
            copied: "Copied",
            copyFailed: "Copy failed",
            newMessages: "New messages",
            askTimeLeft: "{n}s left",
            askExpired: "Expired",
            answered: "Answered",
            askInputPlaceholder: "Write an answer…",
            imagePlaceholder: "[Image]",
            emptyGreeting: "What can I help you with?",
            send: "Send",
            emptyHint: "tabyBot runs locally on this machine.",
            suggestion1: "Summarize this workspace",
            suggestion2: "Explain this repository’s structure",
            suggestion3: "Write a regex for ISO dates",
            suggestion4: "Draft a changelog entry",
            back: "Back",
            connected: "Connected",
            connectingState: "Connecting…",
            connectionLost: "Connection lost",
            reconnecting: "Reconnecting…",
            sendFailed: "Failed to send",
            uploadFailed: "Upload failed",
            fileTooLarge: "File is too large (max 1 GB)",
            emptyFile: "Empty file",
            downloadFailed: "Download failed",
            file: "File",
            attachFile: "Attach file",
            errorPrefix: "Error",
            offlineNote: "Cannot reach the tabyBot server. Start the server and retry.",
            onbLangTitle: "Choose your language",
            onbLangDesc: "You can change it later in Settings.",
            onbProvTitle: "Connect an AI provider",
            onbProvDesc: "Pick the service your bots will use.",
            onbModelTitle: "Choose a model",
            onbModelDesc: "The list comes from the provider. If it stays empty, type a model ID yourself.",
            onbPolicyTitle: "Set your ground rules",
            onbPolicyDesc: "Content limits and who approves permanent actions.",
            onbPolicyNote: "You can change all of this anytime in Settings.",
            onbFinish: "Finish setup",
            onbNext: "Next",
            onbPrev: "Back",
            onbTokenTitle: "Server access",
            onbTokenDesc: "This server requires an access token.",
            onbConnect: "Connect",
            onbTokenFailed: "Connection failed. Check the token.",
            retry: "Retry",
            statModelCalls: "{n} model calls",
            statToolCalls: "{n} tool calls",
            showApiKey: "Show API key",
            hideApiKey: "Hide API key",
            runningState: "Running",
            attachImage: "Attach file",
            botSettings: "Bot settings",
            nsfwLevel: "NSFW content limit",
            nsfwStrict: "Not allowed",
            nsfwModerate: "Indirect only",
            nsfwExplicit: "Fully allowed",
            approvalLevel: "Permanent actions",
            approvalUser: "Always ask",
            approvalModel: "Model decides",
            approvalAlways: "Always allow",
            approvalDesc: "Who approves permanent/irreversible actions (payments, account/data deletion, external sends).",
            oauthAccount: "Account",
            oauthChecking: "Checking…",
            oauthLogin: "Log in",
            oauthRelogin: "Log in again",
            oauthLoggedIn: "Logged in",
            oauthNotLoggedIn: "Not logged in",
            oauthEnterCode: "Open the page and enter the code:",
            oauthPending: "Waiting for authorization…",
            oauthSuccess: "Authorization complete",
            oauthFailed: "Authorization failed",
            notifications: "Notifications",
            notificationsDesc: "Replies, questions, and system notices — like a messenger.",
            notificationsDenied: "Notification permission was denied",
            installApp: "Install app",
            install: "Install",
            menu: "Menu",
        },
        ko: {
            newChat: "새 대화",
            searchPlaceholder: "봇 검색",
            botNoJob: "아직 맡은 일이 없어요",
            editBot: "봇 편집",
            more: "더보기",
            lastBotTooltip: "마지막 봇은 삭제할 수 없어요",
            botThreadIntro: "{name}과(와)의 대화가 시작되었어요.",
            selectBotFirst: "먼저 봇을 선택하세요",
            collapse: "사이드바 접기",
            expand: "사이드바 펼치기",
            noBots: "일치하는 봇이 없어요",
            today: "오늘",
            yesterday: "어제",
            previous7Days: "지난 7일",
            older: "이전",
            rename: "이름 변경",
            delete: "삭제",
            deleteConfirm: "삭제?",
            deleteNoUndo: "대화가 삭제되었습니다. 실행취소할 수 없습니다.",
            cancel: "취소",
            save: "저장",
            saved: "저장됨",
            saveFailed: "저장에 실패했습니다",
            nameRequired: "이름을 입력하세요",
            nameTooLong: "이름은 32자 이하여야 합니다",
            personaRequired: "페르소나를 입력하세요",
            personaTooLong: "페르소나는 500자 이하여야 합니다",
            untitled: "제목 없는 대화",
            settings: "설정",
            general: "일반",
            model: "모델",
            agents: "에이전트",
            addAgent: "에이전트 추가",
            editAgent: "에이전트 편집",
            agentName: "이름",
            persona: "페르소나",
            personaPlaceholder: "이 에이전트의 성격과 역할을 설명하세요…",
            mainAgentNotice: "main 에이전트는 삭제할 수 없습니다.",
            language: "언어",
            theme: "테마",
            dark: "다크",
            light: "라이트",
            statsFooter: "응답 통계 푸터",
            statsFooterExample: "모델 호출 3회 · 도구 호출 5회 · 12,431 / 200,000",
            updateCheck: "업데이트 확인",
            thinkingLevel: "추론 깊이",
            provider: "프로바이더",
            baseURL: "Base URL",
            apiKey: "API 키",
            apiKeyOptional: "키 선택사항",
            apiKeySaved: "저장됨",
            loadModels: "모델 불러오기",
            loadingModels: "모델 불러오는 중…",
            modelsFailed: "모델을 불러오지 못했습니다",
            searchModels: "모델 검색…",
            noModels: "모델이 없습니다",
            manualModel: "모델 ID",
            manualModelPlaceholder: "모델 ID를 입력하세요",
            sendPlaceholder: "무엇이든 물어보세요…",
            generating: "생성 중…",
            thinking: "생각 중…",
            runningTool: "도구 실행 중…",
            compressing: "맥락 압축 중…",
            selfImproving: "자가 개선 중…",
            searching: "검색 중…",
            stop: "정지",
            regenerate: "재생성",
            copy: "복사",
            copied: "복사됨",
            copyFailed: "복사 실패",
            newMessages: "새 메시지",
            askTimeLeft: "{n}초 남음",
            askExpired: "만료됨",
            answered: "답변 완료",
            askInputPlaceholder: "답변 입력…",
            imagePlaceholder: "[이미지]",
            emptyGreeting: "무엇이든 물어보세요",
            emptyHint: "tabyBot이 이 컴퓨터에서 로컬로 실행됩니다.",
            suggestion1: "이 워크스페이스 요약해줘",
            suggestion2: "이 저장소 구조 설명해줘",
            suggestion3: "ISO 날짜 정규식 만들어줘",
            suggestion4: "체인지로그 항목 초안 써줘",
            send: "전송",
            back: "뒤로",
            connected: "연결됨",
            connectingState: "연결 중…",
            connectionLost: "연결 끊김",
            reconnecting: "재접속 중…",
            sendFailed: "전송에 실패했습니다",
            uploadFailed: "업로드에 실패했습니다",
            fileTooLarge: "파일이 너무 큽니다 (최대 1GB)",
            emptyFile: "빈 파일입니다",
            downloadFailed: "다운로드에 실패했습니다",
            file: "파일",
            attachFile: "파일 첨부",
            errorPrefix: "오류",
            offlineNote: "tabyBot 서버에 연결할 수 없습니다. 서버 실행 후 재시도해 주세요.",
            onbLangTitle: "언어를 선택하세요",
            onbLangDesc: "설정에서 언제든 바꿀 수 있습니다.",
            onbProvTitle: "AI 프로바이더 연결",
            onbProvDesc: "봇이 사용할 AI 서비스를 고릅니다.",
            onbModelTitle: "모델을 고르세요",
            onbModelDesc: "목록은 프로바이더에서 가져옵니다. 목록이 비면 모델 ID를 직접 입력하세요.",
            onbPolicyTitle: "이용 정책 정하기",
            onbPolicyDesc: "콘텐츠 제한과 영구적인 행위의 승인 주체를 정합니다.",
            onbPolicyNote: "모든 항목은 설정에서 언제든 바꿀 수 있습니다.",
            onbFinish: "설정 완료",
            onbNext: "다음",
            onbPrev: "이전",
            onbTokenTitle: "서버 접속",
            onbTokenDesc: "이 서버는 액세스 토큰이 필요합니다.",
            onbConnect: "연결",
            onbTokenFailed: "연결에 실패했습니다. 토큰을 확인하세요.",
            retry: "다시 시도",
            statModelCalls: "모델 호출 {n}회",
            statToolCalls: "도구 호출 {n}회",
            showApiKey: "API 키 보기",
            hideApiKey: "API 키 숨기기",
            runningState: "실행 중",
            attachImage: "파일 첨부",
            botSettings: "이 봇 설정",
            nsfwLevel: "NSFW 컨텐츠 제한",
            nsfwStrict: "허용하지 않음",
            nsfwModerate: "간접 언급만",
            nsfwExplicit: "전체 허용",
            approvalLevel: "영구적인 행위 승인",
            approvalUser: "항상 물어보기",
            approvalModel: "모델이 판단",
            approvalAlways: "항상 허용",
            approvalDesc: "결제, 계정/데이터 삭제, 외부 발송 같은 되돌릴 수 없는 행위를 누가 승인할지 정합니다.",
            oauthAccount: "계정",
            oauthChecking: "확인 중…",
            oauthLogin: "로그인",
            oauthRelogin: "다시 로그인",
            oauthLoggedIn: "로그인됨",
            oauthNotLoggedIn: "로그인 필요",
            oauthEnterCode: "페이지를 열고 코드를 입력하세요:",
            oauthPending: "승인을 기다리는 중…",
            oauthSuccess: "인증이 완료되었습니다",
            oauthFailed: "인증에 실패했습니다",
            notifications: "알림",
            notificationsDesc: "답장, 질문, 시스템 알림을 메신저처럼 받습니다.",
            notificationsDenied: "알림 권한이 거부되었습니다",
            installApp: "앱 설치",
            install: "설치",
            menu: "메뉴",
        },
        ja: {
            newChat: "新しいチャット",
            searchPlaceholder: "ボットを検索",
            botNoJob: "担当業務なし",
            editBot: "ボットを編集",
            more: "その他",
            lastBotTooltip: "最後のボットは削除できません",
            botThreadIntro: "{name}とのスレッドが開始されました。",
            selectBotFirst: "先にボットを選択してください",
            collapse: "サイドバーを折りたたむ",
            expand: "サイドバーを展開",
            noBots: "一致するボットがありません",
            today: "今日",
            yesterday: "昨日",
            previous7Days: "過去7日",
            older: "以前",
            rename: "名前を変更",
            delete: "削除",
            deleteConfirm: "削除しますか？",
            deleteNoUndo: "会話を削除しました。元に戻せません。",
            cancel: "キャンセル",
            save: "保存",
            saved: "保存しました",
            saveFailed: "保存に失敗しました",
            nameRequired: "名前を入力してください",
            nameTooLong: "名前は32文字以内にしてください",
            personaRequired: "ペルソナを入力してください",
            personaTooLong: "ペルソナは500文字以内にしてください",
            untitled: "無題の会話",
            settings: "設定",
            general: "一般",
            model: "モデル",
            agents: "エージェント",
            addAgent: "エージェントを追加",
            editAgent: "エージェントを編集",
            agentName: "名前",
            persona: "ペルソナ",
            personaPlaceholder: "このエージェントの性格と役割を説明してください…",
            mainAgentNotice: "mainエージェントは削除できません。",
            language: "言語",
            theme: "テーマ",
            dark: "ダーク",
            light: "ライト",
            statsFooter: "応答統計フッター",
            statsFooterExample: "モデル呼び出し 3回 · ツール 5回 · 12,431 / 200,000",
            updateCheck: "アップデートを確認",
            thinkingLevel: "推論の深さ",
            provider: "プロバイダ",
            baseURL: "Base URL",
            apiKey: "APIキー",
            apiKeyOptional: "キー任意",
            apiKeySaved: "保存済み",
            loadModels: "モデルを取得",
            loadingModels: "モデルを取得中…",
            modelsFailed: "モデルの取得に失敗しました",
            searchModels: "モデルを検索…",
            noModels: "モデルが見つかりません",
            manualModel: "モデル ID",
            manualModelPlaceholder: "モデル IDを入力してください",
            sendPlaceholder: "何でも聞いてください…",
            generating: "生成中…",
            thinking: "思考中…",
            runningTool: "ツール実行中…",
            compressing: "文脈を圧縮中…",
            selfImproving: "自己改善中…",
            searching: "検索中…",
            stop: "停止",
            regenerate: "再生成",
            copy: "コピー",
            copied: "コピーしました",
            copyFailed: "コピー失敗",
            newMessages: "新しいメッセージ",
            askTimeLeft: "残り{n}秒",
            askExpired: "期限切れ",
            answered: "回答済み",
            askInputPlaceholder: "回答を入力…",
            imagePlaceholder: "[画像]",
            emptyGreeting: "何でもお聞きください",
            emptyHint: "tabyBotはこのマシンでローカルに実行されます。",
            suggestion1: "このワークスペースを要約して",
            suggestion2: "このリポジトリの構成を説明して",
            suggestion3: "ISO日付の正規表現を書いて",
            suggestion4: "チェンジログの下書きを書いて",
            back: "戻る",
            connected: "接続済み",
            connectingState: "接続中…",
            connectionLost: "接続が切断されました",
            reconnecting: "再接続中…",
            sendFailed: "送信に失敗しました",
            uploadFailed: "アップロードに失敗しました",
            fileTooLarge: "ファイルが大きすぎます（最大 1GB）",
            emptyFile: "空のファイルです",
            downloadFailed: "ダウンロードに失敗しました",
            file: "ファイル",
            attachFile: "ファイルを添付",
            errorPrefix: "エラー",
            offlineNote: "tabyBotサーバーに接続できません。サーバー起動後に再試行してください。",
            send: "送信",
            onbLangTitle: "言語を選択",
            onbLangDesc: "設定でいつでも変更できます。",
            onbProvTitle: "AIプロバイダに接続",
            onbProvDesc: "ボットが使うAIサービスを選びます。",
            onbModelTitle: "モデルを選択",
            onbModelDesc: "一覧はプロバイダから取得します。空の場合はモデルIDを直接入力してください。",
            onbPolicyTitle: "利用ポリシー",
            onbPolicyDesc: "コンテンツ制限と恒久的な行為の承認者を決めます。",
            onbPolicyNote: "すべて設定からいつでも変更できます。",
            onbFinish: "設定を完了",
            onbNext: "次へ",
            onbPrev: "戻る",
            onbTokenTitle: "サーバー接続",
            onbTokenDesc: "このサーバーはアクセストークンが必要です。",
            onbConnect: "接続",
            onbTokenFailed: "接続に失敗しました。トークンを確認してください。",
            retry: "再試行",
            statModelCalls: "モデル呼び出し {n}回",
            statToolCalls: "ツール呼び出し {n}回",
            showApiKey: "APIキーを表示",
            hideApiKey: "APIキーを隠す",
            runningState: "実行中",
            attachImage: "ファイルを添付",
            botSettings: "このボットの設定",
            nsfwLevel: "NSFWコンテンツ制限",
            nsfwStrict: "許可しない",
            nsfwModerate: "間接言及のみ",
            nsfwExplicit: "全面許可",
            approvalLevel: "恒久的な行為の承認",
            approvalUser: "常に尋ねる",
            approvalModel: "モデルが判断",
            approvalAlways: "常に許可",
            approvalDesc: "支払い、アカウント/データ削除、外部送信など元に戻せない行為を誰が承認するか決めます。",
            oauthAccount: "アカウント",
            oauthChecking: "確認中…",
            oauthLogin: "ログイン",
            oauthRelogin: "再ログイン",
            oauthLoggedIn: "ログイン済み",
            oauthNotLoggedIn: "未ログイン",
            oauthEnterCode: "ページを開いてコードを入力してください:",
            oauthPending: "認証を待っています…",
            oauthSuccess: "認証が完了しました",
            oauthFailed: "認証に失敗しました",
            notifications: "通知",
            notificationsDesc: "返信・質問・システム通知をメッセンジャーのように受け取ります。",
            notificationsDenied: "通知の許可が拒否されました",
            installApp: "アプリをインストール",
            install: "インストール",
            menu: "メニュー",
        },
    };

    let lang = "en";
    const listeners = [];

    // t('key', {n:5}) → 치환된 문자열. 누락 키는 영어 → 키 이름 순으로 폴백.
    function t(key, vars) {
        let s = (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
        if (vars) {
            for (const k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
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

    // 언어 변경. persist=false이면 localStorage에 기록하지 않음(서버 값 우선 노출).
    function setLang(l, opts) {
        const o = opts || {};
        if (!DICT[l]) l = "en";
        lang = l;
        document.documentElement.lang = l;
        if (o.persist !== false) {
            try {
                localStorage.setItem("tabybot.lang", l);
            } catch (_) {}
        }
        applyStatic();
        listeners.forEach((fn) => {
            try {
                fn(l);
            } catch (_) {}
        });
    }

    // 초기 언어 결정: 저장값 > 서버값 > 브라우저 언어
    function init(stored, server) {
        const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
        const cand = stored || server || (["ko", "ja"].indexOf(nav) > -1 ? nav : "en");
        setLang(cand, { persist: false });
        // 저장값이 없고 서버값으로 확정된 경우에도 저장하지 않는다(서버가 소유).
    }

    function onChange(fn) {
        listeners.push(fn);
    }

    T.i18n = { t, getLang, setLang, init, applyStatic, onChange, has: (l) => !!DICT[l] };
})((window.Taby = window.Taby || {}));
