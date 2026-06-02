/** Tailwind config for the static dashboard. Build: see README "Dashboard CSS". */
export default {
  content: ["./web/index.html", "./web/app.js"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        vf: { red: "#e60000", redsoft: "#ff4d4d" },
        ink: { 950: "#08080a", 900: "#0c0c0f", 850: "#111114", 800: "#16161b", 700: "#1f1f26" },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        fadeUp: { "0%": { opacity: 0, transform: "translateY(8px)" }, "100%": { opacity: 1, transform: "translateY(0)" } },
        pulse2: { "0%,100%": { opacity: 1, transform: "scale(1)" }, "50%": { opacity: 0.35, transform: "scale(0.7)" } },
      },
      animation: {
        fadeUp: "fadeUp .45s cubic-bezier(.21,.6,.35,1) both",
        pulse2: "pulse2 1.8s ease-in-out infinite",
      },
    },
  },
};
