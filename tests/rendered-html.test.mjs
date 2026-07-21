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
  assert.match(app, /addToggle/);
  assert.match(app, /editToggle/);
  assert.match(app, /bulkEditMode/);
  assert.match(app, /bulkActions/);
  assert.match(app, /bulkStudentRow/);
  assert.match(app, /bulkTelegram/);
  assert.match(app, /studentEditPanel/);
  assert.match(app, /editChoices/);
  assert.match(app, /studentEditInput/);
  assert.match(app, /telegramUsername/);
  assert.match(app, /telegramUserId/);
  assert.match(app, /telegramDraftValue/);
  assert.match(app, /buildStudentPatch/);
  assert.match(app, /onBulkStudentChange/);
  assert.match(app, /setSelectionRange/);
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
  assert.match(css, /\.leaderboard\s*{[^}]*user-select:\s*none/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*display:\s*flex/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.lessonTabs\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.lessonTab\s*{[^}]*width:\s*clamp\(20px,\s*5\.3vw,\s*24px\)/s);
  assert.match(css, /\.lessonTab\s*{[^}]*height:\s*clamp\(20px,\s*5\.3vw,\s*24px\)/s);
  assert.match(css, /\.lessonTab\.filled\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.student\.expanded \.lessonTabs,\s*\.student\.editing \.lessonTabs,\s*\.student\.bulkEditing \.lessonTabs\s*{[^}]*opacity:\s*0/s);
  assert.match(css, /\.studentEditPanel\s*{[^}]*background:\s*#151720/s);
  assert.match(css, /\.editChoices\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.studentEditInput:focus\s*{[^}]*border-color:\s*var\(--yellow\)/s);
  assert.match(css, /\.bulkActions\s*{[^}]*position:\s*sticky/s);
  assert.match(css, /\.bulkFields\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\) minmax\(0,\s*0\.85fr\)/s);
  assert.match(css, /\.bulkInput:focus\s*{[^}]*border-color:\s*var\(--yellow\)/s);
  assert.match(css, /\.groupBadgeText\s*{[^}]*animation:\s*badgeSwap 760ms/s);
  assert.match(css, /@keyframes badgeSwap/);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*background:\s*var\(--yellow\)/s);
  assert.match(css, /\.lessonChip\.filled\s*{[^}]*opacity:\s*1/s);
  assert.match(css, /\.lessonChip:disabled:not\(\.filled\)/);
  await access(new URL("../public/geeks-lightning.svg", import.meta.url));
  assert.doesNotMatch(app, /добавить ученика/);
});

test("includes leaderboard and admin API surfaces", async () => {
  const [leaderboardRoute, adminRoute, studentRoute, telegramRoute, importRoute, store] = await Promise.all([
    readFile(new URL("../app/api/leaderboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/students/[studentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/telegram/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/import-railway/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(leaderboardRoute, /listStudents/);
  assert.match(adminRoute, /createStudent/);
  assert.match(studentRoute, /updateStudent/);
  assert.match(telegramRoute, /validateTelegramInitData/);
  assert.match(importRoute, /importStudentsSnapshot/);
  assert.match(store, /SET telegram_username = \?, avatar_url = COALESCE/);
});

test("admin score picker stays in one compact row", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /grid-template-columns:\s*repeat\(11,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(css, /\.scorePicker\s*{[^}]*repeat\(4/s);
});
