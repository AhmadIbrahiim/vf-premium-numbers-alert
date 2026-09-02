/** Tailwind config for the dashboard. Built by Next at compile time. */
export default {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        vf: { red: "#e60000", redsoft: "#ff4d4d" },
        ink: { 950: "#08080a", 900: "#0c0c0f", 850: "#111114", 800: "#16161b", 700: "#1f1f26" },
        carrier: { vodafone: "#e60000", etisalat: "#10b981", we: "#8b5cf6" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        fadeUp: { "0%": { opacity: 0, transform: "translateY(8px)" }, "100%": { opacity: 1, transform: "translateY(0)" } },
      },
      animation: { fadeUp: "fadeUp .45s cubic-bezier(.21,.6,.35,1) both" },
    },
  },
};
