// 설정한 시간대를 서버 프로세스의 시간대(TZ)로 쓴다. 도커는 기본이 UTC라 이것 없이는 메시지 시각, 할 일 기본 시간대,
// 터미널 명령이 모두 UTC로 돈다. 자식 프로세스(터미널, 브라우저)도 이 TZ를 물려받는다.
// index.js가 맨 먼저 불러, 불러올 때 시간대를 읽는 모듈도 설정값을 보게 한다.
import { loadUserConfig } from "./config-loader.js";
import { isValidTimeZone } from "./scheduling/time.js";

const SYSTEM_TZ = process.env.TZ; // 설정을 비우면 돌아갈 원래 값

export function applyConfiguredTimeZone(tz = loadUserConfig().timezone) {
    const next = tz && isValidTimeZone(tz) ? tz : SYSTEM_TZ;
    if (next) process.env.TZ = next;
    else delete process.env.TZ;
}

applyConfiguredTimeZone();
