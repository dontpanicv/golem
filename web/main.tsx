import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { queryClient, restoreCache } from "./app/query.ts";
import { router } from "./app/router.tsx";
import { startOutbox } from "./threads/outbox.ts";

// The app opens on the copy it saved last, before any request.
await restoreCache();
startOutbox();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
