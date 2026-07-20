import { GeeksServiceApp } from "./GeeksServiceApp";
import { listStudents } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const initialStudents = await listStudents().catch(() => []);
  return <GeeksServiceApp initialStudents={initialStudents} />;
}
