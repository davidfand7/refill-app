/**
 * OfflineBanner — shows when the app is offline or the backend is degraded.
 *
 * Subscribes to networkHealth status changes and renders a sticky banner
 * at the top of the content area. Disappears automatically when connectivity
 * is restored.
 */
import { useEffect, useState } from "react";
import { WifiOff, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getNetworkStatus,
  subscribeNetworkStatus,
  type NetworkStatus,
} from "@/lib/networkHealth";

export function OfflineBanner() {
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(getNetworkStatus);

  useEffect(() => {
    return subscribeNetworkStatus(setNetworkStatus);
  }, []);

  const isVisible = networkStatus !== "online";

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div
            className={
              networkStatus === "offline"
                ? "flex items-center gap-2.5 px-5 py-2.5 bg-clay/10 border-b border-clay/30 text-clay text-xs font-medium"
                : "flex items-center gap-2.5 px-5 py-2.5 bg-amber-soft border-b border-amber/30 text-amber text-xs font-medium"
            }
          >
            {networkStatus === "offline" ? (
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            )}
            {networkStatus === "offline"
              ? "You're offline. Changes will resume when you reconnect."
              : "Backend is unreachable. Some features may be unavailable — retrying automatically."}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
