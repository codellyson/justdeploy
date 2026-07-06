import { BUILT_IN_THEMES, DEFAULT_THEME_ID, VAR_MAP, } from "./theme-plugins.js";
const THEMES = Object.fromEntries(BUILT_IN_THEMES.map((t) => [t.id, t]));
function applyVariant(variant, mode) {
    const root = document.documentElement;
    Object.keys(VAR_MAP).forEach((key) => {
        const value = variant[key];
        if (value)
            root.style.setProperty(VAR_MAP[key], value);
    });
    if (mode === "dark")
        root.classList.add("dark");
    else
        root.classList.remove("dark");
}
/**
 * Reads saved theme + mode from localStorage and applies CSS custom
 * properties to `<html>` before first paint. Installs a `storage`
 * listener so cross-tab updates re-apply automatically.
 */
export function bootTheme(options = {}) {
    const keyPrefix = options.keyPrefix ?? "justui";
    const defaultThemeId = options.defaultThemeId ?? DEFAULT_THEME_ID;
    const idKey = `${keyPrefix}.theme.id`;
    const modeKey = `${keyPrefix}.theme.mode`;
    if (typeof window !== "undefined") {
        window.__JUSTUI__ = { themes: THEMES, keyPrefix, idKey, modeKey };
    }
    const pickMode = () => {
        try {
            const stored = localStorage.getItem(modeKey);
            if (stored === "light" || stored === "dark")
                return stored;
        }
        catch {
            /* localStorage blocked */
        }
        return typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    };
    const pickThemeId = () => {
        try {
            return localStorage.getItem(idKey) ?? defaultThemeId;
        }
        catch {
            return defaultThemeId;
        }
    };
    const themeId = pickThemeId();
    const mode = pickMode();
    try {
        const theme = THEMES[themeId] ?? THEMES[defaultThemeId];
        if (theme) {
            applyVariant(mode === "dark" ? theme.dark : theme.light, mode);
            document.documentElement.dataset.themeId = themeId;
            document.documentElement.dataset.themeMode = mode;
        }
    }
    catch {
        /* falls back to whatever tokens.css declared */
    }
    if (typeof window !== "undefined") {
        window.addEventListener("storage", (e) => {
            if (e.key !== idKey && e.key !== modeKey)
                return;
            const newThemeId = pickThemeId();
            const newMode = pickMode();
            const theme = THEMES[newThemeId] ?? THEMES[defaultThemeId];
            if (!theme)
                return;
            applyVariant(newMode === "dark" ? theme.dark : theme.light, newMode);
            document.documentElement.dataset.themeId = newThemeId;
            document.documentElement.dataset.themeMode = newMode;
        });
    }
    return { themeId, mode };
}
//# sourceMappingURL=theme-boot.js.map