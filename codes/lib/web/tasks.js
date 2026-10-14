// 진행 중인 시스템 작업(세션 압축, 기억 정리, 세션 리뷰, 업데이트 확인) 목록.
// 대화와 무관하게 뒤에서 도는 일이라 화면에 드러나지 않으므로, 설정의 알림 탭이 진행 표시줄로 보여 준다.
// 메모리에만 둔다. 서버가 다시 뜨면 돌던 작업도 사라지기 때문.
import crypto from "node:crypto";
import { emit } from "./bus.js";

const tasks = new Map();

function changed() {
    // 알림 탭이 알림 기록과 같은 조회로 받아 가므로 같은 이벤트로 알린다.
    emit({ type: "notices_changed" });
}

// 시작한 순서대로.
export function listTasks() {
    return [...tasks.values()];
}

// 작업 하나를 등록한다. total을 알면 진행률을, 모르면 진행 중이라는 것만 보여 준다.
// name은 어느 에이전트의 일인지처럼 종류만으로 구분이 안 될 때 붙인다.
function startTask(kind, { total = 0, name = "" } = {}) {
    const task = { id: crypto.randomBytes(6).toString("hex"), kind, name, startedAt: new Date().toISOString(), done: 0, total };
    tasks.set(task.id, task);
    changed();
    return {
        progress(done, nextTotal = task.total) {
            if (!tasks.has(task.id) || (task.done === done && task.total === nextTotal)) return;
            task.done = done;
            task.total = nextTotal;
            changed();
        },
        end() {
            if (tasks.delete(task.id)) changed();
        },
    };
}

// fn이 도는 동안 작업을 목록에 올려 둔다. fn은 진행률을 알릴 progress(done, total)를 받는다.
export async function trackTask(kind, fn, opts) {
    const task = startTask(kind, opts);
    try {
        return await fn(task.progress);
    } finally {
        task.end();
    }
}
