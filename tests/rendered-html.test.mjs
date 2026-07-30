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
  assert.match(app, /\/api\/admin\/materials\/complete/);
  assert.match(app, /MATERIAL_UPLOAD_RETRIES = 4/);
  assert.match(app, /confirmedParts\.get\(partNumber\) === part\.size/);
  assert.match(app, /material\.slice\(start, end\)/);
  assert.doesNotMatch(app, /apiForm<TeacherMaterialUploadResponse>\("\/api\/admin\/materials"/);
  assert.match(app, /materialSavedName/);
  assert.match(app, /phase === "saving"/);
  assert.match(app, /teacherUploadActions/);
  assert.doesNotMatch(app, /Название ролика<\/span>/);
  assert.doesNotMatch(app, /Описание и домашнее задание<\/span>/);
  assert.doesNotMatch(app, /Доступ: по ссылке/);
  assert.doesNotMatch(app, /Файл идёт напрямую в YouTube/);
  assert.doesNotMatch(app, />\s*Выбрать файл\s*</);
  assert.doesNotMatch(app, /uploadCard homeworkCard/);
  assert.doesNotMatch(app, /homeworkExtra/);
  assert.doesNotMatch(app, /homeworkInputRef\.current\?\.click/);
  assert.doesNotMatch(app, /Дополнить от себя/);
  assert.doesNotMatch(app, /Файл домашки/);
  assert.doesNotMatch(app, /Открой через Telegram, чтобы ДЗ привязалось/);
  assert.match(app, /aria-disabled=\{!canOpenHomework\}/);
  assert.match(app, /uploadFileToYouTube/);
  assert.match(app, /queryYouTubeUploadStatus/);
  assert.match(app, /bytes \*\/\$\{total\}/);
  assert.match(app, /nextYouTubeUploadOffset\(xhr\.getResponseHeader\("Range"\)/);
  assert.match(app, /VIDEO_UPLOAD_RETRIES = 6/);
  assert.match(app, /VIDEO_UPLOAD_TIMEOUT_MS = 5 \* 60 \* 1000/);
  assert.match(app, /\/api\/admin\/youtube\/access-token/);
  assert.match(app, /uploadInFlightRef\.current/);
  assert.match(app, /validateTeacherMaterialFile\(nextFile\)/);
  assert.match(app, /Повторить допматериал/);
  assert.match(app, /initialYouTubeUploadChunkSize/);
  assert.doesNotMatch(app, /nextAdaptiveYouTubeUploadChunkSize/);
  assert.doesNotMatch(app, /smallerYouTubeUploadChunkSize/);
  assert.match(app, /\/api\/admin\/youtube\/reconcile/);
  assert.match(app, /\/api\/admin\/youtube\/resume/);
  assert.match(app, /reconcileUpload/);
  assert.match(app, /createPausedUploadError/);
  assert.match(app, /createFinalizingUploadError/);
  assert.match(app, /phase === "finalizing"/);
  assert.match(app, /reconcileFinalizingUpload/);
  assert.match(app, /window\.setInterval\(\(\) => void reconcileFinalizingUpload\(\), 6_000\)/);
  assert.match(app, /session\.reused/);
  assert.match(app, /phase === "paused"/);
  assert.match(app, /"Продолжить"/);
  assert.match(app, /window\.addEventListener\("online"/);
  assert.match(app, /confirmedOffset:\s*diagnostic\.confirmedOffset/);
  assert.match(app, /diagnostic,/);
  assert.match(app, /lessonNumber,\s*courseMonth/s);
  assert.match(app, /Content-Range/);
  assert.match(app, /\/api\/admin\/youtube\/upload-session/);
  assert.match(app, /className="screenKeepAlive"/);
  assert.match(app, /hidden=\{visibleScreen !== "homeworkUpload"\}/);
  assert.match(app, /TEACHER_UPLOAD_DRAFT_KEY/);
  assert.match(app, /\/api\/admin\/youtube\/upload-job/);
  assert.match(app, /UPLOAD_JOB_POLL_INTERVAL_MS/);
  assert.match(app, /jobId:\s*localJobId/);
  assert.match(app, /7_000/);
  assert.match(app, /uploadMonitorCard/);
  assert.match(app, /activeScreen === "homeworkUpload"/);
  assert.doesNotMatch(app, /runWithViewTransition/);
  assert.doesNotMatch(app, /startViewTransition/);
  assert.doesNotMatch(app, /uploadHeader/);
  assert.doesNotMatch(app, /uploadBack/);
  assert.doesNotMatch(app, /setupNotice/);
  assert.match(app, /<strong>\{cell\.score \?\? cell\.lessonNumber\}<\/strong>/);
  assert.doesNotMatch(app, /<span>\{cell\.lessonNumber\}<\/span>/);
  assert.doesNotMatch(app, /<small>\{cell\.lessonNumber\}<\/small>/);
  assert.match(app, /addToggle/);
  assert.match(app, /editToggle/);
  assert.match(app, /bulkEditMode/);
  assert.match(app, /bulkActions/);
  assert.match(app, /bulkStudentRow/);
  assert.match(app, /bulkTelegram/);
  assert.match(app, /useLockedViewportZoom/);
  assert.match(app, /gesturestart/);
  assert.match(app, /preventKeyboardZoom/);
  assert.doesNotMatch(app, /preventWheelZoom/);
  assert.doesNotMatch(app, /addEventListener\("wheel"/);
  assert.doesNotMatch(app, /touchmove/);
  assert.doesNotMatch(app, /touches\.length > 1/);
  assert.match(app, /telegramUsername/);
  assert.match(app, /telegramUserId/);
  assert.match(app, /telegramDraftValue/);
  assert.match(app, /buildStudentPatch/);
  assert.match(app, /onBulkStudentChange/);
  assert.match(app, /focusEditableFieldEnd/);
  assert.match(app, /input\.scrollLeft = input\.scrollWidth/);
  assert.match(app, /autoCorrect="off"/);
  assert.match(app, /spellCheck=\{false\}/);
  assert.match(app, /const toggleStudent = \(studentId: string\) => \{\s*hapticSelection\(\);\s*setExpandedStudentId/s);
  assert.doesNotMatch(app, /studentEditPanel/);
  assert.doesNotMatch(app, /editChoices/);
  assert.doesNotMatch(app, /studentEditInput/);
  assert.doesNotMatch(app, /startLongPress/);
  assert.doesNotMatch(app, /longPressTimer/);
  assert.doesNotMatch(app, /onPointerDown=\{startLongPress/);
  assert.doesNotMatch(app, /onStudentChange/);
  assert.doesNotMatch(app, /inlineNameInput/);
  assert.doesNotMatch(app, /\.select\(\)/);
  assert.doesNotMatch(app, /\["telegramUsername", "@username"\]/);
  assert.doesNotMatch(app, /\["telegramUserId", "TG ID"\]/);
  assert.doesNotMatch(app, /nameEditor/);
  assert.doesNotMatch(app, /Railway/);
  assert.doesNotMatch(app, /sectionTitle/);
  assert.match(css, /\.delta\s*{[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.delta\s*{[^}]*-webkit-text-stroke:\s*0 transparent/s);
  assert.match(css, /\.student\s*{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.student\s*{[^}]*animation:\s*none/s);
  assert.doesNotMatch(css, /@keyframes cardIn/);
  assert.doesNotMatch(css, /::view-transition-old/);
  assert.match(css, /\.leaderboard\s*{[^}]*gap:\s*10px/s);
  assert.match(css, /\.leaderboard\s*{[^}]*user-select:\s*none/s);
  assert.match(css, /\.avatarWrap\s*{[^}]*position:\s*relative/s);
  assert.match(css, /\.podiumMedal\s*{[^}]*inset:\s*0/s);
  assert.match(css, /\.medalBand\s*{[^}]*position:\s*absolute/s);
  assert.match(css, /\.medalBadge\s*{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.podiumMedal\.gold\s*{[^}]*--award-mid:\s*var\(--yellow\)/s);
  assert.match(css, /\.podiumMedal\.silver\s*{[^}]*--award-mid:\s*#dde3ec/s);
  assert.match(css, /\.podiumMedal\.bronze\s*{[^}]*--award-mid:\s*#d98542/s);
  assert.match(css, /\.bottomNav\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.bottomNav\s*{[^}]*width:\s*min\(384px,\s*calc\(100dvw - 18px\)\)/s);
  assert.match(css, /\.bottomNav\s*{[^}]*height:\s*60px/s);
  assert.match(css, /\.bottomNav\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.bottomNav::before\s*{[^}]*content:\s*none/s);
  assert.match(css, /\.bottomNavButton\s*{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.bottomNavButton\.active,\s*\.bottomNavPrimary\.active\s*{/s);
  assert.doesNotMatch(css, /\.bottomNavButton\.active,\s*\.bottomNavPrimary\s*{/s);
  assert.match(css, /\.bottomNavPrimary\s*{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.bottomNavPrimary\.locked\s*{[^}]*background:\s*linear-gradient\(180deg,\s*#fff078/s);
  assert.match(css, /\.navIconGeeks\s*{[^}]*background:\s*transparent/s);
  assert.match(css, /\.navIconGeeks\s*{[^}]*width:\s*30px/s);
  assert.match(css, /\.navIconGeeks img\s*{[^}]*filter:\s*brightness\(0\) saturate\(100%\)/s);
  assert.match(css, /\.uploadArrow::before\s*{[^}]*height:\s*15px/s);
  assert.match(css, /\.uploadArrow::after\s*{[^}]*border-bottom:\s*14px solid #11131b/s);
  assert.match(css, /\.uploadScreen\s*{[^}]*padding:\s*2px 0 112px/s);
  assert.match(css, /\.homeworkCard\s*{[^}]*gap:\s*10px/s);
  assert.match(css, /\.homeworkCard\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.homeworkCard\s*{[^}]*background:\s*transparent/s);
  assert.match(css, /\.homeworkCard\s*{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.uploadActions\.homeworkSubmitActions\s*{[^}]*width:\s*100%/s);
  assert.match(css, /\.uploadActions\.homeworkSubmitActions\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.homeworkSubmitActions \.uploadPrimary\s*{[^}]*width:\s*100%/s);
  assert.match(css, /\.teacherVideoForm\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.teacherVideoForm \.teacherVideoDescription\s*{[^}]*min-height:\s*clamp\(112px,\s*18svh,\s*150px\)/s);
  assert.match(css, /\.teacherVideoDrop\s*{[^}]*min-height:\s*clamp\(132px,\s*22svh,\s*180px\)/s);
  assert.match(css, /\.screenKeepAlive\[hidden\]\s*{[^}]*display:\s*none !important/s);
  assert.match(css, /\.dropZone\.teacherMaterialDrop\s*{[^}]*min-height:\s*58px/s);
  assert.match(css, /\.dropZone\.teacherMaterialDrop \.dropIcon\s*{[^}]*width:\s*30px/s);
  assert.match(css, /\.dropZone\.teacherMaterialDrop strong\s*{[^}]*font-size:\s*clamp\(13px,\s*3\.6vw,\s*16px\)/s);
  assert.match(css, /\.dropZone\.teacherMaterialDrop small\s*{[^}]*font-size:\s*10px/s);
  assert.match(css, /\.uploadMonitorCard\s*{[^}]*width:\s*100%/s);
  assert.match(css, /\.materialClear\s*{[^}]*z-index:\s*2/s);
  assert.match(css, /\.uploadActions\.teacherUploadActions\s*{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.teacherUploadActions \.uploadPrimary\s*{[^}]*width:\s*100%/s);
  assert.match(css, /\.calendarDay \.calendarLessonBadge:not\(\.transferBadge\)\s*{[^}]*right:\s*auto;[^}]*left:\s*-6px/s);
  assert.match(css, /\.profileScreen\s*{[^}]*padding:\s*0 0 112px/s);
  assert.match(css, /\.calendarCard\s*{[^}]*aspect-ratio:\s*1 \/ 1/s);
  assert.match(css, /\.calendarCard\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.calendarHeader\s*{[^}]*grid-template-columns:\s*38px minmax\(0,\s*1fr\) 38px/s);
  assert.match(css, /\.calendarHeader button\s*{[^}]*width:\s*38px/s);
  assert.match(css, /\.calendarMonthPane\s*{[^}]*height:\s*100%/s);
  assert.match(css, /\.calendarGrid\s*{[^}]*height:\s*100%/s);
  assert.match(css, /\.calendarCard\s*{[^}]*background:\s*var\(--card\)/s);
  assert.match(css, /\.calendarCard\s*{[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /\.calendarGrid\s*{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.calendarDay\.past\s*{[^}]*background:\s*#fffdf6/s);
  assert.match(css, /\.calendarDay\.completed\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.calendarDay\.upcoming\s*{[^}]*background:\s*#fff4a8/s);
  assert.match(css, /\.calendarDay\.transfer\s*{[^}]*background:\s*#deded8/s);
  assert.match(css, /\.calendarDay\.transfer\s*{[^}]*color:\s*var\(--ink\)/s);
  assert.match(css, /\.calendarDay\.today\s*{[^}]*border-color:\s*var\(--yellow\);[^}]*background:\s*#fffdf6/s);
  assert.doesNotMatch(css, /\.calendarDay\.today\s*{[^}]*#65e58a/s);
  assert.match(css, /\.calendarDay\.transfer \.transferBadge\s*{[^}]*width:\s*max-content;[^}]*border:\s*0;[^}]*white-space:\s*nowrap;[^}]*transform:\s*translateX\(-50%\)/s);
  assert.match(css, /\.calendarTransferOverlay\s*{[^}]*position:\s*absolute/s);
  assert.match(css, /\.calendarTransferDialog\s*{[^}]*background:\s*var\(--card\)/s);
  assert.match(app, /Длительность обучения: 1 мес\. 12 занятий/);
  assert.doesNotMatch(css, /\.calendarSwipeHint\s*{/);
  assert.match(app, /aria-label="Предыдущий учебный месяц"/);
  assert.match(app, /aria-label="Следующий учебный месяц"/);
  assert.doesNotMatch(app, /calendarSwipeHint/);
  assert.match(css, /@keyframes calendarSlideNext/);
  assert.match(css, /@keyframes badgeTextSwap/);
  assert.doesNotMatch(css, /\.scheduleEditor\s*{/);
  assert.doesNotMatch(css, /\.calendarEditButton\s*{/);
  assert.match(css, /\.transferTargetField input\s*{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.homeworkDrop\s*{[^}]*min-height:\s*clamp\(118px,\s*19svh,\s*156px\)/s);
  assert.doesNotMatch(css, /\.uploadHeader/);
  assert.doesNotMatch(css, /\.uploadBack/);
  assert.doesNotMatch(css, /\.setupNotice/);
  assert.match(css, /\.dropZone\s*{[^}]*border:\s*3px dashed/s);
  assert.match(css, /\.uploadProgress span\s*{[^}]*transition:\s*width 180ms ease/s);
  assert.match(css, /input,\s*select,\s*textarea\s*{[^}]*font-size:\s*16px/s);
  assert.match(css, /html,\s*body\s*{[^}]*overflow-y:\s*hidden/s);
  assert.match(css, /html,\s*body\s*{[^}]*touch-action:\s*auto/s);
  assert.match(css, /\.shell\s*{[^}]*height:\s*100dvh/s);
  assert.match(css, /\.shell\s*{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.shell\s*{[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*display:\s*flex/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.lessonTab\s*{[^}]*width:\s*clamp\(20px,\s*5\.35vw,\s*25px\)/s);
  assert.match(css, /\.lessonTab\s*{[^}]*height:\s*clamp\(20px,\s*5\.3vw,\s*24px\)/s);
  assert.doesNotMatch(css, /\.lessonTab small/);
  assert.match(css, /\.lessonTab\.filled\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.student\.expanded \.lessonTabs,\s*\.student\.bulkEditing \.lessonTabs\s*{[^}]*opacity:\s*0/s);
  assert.doesNotMatch(css, /\.student\.editing/);
  assert.doesNotMatch(css, /\.studentEditPanel/);
  assert.doesNotMatch(css, /\.editChoices/);
  assert.doesNotMatch(css, /\.studentEditInput/);
  assert.match(css, /\.bulkActions\s*{[^}]*position:\s*sticky/s);
  assert.match(css, /\.bulkFields\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\) minmax\(0,\s*0\.85fr\)/s);
  assert.match(css, /\.bulkInput\s*{[^}]*font-size:\s*clamp\(16px,\s*3\.8vw,\s*18px\)/s);
  assert.match(css, /\.bulkInput\s*{[^}]*background:\s*#f4f1e8/s);
  assert.match(css, /\.bulkInput\s*{[^}]*caret-color:\s*#12141b/s);
  assert.match(css, /\.bulkInput\s*{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.bulkInput:focus\s*{[^}]*background:\s*#e8ebef/s);
  assert.match(css, /\.bulkInput:focus\s*{[^}]*border-color:\s*var\(--yellow\)/s);
  assert.match(css, /\.bulkInput::selection\s*{[^}]*background:\s*rgba\(255,\s*223,\s*38,\s*0\.48\)/s);
  assert.doesNotMatch(css, /badgeSwap/);
  assert.match(css, /\.lessonGrid\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*margin-top:\s*0/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*padding-top:\s*1px/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*border-top:\s*1px solid/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*animation:\s*none/s);
  assert.match(css, /\.lessonChip\s*{[^}]*height:\s*32px/s);
  assert.match(css, /\.lessonChip\s*{[^}]*border-radius:\s*8px/s);
  assert.match(css, /\.lessonChip:not\(\.filled\) strong\s*{[^}]*color:\s*#747985/s);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*opacity:\s*1/s);
  assert.match(css, /\.lessonChip\.active strong\s*{[^}]*color:\s*var\(--ink\)/s);
  assert.match(css, /\.lessonChip:disabled:not\(\.filled\)/);
  await access(new URL("../public/geeks-lightning.svg", import.meta.url));
  assert.doesNotMatch(app, /добавить ученика/);
});

test("includes leaderboard, homework, materials, schedule, and admin API surfaces", async () => {
  const [leaderboardRoute, adminRoute, studentRoute, telegramRoute, importRoute, avatarRoute, youtubeUploadRoute, youtubeUploadJobRoute, youtubeReconcileRoute, youtubeResumeRoute, youtubeUploadJobs, youtubeRecovery, youtubeTokenRoute, youtubeOAuth, teacherMaterialsRoute, teacherMaterialSessionRoute, teacherMaterialPartRoute, teacherMaterialCompleteRoute, homeworkRoute, scheduleRoute, adminScheduleRoute, transferScheduleRoute, homeworkStore, teacherMaterialsStore, lessonVideosStore, hosting, store, schedule, schema, transferMigration, transferUpdateMigration, teacherMaterialsMigration, teacherUploadJobsMigration, recoveryMigration, resumableStateMigration, materialUploadMigration] = await Promise.all([
    readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/telegram/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/import-railway/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/avatar/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/upload-session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/upload-job/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/reconcile/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/resume/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/upload-jobs.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/youtube-upload-recovery.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/access-token/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/youtube-oauth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/materials/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/materials/upload-session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/materials/upload-part/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/materials/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/homework/submit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/schedule/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/schedule/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/schedule/transfer/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/homework.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/materials.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/lesson-videos.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/schedule.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_premium_leo.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_tiny_morgan_stark.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_large_doctor_faustus.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_tense_sunset_bain.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_hot_piledriver.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0008_hot_scalphunter.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0009_nebulous_exiles.sql", import.meta.url), "utf8"),
  ]);

  assert.match(leaderboardRoute, /listStudents/);
  assert.match(adminRoute, /createStudent/);
  assert.match(studentRoute, /updateStudent/);
  assert.match(telegramRoute, /validateTelegramInitData/);
  assert.match(importRoute, /importStudentsSnapshot/);
  assert.match(avatarRoute, /getUserProfilePhotos/);
  assert.match(avatarRoute, /getFile/);
  assert.match(youtubeUploadRoute, /requireAdmin/);
  assert.match(youtubeUploadRoute, /YOUTUBE_CLIENT_ID/);
  assert.match(youtubeUploadRoute, /YOUTUBE_CLIENT_SECRET/);
  assert.match(youtubeUploadRoute, /YOUTUBE_REFRESH_TOKEN/);
  assert.match(youtubeUploadRoute, /uploadType=resumable/);
  assert.match(youtubeUploadRoute, /X-Upload-Content-Length/);
  assert.match(youtubeUploadRoute, /selfDeclaredMadeForKids:\s*false/);
  assert.match(youtubeUploadRoute, /createTeacherUploadJob/);
  assert.match(youtubeUploadRoute, /jobId:\s*job\.id/);
  assert.match(youtubeUploadJobRoute, /export async function GET/);
  assert.match(youtubeUploadJobRoute, /export async function PATCH/);
  assert.match(youtubeUploadJobRoute, /export async function DELETE/);
  assert.match(youtubeUploadJobRoute, /requireAdmin/);
  assert.match(youtubeUploadJobRoute, /currentTeacherUploadJob/);
  assert.match(youtubeUploadJobs, /teacher_upload_jobs/);
  assert.match(youtubeUploadJobs, /WHERE NOT EXISTS/);
  assert.match(youtubeUploadJobs, /WHERE phase IN \('creating', 'uploading', 'finalizing', 'paused', 'saving'\)/);
  assert.match(youtubeUploadJobs, /const staleAfterMs = 45_000/);
  assert.match(youtubeUploadJobs, /upload_url/);
  assert.match(youtubeUploadJobs, /confirmed_offset/);
  assert.match(youtubeUploadJobs, /teacher_upload_chunk_events/);
  assert.match(youtubeUploadJobs, /recordTeacherUploadChunkDiagnostic/);
  assert.match(youtubeUploadJobs, /listTeacherUploadChunkDiagnostics/);
  assert.match(youtubeUploadJobRoute, /searchParams\.get\("diagnostics"\) === "1"/);
  assert.match(youtubeReconcileRoute, /queryYouTubeUploadSession/);
  assert.match(youtubeReconcileRoute, /verifyYouTubeVideo/);
  assert.match(youtubeReconcileRoute, /upsertTeacherLessonVideo/);
  assert.match(youtubeReconcileRoute, /findRecentlyUploadedVideo/);
  assert.match(youtubeReconcileRoute, /jobId:\s*current\.id/);
  assert.match(youtubeResumeRoute, /requireAdmin/);
  assert.match(youtubeResumeRoute, /queryYouTubeUploadSession/);
  assert.match(youtubeResumeRoute, /body\.fileName !== current\.fileName/);
  assert.match(youtubeResumeRoute, /allowResume:\s*true/);
  assert.match(youtubeRecovery, /Content-Range/);
  assert.match(youtubeRecovery, /processingDetails/);
  assert.match(youtubeRecovery, /youtubeUploadJobTag/);
  assert.match(youtubeUploadRoute, /reusableTeacherUploadJob/);
  assert.match(youtubeUploadRoute, /reused:\s*true/);
  assert.match(youtubeUploadRoute, /tags:\s*\[youtubeUploadJobTag\(jobId\)\]/);
  assert.match(youtubeRecovery, /youtube\.com\/oembed/);
  assert.match(youtubeTokenRoute, /requireAdmin/);
  assert.match(youtubeTokenRoute, /exchangeYouTubeRefreshToken/);
  assert.match(youtubeOAuth, /oauth2\.googleapis\.com\/token/);
  assert.match(youtubeOAuth, /YOUTUBE_REFRESH_TOKEN/);
  assert.match(teacherMaterialsRoute, /requireAdmin/);
  assert.match(teacherMaterialsRoute, /request\.formData/);
  assert.match(teacherMaterialsRoute, /createTeacherMaterial/);
  assert.match(teacherMaterialSessionRoute, /requireAdmin/);
  assert.match(teacherMaterialSessionRoute, /createTeacherMaterialUploadSession/);
  assert.match(teacherMaterialPartRoute, /requireAdmin/);
  assert.match(teacherMaterialPartRoute, /MATERIAL_UPLOAD_PART_SIZE/);
  assert.match(teacherMaterialPartRoute, /uploadTeacherMaterialPart/);
  assert.match(teacherMaterialCompleteRoute, /requireAdmin/);
  assert.match(teacherMaterialCompleteRoute, /completeTeacherMaterialUpload/);
  assert.match(homeworkRoute, /requireIdentity/);
  assert.match(homeworkRoute, /request\.formData/);
  assert.match(homeworkRoute, /findByTelegramUserId/);
  assert.match(homeworkRoute, /createHomeworkSubmission/);
  assert.match(scheduleRoute, /getLessonSchedule/);
  assert.match(adminScheduleRoute, /requireAdmin/);
  assert.match(adminScheduleRoute, /saveLessonSchedule/);
  assert.match(transferScheduleRoute, /requireAdmin/);
  assert.match(transferScheduleRoute, /transferScheduledLesson/);
  assert.match(transferScheduleRoute, /cancelScheduledLessonTransfer/);
  assert.match(transferScheduleRoute, /export async function DELETE/);
  assert.match(transferScheduleRoute, /targetScheduledAt/);
  assert.match(transferScheduleRoute, /ScheduleConflictError/);
  assert.match(transferScheduleRoute, /409/);
  assert.match(homeworkStore, /homework_submissions/);
  assert.match(homeworkStore, /HOMEWORK_FILES/);
  assert.match(homeworkStore, /bucket\.put/);
  assert.match(homeworkStore, /cleanLinks/);
  assert.match(homeworkStore, /isLinkToken/);
  assert.match(homeworkStore, /@username/);
  assert.match(homeworkStore, /MAX_FILE_SIZE = 50 \* 1024 \* 1024/);
  assert.match(teacherMaterialsStore, /teacher_materials/);
  assert.match(teacherMaterialsStore, /HOMEWORK_FILES/);
  assert.match(teacherMaterialsStore, /teacher-materials\/month-/);
  assert.match(teacherMaterialsStore, /originalName/);
  assert.match(teacherMaterialsStore, /validateTeacherMaterialFile/);
  assert.match(teacherMaterialsStore, /file\.stream\(\)/);
  assert.match(teacherMaterialsStore, /createMultipartUpload/);
  assert.match(teacherMaterialsStore, /resumeMultipartUpload/);
  assert.match(teacherMaterialsStore, /upload\.uploadPart/);
  assert.match(teacherMaterialsStore, /upload\.complete/);
  assert.match(teacherMaterialsStore, /teacher_material_upload_sessions/);
  assert.match(teacherMaterialsStore, /teacher_material_upload_parts/);
  assert.match(teacherMaterialsStore, /status IN \('uploading', 'completed'\)/);
  assert.match(teacherMaterialsStore, /ON CONFLICT\(session_id, part_number\) DO UPDATE/);
  assert.match(lessonVideosStore, /teacher_lesson_videos/);
  assert.match(lessonVideosStore, /ON CONFLICT\(course_month, lesson_number\)/);
  assert.match(hosting, /"r2":\s*"HOMEWORK_FILES"/);
  assert.match(store, /SET telegram_username = \?, avatar_url = COALESCE/);
  assert.match(store, /lastScoredAt/);
  assert.match(store, /compareScoreTime\(left\.lastScoredAt,\s*right\.lastScoredAt\)/);
  assert.match(store, /SELECT student_id, lesson_number, score, created_at, updated_at FROM lesson_scores/);
  assert.match(store, /const scoredAt = new Date\(\)\.toISOString\(\)/);
  assert.match(store, /DO UPDATE SET score = excluded\.score, updated_at = excluded\.updated_at/);
  assert.doesNotMatch(store, /return \(await listAllStudents\(currentTelegramUserId\)\)\.find\(\(item\) => item\.id === studentId\)/);
  assert.match(store, /findAvatarSourceByStudentId/);
  assert.match(store, /\/api\/avatar\/\$\{row\.id\}/);
  assert.match(store, /lesson_schedule/);
  assert.match(store, /seedLessonScheduleIfEmpty/);
  assert.match(store, /seedExistingLessonTransferIfEmpty/);
  assert.match(store, /lesson_schedule_transfers/);
  assert.match(store, /transferScheduledLesson/);
  assert.match(store, /cancelScheduledLessonTransfer/);
  assert.match(store, /before_schedule_json/);
  assert.match(store, /restoreLessonTransferSchedule/);
  assert.match(store, /latest\.original_scheduled_at/);
  assert.doesNotMatch(store, /Для этого старого переноса восстановление недоступно/);
  assert.match(store, /cancelled_at IS NULL/);
  assert.match(store, /Отменить можно только последний активный перенос/);
  assert.match(store, /db\.batch\(statements\)/);
  assert.match(store, /saveLessonSchedule/);
  assert.match(schedule, /DEFAULT_LESSON_SCHEDULE/);
  assert.match(schedule, /2026-07-22T16:00:00\+06:00/);
  assert.match(schedule, /2026-07-24T16:00:00\+06:00/);
  assert.match(schedule, /2026-08-03T16:00:00\+06:00/);
  assert.match(schedule, /currentLabel:\s*`\$\{currentCourseMonth\} мес \$\{completed\.length\} урок`/);
  assert.match(schedule, /scheduleMonths/);
  assert.match(schedule, /transferLessonSchedule/);
  assert.match(schedule, /restoreLessonTransferSchedule/);
  assert.match(schedule, /restored\[selectedIndex\]\.scheduledAt = originalScheduledAt/);
  assert.match(schedule, /targetScheduledAt/);
  assert.match(schedule, /defaultTransferTarget/);
  assert.match(schedule, /nextTeachingSlot\(/);
  assert.match(schedule, /ScheduleConflictError/);
  assert.match(schema, /lessonSchedule/);
  assert.match(schema, /lesson_schedule/);
  assert.match(schema, /lessonScheduleTransfers/);
  assert.match(schema, /teacherMaterials/);
  assert.match(schema, /teacher_materials/);
  assert.match(schema, /teacherMaterialUploadSessions/);
  assert.match(schema, /teacher_material_upload_sessions/);
  assert.match(schema, /teacherMaterialUploadParts/);
  assert.match(schema, /teacher_material_upload_parts/);
  assert.match(schema, /teacherUploadJobs/);
  assert.match(schema, /teacher_upload_jobs/);
  assert.match(schema, /teacherUploadChunkEvents/);
  assert.match(schema, /teacherLessonVideos/);
  assert.match(transferMigration, /CREATE TABLE `lesson_schedule_transfers`/);
  assert.match(transferMigration, /lesson_schedule_transfers_original_unique/);
  assert.match(transferUpdateMigration, /ADD `before_schedule_json` text/);
  assert.match(transferUpdateMigration, /ADD `cancelled_at` text/);
  assert.match(teacherMaterialsMigration, /CREATE TABLE `teacher_materials`/);
  assert.match(teacherMaterialsMigration, /teacher_materials_file_key_unique/);
  assert.match(teacherUploadJobsMigration, /CREATE TABLE `teacher_upload_jobs`/);
  assert.match(teacherUploadJobsMigration, /`phase` text DEFAULT 'creating' NOT NULL/);
  assert.match(recoveryMigration, /CREATE TABLE `teacher_lesson_videos`/);
  assert.match(recoveryMigration, /ADD `upload_url` text/);
  assert.match(resumableStateMigration, /CREATE TABLE `teacher_upload_chunk_events`/);
  assert.match(resumableStateMigration, /ADD `confirmed_offset` integer/);
  assert.match(resumableStateMigration, /ADD `chunk_size` integer/);
  assert.match(materialUploadMigration, /CREATE TABLE `teacher_material_upload_sessions`/);
  assert.match(materialUploadMigration, /CREATE TABLE `teacher_material_upload_parts`/);
  assert.match(materialUploadMigration, /teacher_material_upload_parts_session_part_unique/);
});

test("admin score picker stays in one compact row", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /grid-template-columns:\s*repeat\(11,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.scorePicker\s*{[^}]*repeat\(4/s);
});

test("completed calendar lessons open source-matched homework while future lessons stay inactive", async () => {
  const app = await readFile(new URL("../app/GeeksServiceApp.tsx", import.meta.url), "utf8");
  const homework = await readFile(new URL("../lib/lesson-homework.ts", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(app, /mainLesson\?\.isCompleted && lessonHomeworkByNumber/);
  assert.match(app, /onHomeworkSelect\(mainLesson\)/);
  assert.match(app, /className="calendarHomeworkDialog"/);
  assert.match(app, /aria-modal="true"/);
  assert.match(homework, /lessonNumber:\s*1/);
  assert.match(homework, /lessonNumber:\s*9/);
  assert.doesNotMatch(homework, /lessonNumber:\s*10/);
  assert.match(homework, /Создать через v0, Lovable или Bolt\.new/);
  assert.match(homework, /создать свой публичный SSH ключ/);
  assert.match(css, /\.calendarHomeworkOverlay\s*{[^}]*position:\s*fixed/s);
  assert.match(css, /\.calendarHomeworkBody p\s*{[^}]*white-space:\s*pre-wrap/s);
});
