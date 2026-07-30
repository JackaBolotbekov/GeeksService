import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScriptModule(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const selfContainedSource = source
    .replace(
      /^import \{ LESSON_COUNT,.*\} from "\.\/types";\r?\n/,
      "const LESSON_COUNT = 12;\n",
    )
    .replace(
      /^import \{ nextYouTubeUploadOffset \} from "\.\/youtube-resumable";\r?\n/,
      "const nextYouTubeUploadOffset = (range, fallback = 0) => { const match = range?.match(/bytes=\\d+-(\\d+)/i); return match ? Number(match[1]) + 1 : fallback; };\n",
    );
  const compiled = ts.transpileModule(selfContainedSource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("restores a legacy future transfer before its original start time", async () => {
  const {
    DEFAULT_LESSON_SCHEDULE,
    buildScheduleResponse,
    restoreLessonTransferSchedule,
  } = await importTypeScriptModule("../lib/schedule.ts");
  const current = DEFAULT_LESSON_SCHEDULE.map((lesson) => ({ ...lesson }));
  [
    "2026-07-27T16:00:00+06:00",
    "2026-07-29T16:00:00+06:00",
    "2026-07-31T16:00:00+06:00",
    "2026-08-03T16:00:00+06:00",
    "2026-08-05T16:00:00+06:00",
  ].forEach((scheduledAt, index) => {
    current[index + 7].scheduledAt = scheduledAt;
  });

  const restored = restoreLessonTransferSchedule(
    current,
    8,
    "2026-07-24T16:00:00+06:00",
  );
  assert.deepEqual(
    restored.slice(7).map((lesson) => lesson.scheduledAt),
    [
      "2026-07-24T16:00:00+06:00",
      "2026-07-27T16:00:00+06:00",
      "2026-07-29T16:00:00+06:00",
      "2026-07-31T16:00:00+06:00",
      "2026-08-03T16:00:00+06:00",
    ],
  );

  const transfer = {
    id: "transfer-8",
    lessonNumber: 8,
    originalScheduledAt: "2026-07-24T16:00:00+06:00",
    rescheduledAt: "2026-07-27T16:00:00+06:00",
    createdAt: "2026-07-23T05:48:24.298Z",
  };
  assert.equal(
    buildScheduleResponse(current, new Date("2026-07-24T09:59:59Z"), [transfer])
      .cancellableTransferId,
    transfer.id,
  );
  assert.equal(
    buildScheduleResponse(current, new Date("2026-07-24T10:00:00Z"), [transfer])
      .cancellableTransferId,
    null,
  );
});

test("teacher material validation preserves names and rejects unsafe files", async () => {
  const {
    expectedMaterialUploadPartSize,
    MATERIAL_UPLOAD_PART_SIZE,
    MAX_MATERIAL_FILE_SIZE,
    materialUploadPartCount,
    validateTeacherMaterialFile,
  } = await importTypeScriptModule("../lib/material-validation.ts");

  assert.equal(
    validateTeacherMaterialFile({ name: "  Урок 7 — презентация.pptx  ", size: 1024 }),
    "Урок 7 — презентация.pptx",
  );
  assert.equal(
    validateTeacherMaterialFile({ name: "Материалы.PDF", size: MAX_MATERIAL_FILE_SIZE }),
    "Материалы.PDF",
  );
  assert.throws(
    () => validateTeacherMaterialFile({ name: "installer.exe", size: 1024 }),
    /Поддерживаются PPTX/,
  );
  assert.throws(
    () => validateTeacherMaterialFile({ name: "large.zip", size: MAX_MATERIAL_FILE_SIZE + 1 }),
    /до 50 MB/,
  );
  assert.equal(MATERIAL_UPLOAD_PART_SIZE, 8 * 1024 * 1024);
  assert.equal(materialUploadPartCount(16_055_812), 2);
  assert.equal(expectedMaterialUploadPartSize(16_055_812, 1), MATERIAL_UPLOAD_PART_SIZE);
  assert.equal(
    expectedMaterialUploadPartSize(16_055_812, 2),
    16_055_812 - MATERIAL_UPLOAD_PART_SIZE,
  );
  assert.equal(expectedMaterialUploadPartSize(16_055_812, 3), 0);
});

test("YouTube resumable helpers recover exact offsets and retry transient failures", async () => {
  const {
    initialYouTubeUploadChunkSize,
    isRetriableYouTubeUploadStatus,
    nextYouTubeUploadOffset,
    YOUTUBE_UPLOAD_MAX_CHUNK_SIZE,
    YOUTUBE_UPLOAD_MIN_CHUNK_SIZE,
  } = await importTypeScriptModule("../lib/youtube-resumable.ts");

  assert.equal(nextYouTubeUploadOffset("bytes=0-16777215", 0), 16777216);
  assert.equal(nextYouTubeUploadOffset(null, 42), 42);
  assert.equal(isRetriableYouTubeUploadStatus(0), true);
  assert.equal(isRetriableYouTubeUploadStatus(429), true);
  assert.equal(isRetriableYouTubeUploadStatus(503), true);
  assert.equal(isRetriableYouTubeUploadStatus(400), false);
  assert.equal(isRetriableYouTubeUploadStatus(401), false);
  assert.equal(initialYouTubeUploadChunkSize(1, "4g"), 8 * 1024 * 1024);
  assert.equal(initialYouTubeUploadChunkSize(30, "4g"), 64 * 1024 * 1024);
  assert.equal(initialYouTubeUploadChunkSize(100, "4g"), YOUTUBE_UPLOAD_MAX_CHUNK_SIZE);
  assert.equal(initialYouTubeUploadChunkSize(undefined, "3g"), 16 * 1024 * 1024);
  assert.equal(YOUTUBE_UPLOAD_MIN_CHUNK_SIZE, 8 * 1024 * 1024);
});

test("YouTube recovery identifies the exact tagged upload and handles closed sessions", async () => {
  const originalFetch = globalThis.fetch;
  const jobId = "job-123";
  const taggedVideoId = "TaggedVid01";
  const olderVideoId = "OlderVideo1";
  const requests = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("https://www.googleapis.com/upload/")) {
        return new Response(null, { status: 410 });
      }
      if (url.includes("/channels?")) {
        return Response.json({
          items: [{ contentDetails: { relatedPlaylists: { uploads: "uploads-playlist" } } }],
        });
      }
      if (url.includes("/playlistItems?")) {
        return Response.json({
          items: [
            {
              snippet: {
                title: "VibeCoding 1 | Урок 7 Месяц 1",
                publishedAt: "2026-07-24T10:03:00.000Z",
                resourceId: { videoId: taggedVideoId },
              },
              contentDetails: { videoId: taggedVideoId },
            },
            {
              snippet: {
                title: "VibeCoding 1 | Урок 7 Месяц 1",
                publishedAt: "2026-07-24T10:01:00.000Z",
                resourceId: { videoId: olderVideoId },
              },
              contentDetails: { videoId: olderVideoId },
            },
          ],
        });
      }
      if (url.includes("/videos?")) {
        return Response.json({
          items: [
            {
              id: olderVideoId,
              snippet: {
                title: "VibeCoding 1 | Урок 7 Месяц 1",
                tags: ["some-other-upload"],
              },
              status: { uploadStatus: "processed" },
            },
            {
              id: taggedVideoId,
              snippet: {
                title: "VibeCoding 1 | Урок 7 Месяц 1",
                tags: [`geeks-upload-${jobId}`],
              },
              status: { uploadStatus: "uploaded" },
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };

    const {
      findRecentlyUploadedVideo,
      queryYouTubeUploadSession,
      youtubeUploadJobTag,
    } = await importTypeScriptModule("../lib/youtube-upload-recovery.ts");
    assert.equal(youtubeUploadJobTag(jobId), `geeks-upload-${jobId}`);
    const recovered = await findRecentlyUploadedVideo({
      accessToken: "token",
      title: "VibeCoding 1 | Урок 7 Месяц 1",
      createdAt: "2026-07-24T10:00:00.000Z",
      jobId,
    });
    assert.equal(recovered?.videoId, taggedVideoId);
    assert.match(requests.find((url) => url.includes("/videos?")) ?? "", /processingDetails/);
    await assert.rejects(
      queryYouTubeUploadSession({
        uploadUrl: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x",
        accessToken: "token",
        fileSize: 1024,
      }),
      (error) => error?.name === "YouTubeUploadSessionUnavailableError" && error?.status === 410,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ships Geeks Service page instead of the starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /GeeksServiceApp/);
  assert.match(layout, /Geeks Service/);
  assert.match(layout, /telegram\.org\/js\/telegram-web-app\.js/);
  assert.match(layout, /maximumScale:\s*1/);
  assert.match(layout, /userScalable:\s*false/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("leaderboard cards show score instead of generic TOP badges", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/GeeksServiceApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /student\.totalScore/);
  assert.match(app, /lastScoredAt/);
  assert.match(app, /compareScoreTime\(left\.lastScoredAt,\s*right\.lastScoredAt\)/);
  assert.match(app, /setLeaderboardFast/);
  assert.match(app, /LEADERBOARD_LIVE_INTERVAL_MS/);
  assert.match(app, /leaderboardSignature/);
  assert.match(app, /isSameLeaderboard/);
  assert.match(app, /refreshLiveLeaderboard/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /LEADERBOARD_CACHE_KEY/);
  assert.match(app, /readCachedLeaderboard/);
  assert.match(app, /writeCachedLeaderboard/);
  assert.match(app, /new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(app, /key=\{bulkEditMode \? "bulk-edit" : "score-view"\}/);
  assert.doesNotMatch(app, /pointsBehindLeader === 0 \? "TOP"/);
  assert.doesNotMatch(app, /<h1>/);
  assert.doesNotMatch(app, /heroStats/);
  assert.match(app, /ScheduleBadge/);
  assert.match(app, /const TEST_ROLE_ORDER: TestRole\[\] = \["service", "students", "teachers"\]/);
  assert.match(app, /service: "SERVICE"/);
  assert.match(app, /students: "STUDENTS"/);
  assert.match(app, /teachers: "TEACHERS"/);
  assert.match(app, /setRolePreviewAvailable\(true\)/);
  assert.match(app, /className="brandRoleSwitcher"/);
  assert.match(app, /if \(!rolePreviewAvailable\) return/);
  assert.match(app, /if \(teacherPreview\) \{/);
  assert.match(app, /previewRole === "students"/);
  assert.match(css, /\.brandRoleSwitcher\s*{[^}]*background:\s*transparent/s);
  assert.match(css, /@keyframes roleLabelSwap/);
  assert.match(app, /schedule\.currentLabel/);
  assert.match(app, /VibeCoding 1/);
  assert.match(app, /GEEKS<span key=\{testRole\}>/);
  assert.doesNotMatch(app, /GEEKS <span key=\{testRole\}>/);
  assert.match(css, /\.topbar\.previewTeacher \.topActions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap/s);
  assert.match(app, /5600/);
  assert.match(app, /activeScreen === "profile"/);
  assert.match(app, /ProfileScreen/);
  assert.match(app, /CalendarMonth/);
  assert.doesNotMatch(app, /ScheduleEditor/);
  assert.doesNotMatch(app, /calendarEditButton/);
  assert.match(app, /\/api\/schedule/);
  assert.match(app, /\/api\/admin\/schedule/);
  assert.match(app, /\/api\/admin\/schedule\/transfer/);
  assert.match(app, /transferLessonSchedule/);
  assert.match(app, /expectedScheduledAt/);
  assert.match(app, /targetScheduledAt/);
  assert.match(app, /method:\s*"DELETE"/);
  assert.match(app, /cancelSelectedTransfer/);
  assert.match(app, /defaultTransferTarget/);
  assert.match(app, /type="datetime-local"/);
  assert.match(app, /calendarTransferDialog/);
  assert.match(app, /schedule\.transfers/);
  assert.doesNotMatch(app, /new Set\(\["2026-07-17"\]\)/);
  assert.match(app, /datetimeLocalToBishkekIso/);
  assert.doesNotMatch(app, /RotatingGroupBadge/);
  assert.doesNotMatch(app, /GROUP_BADGES/);
  assert.doesNotMatch(app, /3200/);
  assert.match(app, /Длительность обучения: 1 мес\. 12 занятий/);
  assert.doesNotMatch(app, />ONLINE</);
  assert.doesNotMatch(app, /className="status"/);
  assert.doesNotMatch(app, /домашек ·/);
  assert.doesNotMatch(app, /\/12 домашек/);
  assert.match(app, /из 12 ДЗ/);
  assert.match(app, /12 из 12 ✅/);
  assert.match(app, /geeks-lightning\.svg/);
  assert.match(app, /lessonEditor/);
  assert.match(app, /lessonTabs/);
  assert.match(app, /lessonTab/);
  assert.match(app, /showMedal/);
  assert.match(app, /podiumMedal/);
  assert.match(app, /medalBand/);
  assert.match(app, /medalBadge/);
  assert.match(app, /BottomNav/);
  assert.match(app, /onProfile/);
  assert.match(app, /activeScreen === "profile" \? "page"/);
  assert.match(app, /currentStudent/);
  assert.match(app, /canOpenHomework/);
  assert.match(app, /visibleScreen/);
  assert.match(app, /navIconHomework/);
  assert.match(app, /navIconGeeks/);
  assert.match(app, /uploadArrow/);
  assert.match(app, /HomeworkUploadScreen/);
  assert.match(app, /apiForm<HomeworkSubmitResponse>/);
  assert.match(app, /\/api\/homework\/submit/);
  assert.match(app, /homeworkCard/);
  assert.match(app, /homeworkDrop/);
  assert.match(app, /homeworkLinksAreValid/);
  assert.match(app, /className="homeworkCard"/);
  assert.match(app, /placeholder=\{"Ссылки,\\ngithub,\\n@Sites,\\n@telegram_bot"\}/);
  assert.match(app, /placeholder="Можешь дополнить от себя\.\."/);
  assert.match(app, /нажми или перетащи/);
  assert.match(app, /\.md \.zip \.pdf \.html \.pptx/);
  assert.match(app, /accept="\.md,\.markdown,\.zip,\.pdf,\.html,\.htm,\.ppt,\.pptx/);
  assert.match(app, /homeworkSubmitActions/);
  assert.match(app, /defaultVideoTitle=\{`VibeCoding 1 \| Урок \$\{Math\.max\(1, schedule\.completedLessonCount\)\} Месяц \$\{schedule\.currentCourseMonth\}`\}/);
  assert.match(app, /className="teacherVideoForm"/);
  assert.match(app, /placeholder=\{"Название темы\\nДомашнее задание\\nTelegram-бот"\}/);
  assert.match(app, /className=\{`dropZone teacherMaterialDrop/);
  assert.match(app, /aria-label="Необязательный допматериал"/);
  assert.match(app, /Допматериалы/);
  assert.match(app, /\/api\/admin\/materials/);
  assert.match(app, /TeacherMaterialUploadResponse/);
  assert.match(app, /TeacherMaterialUploadSessionResponse/);
  assert.match(app, /TeacherMaterialUploadPartResponse/);
  assert.match(app, /\/api\/admin\/materials\/upload-session/);
  assert.match(app, /\/api\/admin\/materials\/upload-part/);
  assert.match(app, /\/api\/admin\/materials\/compl