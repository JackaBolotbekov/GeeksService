import { jsonError, requireAdmin } from "@/lib/api";
import { createProjectTeam } from "@/lib/project-teams";

export async function POST(request: Request) {
  const identity = await requireAdmin(request);
  if (identity instanceof Response) return identity;
  const body = await request.json().catch(() => null) as {
    name?: string;
    studentIds?: string[];
    place?: number | null;
  } | null;
  if (!body) return jsonError("Некорректные данные проекта");

  try {
    const response = await createProjectTeam({
      name: body.name ?? "",
      studentIds: body.studentIds ?? [],
      place: body.place,
    });
    return Response.json(response, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Не удалось создать проект");
  }
}
