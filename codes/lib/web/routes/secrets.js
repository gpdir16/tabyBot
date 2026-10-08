// 시크릿 금고 관리 API. 값은 쓰기만 가능하고 어떤 응답에도 내려가지 않는다. 시크릿은 id(UUID)로 가리킨다.
import { SecretError, createSecret, deleteSecret, listSecrets, updateSecret } from "../../secrets/store.js";

const secretsPayload = () => ({ secrets: listSecrets() });

// SecretError는 코드로 400/404를 돌려주고, 그 밖의 오류는 위로 올린다.
function respondOnSecretError(ctx, fn) {
    try {
        fn();
    } catch (err) {
        if (!(err instanceof SecretError)) throw err;
        return err.code === "not_found" ? ctx.json404() : ctx.json400(err.code);
    }
    ctx.json200(secretsPayload());
}

// 비어 있는 값은 "바꾸지 않음"이다.
const optionalText = (v) => (typeof v === "string" && v !== "" ? v : undefined);

export function registerSecretsRoutes(router) {
    router.add("GET", "/api/secrets", (ctx) => {
        ctx.json200(secretsPayload());
    });

    router.add("POST", "/api/secrets", async (ctx) => {
        const body = await ctx.json();
        respondOnSecretError(ctx, () => createSecret({ name: body?.name, value: body?.value }));
    });

    router.add("PUT", "/api/secrets/:id", async (ctx) => {
        const body = await ctx.json();
        respondOnSecretError(ctx, () => updateSecret(ctx.params.id, { name: optionalText(body?.name), value: optionalText(body?.value) }));
    });

    router.add("DELETE", "/api/secrets/:id", (ctx) => {
        if (!deleteSecret(ctx.params.id)) return ctx.json404();
        ctx.json200(secretsPayload());
    });
}
