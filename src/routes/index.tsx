import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HelloRefill,
});

function HelloRefill() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-5 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald text-paper">
            <span className="font-serif text-[20px] font-semibold leading-none">
              R
            </span>
          </div>
          <span className="font-serif text-[15px] font-semibold tracking-tight text-emerald">
            Refill
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 sm:px-8 py-8">
        <div className="max-w-xl text-center">
          <h1 className="font-serif text-[36px] sm:text-[44px] leading-[1.1] font-semibold tracking-tight mb-4">
            Hello, Refill.
          </h1>
          <p className="text-[16px] leading-[1.6] text-ink-soft mb-3">
            Standalone, finally. New repo. New Supabase. New worker. No bridges.
          </p>
          <p className="text-[13px] text-ink-faint font-mono">
            Phase 1, Step 1.2 — scaffold complete.
          </p>
        </div>
      </main>

      <footer className="px-5 sm:px-8 py-8">
        <div className="max-w-5xl mx-auto text-center text-[12px] text-ink-faint">
          Built for med-spas.
        </div>
      </footer>
    </div>
  );
}
