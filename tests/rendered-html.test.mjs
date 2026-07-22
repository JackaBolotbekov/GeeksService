import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.doesNotMatch(app, /pointsBehindLeader === 0 \? "TOP"/);
  assert.doesNotMatch(app, /<h1>/);
  assert.doesNotMatch(app, /heroStats/);
  assert.match(app, /VibeCoding-1/);
  assert.match(app, /6 урок >/);
  assert.match(app, /RotatingGroupBadge/);
  assert.match(app, /3200/);
  assert.doesNotMatch(app, /12 занятий/);
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
  assert.match(app, /navIconHomework/);
  assert.match(app, /uploadArrow/);
  assert.match(app, /HomeworkUploadScreen/);
  assert.match(app, /uploadFileToYouTube/);
  assert.match(app, /uploadYouTubeChunkWithRetry/);
  assert.match(app, /isRetriableUploadError/);
  assert.match(app, /VIDEO_CHUNK_SIZE = 16 \* 1024 \* 1024/);
  assert.match(app, /Content-Range/);
  assert.match(app, /\/api\/admin\/youtube\/upload-session/);
  assert.match(app, /activeScreen === "homeworkUpload"/);
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
  assert.doesNotMatch(app, /onPointerDown/);
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
  assert.match(css, /\.bottomNav\s*{[^}]*width:\s*min\(392px,\s*calc\(100dvw - 18px\)\)/s);
  assert.match(css, /\.bottomNav\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.bottomNav::before\s*{[^}]*content:\s*none/s);
  assert.match(css, /\.bottomNavButton\s*{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.bottomNavPrimary\s*{[^}]*border-radius:\s*999px/s);
  assert.match(css, /\.uploadArrow::before\s*{[^}]*height:\s*15px/s);
  assert.match(css, /\.uploadArrow::after\s*{[^}]*border-bottom:\s*14px solid #11131b/s);
  assert.match(css, /\.uploadScreen\s*{[^}]*padding:\s*2px 0 112px/s);
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
  assert.match(css, /\.groupBadgeText\s*{[^}]*animation:\s*badgeSwap 760ms/s);
  assert.match(css, /@keyframes badgeSwap/);
  assert.match(css, /\.lessonGrid\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*margin-top:\s*3px/s);
  assert.match(css, /\.lessonEditor\s*{[^}]*padding-top:\s*4px/s);
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

test("includes leaderboard and admin API surfaces", async () => {
  const [leaderboardRoute, adminRoute, studentRoute, telegramRoute, importRoute, avatarRoute, youtubeUploadRoute, store] = await Promise.all([
    readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/telegram/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/import-railway/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/avatar/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/youtube/upload-session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
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
  assert.match(store, /SET telegram_username = \?, avatar_url = COALESCE/);
  assert.match(store, /findAvatarSourceByStudentId/);
  assert.match(store, /\/api\/avatar\/\$\{row\.id\}/);
});

test("admin score picker stays in one compact row", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /grid-template-columns:\s*repeat\(11,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.scorePicker\s*{[^}]*repeat\(4/s);
});
