import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Refill — refill your schedule, recover your revenue." },
      {
        name: "description",
        content:
          "Refill catches the cancellations your front desk doesn't have time to chase, fills them automatically, and only bills when we recover real money for you.",
      },
      { property: "og:title", content: "Refill — no-show recovery that pays for itself." },
      { property: "og:description", content: "Free for 30 days. 12% of what we recover — that's it." },
      { property: "og:site_name", content: "Refill" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://getrefill.app/brand/refill-og.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Refill — no-show recovery for med-spas" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Refill — no-show recovery that pays for itself." },
      { name: "twitter:description", content: "Free for 30 days. 12% of what we recover — that's it." },
      { name: "twitter:image", content: "https://getrefill.app/brand/refill-og.png" },
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
        <Scripts />
      </body>
    </html>
  );
}
