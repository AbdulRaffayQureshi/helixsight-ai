/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        abyss: { 950: "#070B14", 900: "#0A1020", 850: "#0D1424", 800: "#121C33", 700: "#1B2740", 600: "#27375A", 500: "#3A4F7C" },
        ink: { DEFAULT: "#E6EDF7", dim: "#9AABC8", faint: "#6B7C9A" },
        electric: { DEFAULT: "#22D3EE", bright: "#67E8F9", deep: "#0891B2", glow: "#00E5FF" },
        laser: { DEFAULT: "#FF2BD6", bright: "#FF7AE8", deep: "#B0158F" },
        alert: "#F43F5E",
        ok: "#34D399",
        warn: "#FBBF24",
        base: { a: "#4ADE80", c: "#60A5FA", g: "#FBBF24", t: "#F87171" },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "Cascadia Mono", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(34, 211, 238, 0.45)",
        "glow-laser": "0 0 24px -4px rgba(255, 43, 214, 0.5)",
        panel: "0 8px 32px -8px rgba(0, 0, 0, 0.7)",
      },
      keyframes: {
        scan: { "0%": { backgroundPosition: "0 0" }, "100%": { backgroundPosition: "32px 0" } },
        rise: { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
      animation: { scan: "scan 1s linear infinite", rise: "rise 160ms ease-out" },
    },
  },
  plugins: [],
};
