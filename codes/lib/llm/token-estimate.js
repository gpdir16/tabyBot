// 토큰 수 추정. 실제 토크나이저(tiktoken o200k)는 인코더를 만드는 순간 메모리를 100MB 가까이 먹고
// 긴 대화를 매 턴 다시 세느라 느리다. 압축 시점과 파일 읽기 상한만 정하면 되므로 글자 종류별 가중치로 어림한다.
// 실제 대화 기록(조각 1만 개)을 o200k로 센 값과 비교해 전체 102%, 도구 결과 98%, 요약 90%로 맞췄다.
// 적게 세면 압축이 늦어 컨텍스트가 넘치므로 모자라기보다 조금 넘치게 잡는다.
const WORD_CHAR = 0.24; // 영문자와 숫자: 4~5글자가 토큰 하나
const SPACE_CHAR = 0.12; // 공백과 줄바꿈은 앞뒤 단어와 합쳐지는 일이 많다
const PUNCT_CHAR = 0.7; // 기호는 따로 토큰이 되는 일이 많다
const WIDE_CHAR = 0.8; // 한글, 한자, 가나 등 ASCII 밖 글자
const ASTRAL_CHAR = 1; // 이모지 등 서로게이트 쌍(두 코드 유닛)

export function estimateTextTokens(text) {
    if (!text) return 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 128) {
            if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n += WORD_CHAR;
            else if (c === 32 || c === 10 || c === 9 || c === 13) n += SPACE_CHAR;
            else n += PUNCT_CHAR;
        } else if (c >= 0xd800 && c <= 0xdbff) {
            n += ASTRAL_CHAR;
            i++;
        } else {
            n += WIDE_CHAR;
        }
    }
    return Math.ceil(n);
}

// 모델마다 토크나이저가 달라 같은 글도 토큰 수가 다르다. 실제 호출에서 API가 센 입력 토큰 수와 어림값의 비율을
// 모델별로 기억해 이후 어림값에 곱한다. 짧은 요청은 도구 정의나 SDK가 붙이는 고정 분량이 비율을 키우므로 배우지 않는다.
const MIN_LEARN_TOKENS = 20_000;
const tokenScales = new Map();

export function learnTokenScale(model, estimated, actual) {
    if (!model || !(estimated >= MIN_LEARN_TOKENS) || !(actual > 0)) return;
    const ratio = Math.min(3, Math.max(0.5, actual / estimated));
    const prev = tokenScales.get(model);
    // 한 번 튄 값에 휘둘리지 않게 이전 값과 섞는다.
    tokenScales.set(model, prev ? prev * 0.7 + ratio * 0.3 : ratio);
}

export function tokenScale(model) {
    return tokenScales.get(model) ?? 1;
}
