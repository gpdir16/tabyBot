// Anti-bot fingerprint patches injected on every new document (CDP).
// Loaded via Page.addScriptToEvaluateOnNewDocument on each CDP session,
// so it survives navigation, SPA route changes, and iframe loads.
(() => {
    const STEALTH_UA = __TABYAGENT_USER_AGENT_JSON__;

    const define = (obj, key, value) => {
        try {
            Object.defineProperty(obj, key, { get: () => value, configurable: true });
        } catch (_) {}
    };

    // navigator.userAgent is a getter on Navigator.prototype, so defining on
    // the navigator instance is silently ignored — patch the prototype.
    try {
        Object.defineProperty(Navigator.prototype, "userAgent", { get: () => STEALTH_UA, configurable: true });
        Object.defineProperty(Navigator.prototype, "appVersion", { get: () => STEALTH_UA.replace("Mozilla/", ""), configurable: true });
        Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64", configurable: true });
    } catch (_) {}

    // Headless Chrome often lacks window.chrome
    if (!window.chrome) {
        window.chrome = {
            runtime: {
                onConnect: undefined,
                onMessage: undefined,
                connect: () => ({}),
                sendMessage: () => {},
            },
            loadTimes: () => ({}),
            csi: () => ({}),
            app: { isInstalled: false },
        };
    }

    // Empty plugin list is a common headless tell
    if (navigator.plugins.length === 0) {
        const makePlugin = (name, filename, description) => {
            const plugin = { name, filename, description, length: 1 };
            plugin[0] = { type: "application/pdf", suffixes: "pdf", description };
            return plugin;
        };
        const fakePlugins = [
            makePlugin("Chrome PDF Plugin", "internal-pdf-viewer", "Portable Document Format"),
            makePlugin("Chrome PDF Viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", ""),
            makePlugin("Native Client", "internal-nacl-plugin", ""),
        ];
        define(navigator, "plugins", fakePlugins);
        define(navigator, "mimeTypes", [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }]);
    }

    if (!navigator.languages || navigator.languages.length === 0) {
        define(navigator, "languages", ["en-US", "en"]);
    }

    // WebGL vendor/renderer strings used by bot detectors
    const patchWebGL = (Proto) => {
        if (!Proto || !Proto.prototype) return;
        const original = Proto.prototype.getParameter;
        Proto.prototype.getParameter = function (param) {
            // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
            if (param === 37445) return "Intel Inc.";
            if (param === 37446) return "Intel(R) Iris(R) Xe Graphics";
            return original.apply(this, arguments);
        };
    };
    patchWebGL(WebGLRenderingContext);
    patchWebGL(WebGL2RenderingContext);

    // permissions.query notification quirk in headless
    if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (parameters) =>
            parameters && parameters.name === "notifications"
                ? Promise.resolve({ state: Notification.permission, onchange: null })
                : originalQuery(parameters);
    }

    // webdriver flag — headless Chrome sets navigator.webdriver = true
    try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined, configurable: true });
    } catch (_) {}

    // Chrome devtools protocol leaves a tell: Notification is undefined in some
    // headless builds. Restore it so detectors comparing window.Notification see
    // a normal browser surface.
    if (typeof Notification === "undefined") {
        try {
            window.Notification = { permission: "default", requestPermission: () => Promise.resolve("default") };
        } catch (_) {}
    }

    // Headless Chrome often reports a small default screen; detectors flag
    // screens with width 0 or innerWidth === outerWidth as automated.
    if (screen.width === 0 || screen.height === 0) {
        define(screen, "width", 1280);
        define(screen, "height", 720);
        define(screen, "availWidth", 1280);
        define(screen, "availHeight", 680);
    }
})();
