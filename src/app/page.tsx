"use client";

import Link from "next/link";
import Image from "next/image";

export default function Home() {
  return (
    <main className="min-h-[100svh] bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-zinc-100">
      {/* Container */}
      <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-24 text-center sm:py-32">
        {/* Logo circle */}
        <div className="mb-8 grid h-14 w-14 place-items-center rounded-full border border-zinc-800 bg-zinc-900/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
          <span className="text-lg font-semibold tracking-tight">HP</span>
        </div>
        {/* Headline */}
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Something delightful is on the way
        </h1>
        {/* Copy */}
        <p className="mt-3 text-pretty text-zinc-400">
          We're crafting the experience. In the meantime, leave your email and
          we'll let you know when we launch.
        </p>
        {/* Notify form (no backend yet) */}
        <form
          className="mt-8 flex w-full items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const data = new FormData(form);
            const email = String(data.get("email") || "");
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              alert("Please enter a valid email.");
              return;
            }
            alert("Thanks! We'll be in touch at " + email + ".");
            form.reset();
          }}
        >
          <input
            type="email"
            name="email"
            required
            placeholder="you@example.com"
            className="h-11 w-full flex-1 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 text-sm outline-none ring-0 transition focus:border-zinc-700 focus:ring-2 focus:ring-zinc-700/40"
          />
          <button
            type="submit"
            className="h-11 shrink-0 rounded-md bg-zinc-100 px-4 text-sm font-medium text-zinc-900 transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            Notify me
          </button>
        </form>
        {/* Meta */}
        <div className="mt-10 flex items-center gap-3 text-sm text-zinc-500">
          <span>© {new Date().getFullYear()} Holding Page</span>
          <span>•</span>
          <Link href="#" className="underline decoration-zinc-700 underline-offset-4 hover:text-zinc-300">
            Contact
          </Link>
        </div>
      </div>
      {/* Subtle radial spotlight */}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(600px_circle_at_50%_-10%,rgba(244,244,245,0.08),transparent_60%)]" />
    </main>
  );
}
