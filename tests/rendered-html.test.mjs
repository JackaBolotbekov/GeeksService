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
    validateTeacherMaterialFile({ name: "  Ð£Ñ€Ð¾Ðº 7 â€” Ð¿Ñ€ÐµÐ·ÐµÐ½Ñ‚Ð°Ñ†Ð¸Ñ.pptx  ", size: 1024 }),
    "Ð£Ñ€Ð¾Ðº 7 â€” Ð¿Ñ€ÐµÐ·ÐµÐ½Ñ‚Ð°Ñ†Ð¸Ñ.pptx",
  );
  assert.equal(
    validateTeacherMaterialFile({ name: "ÐœÐ°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ñ‹.PDF", size: MAX_MATERIAL_FILE_SIZE }),
    "ÐœÐ°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ñ‹.PDF",
  );
  assert.throws(
    () => validateTeacherMaterialFile({ name: "installer.exe", size: 1024 }),
    /ÐŸÐ¾Ð´Ð´ÐµÑ€Ð¶Ð¸Ð²Ð°ÑŽÑ‚ÑÑ PPTX/,
  );
  assert.throws(
    () => validateTeacherMaterialFile({ name: "large.zip", size: MAX_MATERIAL_FILE_SIZE + 1 }),
    /Ð´Ð¾ 50 MB/,
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
                title: "VibeCoding 1 | Ð£Ñ€Ð¾Ðº 7 ÐœÐµÑÑÑ† 1",
                publishedAt: "2026-07-24T10:03:00.000Z",
                resourceId: { videoId: taggedVideoId },
              },
              contentDetails: { videoId: taggedVideoId },
            },
            {
              snippet: {
                title: "VibeCoding 1 | Ð£Ñ€Ð¾Ðº 7 ÐœÐµÑÑÑ† 1",
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
                title: "VibeCoding 1 | Ð£Ñ€Ð¾Ðº 7 ÐœÐµÑÑÑ† 1",
                tags: ["some-other-upload"],
              },
              status: { uploadStatus: "processed" },
            },
            {
              id: taggedVideoId,
              snippet: {
                title: "VibeCoding 1 | Ð£Ñ€Ð¾Ðº 7 ÐœÐµÑÑÑ† 1",
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
      title: "VibeCoding 1 | Ð£Ñ€Ð¾Ðº 7 ÐœÐµÑÑÑ† 1",
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
  assert.match(app, /Ð”Ð»Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ð¾ÑÑ‚ÑŒ Ð¾Ð±ÑƒÑ‡ÐµÐ½Ð¸Ñ: 1 Ð¼ÐµÑ\. 12 Ð·Ð°Ð½ÑÑ‚Ð¸Ð¹/);
  assert.doesNotMatch(app, />ONLINE</);
  assert.doesNotMatch(app, /className="status"/);
  assert.doesNotMatch(app, /Ð´Ð¾Ð¼Ð°ÑˆÐµÐº Â·/);
  assert.doesNotMatch(app, /\/12 Ð´Ð¾Ð¼Ð°ÑˆÐµÐº/);
  assert.match(app, /Ð¸Ð· 12 Ð”Ð—/);
  assert.match(app, /12 Ð¸Ð· 12 âœ…/);
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
  assert.match(app, /placeholder=\{"Ð¡ÑÑ‹Ð»ÐºÐ¸,\\ngithub,\\n@Sites,\\n@telegram_bot"\}/);
  assert.match(app, /placeholder="ÐœÐ¾Ð¶ÐµÑˆÑŒ Ð´Ð¾Ð¿Ð¾Ð»Ð½Ð¸Ñ‚ÑŒ Ð¾Ñ‚ ÑÐµÐ±Ñ\.\."/);
  assert.match(app, /Ð½Ð°Ð¶Ð¼Ð¸ Ð¸Ð»Ð¸ Ð¿ÐµÑ€ÐµÑ‚Ð°Ñ‰Ð¸/);
  assert.match(app, /\.md \.zip \.pdf \.html \.pptx/);
  assert.match(app, /accept="\.md,\.markdown,\.zip,\.pdf,\.html,\.htm,\.ppt,\.pptx/);
  assert.match(app, /homeworkSubmitActions/);
  assert.match(app, /defaultVideoTitle=\{`VibeCoding 1 \| Ð£Ñ€Ð¾Ðº \$\{Math\.max\(1, schedule\.completedLessonCount\)\} ÐœÐµÑÑÑ† \$\{schedule\.currentCourseMonth\}`\}/);
  assert.match(app, /className="teacherVideoForm"/);
  assert.match(app, /placeholder=\{"ÐÐ°Ð·Ð²Ð°Ð½Ð¸Ðµ Ñ‚ÐµÐ¼Ñ‹\\nÐ”Ð¾Ð¼Ð°ÑˆÐ½ÐµÐµ Ð·Ð°Ð´Ð°Ð½Ð¸Ðµ\\nTelegram-Ð±Ð¾Ñ‚"\}/);
  assert.match(app, /className=\{`dropZone teacherMaterialDrop/);
  assert.match(app, /aria-label="ÐÐµÐ¾Ð±ÑÐ·Ð°Ñ‚ÐµÐ»ÑŒÐ½Ñ‹Ð¹ Ð´Ð¾Ð¿Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»"/);
  assert.match(app, /Ð”Ð¾Ð¿Ð¼Ð°Ñ‚ÐµÑ€Ð¸Ð°Ð»Ñ‹/);
  assert.match(app, /\/api\/admin\/materials/);
  assert.match(app, /TeacherMaterialUploadResponse/);
  assert.match(app, /TeacherMaterialUploadSessionResponse/);
  assert.match(app, /TeacherMaterialUploadPartResponse/);
  assert.match(app, /\/api\/admin\/materials\/upload-session/);
  assert.match(app, /\/api\/admin\/materials\/upload-part/);
  assert.match(app, /\/api\/admin\/materials\/complçz¶‰žËkºwµçQ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½ÍÑÕ‘•¹ÑÌ½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½ÍÑÕ‘•¹ÑÌ½mÍÑÕ‘•¹Ñ%‘t½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…ÕÑ ½Ñ•±•É…´½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½¥µÁ½ÉÐµÉ…¥±Ý…ä½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…Ù…Ñ…È½mÍÑÕ‘•¹Ñ%‘t½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½å½ÕÑÕ‰”½ÕÁ±½…µÍ•ÍÍ¥½¸½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½å½ÕÑÕ‰”½ÕÁ±½…µ©½ˆ½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½å½ÕÑÕ‰”½É•½¹¥±”½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½å½ÕÑÕ‰”½É•ÍÕµ”½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½ÕÁ±½…µ©½‰Ì¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½å½ÕÑÕ‰”µÕÁ±½…µÉ•½Ù•Éä¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½å½ÕÑÕ‰”½…•ÍÌµÑ½­•¸½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½å½ÕÑÕ‰”µ½…ÕÑ ¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½µ…Ñ•É¥…±Ì½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½µ…Ñ•É¥…±Ì½ÕÁ±½…µÍ•ÍÍ¥½¸½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½µ…Ñ•É¥…±Ì½ÕÁ±½…µÁ…ÉÐ½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½µ…Ñ•É¥…±Ì½½µÁ±•Ñ”½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½¡½µ•Ý½É¬½ÍÕ‰µ¥Ð½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½Í¡•‘Õ±”½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½Í¡•‘Õ±”½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½…Á¤½…‘µ¥¸½Í¡•‘Õ±”½ÑÉ…¹Í™•È½É½ÕÑ”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½¡½µ•Ý½É¬¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½µ…Ñ•É¥…±Ì¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½±•ÍÍ½¸µÙ¥‘•½Ì¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸¼¹½Á•¹…¤½¡½ÍÑ¥¹œ¹©Í½¸ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½ÍÑ½É”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½Í¡•‘Õ±”¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘ˆ½Í¡•µ„¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀÍ}ÁÉ•µ¥Õµ}±•¼¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀÑ}Ñ¥¹å}µ½É…¹}ÍÑ…É¬¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀÕ}±…É•}‘½Ñ½É}™…ÕÍÑÕÌ¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀÙ}Ñ•¹Í•}ÍÕ¹Í•Ñ}‰…¥¸¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀÝ}¡½Ñ}Á¥±•‘É¥Ù•È¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°4(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀá}¡½Ñ}Í…±Á¡Õ¹Ñ•È¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€€€É•…‘¥±”¡¹•ÜUI0 ˆ¸¸½‘É¥éé±”¼ÀÀÀå}¹•‰Õ±½ÕÍ}•á¥±•Ì¹ÍÅ°ˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤°(€t¤ì4(4(€…ÍÍ•ÉÐ¹µ…Ñ ¡±•…‘•É‰½…É‘I½ÕÑ”°€½±¥ÍÑMÑÕ‘•¹ÑÌ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡…‘µ¥¹I½ÕÑ”°€½É•…Ñ•MÑÕ‘•¹Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑÕ‘•¹ÑI½ÕÑ”°€½ÕÁ‘…Ñ•MÑÕ‘•¹Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•±•É…µI½ÕÑ”°€½Ù…±¥‘…Ñ•Q•±•É…µ%¹¥Ñ…Ñ„¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¥µÁ½ÉÑI½ÕÑ”°€½¥µÁ½ÉÑMÑÕ‘•¹ÑÍM¹…ÁÍ¡½Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡…Ù…Ñ…ÉI½ÕÑ”°€½•ÑUÍ•ÉAÉ½™¥±•A¡½Ñ½Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡…Ù…Ñ…ÉI½ÕÑ”°€½•Ñ¥±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½e=UQU	}1%9Q}%¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½e=UQU	}1%9Q}MIP¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½e=UQU	}IIM!}Q=-8¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½ÕÁ±½…‘QåÁ”õÉ•ÍÕµ…‰±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½`µUÁ±½…µ½¹Ñ•¹Ðµ1•¹Ñ ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½Í•±™•±…É•‘5…‘•½É-¥‘ÌéqÌ©™…±Í”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½É•…Ñ•Q•…¡•ÉUÁ±½…‘)½ˆ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½©½‰%éqÌ©©½‰p¹¥¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸P¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸AQ ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸1Q¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½ÕÉÉ•¹ÑQ•…¡•ÉUÁ±½…‘)½ˆ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½Ñ•…¡•É}ÕÁ±½…‘}©½‰Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½]!I9=Pa%MQL¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½]!IÁ¡…Í”%8p É•…Ñ¥¹œœ°€ÕÁ±½…‘¥¹œœ°€™¥¹…±¥é¥¹œœ°€Á…ÕÍ•œ°€Í…Ù¥¹œp¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½½¹ÍÐÍÑ…±•™Ñ•É5Ì€ô€ÐÕ|ÀÀÀ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½ÕÁ±½…‘}ÕÉ°¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½½¹™¥Éµ•‘}½™™Í•Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½Ñ•…¡•É}ÕÁ±½…‘}¡Õ¹­}•Ù•¹ÑÌ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½É•½É‘Q•…¡•ÉUÁ±½…‘¡Õ¹­¥…¹½ÍÑ¥Œ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰Ì°€½±¥ÍÑQ•…¡•ÉUÁ±½…‘¡Õ¹­¥…¹½ÍÑ¥Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘)½‰I½ÕÑ”°€½Í•…É¡A…É…µÍp¹•Ñp ‰‘¥…¹½ÍÑ¥Ì‰p¤€ôôô€ˆÄˆ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½¹¥±•I½ÕÑ”°€½ÅÕ•Éåe½ÕQÕ‰•UÁ±½…‘M•ÍÍ¥½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½¹¥±•I½ÕÑ”°€½Ù•É¥™åe½ÕQÕ‰•Y¥‘•¼¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½¹¥±•I½ÕÑ”°€½ÕÁÍ•ÉÑQ•…¡•É1•ÍÍ½¹Y¥‘•¼¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½¹¥±•I½ÕÑ”°€½™¥¹‘I••¹Ñ±åUÁ±½…‘•‘Y¥‘•¼¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½¹¥±•I½ÕÑ”°€½©½‰%éqÌ©ÕÉÉ•¹Ñp¹¥¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•ÍÕµ•I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•ÍÕµ•I½ÕÑ”°€½ÅÕ•Éåe½ÕQÕ‰•UÁ±½…‘M•ÍÍ¥½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•ÍÕµ•I½ÕÑ”°€½‰½‘åp¹™¥±•9…µ”€„ôôÕÉÉ•¹Ñp¹™¥±•9…µ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•ÍÕµ•I½ÕÑ”°€½…±±½ÝI•ÍÕµ”éqÌ©ÑÉÕ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½Ù•Éä°€½½¹Ñ•¹ÐµI…¹”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½Ù•Éä°€½ÁÉ½•ÍÍ¥¹•Ñ…¥±Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½Ù•Éä°€½å½ÕÑÕ‰•UÁ±½…‘)½‰Q…œ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½É•ÕÍ…‰±•Q•…¡•ÉUÁ±½…‘)½ˆ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½É•ÕÍ•éqÌ©ÑÉÕ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•UÁ±½…‘I½ÕÑ”°€½Ñ…ÌéqÌ©qmå½ÕÑÕ‰•UÁ±½…‘)½‰Q…p¡©½‰%‘p¥qt¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•I•½Ù•Éä°€½å½ÕÑÕ‰•p¹½µp½½•µ‰•¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•Q½­•¹I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•Q½­•¹I½ÕÑ”°€½•á¡…¹•e½ÕQÕ‰•I•™É•Í¡Q½­•¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•=ÕÑ °€½½…ÕÑ Ép¹½½±•…Á¥Íp¹½µp½Ñ½­•¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡å½ÕÑÕ‰•=ÕÑ °€½e=UQU	}IIM!}Q=-8¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍI½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍI½ÕÑ”°€½É•ÅÕ•ÍÑp¹™½Éµ…Ñ„¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍI½ÕÑ”°€½É•…Ñ•Q•…¡•É5…Ñ•É¥…°¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±M•ÍÍ¥½¹I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±M•ÍÍ¥½¹I½ÕÑ”°€½É•…Ñ•Q•…¡•É5…Ñ•É¥…±UÁ±½…‘M•ÍÍ¥½¸¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±A…ÉÑI½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±A…ÉÑI½ÕÑ”°€½5QI%1}UA1=}AIQ}M%i¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±A…ÉÑI½ÕÑ”°€½ÕÁ±½…‘Q•…¡•É5…Ñ•É¥…±A…ÉÐ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±½µÁ±•Ñ•I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±½µÁ±•Ñ•I½ÕÑ”°€½½µÁ±•Ñ•Q•…¡•É5…Ñ•É¥…±UÁ±½…¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­I½ÕÑ”°€½É•ÅÕ¥É•%‘•¹Ñ¥Ñä¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­I½ÕÑ”°€½É•ÅÕ•ÍÑp¹™½Éµ…Ñ„¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­I½ÕÑ”°€½™¥¹‘	åQ•±•É…µUÍ•É%¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­I½ÕÑ”°€½É•…Ñ•!½µ•Ý½É­MÕ‰µ¥ÍÍ¥½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±•I½ÕÑ”°€½•Ñ1•ÍÍ½¹M¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡…‘µ¥¹M¡•‘Õ±•I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡…‘µ¥¹M¡•‘Õ±•I½ÕÑ”°€½Í…Ù•1•ÍÍ½¹M¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½É•ÅÕ¥É•‘µ¥¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½ÑÉ…¹Í™•ÉM¡•‘Õ±•‘1•ÍÍ½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½…¹•±M¡•‘Õ±•‘1•ÍÍ½¹QÉ…¹Í™•È¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½•áÁ½ÉÐ…Íå¹Œ™Õ¹Ñ¥½¸1Q¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½Ñ…É•ÑM¡•‘Õ±•‘Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€½M¡•‘Õ±•½¹™±¥ÑÉÉ½È¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉM¡•‘Õ±•I½ÕÑ”°€¼ÐÀä¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½¡½µ•Ý½É­}ÍÕ‰µ¥ÍÍ¥½¹Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½!=5]=I-}%1L¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½‰Õ­•Ñp¹ÁÕÐ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½±•…¹1¥¹­Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½¥Í1¥¹­Q½­•¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½ÕÍ•É¹…µ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É­MÑ½É”°€½5a}%1}M%i€ô€ÔÀp¨€ÄÀÈÐp¨€ÄÀÈÐ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½Ñ•…¡•É}µ…Ñ•É¥…±Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½!=5]=I-}%1L¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½Ñ•…¡•Èµµ…Ñ•É¥…±Íp½µ½¹Ñ ´¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½½É¥¥¹…±9…µ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½Ù…±¥‘…Ñ•Q•…¡•É5…Ñ•É¥…±¥±”¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½™¥±•p¹ÍÑÉ•…µp¡p¤¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½É•…Ñ•5Õ±Ñ¥Á…ÉÑUÁ±½…¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½É•ÍÕµ•5Õ±Ñ¥Á…ÉÑUÁ±½…¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½ÕÁ±½…‘p¹ÕÁ±½…‘A…ÉÐ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½ÕÁ±½…‘p¹½µÁ±•Ñ”¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Í•ÍÍ¥½¹Ì¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Á…ÉÑÌ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½ÍÑ…ÑÕÌ%8p ÕÁ±½…‘¥¹œœ°€½µÁ±•Ñ•p¤¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±ÍMÑ½É”°€½=8=91%Qp¡Í•ÍÍ¥½¹}¥°Á…ÉÑ}¹Õµ‰•Ép¤<UAQ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡±•ÍÍ½¹Y¥‘•½ÍMÑ½É”°€½Ñ•…¡•É}±•ÍÍ½¹}Ù¥‘•½Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡±•ÍÍ½¹Y¥‘•½ÍMÑ½É”°€½=8=91%Qp¡½ÕÉÍ•}µ½¹Ñ °±•ÍÍ½¹}¹Õµ‰•Ép¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½ÍÑ¥¹œ°€¼‰ÈÈˆéqÌ¨‰!=5]=I-}%1Lˆ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½MPÑ•±•É…µ}ÕÍ•É¹…µ”€ôpü°…Ù…Ñ…É}ÕÉ°€ô=1M¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½±…ÍÑM½É•‘Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½½µÁ…É•M½É•Q¥µ•p¡±•™Ñp¹±…ÍÑM½É•‘Ð±qÌ©É¥¡Ñp¹±…ÍÑM½É•‘Ñp¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½M1PÍÑÕ‘•¹Ñ}¥°±•ÍÍ½¹}¹Õµ‰•È°Í½É”°É•…Ñ•‘}…Ð°ÕÁ‘…Ñ•‘}…ÐI=4±•ÍÍ½¹}Í½É•Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½½¹ÍÐÍ½É•‘Ð€ô¹•Ü…Ñ•p¡p¥p¹Ñ½%M=MÑÉ¥¹p¡p¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½<UAQMPÍ½É”€ô•á±Õ‘•‘p¹Í½É”°ÕÁ‘…Ñ•‘}…Ð€ô•á±Õ‘•‘p¹ÕÁ‘…Ñ•‘}…Ð¼¤ì4(€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡ÍÑ½É”°€½É•ÑÕÉ¸p¡…Ý…¥Ð±¥ÍÑ±±MÑÕ‘•¹ÑÍp¡ÕÉÉ•¹ÑQ•±•É…µUÍ•É%‘p¥p¥p¹™¥¹‘p¡p¡¥Ñ•µp¤€ôø¥Ñ•µp¹¥€ôôôÍÑÕ‘•¹Ñ%‘p¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½™¥¹‘Ù…Ñ…ÉM½ÕÉ•	åMÑÕ‘•¹Ñ%¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½p½…Á¥p½…Ù…Ñ…Ép½p‘qíÉ½Ýp¹¥‘qô¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½±•ÍÍ½¹}Í¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½Í••‘1•ÍÍ½¹M¡•‘Õ±•%™µÁÑä¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½Í••‘á¥ÍÑ¥¹1•ÍÍ½¹QÉ…¹Í™•É%™µÁÑä¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½±•ÍÍ½¹}Í¡•‘Õ±•}ÑÉ…¹Í™•ÉÌ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½ÑÉ…¹Í™•ÉM¡•‘Õ±•‘1•ÍÍ½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½…¹•±M¡•‘Õ±•‘1•ÍÍ½¹QÉ…¹Í™•È¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½‰•™½É•}Í¡•‘Õ±•}©Í½¸¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½É•ÍÑ½É•1•ÍÍ½¹QÉ…¹Í™•ÉM¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½±…Ñ•ÍÑp¹½É¥¥¹…±}Í¡•‘Õ±•‘}…Ð¼¤ì4(€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡ÍÑ½É”°€¿BSBïF<ƒF7FBûBÏBøƒFFBÃFBûBÏBøƒBÿB×FB×B÷BûFBÀƒBËBûFFFBÃB÷BûBËBïB×B÷BãBÔƒB÷B×BÓBûFFFBÿB÷Bø¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½…¹•±±•‘}…Ð%L9U10¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€¿B{FBóB×B÷BãFF0ƒBóBûBÛB÷BøƒFBûBïF3BëBøƒBÿBûFBïB×BÓB÷BãBäƒBÃBëFBãBËB÷F/BäƒBÿB×FB×B÷BûF¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½‘‰p¹‰…Ñ¡p¡ÍÑ…Ñ•µ•¹ÑÍp¤¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÑ½É”°€½Í…Ù•1•ÍÍ½¹M¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½U1Q}1MM=9}M!U1¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€¼ÈÀÈØ´ÀÜ´ÈÉPÄØèÀÀèÀÁp¬ÀØèÀÀ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€¼ÈÀÈØ´ÀÜ´ÈÑPÄØèÀÀèÀÁp¬ÀØèÀÀ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€¼ÈÀÈØ´Àà´ÀÍPÄØèÀÀèÀÁp¬ÀØèÀÀ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½ÕÉÉ•¹Ñ1…‰•°éqÌ©p‘qíÕÉÉ•¹Ñ½ÕÉÍ•5½¹Ñ¡qôƒBóB×Fp‘qí½µÁ±•Ñ•‘p¹±•¹Ñ¡qôƒFFBûBé€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½Í¡•‘Õ±•5½¹Ñ¡Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½ÑÉ…¹Í™•É1•ÍÍ½¹M¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½É•ÍÑ½É•1•ÍÍ½¹QÉ…¹Í™•ÉM¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½É•ÍÑ½É•‘qmÍ•±•Ñ•‘%¹‘•áqup¹Í¡•‘Õ±•‘Ð€ô½É¥¥¹…±M¡•‘Õ±•‘Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½Ñ…É•ÑM¡•‘Õ±•‘Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½‘•™…Õ±ÑQÉ…¹Í™•ÉQ…É•Ð¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½¹•áÑQ•…¡¥¹M±½Ñp ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•‘Õ±”°€½M¡•‘Õ±•½¹™±¥ÑÉÉ½È¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½±•ÍÍ½¹M¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½±•ÍÍ½¹}Í¡•‘Õ±”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½±•ÍÍ½¹M¡•‘Õ±•QÉ…¹Í™•ÉÌ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É5…Ñ•É¥…±Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É}µ…Ñ•É¥…±Ì¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É5…Ñ•É¥…±UÁ±½…‘M•ÍÍ¥½¹Ì¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Í•ÍÍ¥½¹Ì¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É5…Ñ•É¥…±UÁ±½…‘A…ÉÑÌ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Á…ÉÑÌ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•ÉUÁ±½…‘)½‰Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É}ÕÁ±½…‘}©½‰Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•ÉUÁ±½…‘¡Õ¹­Ù•¹ÑÌ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Í¡•µ„°€½Ñ•…¡•É1•ÍÍ½¹Y¥‘•½Ì¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•É5¥É…Ñ¥½¸°€½IQQ	1±•ÍÍ½¹}Í¡•‘Õ±•}ÑÉ…¹Í™•ÉÍ€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•É5¥É…Ñ¥½¸°€½±•ÍÍ½¹}Í¡•‘Õ±•}ÑÉ…¹Í™•ÉÍ}½É¥¥¹…±}Õ¹¥ÅÕ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉUÁ‘…Ñ•5¥É…Ñ¥½¸°€½‰•™½É•}Í¡•‘Õ±•}©Í½¹€Ñ•áÐ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÑÉ…¹Í™•ÉUÁ‘…Ñ•5¥É…Ñ¥½¸°€½…¹•±±•‘}…Ñ€Ñ•áÐ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±Í5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}µ…Ñ•É¥…±Í€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•É5…Ñ•É¥…±Í5¥É…Ñ¥½¸°€½Ñ•…¡•É}µ…Ñ•É¥…±Í}™¥±•}­•å}Õ¹¥ÅÕ”¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•ÉUÁ±½…‘)½‰Í5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}ÕÁ±½…‘}©½‰Í€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡Ñ•…¡•ÉUÁ±½…‘)½‰Í5¥É…Ñ¥½¸°€½Á¡…Í•€Ñ•áÐU1P€É•…Ñ¥¹œœ9=P9U10¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡É•½Ù•Éå5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}±•ÍÍ½¹}Ù¥‘•½Í€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡É•½Ù•Éå5¥É…Ñ¥½¸°€½ÕÁ±½…‘}ÕÉ±€Ñ•áÐ¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡É•ÍÕµ…‰±•MÑ…Ñ•5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}ÕÁ±½…‘}¡Õ¹­}•Ù•¹ÑÍ€¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡É•ÍÕµ…‰±•MÑ…Ñ•5¥É…Ñ¥½¸°€½½¹™¥Éµ•‘}½™™Í•Ñ€¥¹Ñ••È¼¤ì4(€…ÍÍ•ÉÐ¹µ…Ñ ¡É•ÍÕµ…‰±•MÑ…Ñ•5¥É…Ñ¥½¸°€½¡Õ¹­}Í¥é•€¥¹Ñ••È¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡µ…Ñ•É¥…±UÁ±½…‘5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Í•ÍÍ¥½¹Í€¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡µ…Ñ•É¥…±UÁ±½…‘5¥É…Ñ¥½¸°€½IQQ	1Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Á…ÉÑÍ€¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡µ…Ñ•É¥…±UÁ±½…‘5¥É…Ñ¥½¸°€½Ñ•…¡•É}µ…Ñ•É¥…±}ÕÁ±½…‘}Á…ÉÑÍ}Í•ÍÍ¥½¹}Á…ÉÑ}Õ¹¥ÅÕ”¼¤ì)ô¤ì(4)Ñ•ÍÐ ‰…‘µ¥¸Í½É”Á¥­•ÈÍÑ…åÌ¥¸½¹”½µÁ…ÐÉ½Üˆ°…Íå¹Œ€ ¤€ôøì(€½¹ÍÐÍÌ€ô…Ý…¥ÐÉ•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½±½‰…±Ì¹ÍÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤ì4(4(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÌ°€½É¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌéqÌ©É•Á•…Ñp ÄÄ±qÌ©µ¥¹µ…áp À±qÌ¨Å™Ép¥p¤¼¤ì4(€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡ÍÌ°€½p¹Í½É•A¥­•ÉqÌ©ímyõt©É•Á•…Ñp Ð½Ì¤ì)ô¤ì()Ñ•ÍÐ ‰½µÁ±•Ñ•…±•¹‘…È±•ÍÍ½¹Ì½Á•¸Í½ÕÉ”µµ…Ñ¡•¡½µ•Ý½É¬Ý¡¥±”™ÕÑÕÉ”±•ÍÍ½¹ÌÍÑ…ä¥¹…Ñ¥Ù”ˆ°…Íå¹Œ€ ¤€ôøì(€½¹ÍÐ…ÁÀ€ô…Ý…¥ÐÉ•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½••­ÍM•ÉÙ¥•ÁÀ¹ÑÍàˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤ì(€½¹ÍÐ¡½µ•Ý½É¬€ô…Ý…¥ÐÉ•…‘¥±”¡¹•ÜUI0 ˆ¸¸½±¥ˆ½±•ÍÍ½¸µ¡½µ•Ý½É¬¹ÑÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤ì(€½¹ÍÐÍÌ€ô…Ý…¥ÐÉ•…‘¥±”¡¹•ÜUI0 ˆ¸¸½…ÁÀ½±½‰…±Ì¹ÍÌˆ°¥µÁ½ÉÐ¹µ•Ñ„¹ÕÉ°¤°€‰ÕÑ˜àˆ¤ì((€…ÍÍ•ÉÐ¹µ…Ñ ¡…ÁÀ°€½µ…¥¹1•ÍÍ½¹pýp¹¥Í½µÁ±•Ñ•€˜˜±•ÍÍ½¹!½µ•Ý½É­	å9Õµ‰•È¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡…ÁÀ°€½½¹!½µ•Ý½É­M•±•Ñp¡µ…¥¹1•ÍÍ½¹p¤¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡…ÁÀ°€½±…ÍÍ9…µ”ô‰…±•¹‘…É!½µ•Ý½É­¥…±½œˆ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡…ÁÀ°€½…É¥„µµ½‘…°ô‰ÑÉÕ”ˆ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É¬°€½±•ÍÍ½¹9Õµ‰•ÈéqÌ¨Ä¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É¬°€½±•ÍÍ½¹9Õµ‰•ÈéqÌ¨ä¼¤ì(€…ÍÍ•ÉÐ¹‘½•Í9½Ñ5…Ñ ¡¡½µ•Ý½É¬°€½±•ÍÍ½¹9Õµ‰•ÈéqÌ¨ÄÀ¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É¬°€¿B‡BûBßBÓBÃFF0ƒFB×FB×BÜØÀ°1½Ù…‰±”ƒBãBïBà	½±Ñp¹¹•Ü¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡¡½µ•Ý½É¬°€¿FBûBßBÓBÃFF0ƒFBËBûBäƒBÿFBÇBïBãFB÷F/BäMM ƒBëBïF;F¼¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÌ°€½p¹…±•¹‘…É!½µ•Ý½É­=Ù•É±…åqÌ©ímyõt©Á½Í¥Ñ¥½¸éqÌ©™¥á•½Ì¤ì(€…ÍÍ•ÉÐ¹µ…Ñ ¡ÍÌ°€½p¹…±•¹‘…É!½µ•Ý½É­	½‘äÁqÌ©ímyõt©Ý¡¥Ñ”µÍÁ…”éqÌ©ÁÉ”µÝÉ…À½Ì¤ì)ô¤ì