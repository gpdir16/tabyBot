import fs from "node:fs";
import path from "node:path";
import { CODES_DIR, USER_DIR, resolveAgentPath } from "../paths.js";

const TEMPLATES_DIR = path.join(CODES_DIR, "skills", "visualization", "templates");
const PLACEHOLDER = "/*__VIZ_CONFIG__*/null/*__VIZ_CONFIG__*/";

const TEMPLATE_TYPES = ["quiz", "causal", "decision-tree"];

export const vizToolDefinitions = [
    {
        type: "function",
        function: {
            name: "viz_create",
            description:
                "Generate an interactive visualization HTML file from a template. Provide a template type and a JSON config object — the tool injects the config into the template engine and writes a ready-to-deploy HTML file. Returns the output path. Then deploy with `terminal_run` using `wrangler deploy --temporary`.",
            parameters: {
                type: "object",
                properties: {
                    template: {
                        type: "string",
                        enum: TEMPLATE_TYPES,
                        description:
                            "quiz: multiple-choice quiz with scoring. causal: what-if explorer with sliders/selects driving live outputs. decision-tree: branching choice flow leading to leaf results.",
                    },
                    config: {
                        type: "object",
                        description:
                            'Template-specific config. quiz: {title, description, questions:[{q, options:[], answer (0-indexed), explain}], passRatio, passText, failText}. causal: {title, description, inputs:[{id, label, type:"range"|"select", min, max, step, default, unit, options[]}], outputs:[{id, label}], evaluate:"JS function body as string, receives state object, returns {outputId:{value,tier,trace}}"}. causal select options can be strings or {v,l} objects. causal tier must be "good"|"warn"|"bad"|"neutral". decision-tree: {title, description, start, nodes:{id:{type:"question"|"leaf", text, choices:[{label,next}], detail}}}.',
                    },
                    output: {
                        type: "string",
                        description: "Output file path. Default: /tmp/viz-<timestamp>.html",
                    },
                },
                required: ["template", "config"],
            },
        },
    },
];

function validateQuizConfig(config) {
    if (!config || typeof config !== "object") return "config must be an object";
    if (!Array.isArray(config.questions) || !config.questions.length) return "questions must be a non-empty array";
    for (let i = 0; i < config.questions.length; i++) {
        const q = config.questions[i];
        if (!q.q || typeof q.q !== "string") return `questions[${i}].q must be a string`;
        if (!Array.isArray(q.options) || q.options.length < 2) return `questions[${i}].options must have >= 2 items`;
        if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= q.options.length) return `questions[${i}].answer must be a valid index`;
    }
    return null;
}

function validateCausalConfig(config) {
    if (!config || typeof config !== "object") return "config must be an object";
    if (!Array.isArray(config.inputs) || !config.inputs.length) return "inputs must be a non-empty array";
    if (!Array.isArray(config.outputs) || !config.outputs.length) return "outputs must be a non-empty array";
    if (typeof config.evaluate !== "string") return "evaluate must be a string (JS function body)";
    for (let i = 0; i < config.inputs.length; i++) {
        const inp = config.inputs[i];
        if (!inp.id || !inp.label) return `inputs[${i}] needs id and label`;
        if (inp.type === "range") {
            if (typeof inp.min !== "number" || typeof inp.max !== "number") return `inputs[${i}] range needs min and max`;
        } else if (inp.type === "select") {
            if (!Array.isArray(inp.options) || !inp.options.length) return `inputs[${i}] select needs options`;
        } else {
            return `inputs[${i}].type must be "range" or "select"`;
        }
    }
    for (let i = 0; i < config.outputs.length; i++) {
        if (!config.outputs[i].id || !config.outputs[i].label) return `outputs[${i}] needs id and label`;
    }
    return null;
}

function validateDecisionTreeConfig(config) {
    if (!config || typeof config !== "object") return "config must be an object";
    if (!config.start || typeof config.start !== "string") return "start must be a string (root node id)";
    if (!config.nodes || typeof config.nodes !== "object") return "nodes must be an object";
    if (!config.nodes[config.start]) return `start node "${config.start}" not found in nodes`;
    for (const [id, node] of Object.entries(config.nodes)) {
        if (node.type === "question") {
            if (!node.text) return `nodes.${id}.text required`;
            if (!Array.isArray(node.choices) || !node.choices.length) return `nodes.${id}.choices required`;
            for (let i = 0; i < node.choices.length; i++) {
                const c = node.choices[i];
                if (!c.label || !c.next) return `nodes.${id}.choices[${i}] needs label and next`;
                if (!config.nodes[c.next]) return `nodes.${id}.choices[${i}].next "${c.next}" not found in nodes`;
            }
        } else if (node.type === "leaf") {
            if (!node.text) return `nodes.${id}.text required`;
        } else {
            return `nodes.${id}.type must be "question" or "leaf"`;
        }
    }
    return null;
}

const VALIDATORS = {
    quiz: validateQuizConfig,
    causal: validateCausalConfig,
    "decision-tree": validateDecisionTreeConfig,
};

export async function executeVizTool(name, args) {
    if (name !== "viz_create") return { error: `Unknown viz tool: ${name}` };

    const template = args?.template;
    const config = args?.config;

    if (!TEMPLATE_TYPES.includes(template)) {
        return { error: `template must be one of: ${TEMPLATE_TYPES.join(", ")}` };
    }

    const validationError = VALIDATORS[template]?.(config);
    if (validationError) return { error: validationError };

    const templatePath = path.join(TEMPLATES_DIR, `${template}.html`);
    if (!fs.existsSync(templatePath)) return { error: `template file not found: ${templatePath}` };

    let html = fs.readFileSync(templatePath, "utf8");
    if (!html.includes(PLACEHOLDER)) return { error: "template missing CONFIG placeholder" };

    let configStr;
    if (template === "causal") {
        const { evaluate, ...rest } = config;
        configStr = JSON.stringify(rest).replace(/}$/, "");
        configStr += `, evaluate(s){${evaluate}}}`;
    } else {
        configStr = JSON.stringify(config, null, 2);
    }

    html = html.replace(PLACEHOLDER, configStr);

    const outRaw = args?.output?.trim();
    const outPath = outRaw ? resolveAgentPath(outRaw) : path.join(USER_DIR, "temp", `viz-${Date.now()}.html`);
    if (!outPath) return { error: "invalid output path" };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, "utf8");

    return { ok: true, path: outPath, template, sizeBytes: html.length };
}
