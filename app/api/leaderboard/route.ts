import { listStudents } from "@/lib/store";

export async function GET() {
  return Response.json({ students: await listStudents() });
}
