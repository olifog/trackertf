import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * No landing page: usage IS the product, so `/` sends you straight there.
 * (The old hero card's only unique feature — a link to your own player page
 * when signed in — lives in the nav via getSessionUser.)
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/usage" });
  },
});
