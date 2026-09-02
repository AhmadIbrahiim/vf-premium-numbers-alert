import "./globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import ThemeToggle from "../components/theme-toggle.jsx";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: "Egypt Premium Numbers",
  description:
    "Every premium mobile number listed by Vodafone, Etisalat and WE Egypt, scored by digit pattern and refreshed continuously.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <head>
        {/*
          Set the theme before first paint, or a dark-mode visitor sees a white flash.
          Inline because it has to run ahead of hydration.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");
              var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
              document.documentElement.classList.toggle("dark",d);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-screen font-sans text-zinc-900 antialiased dark:text-zinc-100">
        <div className="mx-auto max-w-6xl px-4 pb-20 pt-7 sm:px-6">
          <header className="mb-6 flex flex-wrap items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5 no-underline">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-vf-red text-sm font-extrabold text-white">
                EG
              </span>
              <span className="text-[15px] font-bold tracking-tight">Premium Numbers</span>
            </Link>
            <nav className="ml-auto flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white p-1 dark:border-white/5 dark:bg-ink-850">
              <Link
                href="/"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                Numbers
              </Link>
              <Link
                href="/status"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                Provider status
              </Link>
            </nav>
            <ThemeToggle />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
