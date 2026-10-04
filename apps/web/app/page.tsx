import { redirect } from "next/navigation";

/** The (app) layout guard sends signed-out visitors on to /login or /setup. */
export default function Home() {
  redirect("/chat");
}
