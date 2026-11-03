import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/mh/bits";
import { Onboarding } from "@/components/mh/Onboarding";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "Setup — Moodle Helper" },
      { name: "description", content: "Resumable first-run setup: extension, courses, sync, calendar, notifications, local storage and optional AI." },
      { property: "og:title", content: "Setup — Moodle Helper" },
      { property: "og:description", content: "Set up Moodle Helper on this device without an account." },
    ],
  }),
  component: SetupPage,
});

function SetupPage() {
  return <><PageHeader title="Setup" /><Onboarding /></>;
}
