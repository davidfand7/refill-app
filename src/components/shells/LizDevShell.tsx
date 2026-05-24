// Cleave stub — legacy Agentiport Lizzie-dev shell. Reachable only via
// dead branches in app.tsx (useShell() always returns 'refill' or 'liz'
// for rep platform). Step 3.12 deletes these branches; until then we
// stub-render null so app.tsx compiles.
export function LizDevShell({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
