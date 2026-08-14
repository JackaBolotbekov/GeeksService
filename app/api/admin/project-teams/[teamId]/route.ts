import { jsonError, requireAdmin } from "@/lib/api";
import { deleteProjectTeam, updateProjectTeam } from "@/lib/project-teams";

export async function PATCH(request: Request, context: { params: Promise<{ teamId: string }> }) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const { teamId } = await context.params;
  const body = await request.json().catch(() => null) as {
    name?: string;
    studentIds?: string[];
    place?: number | null;
  } | null;
  if (!body) return jsonError("Некорректные данные проекта");

  try {
    return Response.json(await updateProjectTeam(teamId, body));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось обновить проект");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ teamId: string }> }) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const { teamId } = await context.params;

  try {
    return Response.json(await deleteProjectTeam(teamId));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось расформировать проект");
  }
}
