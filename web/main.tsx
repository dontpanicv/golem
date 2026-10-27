import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { confirmPerson, queryClient, restoreCache } from "./app/query.ts";
import { router } from "./app/router.tsx";
import { startOutbox } from "./threads/outbox.ts";

// The app opens on the copy it saved last, before any request, unless a sign-in may have brought another person.
await restoreCache();
await confirmPerson();
// Another tab forgot the copy for another person: this tab must not keep it, or save it again.
window.addEventListener("storage", (event) => {
  if (event.key === null) {
    location.reload();
  }
});
startOutbox();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
