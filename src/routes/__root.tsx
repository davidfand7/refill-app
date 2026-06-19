import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";
import { DemoNav } from "@/components/DemoNav";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "SmartSpa — the patient-profitability OS" },
      {
        name: "description",
        content:
          "SmartSpa fills chairs, recovers no-shows, and turns manufacturer rewards into booked visits — and only bills when it creates real revenue for you.",
      },
      { property: "og:title", content: "SmartSpa — the patient-profitability OS for med-spas." },
      { property: "og:description", content: "Free to run. $5 only when SmartSpa creates a booking." },
      { property: "og:site_name", content: "SmartSpa" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://smartspa.app/brand/refill-og.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "SmartSpa — the patient-profitability OS for med-spas" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "SmartSpa — the patient-profitability OS." },
      { name: "twitter:description", content: "Free to run. $5 only when SmartSpa creates a booking." },
      { name: "twitter:image", content: "https://smartspa.app/brand/refill-og.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/brand/refill-favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/brand/refill-favicon.svg" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <AuthProvider>
          <Outlet />
        </AuthProvider>
        {/* v1.46.6: guided demo walkthrough arrow. Self-gates to the public
            marketing sequence (see WALKTHROUGH in DemoNav) — null everywhere
            else, so it never shows on /app, /login, etc. */}
        <DemoNav />
        {/* v1.46.4: sonner Toaster mounted at root. Every page in the app
            calls toast.success/error throughout (Zoho connect, outreach
            send, template import, light-mode, etc.) but no Toaster was
            ever mounted — zero toasts have rendered app-wide since the
            cleave. Light-theme to match Refill's design language. */}
        <Toaster
          richColors
          position="bottom-right"
          theme="light"
          closeButton
        />
        <Scripts />
      </body>
    </html>
  );
}
