import { listProjectTeams } from "@/lib/project-teams";

export async function GET() {
  return Response.json(await listProjectTeams());
}
